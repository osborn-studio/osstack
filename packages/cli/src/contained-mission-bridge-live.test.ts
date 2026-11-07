import { describe, expect, it, vi } from 'vitest';
import { LiveReconciler, syncLiveChild } from './contained-mission-bridge-live.js';
import { dispatched, setup } from './contained-mission-revision.testkit.js';
import { oid } from './contained-mission-bridge-shadow.testkit.js';

function service(f = setup()) {
  const isBusy = vi.fn(() => false);
  const cancelChild = vi.fn(async () => {});
  const readPr = vi.fn(f.deps.readPr);
  const live = new LiveReconciler({
    dispatch: { ...f.deps, readPr }, isBusy, cancelChild,
    headIsDescendant: async () => true, log: () => {},
  });
  return { f, live, isBusy, cancelChild, readPr };
}

describe('live reconciler', () => {
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
