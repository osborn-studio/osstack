import { HostProcessStore } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import { dispatched, setup } from './contained-mission-revision.testkit.js';
import { createRevisionReceiptRecovery, type RevisionReceiptDeps } from './contained-mission-revision-publication.js';

const oldHead = '1'.repeat(40);
const newHead = '2'.repeat(40);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Use the real Mission FSM, signed dispatch, SQLite stores and stopped W13 journal.
// Only remote facts are supplied locally. Recovery has no runner or App writer.
async function pendingReceipt() {
  const f = setup({ head: oldHead });
  const { child_mission_id: childId } = await dispatched(f);
  const { missions, chains } = f.rig;
  let child = missions.get(childId);
  const step = (to: Parameters<typeof missions.transition>[1]['to'], extra: Record<string, unknown> = {}) => {
    child = missions.transition(childId, { if_revision: child.revision, to,
      event: { kind: `to_${to}`, payload: {} }, ...extra }, ++f.clock.now);
  };
  step('workspace_ready'); step('executing', { expected_head: oldHead });
  child = missions.recordStopEvidence(childId, child.revision, { stop_proof: 'test' }, ++f.clock.now);
  step('candidate_ready', { candidate: { head: newHead, tree: '3'.repeat(40), diff_digest: '4'.repeat(64) } });
  step('verifying');
  child = missions.recordStopEvidence(childId, child.revision, { stop_proof: 'test' }, ++f.clock.now);
  missions.record(childId, 'verify_receipt', { candidate: newHead, exit_code: 0, evidence: 'verified', cancelled: false }, ++f.clock.now);
  missions.record(childId, 'candidate_committed', { head_commit: newHead, tier: 'T0', chain_tier: 'T0' }, ++f.clock.now);
  step('verified'); step('revalidating'); step('delivering');
  const chain = chains.get(f.chain.chain_id);
  const { intent } = chains.recordIntent(chain.chain_id, chain.revision, { kind: 'push', branch: chain.branch,
    expected_old_head: oldHead, new_head: newHead, expected_base_sha: chain.published_base, child_mission_id: childId }, ++f.clock.now);
  chains.appendEvent(chain.chain_id, 'push_range', { intent_id: intent.intent_id, commits: [newHead] }, ++f.clock.now);
  const journal = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => ++f.clock.now });
  const opId = 'hp_recoveryboundaries';
  journal.launching({ op_id: opId, mission_id: childId, kind: 'git_push', remote_target: 'o/r#refs/heads/topic',
    local_target: `${f.childSpec(childId).worktree_path}#refs/heads/topic`, intent_id: intent.intent_id,
    argv_digest: '5'.repeat(64), boot_id: 'test', marker: { path: `${f.rig.root}/marker`, dev: '1', ino: '1' } });
  journal.registered(opId, { pid: 12345, pgid: 12345, leader_start: 'test' });
  journal.release(opId, () => {});
  journal.stopped(opId, { proof: 'group_empty+marker_unheld', detail: {}, exit_code: 0 });
  const deps: RevisionReceiptDeps = {
    chains, missions, now: () => ++f.clock.now, checkEnabled: true,
    host: { recordForIntent: id => id === intent.intent_id ? journal.get(opId) : undefined },
    remoteHead: async () => newHead, localGit: async () => ({ stdout: '', exitCode: 0 }),
    compare: async () => [newHead],
    readPr: async () => ({ state: 'OPEN', repository: 'o/r', headRefName: 'topic', headRefOid: newHead,
      baseRefName: 'main', baseRefOid: chain.published_base, url: 'https://example.invalid/pull/7' }),
  };
  const snapshot = () => ({
    intent: chains.getIntent(intent.intent_id).state,
    chain: chains.get(chain.chain_id).state,
    child: missions.get(childId).state,
    head: chains.get(chain.chain_id).published_head,
    published: chains.events(chain.chain_id).filter(event => event.kind === 'round_published').length,
  });
  return { deps, snapshot };
}

const confirmed = { intent: 'confirmed', chain: 'awaiting_review', child: 'pr_opened', head: newHead, published: 1 };

describe('receipt recovery concurrency boundaries', () => {
  it.each(['matching', 'missing'] as const)('preserves a completed receipt when a concurrent %s read returns late', async result => {
    const f = await pendingReceipt();
    const entered = deferred<void>();
    const lateHead = deferred<string | null>();
    // A captures the pending row, then waits at the remote boundary. B confirms it.
    const slow = createRevisionReceiptRecovery({ ...f.deps, remoteHead: async () => {
      entered.resolve(); return lateHead.promise;
    } }).recoverPendingReceipts();
    await entered.promise;
    let failure: unknown;
    try {
      await createRevisionReceiptRecovery(f.deps).recoverPendingReceipts();
      expect(f.snapshot()).toEqual(confirmed);
    } finally {
      lateHead.resolve(result === 'matching' ? newHead : null);
      try { await slow; } catch (error) { failure = error; }
    }
    // Check durable state even when recovery rejects. Terminal guards must hold.
    expect(f.snapshot()).toEqual(confirmed);
    expect(failure).toBeUndefined();
  });

  it('leaves a concurrent successful recovery unchanged after an aborted read returns late', async () => {
    const f = await pendingReceipt();
    const entered = deferred<void>();
    const lateHead = deferred<string | null>();
    const controller = new AbortController();
    const reason = Error('recovery_invocation_cancelled');
    const slow = createRevisionReceiptRecovery({ ...f.deps, remoteHead: async () => {
      entered.resolve(); return lateHead.promise;
    } }).recoverPendingReceipts({ signal: controller.signal });
    const rejected = expect(slow).rejects.toBe(reason);
    await entered.promise;
    try {
      controller.abort(reason);
      await createRevisionReceiptRecovery(f.deps).recoverPendingReceipts();
      expect(f.snapshot()).toEqual(confirmed);
    } finally {
      lateHead.resolve(null);
      await rejected;
    }
    expect(f.snapshot()).toEqual(confirmed);
    expect(await createRevisionReceiptRecovery(f.deps).recoverPendingReceipts()).toEqual({ visited: 0, complete: true });
  });
});
