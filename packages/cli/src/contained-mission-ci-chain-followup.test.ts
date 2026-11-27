import { expect, it, vi } from 'vitest';
import { classifyFollowup, computeFollowupStats, FOLLOWUP_WINDOW_MS, type FollowupReadPort, type LaterCommit } from './contained-mission-ci-chain-followup.js';

const chain = { mission_id: 'root', repository: 'acme/app', pr: 12, merge_commit_sha: 'abc123', merged_at_ms: 10 };
const until = chain.merged_at_ms + FOLLOWUP_WINDOW_MS;
const signal = new AbortController().signal;
const files = ['src/a'];
function commit(message: string, changes = files, time = 11, sha = 'commit'): LaterCommit {
  return { message, files: changes, committed_at_ms: time, sha };
}
function reads(later: readonly LaterCommit[] = []) {
  return { mergedFiles: vi.fn(async () => ({ files, merge_committed_at_ms: chain.merged_at_ms })), laterCommits: vi.fn(async () => later) };
}

it.each([
  [commit('Revert\nThis reverts commit abc123.'), 'reverted'],
  [commit('Reverts acme/app#12'), 'reverted'],
  [commit('Reverts acme/app#123 then Reverts acme/app#12.'), 'reverted'],
  [commit('Reverts acme/app#123'), 'clean'],
  [commit('HotFix(api)!: repair'), 'hot_fixed'],
  [commit('fix: repair', ['src/b']), 'clean'],
  [commit('chore: message\nfix: repair'), 'clean'],
  [commit('fix: late', files, until + 1), 'clean'],
  [commit('fix: same time', files, chain.merged_at_ms), 'clean'],
  [commit('fix: at deadline', files, until), 'hot_fixed'],
] as const)('classifies %j as %s', async (later, verdict) => {
  const port = reads([later]);
  const result = await computeFollowupStats([chain], port, until, signal);
  expect(port.mergedFiles).toHaveBeenCalledWith(chain, signal);
  expect(port.laterCommits).toHaveBeenCalledWith(chain, chain.merged_at_ms, until, signal);
  expect(classifyFollowup(chain, files, [later])).toBe(verdict);
  expect(result).toMatchObject({ merged: 1, eligible: 1, [verdict]: 1, rate: verdict === 'clean' ? 0 : 1 });
  expect(result.rows).toEqual([{ mission_id: 'root', verdict, ...(verdict === 'clean' ? {} : { by: later.sha }) }]);
});

it('prefers a revert over an earlier fix and resolves simultaneous reverts by SHA', async () => {
  const port = reads([commit('Reverts acme/app#12', files, 15, 'z'), commit('fix: first', files, 11, 'f'),
    commit('Reverts acme/app#12', files, 15, 'a')]);
  expect((await computeFollowupStats([chain], port, until, signal)).rows).toEqual([{ mission_id: 'root', verdict: 'reverted', by: 'a' }]);
});

it('skips reads for pending chains and leaves an empty denominator unknown', async () => {
  const port = reads();
  expect(await computeFollowupStats([], port, until, signal)).toMatchObject({ merged: 0, eligible: 0, rate: null, rows: [] });
  expect(await computeFollowupStats([chain], port, until - 1, signal)).toMatchObject({
    merged: 1, pending: 1, eligible: 0, rate: null, rows: [{ mission_id: 'root', verdict: 'pending' }],
  });
  expect(port.mergedFiles).not.toHaveBeenCalled();
  expect(port.laterCommits).not.toHaveBeenCalled();
});

it.each(['mergedFiles', 'laterCommits'] as const)('excludes incomplete and failed %s reads', async method => {
  for (const read of [async () => null, async () => { throw Error('read failed'); }]) {
    const port: FollowupReadPort = { ...reads(), [method]: read };
    expect(await computeFollowupStats([chain], port, until, signal)).toMatchObject({
      merged: 1, unknown: 1, eligible: 0, rate: null, rows: [{ mission_id: 'root', verdict: 'unknown' }],
    });
  }
});

it('propagates cancellation during a port read', async () => {
  const controller = new AbortController();
  const reason = Error('cancelled');
  const port = { ...reads(), mergedFiles: async () => { controller.abort(reason); throw reason; } };
  await expect(computeFollowupStats([chain], port, until, controller.signal)).rejects.toBe(reason);
  expect(port.laterCommits).not.toHaveBeenCalled();
});

it('excludes the merge SHA even when its timestamp is inside the window', () => {
  expect(classifyFollowup(chain, files, [commit('Reverts acme/app#12', files, 11, chain.merge_commit_sha)])).toBe('clean');
});

it('starts at the observation when the commit timestamp is later', async () => {
  const port = { ...reads([commit('fix: repair')]), mergedFiles: async () => ({ files, merge_committed_at_ms: 15 }) };
  expect(await computeFollowupStats([chain], port, until, signal)).toMatchObject({ hot_fixed: 1 });
  expect(port.laterCommits).toHaveBeenCalledWith(chain, chain.merged_at_ms, until, signal);
});
