import { describe, expect, it, vi } from 'vitest';
import { HostProcessStore } from '@osstack/core';
import { LiveReconciler, syncLiveChild } from './contained-mission-bridge-live.js';
import { BridgeReadLimiter } from './contained-mission-bridge-read-limiter.js';
import { StoppedChainScanService } from './contained-mission-bridge-stopped-scan.js';
import { dispatched, setup } from './contained-mission-revision.testkit.js';
import { oid } from './contained-mission-bridge-shadow.testkit.js';

function service(f = setup()) {
  const isBusy = vi.fn(() => false);
  const cancelChild = vi.fn(async () => {});
  const readPr = vi.fn(f.deps.readPr);
  const headIsDescendant = vi.fn(async () => true);
  const live = new LiveReconciler({
    dispatch: { ...f.deps, readPr }, isBusy, cancelChild,
    headIsDescendant, log: () => {},
  });
  return { f, live, isBusy, cancelChild, readPr, headIsDescendant };
}

describe('live reconciler', () => {
  it.each(['reconciliation_incomplete', 'external_write', 'stale'] as const)('blocks dispatch when publication coverage is %s', async verdict => {
    const f = setup();
    const audit = vi.fn(async () => verdict);
    const live = new LiveReconciler({ dispatch: f.deps, isBusy: () => false, cancelChild: async () => {},
      headIsDescendant: async () => true, verifyLedger: audit, log: () => {} });
    await live.scan();
    expect(audit).toHaveBeenCalledOnce(); expect(f.children()).toHaveLength(0);
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe(verdict === 'external_write' ? 'external_write' : null);
    await live.stop();
  });
  it('dispatches one child for a qualified review and never dispatches the same head twice', async () => {
    const { f, live } = service();
    await live.scan();
    expect(f.children()).toHaveLength(1);
    f.clock.now += 60_000;
    await live.scan();
    expect(f.children()).toHaveLength(1);
  });

  it('stops an in-flight chain on a base change and requests child cancellation', async () => {
    const f = setup();
    const child = await dispatched(f);
    const { live, cancelChild } = service(f);
    f.pr.base_sha = oid('b');
    await live.scan();
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe('base_changed');
    expect(cancelChild).toHaveBeenCalledWith(expect.objectContaining({ current_mission_id: child.child_mission_id }), 'base_changed', expect.any(AbortSignal));
  });

  it.each([false, true])('closes a PR without fetching ancestry (halted child: %s)', async halted => {
    const f = setup();
    const child = await dispatched(f);
    if (halted) f.rig.db.prepare("UPDATE engineering_contained_missions SET state='awaiting_decision',revision=revision+1 WHERE mission_id=?").run(child.child_mission_id);
    const { live, headIsDescendant, cancelChild } = service(f);
    f.pr.state = 'CLOSED';
    f.pr.head = oid('f');
    headIsDescendant.mockRejectedValue(Error('branch_deleted'));
    await live.scan();
    expect(f.rig.chains.get(f.chain.chain_id).state).toBe('closed');
    expect(headIsDescendant).not.toHaveBeenCalled();
    expect(cancelChild).toHaveBeenCalled();
  });

  it('does not mutate the ledger on a failed read and backs off before another read', async () => {
    const { f, live, readPr, isBusy } = service();
    const before = f.rig.db.serialize();
    readPr.mockRejectedValueOnce(new Error('private response'));
    await live.scan();
    expect(f.rig.db.serialize()).toEqual(before);
    expect(isBusy).not.toHaveBeenCalled();
    f.clock.now += 30_000;
    await live.scan();
    expect(readPr).toHaveBeenCalledTimes(1);
    f.clock.now += 30_000;
    await live.scan();
    expect(f.children()).toHaveLength(1);
  });

  it('does no work when disabled', async () => {
    const { f, live, readPr, isBusy } = service();
    f.flags.enabled = false;
    await live.scan();
    expect(readPr).not.toHaveBeenCalled();
    expect(isBusy).not.toHaveBeenCalled();
  });

  it('ignores a read completed after shutdown', async () => {
    const { f, live, readPr } = service();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    readPr.mockImplementationOnce(async ref => { await gate; return f.deps.readPr(ref); });
    const scan = live.scan();
    const stop = live.stop();
    release();
    await Promise.all([scan, stop]);
    expect(f.children()).toHaveLength(0);
  });

  it('refuses a stale observation when the chain changes during a read', async () => {
    const { f, live, readPr } = service();
    readPr.mockImplementationOnce(async ref => {
      f.rig.chains.stopLive(f.chain.chain_id, f.chain.revision, 'grant_expired', f.clock.now);
      return f.deps.readPr(ref);
    });
    await live.scan();
    expect(f.children()).toHaveLength(0);
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe('grant_expired');
  });

  it('requires a stable second read before marking ready', async () => {
    const { f, live, readPr } = service();
    f.pr.reviews[0]!.state = 'APPROVED';
    readPr.mockImplementationOnce(f.deps.readPr).mockImplementationOnce(async ref => {
      f.pr.reviews[0]!.state = 'DISMISSED';
      return f.deps.readPr(ref);
    });
    await live.scan();
    expect(f.rig.chains.get(f.chain.chain_id).state).toBe('awaiting_review');
  });

  it('coalesces concurrent scans', async () => {
    const { f, live } = service();
    const first = live.scan();
    expect(live.scan()).toBe(first);
    await first;
    expect(f.children()).toHaveLength(1);
  });

  it('refuses readiness if the PR branch changes with the same head during the second read', async () => {
    const { f, live, readPr } = service();
    f.pr.reviews[0]!.state = 'APPROVED';
    readPr.mockImplementationOnce(f.deps.readPr).mockImplementationOnce(async ref => {
      const read = await f.deps.readPr(ref);
      return read.complete ? { ...read, pr: { ...read.pr, headRefName: 'other-branch' } } : read;
    });
    await live.scan();
    expect(f.rig.chains.get(f.chain.chain_id).state).toBe('awaiting_review');
  });

  it('keeps a halted child resumable and never stops it during a human decision', async () => {
    const f = setup();
    const child = await dispatched(f);
    f.rig.db.prepare("UPDATE engineering_contained_missions SET state='awaiting_decision',revision=revision+1 WHERE mission_id=?").run(child.child_mission_id);
    syncLiveChild(f.deps, f.chain.chain_id, () => true);
    expect(f.rig.chains.get(f.chain.chain_id).state).toBe('revising');
    syncLiveChild(f.deps, f.chain.chain_id, () => false);
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe('child_halted');
    expect(f.reservations()[0]!.state).toBe('dispatched');
    expect(f.rig.missions.claim(child.child_mission_id).state).toBe('active');
  });

  it('atomically restops an abandoned child, voids its reservation and releases its claim', async () => {
    const f = setup();
    const child = await dispatched(f);
    f.rig.chains.stopLive(f.chain.chain_id, child.chain.revision, 'child_halted', f.clock.now);
    f.rig.db.prepare("UPDATE engineering_contained_missions SET state='abandoned',revision=revision+1 WHERE mission_id=?").run(child.child_mission_id);
    const { live } = service(f);
    await live.scan();
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe('child_cancelled');
    expect(f.reservations()[0]!.state).toBe('void');
    expect(f.rig.missions.claim(child.child_mission_id).state).toBe('released');
  });

  it('retries a lost cancellation from durable stopped state after restart', async () => {
    const f = setup();
    await dispatched(f);
    const first = service(f);
    first.cancelChild.mockRejectedValue(new Error('unavailable'));
    f.pr.base_sha = oid('b');
    await first.live.scan();
    const second = service(f);
    await second.live.scan();
    expect(second.cancelChild).toHaveBeenCalledWith(expect.objectContaining({ chain_id: f.chain.chain_id }), 'base_changed', expect.any(AbortSignal));
  });

  it('retries cancellation for a legacy closed row whose stop reason still says child_halted', async () => {
    const f = setup();
    const child = await dispatched(f);
    f.rig.chains.stopLive(f.chain.chain_id, child.chain.revision, 'child_halted', f.clock.now);
    // Seed the legacy close transaction directly; newer stores must not rewrite immutable closed rows.
    f.rig.db.prepare("UPDATE engineering_revision_chains SET state='closed',revision=revision+1 WHERE chain_id=?")
      .run(f.chain.chain_id);
    f.rig.chains.appendEvent(f.chain.chain_id, 'transition', { from: 'awaiting_decision', to: 'closed', reason: 'pr_closed' }, f.clock.now);
    const first = service(f);
    first.cancelChild.mockRejectedValueOnce(Error('temporary_stop_failure'));
    await first.live.scan();
    expect(first.cancelChild).toHaveBeenCalledWith(expect.objectContaining({ chain_id: f.chain.chain_id }), 'pr_closed', expect.any(AbortSignal));
    const restarted = service(f);
    await restarted.live.scan();
    expect(restarted.cancelChild).toHaveBeenCalledWith(expect.objectContaining({ chain_id: f.chain.chain_id }), 'pr_closed', expect.any(AbortSignal));
  });

  it.each(['abandon', 'takeover'])('retries a human %s cancellation after restart', async reason => {
    const f = setup();
    const child = await dispatched(f);
    f.rig.chains.closeLive(f.chain.chain_id, child.chain.revision, reason, f.clock.now);
    const first = service(f);
    first.cancelChild.mockRejectedValueOnce(Error('temporary_stop_failure'));
    await first.live.scan();
    expect(first.cancelChild).toHaveBeenCalledWith(expect.objectContaining({ chain_id: f.chain.chain_id }), reason, expect.any(AbortSignal));
    const restarted = service(f);
    await restarted.live.scan();
    expect(restarted.cancelChild).toHaveBeenCalledWith(expect.objectContaining({ chain_id: f.chain.chain_id }), reason, expect.any(AbortSignal));
  });

  it.each(['no_record', 'registered', 'released', 'uncertain'] as const)('preserves push receipts and chooses the stop reason from %s evidence', async evidence => {
    const f = setup();
    const child = await dispatched(f);
    const recorded = f.rig.chains.recordIntent(f.chain.chain_id, child.chain.revision, { kind: 'push', branch: f.chain.branch,
      expected_old_head: f.chain.published_head, expected_base_sha: f.chain.published_base, new_head: oid('2'), child_mission_id: child.child_mission_id }, f.clock.now);
    if (evidence === 'registered' || evidence === 'released') {
      const journal = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => ++f.clock.now });
      journal.launching({ op_id: 'hp_livecycle', mission_id: child.child_mission_id, kind: 'git_push',
        remote_target: 'o/r#refs/heads/topic', local_target: `${f.rig.root}/repo#refs/heads/topic`, intent_id: recorded.intent.intent_id,
        argv_digest: '5'.repeat(64), boot_id: 'test', marker: { path: `${f.rig.root}/marker`, dev: '1', ino: '1' } });
      journal.registered('hp_livecycle', { pid: 12345, pgid: 12345, leader_start: 'test' });
      if (evidence === 'released') journal.release('hp_livecycle', () => {});
    }
    if (evidence === 'uncertain') f.rig.chains.settleIntent(recorded.intent.intent_id, 'uncertain', f.clock.now);
    f.rig.db.prepare("UPDATE engineering_contained_missions SET state='awaiting_decision',revision=revision+1 WHERE mission_id=?").run(child.child_mission_id);
    const before = f.rig.chains.getIntent(recorded.intent.intent_id);
    syncLiveChild(f.deps, f.chain.chain_id, () => false);
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe(evidence === 'released' || evidence === 'uncertain' ? 'intent_uncertain' : 'child_halted');
    expect(f.rig.chains.getIntent(recorded.intent.intent_id)).toEqual(before);
    expect(f.reservations()[0]!.state).toBe('dispatched');
    expect(f.rig.missions.claim(child.child_mission_id).state).toBe('active');
  });

  it('shutdown returns even when a legacy read cannot be aborted', async () => {
    const { live, readPr } = service();
    readPr.mockImplementation(() => new Promise(() => {}));
    const scan = live.scan();
    await Promise.resolve();
    await live.stop();
    await scan;
  });

  it('cleans a closed chain terminal child without reading GitHub', async () => {
    const f = setup();
    const child = await dispatched(f);
    f.rig.chains.closeLive(f.chain.chain_id, child.chain.revision, 'pr_closed', f.clock.now);
    f.rig.db.prepare("UPDATE engineering_contained_missions SET state='cancelled',revision=revision+1 WHERE mission_id=?").run(child.child_mission_id);
    const { live, readPr } = service(f);
    await live.scan();
    expect(readPr).not.toHaveBeenCalled();
    expect(f.rig.missions.claim(child.child_mission_id).state).toBe('released');
  });

  it('keeps the claim and reservation while a terminal child has unproven work', async () => {
    const f = setup();
    const child = await dispatched(f);
    f.rig.db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(child.child_mission_id);
    syncLiveChild(f.deps, f.chain.chain_id, () => false);
    expect(f.reservations()[0]!.state).toBe('dispatched');
    expect(f.rig.missions.claim(child.child_mission_id).state).toBe('active');
  });

  it('stops and cancels an in-flight child when the protected set changes', async () => {
    const f = setup();
    await dispatched(f);
    f.flags.protectedDigest = 'e'.repeat(64);
    const { live, cancelChild } = service(f);
    await live.scan();
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe('protected_set_changed');
    expect(cancelChild).toHaveBeenCalled();
  });

  it('limits each batch to ten chains and advances beyond an unreadable row', async () => {
    const { f, live, readPr } = service();
    f.pr.reviews = [];
    for (let n = 0; n < 12; n++) {
      const root = f.rig.seedMission({ pr_number: 10 + n, head: f.chain.published_head, base_head: f.chain.published_base, branch: 'topic' });
      f.rig.chains.createLiveChain({ root_mission_id: root, repository: 'o/r', pr_number: 10 + n, branch: 'topic', base_ref: 'main',
        published_head: f.chain.published_head, published_base: f.chain.published_base, trace_id: 't',
        grant: { ...f.grant, root_mission_id: root, pr_number: 10 + n } }, f.clock.now);
    }
    readPr.mockRejectedValueOnce(Error('unreadable'));
    await live.scan();
    expect(readPr).toHaveBeenCalledTimes(10);
    await live.scan();
    expect(readPr).toHaveBeenCalledTimes(13);
    await live.scan();
    expect(readPr).toHaveBeenCalledTimes(13);
  });
});

