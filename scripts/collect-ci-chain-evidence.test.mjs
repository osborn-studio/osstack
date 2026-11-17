import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACTORS, collectEvidence, githubQueryError, loadPolicy } from './collect-ci-chain-evidence.mjs';

const H0 = 'ad9393b36662ba28035a93e312ba6a5740c55d4a';
const H1 = 'ec34309efbb70b515dd419190c7d688e281fdb07';
const BASE = '55dbb3b4f100884053f61cdc8e100a61b874f228';
const MERGE = '1b41d56d169a2d457d5a5994aba08c241ff42f8a';
const repo = 'osborn-studio/osstack-bridge-sandbox';
const at = n => `2026-11-01T00:0${n}:00Z`;
const policy = { workflowId: 407532337, actionsAppId: 15368, jobs: [
  { name: 'check' }, { name: 'graph-macos-fixtures (22)' }, { name: 'graph-macos-fixtures (24)' },
  { name: 'graph-runtime-matrix (20.6.0)' }, { name: 'graph-runtime-matrix (22.23.1)' },
] };

// Trimmed from raw PR #31 responses. The repaired Actions run, merge commit, and GraphQL
// response were not recorded; their small stand-ins use the fields consumed by the collector.
function fixture() {
  const runs = [{ id: 42610697602, workflow_id: 407532337, check_suite_id: 115409021006,
    head_sha: H0, run_attempt: 1, status: 'completed', conclusion: 'failure',
    created_at: '2026-11-09T11:38:55Z', updated_at: '2026-11-09T11:39:04Z' },
  { id: 42610700000, workflow_id: 407532337, check_suite_id: 115409872745,
    head_sha: H1, run_attempt: 1, status: 'completed', conclusion: 'success',
    created_at: at(3), updated_at: at(4) }];
  const check = (id, name, head_sha, suite, conclusion) => ({ id, name, head_sha,
    check_suite: { id: suite }, app: { id: 15368 }, status: 'completed', conclusion,
    started_at: at(2), completed_at: at(3) });
  const checks = new Map([[H0, [
    check(129138061708, 'graph-runtime-matrix (22.23.1)', H0, 115409021006, 'failure'),
    check(129138061666, 'graph-runtime-matrix (20.6.0)', H0, 115409021006, 'failure'),
    check(129138061637, 'graph-macos-fixtures (24)', H0, 115409021006, 'cancelled'),
    check(129138061610, 'check', H0, 115409021006, 'failure'),
    check(129138061492, 'graph-macos-fixtures (22)', H0, 115409021006, 'failure'),
  ]], [H1, [
    check(129139161516, 'check', H1, 115409872745, 'success'),
    check(129139161335, 'graph-macos-fixtures (24)', H1, 115409872745, 'success'),
    check(129139161324, 'graph-runtime-matrix (20.6.0)', H1, 115409872745, 'success'),
    check(129139161235, 'graph-runtime-matrix (22.23.1)', H1, 115409872745, 'success'),
    check(129139161064, 'graph-macos-fixtures (22)', H1, 115409872745, 'success'),
  ]]]);
  const f = {
    pull: { commits: 2, head: { sha: H1, repo: { full_name: repo } }, base: { sha: BASE },
      merged_at: '2026-11-09T11:45:24Z', merge_commit_sha: MERGE,
      merged_by: { id: ACTORS.merger, type: 'Bot' } },
    commits: [{ sha: H0, commit: { author: { date: '2026-11-09T11:38:35Z' } }, parents: [{ sha: BASE }] },
      { sha: H1, commit: { author: { date: '2026-11-09T11:40:02Z' } }, parents: [{ sha: H0 }] }],
    reviews: [{ id: 5825353136, state: 'APPROVED', commit_id: H1,
      submitted_at: '2026-11-09T11:42:39Z', user: { id: ACTORS.watcher, type: 'User' } }],
    comments: [{ id: 6739218696, body: `osstack-sandbox-merge ${H1} ${BASE}`,
      created_at: '2026-11-09T11:43:42Z', updated_at: '2026-11-09T11:43:42Z' }],
    graph: { data: { repository: { pullRequest: { reviewDecision: 'APPROVED', labels: { nodes: [{ name: 'verified' }],
      pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } },
    merge: { parents: [{ sha: BASE }] }, runs, checks,
  };
  const validPath = path => assert.doesNotMatch(path, /(?:undefined|null)/u);
  const api = {
    get: async path => {
      validPath(path);
      if (path.endsWith('/pulls/31')) return f.pull;
      if (path.endsWith(`/commits/${MERGE}`)) return f.merge;
      throw Error(`unexpected GET ${path}`);
    },
    pages: async path => {
      validPath(path);
      if (path.includes('/pulls/31/commits')) return f.commits;
      if (path.includes('/pulls/31/reviews')) return f.reviews;
      if (path.includes('/issues/31/comments')) return f.comments;
      throw Error(`unexpected pages ${path}`);
    },
    objects: async (path, key) => {
      validPath(path);
      if (key === 'workflow_runs') return f.runs.filter(r => path.includes(r.head_sha));
      if (key === 'check_runs') return f.checks.get(/commits\/([^/]+)\/check-runs/u.exec(path)?.[1]) ?? [];
      throw Error(`unexpected objects ${path}`);
    },
    query: async (_query, variables) => { assert.equal(variables.number, 31); return f.graph; },
  };
  return { f, api };
}
const status = () => ({ mission: { mission_id: 'm-1', scope_id: 'scope' }, github_ci_chain: { state: 'closed', merge_commit_sha: MERGE } });
const collect = (api, missionStatus = status()) => collectEvidence({ repo, pr: 31, missionStatus }, api, policy);

test('recorded complete chain qualifies', async () => {
  const { api } = fixture();
  const result = await collect(api);
  assert.equal(result.qualified, true, result.failures.join('; '));
  assert.deepEqual(result.requiredChecks.map(c => c.name), policy.jobs.map(j => j.name));
  assert.equal(result.failed.job.appId, 15368);
  assert.equal(result.failed.job.checkRunId, 129138061708);
  assert.equal(result.repairHead, H1);
  assert.equal(result.mergeSha, MERGE);
  assert.equal(result.mergeParents[0], BASE);
});
test('unclosed Mission fails', async () => {
  const { api } = fixture();
  const result = await collect(api, { github_ci_chain: { state: 'merge_held' } });
  assert.equal(result.qualified, false);
  assert.match(result.failures.join(' '), /not closed/u);
});
test('unrepaired and unmerged PR reports both reasons', async () => {
  const { f, api } = fixture();
  f.commits.pop(); f.pull.commits = 1; f.pull.merged_at = null; f.pull.merge_commit_sha = null; f.pull.merged_by = null;
  const result = await collect(api, { github_ci_chain: { state: 'open' } });
  assert.equal(result.qualified, false);
  assert.match(result.failures.join(' '), /repair push count is not one/u);
  assert.match(result.failures.join(' '), /PR is not merged/u);
});
test('approval on old head fails', async () => {
  const { f, api } = fixture(); f.reviews[0].commit_id = H0;
  assert.match((await collect(api)).failures.join(' '), /current-head watcher approval/u);
});
test('check runs from another suite cannot qualify the repair', async () => {
  const { f, api } = fixture(); f.runs[1].check_suite_id = 1;
  const result = await collect(api);
  assert.equal(result.qualified, false);
  assert.match(result.failures.join(' '), /required check failed or missing/u);
});
test('edited handoff fails', async () => {
  const { f, api } = fixture(); f.comments[0].updated_at = at(6);
  assert.match((await collect(api)).failures.join(' '), /was edited/u);
});
test('non-App E merger fails', async () => {
  const { f, api } = fixture(); f.pull.merged_by.id = 1;
  assert.match((await collect(api)).failures.join(' '), /not App E/u);
});
test('incomplete pagination fails closed', async () => {
  const { api } = fixture(); api.pages = async () => { throw Error('incomplete pagination'); };
  const result = await collect(api);
  assert.equal(result.qualified, false);
  assert.match(result.failures.join(' '), /incomplete pagination/u);
});
test('fixture rejects any request path containing undefined or null', async () => {
  const { api } = fixture();
  for (const path of ['repos/x/check-runs/undefined', 'repos/x/check-runs/null']) {
    await assert.rejects(api.get(path), /undefined|null/u);
    await assert.rejects(api.pages(path), /undefined|null/u);
    await assert.rejects(api.objects(path, 'check_runs'), /undefined|null/u);
  }
});
test('GitHub query errors include path and HTTP status without stderr', () => {
  const error = githubQueryError('repos/example/check-runs/123', {
    stderr: 'HTTP 404: Not Found\nAuthorization: secret', message: 'command failed',
  });
  assert.equal(error.message, 'GitHub query failed: repos/example/check-runs/123 (HTTP 404)');
});
test('script actor constants and required checks match source policies', async () => {
  const app = await readFile(new URL('../packages/cli/src/contained-mission-sandbox-app-e.ts', import.meta.url), 'utf8');
  assert.match(app, new RegExp(`actorId: ${ACTORS.merger},.*watcherId: ${ACTORS.watcher}`, 'u'));
  const merge = await readFile(new URL('../packages/cli/src/contained-mission-sandbox-ci-merge.ts', import.meta.url), 'utf8');
  assert.match(merge, /'osstack-ci-pilot-merge' : 'osstack-sandbox-merge'/u);
  const registered = await loadPolicy(repo);
  assert.equal(registered.actionsAppId, 15368);
  assert.deepEqual(registered.jobs.map(j => j.name), ['check', 'graph-macos-fixtures (22)', 'graph-macos-fixtures (24)',
    'graph-runtime-matrix (20.6.0)', 'graph-runtime-matrix (22.23.1)']);
});
