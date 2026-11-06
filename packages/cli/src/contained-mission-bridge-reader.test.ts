import { type ProducerRegistry, decideChainStep, type ChainView } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READ_LIMITS,
  type GhExec,
  type GraphqlTransport,
  type RawAuthor,
  type RawComment,
  type RawReview,
  type RawThread,
  feedbackDigest,
  ghGraphqlTransport,
  normalizeBody,
  normalizeSnapshot,
  readPullRequest,
  secondRead,
} from './contained-mission-bridge-reader.js';

const REF = { owner: 'o', name: 'r', number: 7 };
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const registry: ProducerRegistry = {
  publisher: [{ actor_id: 1, app_id: null }],
  reviewers: [{ actor_id: 100, app_id: null }, { actor_id: 200, app_id: 55 }],
};
const user = (id: number): RawAuthor => ({ __typename: 'User', databaseId: id });
const bot = (id: number): RawAuthor => ({ __typename: 'Bot', databaseId: id });
const T0 = Date.parse('2026-11-01T00:00:00Z');
const review = (id: number, over: Partial<RawReview> = {}): RawReview => ({
  databaseId: id, state: 'COMMENTED', submittedAt: new Date(T0 + id * 1000).toISOString(), commit: { oid: HEAD }, author: user(100), body: '', ...over,
});
const comment = (id: number, reviewId: number | null, body: string): RawComment => ({
  databaseId: id, pullRequestReview: reviewId === null ? null : { databaseId: reviewId }, body, author: user(100),
});

interface Model {
  state?: string; head?: string; base?: string; baseRef?: string;
  reviews?: RawReview[]; threads?: RawThread[]; commits?: string[]; timeline?: string[];
}
const page = <T,>(all: readonly T[], after: unknown, size = 100) => {
  const start = typeof after === 'string' ? Number(after) : 0;
  const end = Math.min(start + size, all.length);
  return { pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null }, nodes: all.slice(start, end) };
};

/** Serves a PR model through the same query shapes, honouring include flags and cursors. */
function server(model: Model, calls: { query: string; variables: Record<string, unknown> }[] = []): GraphqlTransport {
  return async (query, v) => {
    calls.push({ query, variables: v });
    if (query.includes('BridgeThreadComments')) {
      const thread = (model.threads ?? []).find((t) => t.id === v['id']);
      return { data: { node: { comments: page(thread?.comments ?? [], v['after']) } } };
    }
    const pr: Record<string, unknown> = {
      state: model.state ?? 'OPEN', merged: false, closed: false, headRefName: 'x', headRefOid: model.head ?? HEAD,
      headRepository: { nameWithOwner: 'o/r' }, baseRefName: model.baseRef ?? 'main', baseRefOid: model.base ?? BASE,
    };
    if (v['reviews']) pr['reviews'] = page(model.reviews ?? [], v['reviewsAfter']);
    if (v['threads']) pr['reviewThreads'] = {
      ...page(model.threads ?? [], v['threadsAfter']),
      nodes: page(model.threads ?? [], v['threadsAfter']).nodes.map((t) => ({ ...t, comments: page(t.comments, undefined) })),
    };
    if (v['commits']) pr['commits'] = page((model.commits ?? [HEAD]).map((oid) => ({ commit: { oid } })), v['commitsAfter']);
    if (v['timeline']) pr['timelineItems'] = page((model.timeline ?? []).map((__typename) => ({ __typename })), v['timelineAfter']);
    return { data: { repository: { pullRequest: pr } } };
  };
}
async function read(model: Model, limits = DEFAULT_READ_LIMITS) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const result = await readPullRequest(server(model, calls), REF, limits);
  return { result, calls };
}

describe('normalizeBody / feedbackDigest', () => {
  it('normalises line endings, trailing whitespace and outer blank lines', () => {
    expect(normalizeBody('\r\n\r\n  a  \r\n\r\nb\t\r\n\r\n')).toBe('  a\n\nb');
    expect(normalizeBody('   \r\n \n\t')).toBe('');
    expect(normalizeBody('')).toBe('');
  });
  it('is injective across body / comment boundaries and independent of input order', () => {
    const a = feedbackDigest('x', [{ threadId: 't', databaseId: 1, body: 'y' }]);
    const b = feedbackDigest('x\nthread:1:t', [{ threadId: 'u', databaseId: 1, body: 'y' }]);
    const c = feedbackDigest('', [{ threadId: 't', databaseId: 1, body: 'xy' }]);
    expect(new Set([a, b, c]).size).toBe(3);
    const one = { threadId: 'a', databaseId: 2, body: 'p' };
    const two = { threadId: 'b', databaseId: 1, body: 'q' };
    expect(feedbackDigest('s', [one, two])).toBe(feedbackDigest('s', [two, one]));
    expect(feedbackDigest('s', [one])).not.toBe(feedbackDigest('s', [one, two]));
  });
});

