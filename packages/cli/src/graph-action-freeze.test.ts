import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { FifoSemaphore } from '@osstack/autonomy';
import { openDb, GraphRunStore, resolveRepositoryScope } from '@osstack/core';
import { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import { ExecutionPlan } from '@osstack/loop';
import type { WorkerActionRequest } from '@osstack/protocol';
import { GraphActionBroker, type GraphWorkerRegistration } from './graph-action-broker.js';
import { GovernedExecution } from './governed-execution.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
it('freezes a real confirmed implementation under the same shared admission into a verified artifact', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gfz-'))); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'file.txt'), 'before\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
  const base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const scope = { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' };
  const db = openDb({ path: join(root, 'db') }); cleanups.push(() => db.close()); const runs = new GraphRunStore(db);
  const created = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'freeze', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: base, acceptanceRef: 'acceptance' },
      limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 5, deadlineSeconds: 120, tokenReservationLimit: 100 } } },
    { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) }, Date.now());
  const run = runs.acquireLease({ scope, graphRunId: created.graphRunId, identity: created.identity, expectedGeneration: 0, expectedRevision: 0, expectedOwner: null,
    now: Date.now(), owner: 'worker', leaseExpiresAt: Date.now() + 120000 });
  const writes = new FifoSemaphore(1); const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes, repositories: new Map(), checkHealth: async () => {} });
  const broker = new GraphActionBroker(db, { acquire: admission.acquire.bind(admission) }); const connection = {};
  const artifacts = new GraphArtifactStore(join(root, 'artifacts')); const canonical = await resolveRepositoryScope(repo);
  const receiptPath = join(root, 'receipt.json');
  const registration: GraphWorkerRegistration = { scope, graphRunId: run.graphRunId, generation: run.generation, owner: 'worker', identity: run.identity, epoch: 0,
    workspace: { workspace_id: 'workspace', workspace_path: repo }, authorize: () => {}, actions: [
      { nodeId: 'implement', effectSlot: 'invoke', tokenReservation: 0, action: { kind: 'implement', inputArtifactRef: 'input', workspaceLeaseRef: 'workspace' },
        execution: { kind: 'command', command: "printf after > file.txt", plan: ExecutionPlan.parse({ plan_id: 'plan', agent_id: 'local-command', task: { task_id: 'task', capability: 'code.write', prompt: 'change', source: 'manual' }, stop_condition: { type: 'tests_pass' } }) },
        persist: async evidence => { expect(evidence.command?.termination?.stop_confirmed).toBe(true); writeFileSync(receiptPath, JSON.stringify(evidence.command));
          const fd = openSync(receiptPath, 'r'); fsyncSync(fd); closeSync(fd);
          return { evidenceRef: 'implementation-receipt', actualTokens: 0, result: { schemaVersion: 1, kind: 'implementation_complete', workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' } }; } },
      { nodeId: 'freeze', effectSlot: 'invoke', tokenReservation: 0, action: { kind: 'freeze', workspaceLeaseRef: 'workspace', receiptRef: 'implementation-receipt' },
        execution: { kind: 'freeze', store: artifacts, input: { artifactId: `candidate:${run.graphRunId}`, scope, runId: run.graphRunId, generation: run.generation, owner: 'worker',
          workspaceLeaseRef: 'workspace', repoId: canonical.repoId, commonDir: canonical.commonDir, worktreePath: repo, baseRevision: base,
          implementationReceiptRef: 'implementation-receipt', producerStopEvidenceRef: 'producer-stopped' },
          authority: { verifyLease: async () => { expect(writes.in_use).toBe(1); },
            verifyImplementationReceipt: async () => { expect(db.prepare("SELECT state FROM graph_actions WHERE node_id = 'implement'").get()).toEqual({ state: 'confirmed' }); },
            verifyProducersStopped: async () => { expect(JSON.parse(readFileSync(receiptPath, 'utf8')).termination.stop_confirmed).toBe(true); } } },
        persist: async evidence => ({ evidenceRef: 'frozen-receipt', actualTokens: 0, result: evidence.frozenCandidate! }) },
    ] };
  broker.register(connection, registration);
  const invoke = (index: number) => { const a = registration.actions[index]!; const request: WorkerActionRequest = { schemaVersion: 1, kind: 'worker_action', requestId: `request-${index}`,
    scope, graphRunId: run.graphRunId, specHash: run.identity.specHash, generation: run.generation, epoch: 0, nodeId: a.nodeId, effectSlot: a.effectSlot, action: a.action }; return broker.handle(connection, request); };
  expect(await invoke(0)).toMatchObject({ outcome: { state: 'confirmed' } });
  const result = await invoke(1); expect(result).toMatchObject({ outcome: { state: 'confirmed', result: { kind: 'candidate_ready' } } });
  if (result.kind !== 'worker_action_response' || result.outcome.state !== 'confirmed' || result.outcome.result.kind !== 'candidate_ready') throw new Error('freeze not confirmed');
  const verified = await artifacts.verify(result.outcome.result.artifactDigest); expect(verified.candidateRevision).toBe(result.outcome.result.candidateRevision);
  expect(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(base);
  expect(await invoke(1)).toEqual({ ...result, requestId: 'request-1' }); expect(writes.in_use).toBe(0);
// Real Git, filesystem durability and both broker actions share this test budget.
}, 15_000);
