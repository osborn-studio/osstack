import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { defaultGhExec, ghGraphqlTransport, type GhExec, type GraphqlTransport } from './contained-mission-bridge-reader.js';
import type { RestGet } from './contained-mission-merger-reader.js';
import { createInstallationTokenSource } from './contained-mission-github-app.js';
import { APP_E_SANDBOX as S, type SandboxAppEPorts, type SandboxMergeBinding } from './contained-mission-sandbox-app-e.js';

function fail(): never { throw Error('SANDBOX_APP_E_EVIDENCE_UNAVAILABLE'); }
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const id = z.number().int().positive().safe();
const repository = z.object({ id: z.literal(S.repositoryId), full_name: z.literal(S.repository) });
const actor = z.object({ id, type: z.enum(['User', 'Bot']) });
const pull = z.object({ number: id, state: z.enum(['open', 'closed']), draft: z.boolean(), user: actor,
  head: z.object({ sha, ref: z.string(), repo: repository }),
  base: z.object({ sha, ref: z.literal('main'), repo: repository }),
  title: z.string().max(1024), body: z.string().max(1_048_576).nullable(),
  mergeable: z.boolean().nullable(), merged: z.boolean(), merge_commit_sha: sha.nullable(),
  merged_by: actor.nullable(),
});
const contexts = ['check', 'graph-macos-fixtures (22)', 'graph-macos-fixtures (24)',
  'graph-runtime-matrix (20.6.0)', 'graph-runtime-matrix (22.23.1)'];
const rule = z.object({ type: z.string(), ruleset_id: id.optional(), parameters: z.unknown().optional() });
const ruleset = z.object({ id, name: z.string(), target: z.literal('branch'), enforcement: z.literal('active'),
  conditions: z.object({ ref_name: z.object({ include: z.array(z.string()), exclude: z.array(z.string()).length(0) }) }),
  bypass_actors: z.array(z.object({ actor_id: id, actor_type: z.string(), bypass_mode: z.string() })), rules: z.array(rule),
});
const prPolicy = z.object({ required_approving_review_count: z.number().int().min(1),
  dismiss_stale_reviews_on_push: z.literal(true), require_last_push_approval: z.literal(true),
  required_review_thread_resolution: z.literal(true) });
const checksPolicy = z.object({ required_status_checks: z.array(z.object({ context: z.string(), integration_id: z.literal(15368) })).length(5) });
const author = z.object({ __typename: z.enum(['User', 'Bot']), databaseId: id });
const review = z.object({ databaseId: id, state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']),
  author, authorCanPushToRepository: z.boolean(), commit: z.object({ oid: sha }) });