describe('readPullRequest', () => {
  it('reads a small PR in one request with every connection switched on', async () => {
    const { result, calls } = await read({ reviews: [review(1)], commits: [HEAD, BASE], timeline: ['MERGED_EVENT'] });
    expect(result.complete).toBe(true);
    if (!result.complete) return;
    expect(calls).toHaveLength(1);
    expect(result.pr.commits).toEqual([HEAD, BASE]);
    expect(result.pr.timeline).toEqual(['MERGED_EVENT']);
    expect(calls[0]!.query).toContain('HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, BASE_REF_FORCE_PUSHED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT');
    expect(calls[0]!.query).not.toMatch(/mutation|subscription/iu);
  });

  it('pages top-level connections to the end, fetching only unfinished ones', async () => {
    const reviews = Array.from({ length: 230 }, (_, i) => review(i + 1));
    const { result, calls } = await read({ reviews, commits: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(40, '0')) });
    expect(result.complete && result.pr.reviews.length).toBe(230);
    expect(result.complete && result.pr.commits.length).toBe(101);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.variables).toMatchObject({ reviews: true, threads: false, commits: false, timeline: false, reviewsAfter: '200' });
  });

  it('pages a thread with more than 100 comments through node()', async () => {
    const comments = Array.from({ length: 250 }, (_, i) => comment(i + 1, 5, `c${i}`));
    const { result, calls } = await read({ threads: [{ id: 'T1', isResolved: false, comments }] });
    expect(result.complete && result.pr.threads[0]!.comments.length).toBe(250);
    const nodeCalls = calls.filter((c) => c.query.includes('BridgeThreadComments'));
    expect(nodeCalls.map((c) => c.variables)).toEqual([{ id: 'T1', after: '100' }, { id: 'T1', after: '200' }]);
    expect(nodeCalls[0]!.query).toContain('node(id: $id)');
    expect(nodeCalls[0]!.query).toContain('... on PullRequestReviewThread');
  });

  it('reports incomplete when a GraphQL errors array is present, even beside data', async () => {
    const inner = server({});
    const t: GraphqlTransport = async (q, v) => ({ ...((await inner(q, v)) as object), errors: [{ message: 'boom' }] });
    expect(await readPullRequest(t, REF)).toEqual({ complete: false, reason: 'graphql_errors' });
  });

  it('reports incomplete on a rejected request, never throwing', async () => {
    const t: GraphqlTransport = async () => { throw new Error('network down'); };
    expect(await readPullRequest(t, REF)).toEqual({ complete: false, reason: 'request_failed' });
  });

  it('reports incomplete on malformed and missing PR responses', async () => {
    expect(await readPullRequest(async () => ({ data: { repository: { pullRequest: { state: 'WAT' } } } }), REF)).toEqual({ complete: false, reason: 'malformed_response' });
    expect(await readPullRequest(async () => ({ data: { repository: { pullRequest: null } } }), REF)).toEqual({ complete: false, reason: 'pull_request_not_found' });
    expect(await readPullRequest(async () => 'nonsense', REF)).toEqual({ complete: false, reason: 'malformed_response' });
  });

  it('enforces the per-connection page cap', async () => {
    const reviews = Array.from({ length: 1001 }, (_, i) => review(i + 1));
    expect(await read({ reviews })).toMatchObject({ result: { complete: false, reason: 'page_cap' } });
    const exactlyTen = await read({ reviews: reviews.slice(0, 1000) });
    expect(exactlyTen.result.complete).toBe(true);
  });

  it('enforces the per-cycle request cap, node() paging included', async () => {
    const threads: RawThread[] = Array.from({ length: 5 }, (_, i) => ({ id: `T${i}`, isResolved: false, comments: Array.from({ length: 150 }, (_, j) => comment(i * 1000 + j + 1, 1, 'x')) }));
    const { result, calls } = await read({ threads }, { maxPages: 10, maxRequests: 4 });
    expect(result).toEqual({ complete: false, reason: 'request_cap' });
    expect(calls).toHaveLength(4);
    expect((await read({ threads })).result.complete).toBe(true);
  });

  it('enforces the page cap on thread comments', async () => {
    const comments = Array.from({ length: 1001 }, (_, i) => comment(i + 1, 1, 'x'));
    const { result } = await read({ threads: [{ id: 'T', isResolved: false, comments }] }, { maxPages: 10, maxRequests: 40 });
    expect(result).toEqual({ complete: false, reason: 'page_cap' });
  });

  it('gives up when the PR moves between pages', async () => {
    let n = 0;
    const inner = server({ reviews: Array.from({ length: 150 }, (_, i) => review(i + 1)) });
    const t: GraphqlTransport = async (q, v) => {
      const body = (await inner(q, v)) as { data: { repository: { pullRequest: { headRefOid: string } } } };
      if (++n === 2) body.data.repository.pullRequest.headRefOid = 'c'.repeat(40);
      return body;
    };
    expect(await readPullRequest(t, REF)).toEqual({ complete: false, reason: 'moved_during_read' });
  });
});

