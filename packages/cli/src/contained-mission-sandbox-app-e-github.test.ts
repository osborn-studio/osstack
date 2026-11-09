import { describe, expect, it, vi } from 'vitest';
import { APP_E_SANDBOX as S, SANDBOX_MERGER_POLICY, type CiMergerPolicy, type SandboxMergeBinding } from './contained-mission-sandbox-app-e.js';
import { PRODUCTION_CI_POLICY } from './contained-mission-ci-policy.js';
const mocks = vi.hoisted(() => ({ mint: vi.fn(() => ({ token: async () => 'app-e-only' })), stat: vi.fn() }));
vi.mock('./contained-mission-github-app.js', () => ({ createInstallationTokenSource: mocks.mint }));
vi.mock('node:fs/promises', () => ({ lstat: mocks.stat }));
import { createSandboxAppEObserver, createSandboxAppEWriteAdapter, SandboxAppEWriteUnknown } from './contained-mission-sandbox-app-e-github.js';
const b: SandboxMergeBinding = { repository: S.repository, repositoryId: S.repositoryId, pr: 7,
  branch: 'osstack/mission/test', head: 'a'.repeat(40), base: 'b'.repeat(40) };
const repo = { id: S.repositoryId, full_name: S.repository };
const author = { __typename: 'Bot', databaseId: S.publisherId };
const restPull = () => ({ number: b.pr, title: 'Sandbox mission', body: '', state: 'open', draft: false, user: { id: S.publisherId, type: 'Bot' },
  head: { sha: b.head, ref: b.branch, repo }, base: { sha: b.base, ref: 'main', repo }, mergeable: true,
  merged: false, merge_commit_sha: null, merged_by: null });
