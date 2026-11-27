import { expect, it, vi } from 'vitest';
import { FOLLOWUP_WINDOW_MS, type FollowupReadPort } from './contained-mission-ci-chain-followup.js';
import { assertFollowupPathAllowed, createFollowupReadPort, FollowupReadDenied, measureCiChainFollowup } from './contained-mission-ci-chain-followup-reader.js';

const repository = 'acme/app.v2';
const base = `repos/${repository}`;
const sha = 'a'.repeat(40);
const fixSha = 'b'.repeat(40);
const chain = { mission_id: 'root', repository, pr: 7, merge_commit_sha: sha, merged_at_ms: 3500 };
const signal = new AbortController().signal;
const branch = 'stable%2Fv2';
const compare = `${base}/compare/${branch}...${sha}`;
const files = (id: string, n = 1) => `${base}/commits/${id}?per_page=100&page=${n}`;
const list = (n = 1) => `${base}/commits?sha=${branch}&since=1970-01-01T00:00:01Z&until=1970-01-08T00:00:04Z&per_page=100&page=${n}`;
const commit = (sha: string, message: string) => ({ sha, commit: { message, committer: { date: new Date(2000).toISOString() } } });
const filePage = (...files: { filename: string; previous_filename?: string }[]) => ({
  commit: { committer: { date: new Date(1250).toISOString() } }, files,
});

it.each([base, compare, files(sha), list(2)])('allows scoped GET %s', path => {
  expect(() => assertFollowupPathAllowed(path, repository)).not.toThrow();
});
it.each([
  ['repos/acme/appXv2', repository], [base + '/', repository], [base + '/pulls', repository],
  ['repos/../r', '../r'], ['repos/o/.', 'o/.'], ['repos/o/r/s', 'o/r/s'],
  [compare.replace(branch, '..'), repository], [list().replace(branch, 'x%2F.%2Fy'), repository],
  [compare.replace(branch, 'x/y'), repository], [compare.replace(sha, sha.slice(1)), repository],
  [files(sha, 0), repository], [list() + '&extra=true', repository], [list().replace('Z', '.000Z'), repository],
  [list().replace(branch, 'a'.repeat(512)), repository], ['POST ' + base, repository],
])('denies %s for %s', (path, repo) => {
  expect(() => assertFollowupPathAllowed(path, repo)).toThrow(FollowupReadDenied);
});

function fixture(overrides: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown> = {
    [base]: { default_branch: 'stable/v2' }, [compare]: { status: 'behind' },
    [files(sha)]: filePage({ filename: 'renamed', previous_filename: 'old' }), [list()]: [],
    ...overrides,
  };
  return vi.fn(async (path: string, _signal: AbortSignal) => {
    if (!(path in bodies)) throw Error('unexpected path');
    return bodies[path];
  });
}

it('passes only the fixed GET argv, deadline and signal to gh', async () => {
  const get = fixture();
  const exec = vi.fn(async (args: readonly string[]) => ({ stdout: JSON.stringify(await get(args[5]!, signal)), exitCode: 0, stderr: '' }));
  expect(await createFollowupReadPort({ exec }).mergedFiles(chain, signal)).toEqual({ files: ['renamed', 'old'], merge_committed_at_ms: 1250 });
  expect(exec.mock.calls).toEqual([base, compare, files(sha)].map(path =>
    [['api', '--hostname', 'github.com', '--method', 'GET', path], { timeoutMs: 15_000, signal }]));
});

it('reads both page types to completion, reuses the branch, and finds a fix before merge observation', async () => {
  const chore = commit('c'.repeat(40), 'chore: docs\nfix: example');
  const get = fixture({
    [compare]: { status: 'identical' },
    [files(sha)]: filePage(...Array(100).fill({ filename: 'unrelated' })),
    [files(sha, 2)]: filePage({ filename: 'renamed', previous_filename: 'old' }),
    [list()]: [commit(sha, 'fix: merge itself'), ...Array(99).fill(chore)],
    [list(2)]: [commit(fixSha, 'Hotfix(cli)!: repair')],
    [files(fixSha)]: filePage({ filename: 'old' }),
  });
  const port = createFollowupReadPort({ get });
  expect(await measureCiChainFollowup([chain], port, chain.merged_at_ms + FOLLOWUP_WINDOW_MS, signal))
    .toMatchObject({ measured: true, hot_fixed: 1, rate: 1 });
  expect(get.mock.calls.map(([path]) => path)).toEqual([base, compare, files(sha), files(sha, 2), list(), list(2), files(fixSha)]);
});

it.each([
  { [compare]: { status: 'ahead' } }, { [compare]: { status: 'diverged' } },
  { [base]: { default_branch: '../main' } }, { [files(sha)]: { files: [] } },
  { [files(sha)]: filePage(...Array(100).fill({ filename: 'full' })) },
])('returns null for denied paths, non-ancestors and incomplete file reads', async overrides => {
  const get = fixture(overrides);
  expect(await createFollowupReadPort({ get, limits: { maxFilePages: 1 } }).mergedFiles(chain, signal)).toBeNull();
  if (base in overrides) expect(get).toHaveBeenCalledTimes(1);
});

it.each([{ entries: Array(100).fill(commit(sha, 'chore: update')) }, { entries: [{}] }])('rejects incomplete or malformed lists %#', async ({ entries }) => {
  const get = fixture({ [list()]: entries });
  const port = createFollowupReadPort({ get, limits: { maxCommitPages: 1 } });
  expect(await port.laterCommits(chain, 1250, chain.merged_at_ms + FOLLOWUP_WINDOW_MS, signal)).toBeNull();
  expect(get).toHaveBeenCalledTimes(2);
});

it('shares the request budget across port calls', async () => {
  const get = fixture();
  const port = createFollowupReadPort({ get, limits: { maxRequests: 3 } });
  expect(await port.mergedFiles(chain, signal)).not.toBeNull();
  expect(await port.laterCommits(chain, 1250, chain.merged_at_ms + FOLLOWUP_WINDOW_MS, signal)).toBeNull();
  expect(get).toHaveBeenCalledTimes(3);
});

it('reports pending and mixed verdicts and suppresses a partial rate', async () => {
  const now = chain.merged_at_ms + FOLLOWUP_WINDOW_MS;
  const pending = { ...chain, merged_at_ms: now };
  const port: FollowupReadPort = {
    mergedFiles: async () => ({ files: ['src'], merge_committed_at_ms: 1000 }),
    laterCommits: async ({ pr }) => pr === 4 ? null : [{
      sha: fixSha, committed_at_ms: 2000, files: ['src'],
      message: pr === 1 ? `Reverts ${repository}#1` : pr === 2 ? 'fix: repair' : 'docs: example',
    }],
  };
  const complete = [1, 2, 3].map(pr => ({ ...chain, pr }));
  expect(await measureCiChainFollowup([pending], port, now, signal)).toMatchObject({ measured: true, pending: 1, rate: null });
  expect(await measureCiChainFollowup([...complete, pending], port, now, signal)).toMatchObject({
    measured: true, pending: 1, reverted: 1, hot_fixed: 1, clean: 1, eligible: 3, rate: 2 / 3,
  });
  expect(await measureCiChainFollowup([...complete, { ...chain, pr: 4 }, pending], port, now, signal))
    .toMatchObject({ measured: false, unknown: 1, eligible: 3, pending: 1, rate: null });
});