describe('normalizeSnapshot', () => {
  const snap = async (model: Model, observedAt = 123) => {
    const { result } = await read(model);
    return normalizeSnapshot(result, registry, observedAt);
  };

  it('keeps no bodies, logins, paths or URLs', async () => {
    const s = await snap({
      reviews: [review(1, { state: 'CHANGES_REQUESTED', body: 'secret body https://x.example/@bob' })],
      threads: [{ id: 'T', isResolved: false, comments: [comment(10, 1, 'SECRET-THREAD')] }],
    });
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/secret|http|@|bob/iu);
    expect(Object.keys(s).sort()).toEqual(['base_ref', 'base_sha', 'complete', 'head', 'moved', 'observed_at', 'pr_state', 'reviews']);
    expect(Object.keys(s.reviews[0]!).sort()).toEqual(['feedback_digest', 'has_feedback', 'review_commit', 'review_id', 'reviewer', 'state', 'submitted_at']);
  });

  it('carries head, base, state, observed_at and review commits', async () => {
    const s = await snap({ state: 'MERGED', reviews: [review(1, { commit: { oid: BASE } }), review(2, { commit: null })] }, 999);
    expect(s).toMatchObject({ pr_state: 'MERGED', head: HEAD, base_sha: BASE, base_ref: 'main', observed_at: 999, complete: true, moved: false });
    expect(s.reviews.map((r) => r.review_commit)).toEqual([BASE, '']);
    expect(s.reviews[0]!.submitted_at).toBe(T0 + 1000);
  });

  it('maps User to a null app id and Bot through the registry by actor id', async () => {
    const s = await snap({
      reviews: [
        review(1, { author: user(200) }), // a User sharing a registered Bot's number is still not that App
        review(2, { author: bot(200) }),
        review(3, { author: bot(999) }),
        review(4, { author: null }),
        review(5, { author: { __typename: 'Mannequin' } }),
      ],
    });
    expect(s.reviews.map((r) => r.reviewer)).toEqual([
      { app_id: null, actor_id: 200 }, { app_id: 55, actor_id: 200 }, { app_id: null, actor_id: 999 }, { app_id: null, actor_id: 0 }, { app_id: null, actor_id: 0 },
    ]);
  });

  it('computes has_feedback: body, unresolved thread, empty and whitespace-only bodies, resolved threads', async () => {
    const s = await snap({
      reviews: [
        review(1, { state: 'CHANGES_REQUESTED', body: 'please fix' }),
        review(2, { state: 'CHANGES_REQUESTED', body: '' }),
        review(3, { state: 'CHANGES_REQUESTED', body: ' \r\n\t \n' }),
        review(4, { state: 'CHANGES_REQUESTED', body: '' }),
        review(5, { state: 'CHANGES_REQUESTED', body: '' }),
        review(6, { state: 'CHANGES_REQUESTED', body: '' }),
      ],
      threads: [
        { id: 'T1', isResolved: false, comments: [comment(10, 4, 'inline'), comment(11, 1, 'reply from other review')] },
        { id: 'T2', isResolved: true, comments: [comment(12, 5, 'resolved')] },
        { id: 'T3', isResolved: false, comments: [comment(13, 6, '  \n'), comment(14, null, 'orphan')] },
      ],
    });
    expect(s.reviews.map((r) => r.has_feedback)).toEqual([true, false, false, true, false, false]);
    expect(s.reviews.map((r) => r.feedback_digest === null)).toEqual([false, true, true, false, true, true]);
    // review 1 owns a thread comment too, so its digest differs from a body-only digest
    expect(s.reviews[0]!.feedback_digest).toBe(feedbackDigest('please fix', [{ threadId: 'T1', databaseId: 11, body: 'reply from other review' }]));
    expect(s.reviews[3]!.feedback_digest).toBe(feedbackDigest('', [{ threadId: 'T1', databaseId: 10, body: 'inline' }]));
  });

  it('digest is stable across CRLF, trailing whitespace and thread/comment arrival order, and changes with content', async () => {
    const base = (body: string, order: 'ab' | 'ba') => {
      const a: RawThread = { id: 'Ta', isResolved: false, comments: [comment(1, 1, 'one  '), comment(2, 1, 'two')] };
      const b: RawThread = { id: 'Tb', isResolved: false, comments: [comment(3, 1, 'three')] };
      return snap({ reviews: [review(1, { state: 'CHANGES_REQUESTED', body })], threads: order === 'ab' ? [a, b] : [b, { ...a, comments: [...a.comments].reverse() }] });
    };
    const x = (await base('fix\n', 'ab')).reviews[0]!.feedback_digest;
    expect((await base('\r\nfix  \r\n\r\n', 'ba')).reviews[0]!.feedback_digest).toBe(x);
    expect((await base('fixed', 'ab')).reviews[0]!.feedback_digest).not.toBe(x);
  });

  it('skips PENDING and unsubmitted reviews; keeps DISMISSED and all four states', async () => {
    const s = await snap({
      reviews: [
        review(1, { state: 'PENDING', submittedAt: null }),
        review(2, { state: 'APPROVED' }), review(3, { state: 'CHANGES_REQUESTED' }), review(4, { state: 'COMMENTED' }), review(5, { state: 'DISMISSED' }),
        review(6, { submittedAt: null }),
      ],
    });
    expect(s.reviews.map((r) => r.state)).toEqual(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);
  });

  it('reads multi-page reviews fully and feeds decideChainStep', async () => {
    const reviews = Array.from({ length: 130 }, (_, i) => review(i + 1, { author: user(300), commit: { oid: BASE } }));
    reviews.push(review(500, { state: 'CHANGES_REQUESTED', body: 'late page' }));
    const s = await snap({ reviews });
    expect(s.reviews).toHaveLength(131);
    const chain: ChainView = { mode: 'shadow', state: 'awaiting_review', published_head: HEAD, published_base: BASE, base_ref: 'main', rounds_used: 0, grant_rounds: null, review_deadline: null, reserved_heads: [] };
    const d = decideChainStep(chain, s, registry, T0 + 501_000);
    expect(d).toMatchObject({ kind: 'would_reserve', review_ids: [500] });
  });

  it('an incomplete read yields complete=false with no facts, and decides nothing', async () => {
    const s = normalizeSnapshot({ complete: false, reason: 'page_cap' }, registry, 5);
    expect(s).toMatchObject({ complete: false, reviews: [], head: '', observed_at: 5 });
    const chain: ChainView = { mode: 'shadow', state: 'awaiting_review', published_head: HEAD, published_base: BASE, base_ref: 'main', rounds_used: 0, grant_rounds: null, review_deadline: null, reserved_heads: [] };
    expect(decideChainStep(chain, s, registry, 5)).toMatchObject({ kind: 'none', reason: 'snapshot_incomplete' });
  });
});