const connection = <T extends z.ZodTypeAny>(node: T) => z.object({
  nodes: z.array(node).max(100), pageInfo: z.object({ hasNextPage: z.literal(false) }),
});
const graph = z.object({ errors: z.array(z.unknown()).length(0).optional(), data: z.object({ repository: z.object({
  databaseId: z.literal(S.repositoryId), nameWithOwner: z.literal(S.repository),
  pullRequest: z.object({ number: id, state: z.literal('OPEN'), isDraft: z.literal(false),
    author, headRefName: z.string(), headRefOid: sha, baseRefName: z.literal('main'), baseRefOid: sha,
    headRepository: z.object({ databaseId: z.literal(S.repositoryId) }),
    // GitHub can report BLOCKED with the App E-only update rule even to App E.
    // The observer still verifies every quality gate and GitHub enforces them on the merge PUT.
    mergeable: z.literal('MERGEABLE'), mergeStateStatus: z.enum(['CLEAN', 'BLOCKED']), reviewDecision: z.literal('APPROVED'), body: z.string().max(1_048_576), title: z.string().max(1024),
    mergeQueueEntry: z.null(), autoMergeRequest: z.null(),
    latestOpinionatedReviews: connection(review), reviewThreads: connection(z.object({ isResolved: z.boolean() })),
    labels: connection(z.object({ name: z.string() })),
  }),
}) }) });
export const SANDBOX_APP_E_QUERY = `query SandboxAppE($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){databaseId nameWithOwner pullRequest(number:$number){number state isDraft title body author{__typename ... on User{databaseId} ... on Bot{databaseId}} headRefName headRefOid baseRefName baseRefOid headRepository{databaseId} mergeable mergeStateStatus reviewDecision mergeQueueEntry{id} autoMergeRequest{enabledAt} latestOpinionatedReviews(first:100){pageInfo{hasNextPage} nodes{databaseId state authorCanPushToRepository author{__typename ... on User{databaseId} ... on Bot{databaseId}} commit{oid}}} reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}} labels(first:100){pageInfo{hasNextPage} nodes{name}}}}}`;
const root = `repos/${S.repository}`;
function validBinding(b: SandboxMergeBinding): void {
  if (b.repository !== S.repository || b.repositoryId !== S.repositoryId || !id.safeParse(b.pr).success
    || !sha.safeParse(b.head).success || !sha.safeParse(b.base).success || !/^osstack\/mission\/[A-Za-z0-9_.-]+$/u.test(b.branch)) fail();
}
function bind(p: z.infer<typeof pull>, b: SandboxMergeBinding): void {
  validBinding(b);
  if (p.number !== b.pr || p.head.sha !== b.head || p.head.ref !== b.branch || (p.state === 'open' && p.base.sha !== b.base)
    || p.user.id !== S.publisherId || p.user.type !== 'Bot') fail();
}
/** Fixed GET paths, existing authenticated gh execution. Lists are bounded and never follow URLs. */
function observerRest(exec: GhExec): RestGet {
  return async path => {
    if (!new RegExp(`^repos/${S.repository}/(?:pulls/[1-9][0-9]*|git/ref/heads/main|rulesets/(?:26575831|26577634)|rules/branches/main\\?per_page=100&page=1)$`, 'u').test(path)
      && path !== root) fail();
    const r = await exec(['api', '--method', 'GET', path, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'], { timeoutMs: 5000 });
    if (r.exitCode !== 0 || Buffer.byteLength(r.stdout) > 4_194_304) fail();
    return { ok: true, body: JSON.parse(r.stdout) as unknown };
  };
}
/** One page per connection. Any full REST page or GraphQL continuation is refused. */
export function createSandboxAppEObserver(deps: { rest?: RestGet; graphql?: GraphqlTransport; exec?: GhExec } = {}): SandboxAppEPorts['observe'] {
  const rest = deps.rest ?? observerRest(deps.exec ?? defaultGhExec);
  const graphql = deps.graphql ?? ghGraphqlTransport(deps.exec ?? defaultGhExec, 5000);
  return async raw => {
    const b = { ...raw };
    validBinding(b);
    const get = async (path: string): Promise<unknown> => { const r = await rest(path); if (!r.ok) fail(); return r.body; };
    const repo = z.object({ id: z.literal(S.repositoryId), full_name: z.literal(S.repository), default_branch: z.literal('main') }).parse(await get(root));
    void repo;
    const p = pull.parse(await get(`${root}/pulls/${b.pr}`)); bind(p, b);
    if (p.state !== 'open' || p.draft || p.merged || p.mergeable !== true) fail();
    const tip = z.object({ ref: z.literal('refs/heads/main'), object: z.object({ type: z.literal('commit'), sha }) }).parse(await get(`${root}/git/ref/heads/main`));
    if (tip.object.sha !== b.base) fail();
    const g = graph.parse(await graphql(SANDBOX_APP_E_QUERY, { owner: 'osborn-studio', name: 'osstack-bridge-sandbox', number: b.pr })).data.repository.pullRequest;
    if (g.body !== (p.body ?? '') || g.title !== p.title || /merge[ _-]+after/iu.test(`${g.title}\n${g.body}`)) fail();
    if (g.number !== b.pr || g.headRefName !== b.branch || g.headRefOid !== b.head || g.baseRefOid !== b.base
      || g.author.databaseId !== p.user.id || g.author.__typename !== p.user.type) fail();
    const reviews = g.latestOpinionatedReviews.nodes;
    if (new Set(reviews.map(r => r.author.databaseId)).size !== reviews.length) fail();
    const watcher = reviews.find(r => r.author.databaseId === S.watcherId);
    if (watcher?.author.__typename !== 'User' || watcher.state !== 'APPROVED' || !watcher.authorCanPushToRepository || watcher.commit.oid !== b.head
      || reviews.some(r => r.state === 'CHANGES_REQUESTED') || g.reviewThreads.nodes.some(t => !t.isResolved)) fail();
    const labels = g.labels.nodes.map(l => l.name);
    if (!labels.includes('verified') || labels.some(l => /merge[ _-]?after|block|do[ _-]?not[ _-]?merge|hold/iu.test(l))) fail();
    const q = ruleset.parse(await get(`${root}/rulesets/26575831`));
    const u = ruleset.parse(await get(`${root}/rulesets/26577634`));
    const applies = (r: z.infer<typeof ruleset>) => r.conditions.ref_name.include.length === 1
      && ['~DEFAULT_BRANCH', 'refs/heads/main'].includes(r.conditions.ref_name.include[0] ?? '');
    if (q.id !== 26575831 || q.name !== 'main-quality' || u.id !== 26577634 || u.name !== 'main-update'
      || !applies(q) || !applies(u) || q.bypass_actors.length !== 0 || u.bypass_actors.length !== 1
      || u.bypass_actors[0]?.actor_id !== S.appId || u.bypass_actors[0]?.actor_type !== 'Integration'
      || u.bypass_actors[0]?.bypass_mode !== 'pull_request') fail();
    if (q.rules.length !== 4 || !['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'].every(t => q.rules.filter(r => r.type === t).length === 1)
      || u.rules.length !== 1 || u.rules[0]?.type !== 'update') fail();
    const applied = z.array(rule.extend({ ruleset_id: id })).max(99).parse(await get(`${root}/rules/branches/main?per_page=100&page=1`));
    if (applied.length !== 5 || applied.filter(r => r.ruleset_id === q.id).length !== 4) fail();
    for (const type of ['deletion', 'non_fast_forward']) {
      if (applied.filter(r => r.ruleset_id === q.id && r.type === type).length !== 1) fail();
    }
    const requireRule = (rules: z.infer<typeof rule>[], type: string, rulesetId?: number) => {
      const matches = rules.filter(r => r.type === type && (rulesetId === undefined || r.ruleset_id === rulesetId));
      if (matches.length !== 1) fail(); return matches[0]!;
    };
    for (const rules of [q.rules, applied.filter(r => r.ruleset_id === q.id)]) {
      prPolicy.parse(requireRule(rules, 'pull_request').parameters);
      const checks = checksPolicy.parse(requireRule(rules, 'required_status_checks').parameters).required_status_checks;
      if (new Set(checks.map(c => c.context)).size !== 5 || contexts.some(c => !checks.some(x => x.context === c))) fail();
    }
    requireRule(u.rules, 'update'); requireRule(applied, 'update', u.id);
    // Unknown active applied rules cannot silently add unobserved merge conditions.
    if (applied.some(r => ![q.id, u.id].includes(r.ruleset_id) || !['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks', 'update'].includes(r.type))) fail();
    return { binding: { ...b }, complete: true, open: true, draft: false, publisherId: p.user.id,
      headRepositoryId: S.repositoryId, baseRef: 'main', baseTip: tip.object.sha, mergeable: true,
      reviewDecision: g.reviewDecision, labels, blockers: [], unresolvedThreads: 0, currentChangesRequested: false,
      watcher: { userId: watcher.author.databaseId, type: 'User', state: watcher.state, head: watcher.commit.oid, counted: true },
      quality: { id: q.id, active: true, appliesToMain: true, bypassActors: [], requiredChecksEnforced: true,
        approvalEnforced: true, threadsEnforced: true, lastPushApprovalEnforced: true },
      update: { id: u.id, active: true, appliesToMain: true, restrictsUpdates: true,
        bypassActors: [{ actorId: S.appId, actorType: 'Integration', mode: 'pull_request' }] } };
  };
}

export class SandboxAppEWriteUnknown extends Error {
  constructor() { super('SANDBOX_APP_E_WRITE_UNKNOWN'); }
}
/** Creating the adapter performs no I/O. Key access and writes occur only on explicit invocation. */
export function createSandboxAppEWriteAdapter(options: { privateKeyPath: string; fetchImpl?: typeof fetch; signal?: AbortSignal }): Pick<SandboxAppEPorts, 'merge' | 'readback'> {
  if (!isAbsolute(options.privateKeyPath)) fail();
  const rawFetch = options.fetchImpl ?? fetch;
  // This wrapper also bounds token minting. No response body or credential escapes in errors.
  const boundedFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith('https://api.github.com/')) fail();
    try {
      const timeout = AbortSignal.timeout(5000);
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
      const response = await rawFetch(input, { ...init, redirect: 'error', signal });
      if (response.status >= 300 || response.status < 200 || response.redirected) fail();
      const reader = response.body?.getReader(); if (!reader) fail();
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
        if (bytes > 1_048_576) { await reader.cancel(); fail(); } chunks.push(part.value); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    } catch { return fail(); }
  };
  const source = createInstallationTokenSource({ app_id: S.appId, installation_id: S.installationId,
    private_key_path: options.privateKeyPath }, { repository: S.repository,
    permissions: { contents: 'write', pull_requests: 'read', checks: 'read' } }, { fetchImpl: boundedFetch });
  async function token(): Promise<string> {
    const stat = await lstat(options.privateKeyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail();
    const t = await source.token();
    const r = z.object({ total_count: z.literal(1), repositories: z.array(repository).length(1) })
      .parse(await api('/installation/repositories?per_page=100&page=1', t));
    void r; return t;
  }
  async function api(path: string, t: string, body?: unknown): Promise<unknown> {
    const response = await boundedFetch(`https://api.github.com${path}`, {
      method: body === undefined ? 'GET' : 'PUT', headers: { authorization: `Bearer ${t}`,
        accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.headers.get('link')) fail();
    return await response.json() as unknown;
  }
  return {
    async merge(raw, beforeWrite) {
      const r = { ...raw };
      if (r.appId !== S.appId || r.installationId !== S.installationId || r.repository !== S.repository
        || !id.safeParse(r.pr).success || !sha.safeParse(r.sha).success || r.merge_method !== 'squash') fail();
      const t = await token();
      await beforeWrite();
      options.signal?.throwIfAborted();
      // From the start of the sole PUT, every failure is ambiguous. No retries or fallback.
      try { return z.object({ merged: z.literal(true), sha }).parse(await api(`/${root}/pulls/${r.pr}/merge`, t,
        { sha: r.sha, merge_method: 'squash' })); } catch { throw new SandboxAppEWriteUnknown(); }
    },
    async readback(raw) {
      const b = { ...raw };
      validBinding(b); const t = await token();
      const p = pull.parse(await api(`/${root}/pulls/${b.pr}`, t)); bind(p, b);
      if (!p.merged || p.state !== 'closed' || p.merge_commit_sha === null || p.merged_by?.id !== 352681958
        || p.merged_by.type !== 'Bot') fail();
      const c = z.object({ sha, parents: z.array(z.object({ sha })).length(1) })
        .parse(await api(`/${root}/git/commits/${p.merge_commit_sha}`, t));
      if (c.sha !== p.merge_commit_sha || c.parents[0]?.sha !== b.base) fail();
      return { binding: { ...b }, merged: true, actorAppId: S.appId, actorType: 'Bot', actorVerified: true,
        actorUserId: 352681958, sha: c.sha, parents: c.parents.map(x => x.sha) };
    },
  };
}
