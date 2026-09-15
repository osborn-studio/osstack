import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { GraphRunStore } from './graph-runs.js';
import { GraphActionStore } from './graph-actions.js';
import { GraphAdmissionStore } from './graph-recovery.js';
import { GraphVerificationStore } from './graph-verification.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gvj-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb({ path: join(root, 'db') }); cleanups.push(() => db.close());
  const runs = new GraphRunStore(db); const actions = new GraphActionStore(db);
  const scope = { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' };
  let run = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'start', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'r' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'accept' },
      limits: { maxEpochs: 3, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 20, deadlineSeconds: 60, tokenReservationLimit: 100 } } },
    { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1', checkpointVersion: '1', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) }, 100);
  const fence = () => ({ scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation, expectedOwner: run.leaseOwner, expectedRevision: run.revision, now: 120 });
  run = runs.acquireLease({ ...fence(), owner: 'worker', leaseExpiresAt: 10000 });
  const store = new GraphVerificationStore(db, () => {});
  const reserve = () => { const result = actions.reserve(fence(), { epoch: 0, nodeId: 'tests', effectSlot: 'invoke', reservationTokens: 4,
    action: { kind: 'tests', candidateRevision: 'c'.repeat(40), commandSpecRef: 'accept', workspaceLeaseRef: 'lease' } }); run = result.run; return result.action; };
  return { db, runs, actions, store, fence, reserve, refresh: () => { run = runs.get(scope, run.graphRunId)!; } };
}
const binding = (f: ReturnType<typeof fixture>) => ({ scope: f.fence().scope, graphRunId: f.fence().graphRunId, specHash: f.fence().identity.specHash, epoch: 0, candidateRevision: 'c'.repeat(40), artifactDigest: 'd'.repeat(64), acceptanceRef: 'accept' });
const bundle = (f: ReturnType<typeof fixture>) => ({ schemaVersion: 1, binding: binding(f), evidenceDigest: 'e'.repeat(64), status: 'complete', branches: [] });
it('captures budget and admissions atomically and refuses a stale snapshot', () => {
  const f = fixture(); const old = f.store.snapshot(f.fence()); const action = f.reserve();
  expect(f.store.snapshot(f.fence())).toMatchObject({ budget: { actionStarts: 1, reservedTokens: '4' }, unresolvedActions: 1 });
  expect(() => f.store.commit(old, bundle(f), 125)).toThrow();
  new GraphAdmissionStore(f.db).hold(action.effectKey, 125);
  expect(f.store.snapshot(f.fence()).pendingAdmissions).toBe(1);
});
it('requires resolved effects and released admissions before publishing a join', () => {
  const f = fixture(); const action = f.reserve();
  expect(() => f.store.commit(f.store.snapshot(f.fence()), bundle(f), 125)).toThrow(/UNRESOLVED/);
  f.actions.markRunning(f.fence(), action.effectKey, 'execution'); f.refresh();
  const done = f.actions.recordOutcome(f.fence(), action.effectKey, { state: 'confirmed', evidenceRef: 'tests', actualTokens: 0,
    result: { schemaVersion: 1, kind: 'tests', candidateRevision: 'c'.repeat(40), passed: true, evidenceDigest: 'a'.repeat(64), evidenceRefs: ['tests'] } });
  f.refresh(); new GraphAdmissionStore(f.db).hold(done.action.effectKey, 125);
  expect(() => f.store.commit(f.store.snapshot(f.fence()), bundle(f), 130)).toThrow(/ADMISSION/);
});
it('publishes one immutable join and replays an identical result after lost ACK', () => {
  const f = fixture(); const first = f.store.commit(f.store.snapshot(f.fence()), bundle(f), 125); f.refresh();
  expect(first.created).toBe(true); expect(first.record.receiptRef).toMatch(/^graph-join:/);
  const replay = f.store.commit(f.store.snapshot({ ...f.fence(), now: 130 }), bundle(f), 130);
  expect(replay.created).toBe(false); expect(replay.record).toEqual(first.record);
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_verification_joins').get()).toEqual({ n: 1 });
  expect(() => f.db.prepare('DELETE FROM graph_verification_joins').run()).toThrow(/immutable/);
  expect(() => f.db.prepare("UPDATE graph_verification_joins SET bundle_json='{}'").run()).toThrow(/immutable/);
});
it('requires a fresh synchronous host verifier and rejects a changed publication', () => {
  const f = fixture(); const rejected = new GraphVerificationStore(f.db, () => { throw Error('evidence tampered'); });
  expect(() => rejected.commit(rejected.snapshot(f.fence()), bundle(f), 125)).toThrow('evidence tampered');
  const asyncVerifier = new GraphVerificationStore(f.db, async () => {});
  expect(() => asyncVerifier.commit(asyncVerifier.snapshot(f.fence()), bundle(f), 125)).toThrow(/synchronous/);
  f.store.commit(f.store.snapshot(f.fence()), bundle(f), 125); f.refresh();
  expect(() => f.store.commit(f.store.snapshot({ ...f.fence(), now: 130 }), { ...bundle(f), evidenceDigest: 'f'.repeat(64) }, 130)).toThrow(/CONFLICT/);
});
it('detects release-only changes even when run revision stays the same', () => {
  const f = fixture(); const action = f.reserve();
  f.actions.markRunning(f.fence(), action.effectKey, 'execution'); f.refresh();
  f.actions.recordOutcome(f.fence(), action.effectKey, { state: 'confirmed', evidenceRef: 'tests', actualTokens: 0,
    result: { schemaVersion: 1, kind: 'tests', candidateRevision: 'c'.repeat(40), passed: true, evidenceDigest: 'a'.repeat(64), evidenceRefs: ['tests'] } }); f.refresh();
  const admissions = new GraphAdmissionStore(f.db); admissions.hold(action.effectKey, 125);
  const before = f.store.snapshot(f.fence()); admissions.released(action.effectKey, 126);
  const after = f.store.snapshot(f.fence());
  expect(after.run.revision).toBe(before.run.revision); expect(after.digest).not.toBe(before.digest);
  expect(() => f.store.commit(before, bundle(f), 130)).toThrow('VERIFICATION_SNAPSHOT_CHANGED');
  expect(f.store.commit(after, bundle(f), 130).created).toBe(true);
});
