import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { openDb, GraphRunStore, GraphCheckpointStore, type GraphRun, type GraphProgramVersion } from '@osstack/core';
import type { StartGraphRequest, GraphCheckpointRequest } from '@osstack/protocol';
import { GraphCheckpointService } from './graph-checkpoint-service.js';

const scope = { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' };
const program: GraphProgramVersion = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) };
const start: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'start', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request' }, spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'acceptance' }, limits: { maxEpochs: 1, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } } };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fence(run: GraphRun, now = 110) { return { scope, graphRunId: run.graphRunId, expectedGeneration: run.generation, expectedRevision: run.revision, expectedOwner: run.leaseOwner, identity: run.identity, now }; }
function fixture(authorize = vi.fn(async () => {})) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-svc-'));
  const db = openDb({ path: join(dir, 'state.db') });
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const runs = new GraphRunStore(db);
  const run = runs.acquireLease({ ...fence(runs.create(start, program, 100)), owner: 'worker1', leaseExpiresAt: 1000 });
  const token = {};
  const binding = { scope: structuredClone(scope), graphRunId: run.graphRunId, generation: run.generation, owner: run.leaseOwner!, identity: structuredClone(run.identity), authorize };
  const bindings = new Map([[token, binding]]);
  const service = new GraphCheckpointService({ runs, checkpoints: new GraphCheckpointStore(db), bindings, now: () => 120 });
  const request: GraphCheckpointRequest = { kind: 'get', threadId: run.graphRunId, namespace: '' };
  return { db, runs, run, service, token, binding, bindings, request, authorize };
}
it('requires exact host registration and rejects caller-supplied scope or a different thread', async () => {
  const f = fixture();
  await expect(f.service.execute({}, f.request)).rejects.toThrow('UNAUTHENTICATED');
  await expect(f.service.execute(f.token, { ...f.request, scope })).rejects.toThrow();
  await expect(f.service.execute(f.token, { ...f.request, threadId: 'other' })).rejects.toThrow('RUN_MISMATCH');
  await expect(f.service.execute(f.token, f.request)).resolves.toEqual({ kind: 'get', tuple: null });
});
it('refreshes revision after an authorization await but never adopts a new worker generation', async () => {
  let resume!: () => void;
  const f = fixture(vi.fn(() => new Promise<void>(resolve => { resume = resolve; })));
  const response = f.service.execute(f.token, f.request);
  f.runs.renewLease({ ...fence(f.run, 115), leaseExpiresAt: 1100 });
  resume(); await expect(response).resolves.toEqual({ kind: 'get', tuple: null });
  const current = f.runs.get(scope, f.run.graphRunId)!;
  const stale = f.service.execute(f.token, f.request);
  f.runs.acquireLease({ ...fence(current, 119), owner: 'worker2', leaseExpiresAt: 1200,
    stoppedWorker: { graphRunId: current.graphRunId, generation: current.generation, owner: current.leaseOwner!, confirmedAt: 118, evidenceRef: 'trusted-supervisor-stop' } });
  resume(); await expect(stale).rejects.toThrow('STALE_GENERATION');
});
it('snapshots registration data and request before authorization can yield', async () => {
  let resume!: () => void;
  const f = fixture(vi.fn(() => new Promise<void>(resolve => { resume = resolve; })));
  const request = { ...f.request };
  const response = f.service.execute(f.token, request);
  request.threadId = 'other'; f.binding.scope.tenantId = 'other'; f.binding.owner = 'other'; f.bindings.clear();
  resume(); await expect(response).resolves.toEqual({ kind: 'get', tuple: null });
});
it('denies revoked authorization and prevents late writes after service closes', async () => {
  const f = fixture(vi.fn(async () => { throw new Error('GRANT_EXPIRED'); }));
  await expect(f.service.execute(f.token, f.request)).rejects.toThrow('GRANT_EXPIRED');
  let resume!: () => void;
  const pending = fixture(vi.fn(() => new Promise<void>(resolve => { resume = resolve; })));
  const response = pending.service.execute(pending.token, pending.request); pending.service.close(); resume();
  await expect(response).rejects.toThrow('CHECKPOINT_SERVICE_CLOSED');
});
it('rejects a false authorization return instead of treating it as successful completion', async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false as unknown as undefined);
  await expect(f.service.execute(f.token, f.request)).rejects.toThrow('POLICY_DENIED');
});
it('registers new supervised connections and rejects an in-flight write after revocation', async () => {
  let resume!: () => void;
  const f = fixture(); const token = {};
  f.service.register(token, { ...f.binding, authorize: () => new Promise<void>(resolve => { resume = resolve; }) });
  expect(() => f.service.register(token, f.binding)).toThrow('ALREADY_REGISTERED');
  const pending = f.service.execute(token, { kind: 'put', requestId: 'revoked-put', threadId: f.run.graphRunId,
    namespace: '', checkpointId: '001', checkpoint: 'null', metadata: 'null', newVersions: 'null' });
  f.service.unregister(token); resume();
  await expect(pending).rejects.toThrow('UNAUTHENTICATED');
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_checkpoints').get()).toEqual({ n: 0 });
  expect(() => f.service.register(token, f.binding)).toThrow('CONNECTION_RETIRED');
  f.service.close(); expect(() => f.service.register({}, f.binding)).toThrow('CLOSED');
});