const conn = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false } });
const checks = ['check', 'graph-macos-fixtures (22)', 'graph-macos-fixtures (24)', 'graph-runtime-matrix (20.6.0)', 'graph-runtime-matrix (22.23.1)'];
function fixture() {
  const pr = { number: b.pr, title: 'Sandbox mission', body: '', state: 'OPEN', isDraft: false, author, headRefName: b.branch, headRefOid: b.head,
    baseRefName: 'main', baseRefOid: b.base, headRepository: { databaseId: S.repositoryId }, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', mergeQueueEntry: null, autoMergeRequest: null,
    latestOpinionatedReviews: conn([{ databaseId: 30, authorCanPushToRepository: true, state: 'APPROVED', author: { __typename: 'User', databaseId: Number(S.watcherId) }, commit: { oid: b.head } }]),
    reviewThreads: conn([{ isResolved: true }]), labels: conn([{ name: 'verified' }]) };
  const policy = [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true,
    require_last_push_approval: true, required_review_thread_resolution: true } },
  { type: 'required_status_checks', parameters: { required_status_checks: checks.map(context => ({ context, integration_id: 15368 })) } }];
  const q = { id: 26575831, name: 'main-quality', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [] as unknown[], rules: policy };
  const u = { ...q, id: 26577634, name: 'main-update', rules: [{ type: 'update' }],
    bypass_actors: [{ actor_id: S.appId, actor_type: 'Integration', bypass_mode: 'pull_request' }] };
  const applied = [...policy.map(r => ({ ...r, ruleset_id: q.id })), { type: 'update', ruleset_id: u.id }];
  const p = restPull();
  const routes: Record<string, unknown> = { '': { ...repo, default_branch: 'main' }, '/pulls/7': p,
    '/git/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: b.base } },
    '/rulesets/26575831': q, '/rulesets/26577634': u, '/rules/branches/main?per_page=100&page=1': applied };
  const rest = vi.fn(async (path: string) => {
    const suffix = path.replace(`repos/${S.repository}`, '');
    if (!(suffix in routes)) throw Error('unexpected path');
    return { ok: true as const, body: routes[suffix] };
  });
  const graphql = vi.fn(async () => ({ data: { repository: { databaseId: S.repositoryId, nameWithOwner: S.repository, pullRequest: pr } } }));
  return { pr, p, q, u, applied, routes, observe: createSandboxAppEObserver({ rest, graphql }), rest };
}
describe('bounded sandbox observer', () => {
  it('binds complete REST and GraphQL evidence to exact sandbox rules', async () => {
    const f = fixture(); const observed = await f.observe(b);
    expect(observed.binding).toEqual(b); expect(observed.watcher.counted).toBe(true);
    expect(observed.quality.requiredChecksEnforced).toBe(true); expect(f.rest).toHaveBeenCalledTimes(6);
  });
  it('accepts GitHub BLOCKED after verifying the exact App E update rule and independent quality gates', async () => {
    const f = fixture();
    f.pr.mergeStateStatus = 'BLOCKED';
    await expect(f.observe(b)).resolves.toMatchObject({ binding: b, watcher: { counted: true }, update: { bypassActors: [
      { actorId: S.appId, actorType: 'Integration', mode: 'pull_request' },
    ] } });
    f.applied.pop();
    await expect(f.observe(b)).rejects.toThrow();
  });
  it.each([
    ['REST author', (f: ReturnType<typeof fixture>) => { f.p.user.id++; }],
    ['REST head', f => { f.p.head.sha = b.base; }],
    ['REST base', f => { f.p.base.sha = b.head; }],
    ['GraphQL head', f => { f.pr.headRefOid = b.base; }],
    ['unknown mergeability', f => { f.pr.mergeable = 'UNKNOWN'; }],
    ['unstable merge status', f => { f.pr.mergeStateStatus = 'UNSTABLE'; }],
    ['GitHub review decision', f => { f.pr.reviewDecision = 'REVIEW_REQUIRED'; }],
    ['Watcher identity', f => { f.pr.latestOpinionatedReviews.nodes[0]!.author.databaseId++; }],
    ['Watcher type', f => { f.pr.latestOpinionatedReviews.nodes[0]!.author.__typename = 'Bot'; }],
    ['stale Watcher', f => { f.pr.latestOpinionatedReviews.nodes[0]!.commit.oid = b.base; }],
    ['non-counting Watcher', f => { f.pr.latestOpinionatedReviews.nodes[0]!.authorCanPushToRepository = false; }],
    ['merge-after body', f => { f.p.body = 'Merge after #8'; f.pr.body = f.p.body; }],
    ['dismissed Watcher', f => { f.pr.latestOpinionatedReviews.nodes[0]!.state = 'DISMISSED'; }],
    ['review pagination', f => { f.pr.latestOpinionatedReviews.pageInfo.hasNextPage = true; }],
    ['thread pagination', f => { f.pr.reviewThreads.pageInfo.hasNextPage = true; }],
    ['label pagination', f => { f.pr.labels.pageInfo.hasNextPage = true; }],
    ['unresolved thread', f => { f.pr.reviewThreads.nodes[0]!.isResolved = false; }],
    ['merge-after label', f => { f.pr.labels.nodes.push({ name: 'merge-after: tomorrow' }); }],
    ['quality bypass', f => { f.q.bypass_actors.push({ actor_id: S.appId }); }],
    ['App E bypass mode', f => { f.u.bypass_actors[0]!.bypass_mode = 'always'; }],
    ['missing applied rule', f => { f.applied.pop(); }],
    ['wrong check producer on BLOCKED', f => {
      f.pr.mergeStateStatus = 'BLOCKED';
      f.q.rules[3]!.parameters!.required_status_checks![0]!.integration_id = 9;
    }],
    ['inactive ruleset', f => { f.q.enforcement = 'evaluate'; }],
  ] as [string, (f: ReturnType<typeof fixture>) => void][])('refuses %s', async (_name, change) => {
    const f = fixture(); change(f); await expect(f.observe(b)).rejects.toThrow();
  });
  it('refuses a current changes request even from another user', async () => {
    const f = fixture(); f.pr.latestOpinionatedReviews.nodes.push({ databaseId: 31, authorCanPushToRepository: true, state: 'CHANGES_REQUESTED',
      author: { __typename: 'User', databaseId: 42 }, commit: { oid: b.base } });
    await expect(f.observe(b)).rejects.toThrow();
  });
});
describe('production repository merge gates', () => {
  it.each(['eligible', 'missing marker', 'wrong Actions producer', 'loose base checks', 'App A missing', 'workflow token can write'])(
    'checks the counted review, branch rules, and CI settings (%s)', async fault => {
      const f = fixture();
      const ci = PRODUCTION_CI_POLICY;
      const policy: CiMergerPolicy = { ...SANDBOX_MERGER_POLICY, ci, repository: ci.repository, repositoryId: ci.repositoryId,
        missionRulesets: { writers: 111, history: 112 } };
      const bound = { ...b, repository: ci.repository, repositoryId: ci.repositoryId };
      const repo = { id: ci.repositoryId, full_name: ci.repository, default_branch: 'main' };
      const status = { strict_required_status_checks_policy: fault !== 'loose base checks',
        required_status_checks: ci.jobs.map(j => ({ context: j.name, integration_id: fault === 'wrong Actions producer' ? 9 : ci.actionsAppId })) };
      const quality = f.q.rules.find(r => r.type === 'required_status_checks')!;
      const applied = f.applied.find(r => r.type === 'required_status_checks')!;
      const missionRules = { ...f.q, conditions: { ref_name: { include: ['refs/heads/osstack/mission/**'], exclude: [] } } };
      const writers = { ...missionRules, id: 111, name: 'mission-writers', rules: [{ type: 'creation' }, { type: 'update' }],
        bypass_actors: fault === 'App A missing' ? [] : [{ actor_type: 'Integration', actor_id: 5620012, bypass_mode: 'always' }] };
      const history = { ...missionRules, id: 112, name: 'mission-history', rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] };
      const routes: Record<string, unknown> = {
        ...f.routes, '': repo, '/pulls/7': { ...f.p, head: { ...f.p.head, repo }, base: { ...f.p.base, repo } },
        '/rulesets/26575831': { ...f.q, rules: f.q.rules.map(r => r === quality ? { ...r, parameters: status } : r) },
        '/rules/branches/main?per_page=100&page=1': f.applied.map(r => r === applied ? { ...r, parameters: status } : r),
        '/rulesets/111': writers, '/rulesets/112': history,
        '/rules/branches/osstack%2Fmission%2Ftest?per_page=100&page=1':
          [writers, history].flatMap(r => r.rules.map(x => ({ ...x, ruleset_id: r.id }))),
        '/actions/permissions/workflow': { default_workflow_permissions: fault === 'workflow token can write' ? 'write' : 'read',
          can_approve_pull_request_reviews: false },
      };
      const observe = createSandboxAppEObserver({
        policy, rest: async path => ({ ok: true, body: routes[path.slice(`repos/${ci.repository}`.length)] }),
        graphql: async () => ({ data: { repository: { databaseId: ci.repositoryId, nameWithOwner: ci.repository, pullRequest: {
          ...f.pr, headRepository: { databaseId: ci.repositoryId },
          latestOpinionatedReviews: conn(f.pr.latestOpinionatedReviews.nodes.map(r => ({ ...r,
            body: fault === 'missing marker' ? 'approved' : `verify-osstack: pass ${b.head} ${b.base}` }))),
        } } } }),
      });
      if (fault === 'eligible') await expect(observe(bound)).resolves.toMatchObject({ binding: bound, watcher: { counted: true } });
      else await expect(observe(bound)).rejects.toThrow();
    });
});
function writerFixture() {
  mocks.stat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, mode: 0o600, uid: process.getuid?.() });
  const p = { ...restPull(), state: 'closed', merged: true, base: { ...restPull().base, sha: 'c'.repeat(40) }, merge_commit_sha: 'c'.repeat(40), merged_by: { id: 352681958, type: 'Bot' } };
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (url.includes('/installation/repositories')) return Response.json({ total_count: 1, repositories: [repo] });
    if (init?.method === 'PUT') return Response.json({ merged: true, sha: p.merge_commit_sha });
    if (url.includes('/git/commits/')) return Response.json({ sha: p.merge_commit_sha, parents: [{ sha: b.base }] });
    return Response.json(p);
  });
  const adapter = createSandboxAppEWriteAdapter({ privateKeyPath: '/private/owner/app-e.pem', fetchImpl: fetcher as typeof fetch });
  const request = { appId: S.appId, installationId: S.installationId, repository: S.repository, pr: b.pr,
    sha: b.head, merge_method: 'squash' as const };
  return { adapter, request, calls, p, fetcher };
}
describe('independent App E write and readback', () => {
  it('scopes the App E token, submits one exact squash PUT, and verifies numeric Bot plus parent', async () => {
    const f = writerFixture(); await f.adapter.merge(f.request, async () => {});
    expect(mocks.mint).toHaveBeenLastCalledWith(expect.objectContaining({ app_id: 5620091, installation_id: 178742757 }),
      { repository: S.repository, permissions: { contents: 'write', pull_requests: 'read', checks: 'read' } }, expect.anything());
    const puts = f.calls.filter(c => c.init?.method === 'PUT'); expect(puts).toHaveLength(1);
    expect(puts[0]!.init?.body).toBe(JSON.stringify({ sha: b.head, merge_method: 'squash' }));
    expect(puts[0]!.init?.redirect).toBe('error');
    expect(await f.adapter.readback(b)).toMatchObject({ actorUserId: 352681958, actorVerified: true, parents: [b.base] });
  });
  it('rechecks authorization after token scope verification and before the PUT', async () => {
    const f = writerFixture();
    const revoked = async () => {
      expect(f.calls.some(c => c.url.includes('/installation/repositories'))).toBe(true);
      throw Error('revoked');
    };
    await expect(f.adapter.merge(f.request, revoked)).rejects.toThrow('revoked');
    expect(f.calls.every(c => c.init?.method !== 'PUT')).toBe(true);
  });
  it('classifies a disconnected PUT as unknown without retry', async () => {
    const f = writerFixture(); f.fetcher.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') throw Error('disconnected');
      return Response.json({ total_count: 1, repositories: [repo] });
    });
    await expect(f.adapter.merge(f.request, async () => {})).rejects.toBeInstanceOf(SandboxAppEWriteUnknown);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses another installation repository before PUT', async () => {
    const f = writerFixture(); f.fetcher.mockResolvedValue(Response.json({ total_count: 2, repositories: [repo] }));
    await expect(f.adapter.merge(f.request, async () => {})).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([352680398, 42])('refuses merged_by %s', async actorId => {
    const f = writerFixture(); f.p.merged_by.id = actorId; await expect(f.adapter.readback(b)).rejects.toThrow();
  });
  it('refuses a shared key path before minting', async () => {
    const f = writerFixture(); mocks.stat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, mode: 0o644 });
    await expect(f.adapter.merge(f.request, async () => {})).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('refuses foreign repository requests before key access', async () => {
    const f = writerFixture(); await expect(f.adapter.merge({ ...f.request, repository: 'other/repo' }, async () => {})).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('refuses redirected write responses without fallback', async () => {
    const f = writerFixture();
    f.fetcher.mockImplementation(async (_input, init) => init?.method === 'PUT'
      ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid' } })
      : Response.json({ total_count: 1, repositories: [repo] }));
    await expect(f.adapter.merge(f.request, async () => {})).rejects.toBeInstanceOf(SandboxAppEWriteUnknown);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses overlarge write responses as unknown', async () => {
    const f = writerFixture();
    f.fetcher.mockImplementation(async (_input, init) => init?.method === 'PUT'
      ? new Response('x'.repeat(1_048_577)) : Response.json({ total_count: 1, repositories: [repo] }));
    await expect(f.adapter.merge(f.request, async () => {})).rejects.toBeInstanceOf(SandboxAppEWriteUnknown);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses squash readback with a second parent or moved parent', async () => {
    for (const parents of [[{ sha: b.base }, { sha: b.head }], [{ sha: b.head }]]) {
      const f = writerFixture();
      f.fetcher.mockImplementation(async (input) => String(input).includes('/installation/repositories')
        ? Response.json({ total_count: 1, repositories: [repo] })
        : String(input).includes('/git/commits/') ? Response.json({ sha: f.p.merge_commit_sha, parents }) : Response.json(f.p));
      await expect(f.adapter.readback(b)).rejects.toThrow();
    }
  });
  it('refuses pagination on the installation repository attestation', async () => {
    const f = writerFixture();
    f.fetcher.mockResolvedValue(Response.json({ total_count: 1, repositories: [repo] }, { headers: { link: '<next>; rel="next"' } }));
    await expect(f.adapter.merge(f.request, async () => {})).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

});
