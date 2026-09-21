import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GraphRunStore, openDb } from '@osstack/core';
import { FifoSemaphore } from '@osstack/autonomy';
import { ExecutionPlan } from '@osstack/loop';
import type { WorkerActionRequest } from '@osstack/protocol';
import { GraphActionBroker, type GraphRegisteredAction } from './graph-action-broker.js';
import { GovernedExecution } from './governed-execution.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'g21-registration-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); execFileSync('git', ['init', '-q', repo]);
  const db = openDb({ path: join(root, 'control.sqlite') }); cleanups.push(() => db.close());
  const scope = { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'owner', workspaceId: 'workspace' };
  const runs = new GraphRunStore(db);
  const run = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'registration', inputArtifactRef: 'input',
    source: { product: 'osstack', requestId: 'registration' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
      input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'acceptance' },
      limits: { maxEpochs: 2, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
        maxActionStarts: 20, deadlineSeconds: 120, tokenReservationLimit: 100 } } },
    { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5',
      templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) }, Date.now());
  const leased = runs.acquireLease({ scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: 0,
    expectedRevision: 0, expectedOwner: null, owner: 'host', now: Date.now(), leaseExpiresAt: Date.now() + 120_000 });
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(1), repositories: new Map(), checkHealth: async () => {} });
  const broker = new GraphActionBroker(db, { acquire: admission.acquire.bind(admission) });
  const connection = {}; let revoked = false;
  broker.register(connection, { scope, graphRunId: leased.graphRunId, identity: leased.identity,
    generation: leased.generation, owner: 'host', epoch: 0, workspace: { workspace_id: scope.workspaceId, workspace_path: repo },
    authorize: () => { if (revoked) throw Error('revoked'); }, actions: [] });
  const action = (nodeId: string): GraphRegisteredAction => ({ nodeId, effectSlot: 'main', tokenReservation: 0,
    action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'writer' },
    execution: { kind: 'command', command: 'printf once >> calls', plan: ExecutionPlan.parse({ plan_id: nodeId, agent_id: 'local-command',
      task: { task_id: nodeId, capability: 'code.write', prompt: 'one invocation', source: 'manual' }, stop_condition: { type: 'tests_pass' } }) },
    persist: async () => ({ evidenceRef: 'implementation', actualTokens: 0,
      result: { schemaVersion: 1, kind: 'implementation_complete', workspaceLeaseRef: 'writer', receiptRef: 'implementation' } }) });
  const request = (nodeId: string): WorkerActionRequest => ({ schemaVersion: 1, kind: 'worker_action', requestId: nodeId,
    scope, graphRunId: leased.graphRunId, specHash: leased.identity.specHash, generation: leased.generation,
    epoch: 0, nodeId, effectSlot: 'main', action: action(nodeId).action });
  return { db, repo, broker, connection, action, request, leased, revoke: () => { revoked = true; } };
}

it('installs trusted slots without invoking, snapshots inputs, and replays one actual effect', async () => {
  const f = fixture(); const action = f.action('writer'); f.broker.installActions(f.connection, [action]);
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_actions').get()).toEqual({ n: 0 });
  if (action.execution.kind === 'command') action.execution.command = 'exit 9';
  expect(await f.broker.handle(f.connection, f.request('writer'))).toMatchObject({ outcome: { state: 'confirmed' } });
  expect(await f.broker.handle(f.connection, f.request('writer'))).toMatchObject({ outcome: { state: 'confirmed' } });
  expect(readFileSync(join(f.repo, 'calls'), 'utf8')).toBe('once');
});

it('rejects an entire append batch containing an existing slot without partially installing it', async () => {
  const f = fixture(); f.broker.installActions(f.connection, [f.action('writer')]);
  expect(() => f.broker.installActions(f.connection, [f.action('new'), f.action('writer')])).toThrow(/immutable/);
  expect(await f.broker.handle(f.connection, f.request('new'))).toMatchObject({ kind: 'worker_action_rejected' });
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_actions').get()).toEqual({ n: 0 });
});

it.each(['revoked', 'retired', 'epoch'] as const)('rejects dynamic registration after %s authority changes', reason => {
  const f = fixture();
  if (reason === 'revoked') f.revoke();
  if (reason === 'retired') f.broker.unregister(f.connection);
  if (reason === 'epoch') f.db.prepare('INSERT INTO graph_delivery_epochs(graph_run_id,epoch,join_ref,generation,created_at) VALUES(?,1,NULL,?,?)')
    .run(f.leased.graphRunId, f.leased.generation, Date.now());
  expect(() => f.broker.installActions(f.connection, [f.action('writer')])).toThrow();
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_actions').get()).toEqual({ n: 0 });
});
