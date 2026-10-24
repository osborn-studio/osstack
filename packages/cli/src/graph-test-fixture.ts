import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { openDb, CapabilitySchema, createScratchDir } from '@osstack/core';
import { GraphDelegationStatus, type StartGraphRequest } from '@osstack/protocol';
import { FifoSemaphore } from '@osstack/autonomy';
import { GraphRpcService, type GraphHostRegistration, type GraphRpcOptions } from './graph-rpc.js';
import { GovernedExecution } from './governed-execution.js';
import type { AgentAdapter } from '@osstack/agents';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
interface GraphRpcFixture {
  root: string; db: Database.Database; request: StartGraphRequest; registration: GraphHostRegistration;
  connection: object; service: GraphRpcService; options: GraphRpcOptions; writer: AgentAdapter; reviewer: AgentAdapter;
  start: () => Promise<GraphDelegationStatus>;
  status: (id: string, host?: GraphRpcService) => Promise<GraphDelegationStatus>;
  until: (id: string, predicate: (status: GraphDelegationStatus) => boolean) => Promise<GraphDelegationStatus>;
  writes: () => number; abortObserved: () => boolean; grant: (value: boolean) => void; close: () => Promise<void>;
}
export async function graphRpcFixture(mode: 'success' | 'repair' | 'cancel' | 'unknown' = 'success'): Promise<GraphRpcFixture> {
  const root = await realpath(await createScratchDir('tests', 'g22-rpc')); const repo = join(root, 'source'); await mkdir(repo);
  git(repo, 'init', '-q'); await writeFile(join(repo, 'answer'), '0\n'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=G22', '-c', 'user.email=g22@invalid', 'commit', '-qm', 'base');
  const db: Database.Database = openDb({ path: join(root, 'control.sqlite') }); let writes = 0; let granted = true; let abortObserved = false;
  const stopped = new Set<string>();
  const writer: AgentAdapter = { id: 'writer', display_name: 'writer', cost_tier: 'low',
    capabilities: () => [CapabilitySchema.parse({ id: 'write', agent_id: 'writer', kind: 'code.write', description: 'write' })],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: async function* (task, options) {
      writes++;
      if (mode === 'cancel') {
        await new Promise<void>(resolve => { if (options?.aborted) resolve(); else options?.addEventListener('abort', () => resolve(), { once: true }); });
        abortObserved = true;
      } else await writeFile(join(String(task.context?.['repo_path']), 'answer'), mode === 'repair' && writes === 1 ? '0\n' : '1\n');
      if (mode !== 'unknown') stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: mode === 'cancel' ? 'failed' : 'completed', last_seq: 0, result_summary: 'implemented', usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    }, confirmStopped: async id => ({ stopped: stopped.has(id), evidence: `finite:${id}` }) };
  const reviewer: AgentAdapter = { ...writer, id: 'reviewer', capabilities: () => [CapabilitySchema.parse({ id: 'review', agent_id: 'reviewer', kind: 'review.code', description: 'review' })],
    invoke: async function* (task) {
      const good = (await readFile(join(String(task.context?.['repo_path']), 'answer'), 'utf8')).trim() === '1'; stopped.add(task.run_id);
      yield { event_id: task.run_id, run_id: task.run_id, session_id: task.session_id, seq: 1, created_at: Date.now() / 1000, type: 'done', terminal: true,
        payload: { status: 'completed', last_seq: 0, result_summary: JSON.stringify({ schemaVersion: 1, verdict: good ? 'accept' : 'changes_requested', summary: 'actual candidate', findings: good ? [] : ['answer must be 1'] }), usage: { tokens_in: 1, tokens_out: 1, duration_ms: 1 } } };
    } };
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' },
    idempotencyKey: 'public-key', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request', parentRunId: 'parent' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: git(repo, 'rev-parse', 'HEAD'), acceptanceRef: 'acceptance' },
      limits: { maxEpochs: 2, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 14, tokenReservationLimit: 200000, deadlineSeconds: 120 } } };
  const registration: GraphHostRegistration = { id: 'local', scope: request.scope, product: 'osstack', repositoryRef: 'repo', taskRef: 'task', inputArtifactRef: 'input',
    authorize: operation => { if (!granted && operation !== 'read' && operation !== 'cancel') throw Error('GRANT_EXPIRED'); },
    delivery: { repositoryPath: repo, task: 'Set answer to 1', writer: { identity: 'writer', adapter: writer, capabilityId: 'write' }, reviewer: { identity: 'reviewer', adapter: reviewer, capabilityId: 'review' },
      verifyReviewer: async proof => { if (proof.writerIdentity === proof.reviewerIdentity) throw Error('independence'); },
      acceptanceRegistry: [{ ref: 'acceptance', command: 'test "$(cat answer)" = 1', passExitCodes: [0], failExitCodes: [1] }] } };
  const connection = {};
  const admission = new GovernedExecution({ reads: new FifoSemaphore(2), writes: new FifoSemaphore(2), repositories: new Map(), checkHealth: async () => {} });
  const options = { db, root: join(root, 'delivery'), registrations: [registration], resolveCaller: (key: object) => key === connection ? 'local' : null, acquire: admission.acquire.bind(admission) };
  const service = new GraphRpcService(options);
  const start = async () => GraphDelegationStatus.parse(await service.handle(connection, 'graph.start', request));
  const status = async (id: string, host = service) => GraphDelegationStatus.parse(await host.handle(connection, 'graph.status', { schemaVersion: 1, scope: request.scope, graphRunId: id }));
  const until = async (id: string, predicate: (s: ReturnType<typeof GraphDelegationStatus.parse>) => boolean) => {
    const deadline = Date.now() + 20000;
    for (;;) { const value = await status(id); if (predicate(value)) return value;
      if (Date.now() > deadline) throw Error(`TIMEOUT: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  return { root, db, request, registration, connection, service, start, status, until, options, writer, reviewer,
    writes: () => writes, abortObserved: () => abortObserved, grant: (value: boolean) => { granted = value; },
    close: async () => { await service.close(); db.close(); } };
}
