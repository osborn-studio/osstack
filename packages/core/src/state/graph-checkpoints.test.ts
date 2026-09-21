import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { GraphCheckpointRequest, StartGraphRequest } from '@osstack/protocol';
import { openDb } from './db.js';
import { GraphRunStore, type GraphRun, type GraphRunFence, type GraphProgramVersion } from './graph-runs.js';
import { GraphCheckpointStore } from './graph-checkpoints.js';
const scope = { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' };
const request: StartGraphRequest = {
  schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'key', inputArtifactRef: 'input',
  source: { product: 'osstack', requestId: 'request', parentRunId: 'parent' },
  spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
    input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'acceptance' },
    limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1,
      maxActionStarts: 10, deadlineSeconds: 60, tokenReservationLimit: 100 } },
};
const program: GraphProgramVersion = { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15',
  checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) };
let dir: string;
let db: Database.Database;
let runs: GraphRunStore;
let store: GraphCheckpointStore;
let run: GraphRun;
const fence = (value = run): GraphRunFence => ({ scope, graphRunId: value.graphRunId, identity: value.identity,
  expectedOwner: value.leaseOwner, expectedGeneration: value.generation, expectedRevision: value.revision, now: 120 });
const put = (requestId = 'put-1'): Extract<GraphCheckpointRequest, { kind: 'put' }> => ({ kind: 'put', requestId, threadId: run.graphRunId, namespace: '',
  checkpointId: '001', checkpoint: 'opaque checkpoint', metadata: 'opaque metadata', newVersions: 'opaque versions' });
const writes = (requestId = 'writes-1'): Extract<GraphCheckpointRequest, { kind: 'writes' }> => ({ kind: 'writes', requestId, threadId: run.graphRunId,
  namespace: '', checkpointId: '001', taskId: 'task', writes: [{ channel: '__return__', index: 0, value: 'false' },
    { channel: '__error__', index: -1, value: 'first error' }] });
const execute = (value: GraphCheckpointRequest) => { const result = store.execute(fence(), value); run = result.run; return result.response; };
const get = () => execute({ kind: 'get', threadId: run.graphRunId, namespace: '' });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-checkpoints-')); db = openDb({ path: join(dir, 'state.db') });
  runs = new GraphRunStore(db); store = new GraphCheckpointStore(db);
  run = runs.create(request, program, 100);
  run = runs.acquireLease({ ...fence(), now: 110, owner: 'worker', leaseExpiresAt: 200 });
});
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });

it('stores opaque codec bytes without revival and persists full tuples across SQLite close/reopen', () => {
  execute(put()); execute(writes()); const tuple = get(); const revision = run.revision;
  db.close(); db = openDb({ path: join(dir, 'state.db') }); store = new GraphCheckpointStore(db);
  expect(get()).toEqual(tuple); expect(run.revision).toBe(revision);
  expect(tuple).toMatchObject({ kind: 'get', tuple: { checkpoint: 'opaque checkpoint', metadata: 'opaque metadata',
    newVersions: 'opaque versions', pendingWrites: [{ taskId: 'task', channel: '__error__', index: -1, value: 'first error' },
      { taskId: 'task', channel: '__return__', index: 0, value: 'false' }] } });
});
it('fences every cache replay by scope, complete program, generation, owner, revision and live lease', () => {
  const value = put(); const old = run; execute(value); const current = run;
  expect(() => store.execute(fence(old), value)).toThrow('REVISION_CONFLICT');
  const replay = execute(value); expect(replay.kind).toBe('put'); expect(run.revision).toBe(current.revision);
  expect(() => store.execute({ ...fence(), scope: { ...scope, principalId: 'other' } }, value)).toThrow('RUN_NOT_FOUND');
  expect(() => store.execute({ ...fence(), identity: { ...run.identity, compilerVersion: 'changed' } }, value)).toThrow('PROGRAM_IDENTITY_MISMATCH');
  expect(() => store.execute({ ...fence(), expectedOwner: 'other' }, value)).toThrow('OWNER_MISMATCH');
  expect(() => store.execute({ ...fence(), now: 200 }, value)).toThrow('LEASE_EXPIRED');
  run = runs.acquireLease({ ...fence(), now: 201, owner: 'new', leaseExpiresAt: 400,
    stoppedWorker: { graphRunId: current.graphRunId, generation: current.generation, owner: current.leaseOwner!, confirmedAt: 190, evidenceRef: 'exit' } });
  expect(() => store.execute({ ...fence(current), now: 202 }, value)).toThrow('STALE_GENERATION');
});
it('rejects cross-run read/write and changed payload under the same mutation ID', () => {
  execute(put());
  expect(() => execute({ ...put(), threadId: 'other' })).toThrow('CHECKPOINT_THREAD_MISMATCH');
  expect(() => execute({ kind: 'get', threadId: 'other', namespace: '' })).toThrow('CHECKPOINT_THREAD_MISMATCH');
  expect(() => execute({ kind: 'list', threadId: 'other', pageSize: 1 })).toThrow('CHECKPOINT_THREAD_MISMATCH');
  expect(() => execute({ ...put(), kind: 'put', metadata: 'changed' })).toThrow('IDEMPOTENCY_CONFLICT');
});
it('rolls back the entire pending-write batch, replay record and revision on an injected SQLite failure', () => {
  execute(put()); const prior = run;
  db.exec(`CREATE TEMP TRIGGER fail_checkpoint_write BEFORE INSERT ON graph_checkpoint_writes
    WHEN NEW.channel = '__error__' BEGIN SELECT RAISE(ABORT, 'injected rollback'); END`);
  expect(() => execute(writes())).toThrow('injected rollback');
  expect(runs.get(scope, run.graphRunId)).toEqual(prior);
  expect(get()).toMatchObject({ tuple: { pendingWrites: [] } });
  db.exec('DROP TRIGGER fail_checkpoint_write'); execute(writes());
  expect(get()).toMatchObject({ tuple: { pendingWrites: expect.arrayContaining([{ taskId: 'task', channel: '__return__', index: 0, value: 'false' }]) } });
});
it('preserves partial batches, reserved negative overwrites and ordinary positive first-write semantics', () => {
  execute(put()); execute(writes());
  execute({ kind: 'writes', requestId: 'writes-2', threadId: run.graphRunId, namespace: '', checkpointId: '001', taskId: 'task',
    writes: [{ channel: '__return__', index: 0, value: 'true' }, { channel: '__error__', index: -1, value: 'second error' },
      { channel: 'extra', index: 2, value: 'extra' }] });
  expect(get()).toMatchObject({ tuple: { pendingWrites: [
    { taskId: 'task', channel: '__error__', index: -1, value: 'second error' },
    { taskId: 'task', channel: '__return__', index: 0, value: 'false' },
    { taskId: 'task', channel: 'extra', index: 2, value: 'extra' },
  ] } });
  expect(() => execute({ kind: 'writes', requestId: 'forged', threadId: run.graphRunId, namespace: '', checkpointId: '001', taskId: 'task',
    writes: [{ channel: '__return__', index: -1, value: 'forged' }] })).toThrow('CHECKPOINT_WRITE_INDEX');
});
it('bounds aggregate tuple bytes transactionally across many individually bounded write requests', () => {
  execute(put());
  for (let i = 0; i < 3; i++) execute({ kind: 'writes', requestId: `large-${i}`, threadId: run.graphRunId, namespace: '', checkpointId: '001',
    taskId: `task-${i}`, writes: [{ channel: 'value', index: 0, value: 'x'.repeat(1_048_576) }] });
  const prior = run;
  expect(() => execute({ kind: 'writes', requestId: 'too-large', threadId: run.graphRunId, namespace: '', checkpointId: '001',
    taskId: 'task-4', writes: [{ channel: 'value', index: 0, value: 'x'.repeat(1_048_576) }] })).toThrow('CHECKPOINT_TUPLE_LIMIT');
  expect(run).toEqual(prior);
});
it('rolls back checkpoint insertion when the idempotency record fails, then retries the original ID', () => {
  const prior = run;
  db.exec(`CREATE TEMP TRIGGER fail_checkpoint_ack BEFORE INSERT ON graph_checkpoint_requests
    BEGIN SELECT RAISE(ABORT, 'injected cache failure'); END`);
  expect(() => execute(put())).toThrow('injected cache failure');
  expect(get()).toEqual({ kind: 'get', tuple: null });
  expect(runs.get(scope, run.graphRunId)).toEqual(prior);
  db.exec('DROP TRIGGER fail_checkpoint_ack');
  expect(execute(put())).toEqual({ kind: 'put', checkpointId: '001' });
});
it('paginates equal checkpoint IDs across namespaces without skipping and bounds response bytes', () => {
  for (const namespace of ['a', 'b', 'c']) execute({ ...put(namespace), namespace, checkpoint: 'x'.repeat(1_048_576), metadata: 'x'.repeat(1_048_576), newVersions: 'x'.repeat(1_048_576) });
  const first = execute({ kind: 'list', threadId: run.graphRunId, pageSize: 16 });
  expect(first).toMatchObject({ kind: 'list', tuples: [{ namespace: 'c' }, { namespace: 'b' }], cursor: { namespace: 'b', checkpointId: '001' } });
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(8 * 1024 * 1024);
  if (first.kind !== 'list') throw new Error('list expected');
  const second = execute({ kind: 'list', threadId: run.graphRunId, pageSize: 16, cursor: first.cursor });
  expect(second).toMatchObject({ kind: 'list', tuples: [{ namespace: 'a' }] });
  expect('cursor' in second).toBe(false);
});
it('splits pages at transport traversal bounds even when many small pending writes fit the byte cap', () => {
  for (let i = 0; i < 5; i++) {
    execute({ ...put(`put-${i}`), checkpointId: `00${i}` });
    execute({ ...writes(`write-${i}`), checkpointId: `00${i}`,
      writes: Array.from({ length: 4096 }, (_, index) => ({ channel: 'value', index, value: 'x' })) });
  }
  const page = execute({ kind: 'list', threadId: run.graphRunId, pageSize: 16 });
  expect(page.kind === 'list' && page.tuples.length).toBe(4);
  expect(page).toMatchObject({ cursor: { namespace: '', checkpointId: '001' } });
});
it.each(['checkpoints', 'pendingWrites', 'requests', 'bytes'] as const)('enforces the daemon %s run quota atomically across addresses and reopening', (kind) => {
  const limits = { checkpoints: 2, pendingWrites: 3, requests: 3, bytes: 200 };
  store = new GraphCheckpointStore(db, limits);
  execute(put());
  const before = run;
  if (kind === 'checkpoints') {
    execute({ ...put('put2'), checkpointId: '002' });
    const revision = run.revision;
    expect(() => execute({ ...put('put3'), checkpointId: '003' })).toThrow('CHECKPOINT_RUN_LIMIT');
    expect(runs.get(scope, run.graphRunId)?.revision).toBe(revision);
  } else if (kind === 'pendingWrites') {
    execute(writes());
    expect(() => execute({ ...writes('writes2'), checkpointId: '002' })).toThrow('CHECKPOINT_RUN_LIMIT');
    expect(db.prepare('SELECT count(*) AS n FROM graph_checkpoint_writes').get()).toEqual({ n: 2 });
  } else if (kind === 'requests') {
    execute(put('same-data-new-id-1')); execute(put('same-data-new-id-2'));
    expect(() => execute(put('same-data-new-id-3'))).toThrow('CHECKPOINT_RUN_LIMIT');
    // Original idempotency replay is still allowed, without growing history.
    expect(execute(put())).toEqual({ kind: 'put', checkpointId: '001' });
  } else {
    expect(() => execute({ ...writes(), checkpointId: 'other', writes: [{ index: 0, channel: 'result', value: 'x'.repeat(201) }] })).toThrow('CHECKPOINT_RUN_LIMIT');
    expect(runs.get(scope, run.graphRunId)).toEqual(before);
  }
  const dbPath = db.name; db.close(); db = openDb({ path: dbPath }); runs = new GraphRunStore(db);
  store = new GraphCheckpointStore(db, limits);
  expect(get().kind).toBe('get');
  expect(db.prepare('SELECT count(*) AS n FROM graph_checkpoint_requests').get()).toEqual({ n: kind === 'requests' ? 3 : kind === 'bytes' ? 1 : 2 });
});
it('permits only trusted tightening of fixed checkpoint storage ceilings', () => {
  expect(() => new GraphCheckpointStore(db, { bytes: Number.MAX_SAFE_INTEGER })).toThrow('CHECKPOINT_QUOTA_INVALID');
  expect(() => new GraphCheckpointStore(db, { requests: 0 })).toThrow('CHECKPOINT_QUOTA_INVALID');
});

it('counts UTF-8 bytes rather than characters in the checkpoint run quota', () => {
  store = new GraphCheckpointStore(db, { bytes: 200 });
  execute(put());
  const prior = run;
  expect(() => execute({ ...writes(), checkpointId: 'unicode', writes: [
    { index: 0, channel: 'result', value: '中文🙂'.repeat(21) },
  ] })).toThrow('CHECKPOINT_RUN_LIMIT');
  expect(runs.get(scope, run.graphRunId)).toEqual(prior);
  expect(db.prepare('SELECT count(*) AS n FROM graph_checkpoint_writes').get()).toEqual({ n: 0 });
});