describe('ghGraphqlTransport', () => {
  it('refuses mutations and subscriptions before running anything', async () => {
    let ran = 0;
    const exec: GhExec = async () => { ran += 1; return { stdout: '{}', stderr: '', exitCode: 0 }; };
    const t = ghGraphqlTransport(exec);
    await expect(t('mutation { addComment(input: {}) { clientMutationId } }', {})).rejects.toThrow('BRIDGE_READ_MUTATION_DENIED');
    await expect(t('  Mutation M { x }', {})).rejects.toThrow('BRIDGE_READ_MUTATION_DENIED');
    await expect(t('subscription { x }', {})).rejects.toThrow('BRIDGE_READ_MUTATION_DENIED');
    expect(ran).toBe(0);
  });

  it('passes strings raw and numbers/booleans typed, skips nulls, and adds no token', async () => {
    let seen: { args: readonly string[]; options: object } | undefined;
    const exec: GhExec = async (args, options) => { seen = { args, options }; return { stdout: '{"data":{}}', stderr: '', exitCode: 0 }; };
    const body = await ghGraphqlTransport(exec)('query { viewer { id } }', { owner: 'o', number: 7, flag: true, cursor: null, after: undefined });
    expect(body).toEqual({ data: {} });
    expect(seen!.args).toEqual(['api', 'graphql', '-f', 'query=query { viewer { id } }', '-f', 'owner=o', '-F', 'number=7', '-F', 'flag=true']);
    expect(Object.keys(seen!.options)).toEqual(['timeoutMs']);
  });

  it('turns non-zero exits and bad output into scrubbed errors', async () => {
    const fail: GhExec = async () => ({ stdout: '', stderr: 'bad credentials ghp_abcdef123456', exitCode: 1 });
    await expect(ghGraphqlTransport(fail)('query { x }', {})).rejects.toThrow(/GH_GRAPHQL_FAILED:1:.*\[REDACTED\]/u);
    await expect(ghGraphqlTransport(fail)('query { x }', {})).rejects.not.toThrow(/ghp_/u);
    const junk: GhExec = async () => ({ stdout: 'not json', stderr: '', exitCode: 0 });
    await expect(ghGraphqlTransport(junk)('query { x }', {})).rejects.toThrow('GH_GRAPHQL_MALFORMED');
  });

  it('the reader never emits a mutation through a real-shaped transport (denial surfaces as incomplete)', async () => {
    const exec: GhExec = async () => ({ stdout: '{"data":{"repository":{"pullRequest":null}}}', stderr: '', exitCode: 0 });
    expect(await readPullRequest(ghGraphqlTransport(exec), REF)).toEqual({ complete: false, reason: 'pull_request_not_found' });
  });
});