describe('shared live and stopped read scheduling', () => {
  it.each(['pr', 'ancestry'] as const)('keeps a cancelled %s transport exclusive when its chain becomes stopped', async transport => {
    const f = setup();
    const readLimiter = new BridgeReadLimiter();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (transport === 'ancestry') f.pr.head = oid('f');
    const liveRead = vi.fn(async () => { if (transport === 'pr') await gate; return f.deps.readPr({ owner: 'o', name: 'r', number: 7 }); });
    const ancestryRead = vi.fn(async () => { if (transport === 'ancestry') await gate; return true; });
    const live = new LiveReconciler({ dispatch: f.deps, readLimiter, readPr: liveRead,
      isBusy: () => false, cancelChild: async () => {}, headIsDescendant: ancestryRead, log: () => {} });
    const stoppedRead = vi.fn(async () => ({ complete: false, pr_state: 'OPEN' as const,
      head: f.chain.published_head, head_repository: 'o/r', head_ref: 'topic', base_sha: f.chain.published_base, base_ref: 'main' }));
    const stopped = new StoppedChainScanService({ chains: f.rig.chains, readLimiter, now: () => f.clock.now,
      enabled: () => true, missionState: () => 'failed', refreshPrincipal: () => f.principal,
      cancelChild: async () => {}, readPr: stoppedRead, log: () => {} });
    const scan = live.scan();
    await new Promise(resolve => setImmediate(resolve));
    expect(liveRead).toHaveBeenCalledTimes(1);
    if (transport === 'ancestry') expect(ancestryRead).toHaveBeenCalledTimes(1);
    f.rig.chains.stopLive(f.chain.chain_id, f.chain.revision, 'child_halted', f.clock.now);
    f.clock.now += 600_000;
    await live.stop();
    await scan;
    f.clock.now += 600_000; // Pass every cadence deadline while the underlying operation remains blocked.
    const before = f.rig.db.serialize();
    await stopped.scan();
    expect(stoppedRead).not.toHaveBeenCalled();
    expect(f.rig.db.serialize()).toEqual(before);
    release();
    await gate;
    await new Promise(resolve => setImmediate(resolve));
    f.clock.now += 600_000;
    await stopped.scan();
    await stopped.scan(); // The stopped cursor wraps through an empty page.
    expect(stoppedRead).toHaveBeenCalledTimes(1);
    await stopped.stop();
  });
});
