import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRig, oid } from './contained-mission-bridge-shadow.testkit.js';
import { compareBridgeLedgerRange, verifyBridgeLedger } from './contained-mission-bridge-ledger.js';
import { recoverBridgeLedgers } from './contained-mission-bridge-ledger.js';
import { HostProcessStore } from '@osstack/core';
import { setup as revisionFixture, dispatched } from './contained-mission-revision.testkit.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
function fixture() {
  const rig = createRig(); cleanup.push(() => rig.close());
  const root = rig.seedMission({ pr_number: 7, head: oid('2'), base_head: oid('a'), branch: 'topic',
    spec: { start_commit: oid('0'), worktree_path: '/isolated/worktree' } });
  const chain = rig.chains.createLiveChain({ root_mission_id: root, repository: 'o/r', pr_number: 7, branch: 'topic', base_ref: 'main',
    published_head: oid('2'), published_base: oid('a'), trace_id: 't', grant: { rounds: 2 } }, 100);
  const commits = [oid('1'), oid('2')];
  const baseline = () => {
    const intent = rig.chains.recordIntent(chain.chain_id, chain.revision, { kind: 'open_pr', branch: 'topic',
      expected_old_head: oid('0'), new_head: oid('2'), expected_base_sha: oid('a'),
      binding: { commit_count: 2, range_sha256: createHash('sha256').update(JSON.stringify(commits)).digest('hex') } }, 101).intent;
    rig.chains.appendEvent(chain.chain_id, 'push_range', { intent_id: intent.intent_id, commits }, 101);
    rig.chains.settleIntent(intent.intent_id, 'confirmed', 101);
    return intent;
  };
  const remoteHead = vi.fn(async () => oid('2'));
  const compare = vi.fn(async () => commits);
  const deps = { chains: rig.chains, missions: rig.missions, remoteHead, compare };
  const verify = () => verifyBridgeLedger(deps, rig.chains.get(chain.chain_id), new AbortController().signal);
  return { rig, chain, baseline, compare, remoteHead, verify };
}
describe('exact publication ledger reconciliation', () => {
  it('requires the confirmed baseline, its complete range and exact remote head', async () => {
    const f = fixture();
    expect(await f.verify()).toBe('external_write');
    f.baseline(); expect(await f.verify()).toBe('matched');
    f.compare.mockResolvedValue([oid('2')]); expect(await f.verify()).toBe('external_write');
    f.compare.mockResolvedValue([oid('2'), oid('1')]); expect(await f.verify()).toBe('external_write');
    f.remoteHead.mockResolvedValue(oid('3')); expect(await f.verify()).toBe('external_write');
  });
  it('refuses a corrupted recorded range even if the remote tip is unchanged', async () => {
    const f = fixture(); const intent = f.baseline();
    f.rig.chains.appendEvent(f.chain.chain_id, 'push_range', { intent_id: intent.intent_id, commits: [oid('2')] }, 102);
    expect(await f.verify()).toBe('external_write');
    expect(f.compare).not.toHaveBeenCalled();
  });
  it('does not turn a read outage or a stale ledger version into external-write evidence', async () => {
    const f = fixture(); f.baseline();
    f.compare.mockRejectedValueOnce(Error('offline')); await expect(f.verify()).rejects.toThrow('offline');
    f.compare.mockImplementationOnce(async () => {
      f.rig.chains.stopLive(f.chain.chain_id, f.chain.revision, 'grant_expired', 103);
      return [oid('1'), oid('2')];
    });
    expect(await f.verify()).toBe('stale');
  });
  it('pages the cumulative range beyond one revision and rejects missing pages', async () => {
    const commits = Array.from({ length: 101 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
    const exec = vi.fn(async (args: readonly string[]) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify({ total_commits: 101,
      commits: (args[1]!.endsWith('page=1') ? commits.slice(0, 100) : commits.slice(100)).map(sha => ({ sha })) }) }));
    expect(await compareBridgeLedgerRange('o/r', oid('0'), commits.at(-1)!, exec)).toEqual(commits);
    expect(exec).toHaveBeenCalledTimes(2);
    await expect(compareBridgeLedgerRange('o/r', oid('0'), oid('1'), async () => ({ exitCode: 0, stderr: '', stdout: '{"total_commits":2,"commits":[]}' }))).rejects.toThrow('bridge_ledger_range_incomplete');
  });
  it('defers released unsettled pushes before remote reads and preserves the stop reason', async () => {
    const f = revisionFixture(); const child = await dispatched(f);
    const chain = f.rig.chains.get(f.chain.chain_id);
    const intent = f.rig.chains.recordIntent(chain.chain_id, chain.revision, { kind: 'push', branch: 'topic',
      expected_old_head: oid('1'), new_head: oid('2'), expected_base_sha: oid('a'), child_mission_id: child.child_mission_id }, f.clock.now).intent;
    const journal = new HostProcessStore(f.rig.attention, f.rig.owner, { clock: () => f.clock.now });
    journal.launching({ op_id: 'hp_audit', mission_id: child.child_mission_id, kind: 'git_push', remote_target: 'o/r#refs/heads/topic', local_target: '/isolated/repo',
      intent_id: intent.intent_id, argv_digest: 'a'.repeat(64), boot_id: 'test', marker: { path: '/isolated/marker', dev: '1', ino: '1' } });
    journal.registered('hp_audit', { pid: 12345, pgid: 12345, leader_start: 'test' }); journal.release('hp_audit', () => {});
    f.rig.chains.settleIntent(intent.intent_id, 'uncertain', f.clock.now);
    const read = vi.fn(async () => { throw Error('unexpected_network'); });
    const deps = { chains: f.rig.chains, missions: f.rig.missions, remoteHead: read, compare: read, now: () => f.clock.now };
    expect(await verifyBridgeLedger(deps, f.rig.chains.get(chain.chain_id), new AbortController().signal)).toBe('reconciliation_incomplete');
    await recoverBridgeLedgers(deps, new AbortController().signal);
    expect(f.rig.chains.get(chain.chain_id).stop_reason).toBe('intent_uncertain'); expect(read).not.toHaveBeenCalled();
  });
  it('concatenates a confirmed root and revision range in ancestry order', async () => {
    const f = revisionFixture(); const child = await dispatched(f);
    let chain = f.rig.chains.get(f.chain.chain_id);
    const binding = (commits: string[]) => ({ commit_count: commits.length, range_sha256: createHash('sha256').update(JSON.stringify(commits)).digest('hex') });
    const baseline = f.rig.chains.recordIntent(chain.chain_id, chain.revision, { kind: 'open_pr', branch: 'topic',
      expected_old_head: oid('9'), new_head: oid('1'), expected_base_sha: oid('a'), binding: binding([oid('1')]) }, f.clock.now).intent;
    f.rig.chains.appendEvent(chain.chain_id, 'push_range', { intent_id: baseline.intent_id, commits: [oid('1')] }, f.clock.now);
    f.rig.chains.settleIntent(baseline.intent_id, 'confirmed', f.clock.now);
    const intent = f.rig.chains.recordIntent(chain.chain_id, chain.revision, { kind: 'push', branch: 'topic',
      expected_old_head: oid('1'), new_head: oid('3'), expected_base_sha: oid('a'), child_mission_id: child.child_mission_id,
      binding: binding([oid('2'), oid('3')]) }, f.clock.now).intent;
    f.rig.chains.appendEvent(chain.chain_id, 'push_range', { intent_id: intent.intent_id, commits: [oid('2'), oid('3')] }, f.clock.now);
    chain = f.rig.chains.settleIntent(intent.intent_id, 'confirmed', f.clock.now).chain;
    const compare = vi.fn(async () => [oid('1'), oid('2'), oid('3')]);
    const deps = { chains: f.rig.chains, missions: f.rig.missions, remoteHead: async () => oid('3'), compare };
    expect(await verifyBridgeLedger(deps, chain, new AbortController().signal)).toBe('matched');
    compare.mockResolvedValue([oid('1'), oid('3')]);
    expect(await verifyBridgeLedger(deps, chain, new AbortController().signal)).toBe('external_write');
  });
  it('stops both running and previously stopped chains on a proven history mismatch', async () => {
    const f = fixture(); f.baseline();
    f.rig.chains.stopLive(f.chain.chain_id, f.chain.revision, 'grant_expired', 105);
    f.compare.mockResolvedValue([oid('2')]);
    const cancel = vi.fn(async () => {});
    await recoverBridgeLedgers({ chains: f.rig.chains, missions: f.rig.missions, remoteHead: f.remoteHead, compare: f.compare, now: () => 106, cancelChild: cancel }, new AbortController().signal);
    expect(f.rig.chains.get(f.chain.chain_id).stop_reason).toBe('external_write');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