describe('secondRead', () => {
  const expected = { head: HEAD, base_sha: BASE, base_ref: 'main', reviews: [{ review_id: 2, state: 'CHANGES_REQUESTED' as const }] };
  const answer = (over: Record<string, unknown> = {}, nodes: unknown[] = [{ databaseId: 1, state: 'COMMENTED' }, { databaseId: 2, state: 'CHANGES_REQUESTED' }]) =>
    async () => ({ data: { repository: { pullRequest: { headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main', reviews: { nodes }, ...over } } } });

  it('is not moved when nothing changed', async () => {
    expect(await secondRead(answer(), REF, expected)).toBe(false);
  });
  it.each([
    ['head', { headRefOid: 'c'.repeat(40) }],
    ['base sha', { baseRefOid: 'c'.repeat(40) }],
    ['base ref', { baseRefName: 'other' }],
  ])('is moved when the %s changed', async (_n, over) => {
    expect(await secondRead(answer(over), REF, expected)).toBe(true);
  });
  it('is moved when a selected review changed state or is not on the first page', async () => {
    expect(await secondRead(answer({}, [{ databaseId: 2, state: 'DISMISSED' }]), REF, expected)).toBe(true);
    expect(await secondRead(answer({}, [{ databaseId: 1, state: 'COMMENTED' }]), REF, expected)).toBe(true);
  });
  it('is moved on transport failure, GraphQL errors and malformed output', async () => {
    expect(await secondRead(async () => { throw new Error('x'); }, REF, expected)).toBe(true);
    expect(await secondRead(async () => ({ errors: [{}], data: null }), REF, expected)).toBe(true);
    expect(await secondRead(async () => ({ data: { repository: { pullRequest: null } } }), REF, expected)).toBe(true);
    expect(await secondRead(async () => 42, REF, expected)).toBe(true);
  });
  it('asks only for the small field set', async () => {
    let query = '';
    await secondRead(async (q) => { query = q; return answer()(); }, REF, expected);
    expect(query).toContain('headRefOid baseRefOid baseRefName');
    expect(query).not.toMatch(/mutation|subscription|body|reviewThreads/iu);
  });
});
