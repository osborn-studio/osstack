import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { GraphResult } from '@osstack/protocol';
import { openDb } from './db.js';
import { GraphRunStore } from './graph-runs.js';
import { GraphActionStore } from './graph-actions.js';
import { GraphAdmissionStore } from './graph-recovery.js';
import { GraphDeliveryEpochStore, GraphVerificationStore } from './graph-verification.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const cost = { actions: 7, tokens: 40 };
function fixture(compilerVersion = '1') {
  const root = mkdtempSync(join(tmpdir(), 'g21-epoch-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb({ path: join(root, 'control.sqlite') }); cleanups.push(() => db.close());
  const runs = new GraphRunStore(db); const actions = new GraphActionStore(db);
  const scope = { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' };
  let run = runs.create({ schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'start', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'request' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'accept' },
      limits: { maxEpochs: 3, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 20, deadlineSeconds: 60, tokenReservationLimit: 100 } } },
    { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1', checkpointVersion: '1', templateVersion: '1', registryVersion: '1', compilerVersion, schemaVersion: '1', compiledProgramDigest: 'b'.repeat(64) }, 100);
  let now = 120;
  const refresh = () => { run = runs.get(scope, run.graphRunId)!; };
  const fence = () => ({ scope, graphRunId: run.graphRunId, identity: run.identity, expectedGeneration: run.generation, expectedOwner: run.leaseOwner, expectedRevision: run.revision, now });
  run = runs.acquireLease({ ...fence(), owner: 'host', leaseExpiresAt: 100_000 });
  run = runs.project({ ...fence(), status: 'running' });
  const epochs = new GraphDeliveryEpochStore(db);
  const activate = (epoch = 0, joinRef?: string) => { run = epochs.activate(fence(), epoch, cost, joinRef); return run; };
  const reserve = (kind: 'review' | 'tests', epoch = 0) => {
    const action = kind === 'review' ? { kind, candidateRevision: 'c'.repeat(40), acceptanceRef: 'accept', workspaceLeaseRef: 'review' }
      : { kind, candidateRevision: 'c'.repeat(40), commandSpecRef: 'accept', workspaceLeaseRef: 'tests' };
    const reserved = actions.reserve(fence(), { epoch, nodeId: `e${epoch}.${kind}`, effectSlot: 'main', reservationTokens: 10, action });
    run = reserved.run; return reserved.action;
  };
  const publish = (negative = true) => {
    const branches = (['review', 'tests'] as const).map(kind => {
      const action = reserve(kind); run = actions.markRunning(fence(), action.effectKey, kind).run;
      const result: GraphResult = { schemaVersion: 1, candidateRevision: 'c'.repeat(40), evidenceRefs: [kind], evidenceDigest: 'd'.repeat(64),
        ...(kind === 'review' ? { kind, verdict: negative ? 'changes_requested' : 'accept' } : { kind, passed: true }) };
      run = actions.recordOutcome(fence(), action.effectKey, { state: 'confirmed', evidenceRef: kind, actualTokens: 10, result }).run;
      return { kind, nodeId: action.effect.nodeId, effectSlot: 'main', logicalAttempt: 1, state: 'confirmed', effectKey: action.effectKey, result };
    });
    // Core storage boundary test: the CLI integration separately exercises real artifact attestation.
    const store = new GraphVerificationStore(db, () => {});
    const record = store.commit(store.snapshot(fence()), { schemaVersion: 1, binding: { scope, graphRunId: run.graphRunId, specHash: run.identity.specHash,
      epoch: 0, candidateRevision: 'c'.repeat(40), artifactDigest: 'e'.repeat(64), acceptanceRef: 'accept' }, status: 'complete', branches, evidenceDigest: 'f'.repeat(64) }, now);
    run = record.run; return { receiptRef: record.record.receiptRef, branches };
  };
  return { db, runs, actions, epochs, fence, refresh, activate, reserve, publish, tick: (time: number) => { now = time; } };
}

it('persists one initial permit, preserves the original budget identity, and rejects stale fences', () => {
  const f = fixture(); const prior = f.fence(); const first = f.activate();
  expect(f.activate()).toEqual(first);
  expect(first.createdAt).toBe(100); expect(first.spec!.limits.tokenReservationLimit).toBe(100);
  expect(() => f.epochs.activate(prior, 0, cost)).toThrow(/REVISION/);
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_actions').get()).toEqual({ n: 0 });
  expect(() => f.db.prepare('DELETE FROM graph_delivery_epochs').run()).toThrow(/immutable/);
});

it.each(['code-delivery-functional-v4', 'code-delivery-functional-v999'])('requires initial epoch authority across compiler family versions: %s', version => {
  const f = fixture(version);
  expect(() => f.reserve('review')).toThrow('DELIVERY_EPOCH_PERMIT_REQUIRED');
  f.activate(); expect(f.reserve('review').state).toBe('intent');
});

it('requires an immediately preceding negative host join and fences every old-epoch admission', () => {
  const f = fixture(); f.activate();
  expect(() => f.activate(1, 'worker-claimed-join')).toThrow(/JOIN/);
  const publication = f.publish(); f.activate(1, publication.receiptRef);
  expect(() => f.reserve('tests', 0)).toThrow(/EPOCH/);
  expect(() => f.activate(2, publication.receiptRef)).toThrow(/JOIN/);
  expect(f.db.prepare('SELECT epoch FROM graph_delivery_epochs ORDER BY epoch').all()).toEqual([{ epoch: 0 }, { epoch: 1 }]);
});

it('does not authorize repair after a fully accepted candidate', () => {
  const f = fixture(); f.activate(); const publication = f.publish(false);
  expect(() => f.activate(1, publication.receiptRef)).toThrow(/NEGATIVE_JOIN/);
});

it.each(['unresolved', 'admission', 'deadline', 'budget', 'cancel'] as const)('refuses epoch activation at %s boundary', reason => {
  const f = fixture(); f.activate(); const publication = f.publish();
  if (reason === 'unresolved') f.actions.reserve(f.fence(), { epoch: 0, nodeId: 'another', effectSlot: 'main', reservationTokens: 0,
    action: { kind: 'workspace_create', repositoryRef: 'repo', baseRevision: 'a'.repeat(40) } });
  if (reason === 'admission') new GraphAdmissionStore(f.db).hold(publication.branches[0]!.effectKey, 120);
  if (reason === 'deadline') f.tick(60_100);
  if (reason === 'cancel') f.runs.project({ ...f.fence(), status: 'cancel_pending' });
  f.refresh();
  expect(() => f.epochs.activate(f.fence(), 1, reason === 'budget' ? { actions: 19, tokens: 40 } : cost, publication.receiptRef)).toThrow();
  expect(f.db.prepare('SELECT count(*) AS n FROM graph_delivery_epochs').get()).toEqual({ n: 1 });
});
