// Read-only PR reader for the bridge shadow reconciler (appendix §5.1). Two layers:
//   transport (gh api graphql, injectable) -> raw pages -> normalizeSnapshot() -> PrSnapshot (no bodies).
// Query operations only; never touches App credentials. Lazy-imported only.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { PrSnapshot, PrState, ProducerRegistry, ReviewState, SnapshotReview } from '@osstack/core';
import { redactSecrets } from '@osstack/governance';
import { z } from 'zod';

export type GraphqlTransport = (query: string, variables: Record<string, unknown>) => Promise<unknown>;
export interface PullRequestRef {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}
export interface ReadLimits {
  /** Pages per connection (top-level connections and each thread's comments). */
  readonly maxPages: number;
  /** Requests per read cycle, node() paging included. */
  readonly maxRequests: number;
}
export const DEFAULT_READ_LIMITS: ReadLimits = { maxPages: 10, maxRequests: 40 };

const PAGE = 100;

/** Single source of the document: each connection is switched on by a variable so later pages only fetch what is unfinished. */
export const PULL_REQUEST_QUERY = `query BridgePullRequest($owner: String!, $name: String!, $number: Int!, $reviews: Boolean!, $reviewsAfter: String, $threads: Boolean!, $threadsAfter: String, $commits: Boolean!, $commitsAfter: String, $timeline: Boolean!, $timelineAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state merged closed headRefName headRefOid headRepository { nameWithOwner } baseRefName baseRefOid
      reviews(first: ${PAGE}, after: $reviewsAfter) @include(if: $reviews) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId state submittedAt commit { oid } author { __typename ... on User { databaseId } ... on Bot { databaseId } } body }
      }
      reviewThreads(first: ${PAGE}, after: $threadsAfter) @include(if: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved
          comments(first: ${PAGE}) {
            pageInfo { hasNextPage endCursor }
            nodes { databaseId pullRequestReview { databaseId } body author { __typename ... on User { databaseId } ... on Bot { databaseId } } }
          }
        }
      }
      commits(first: ${PAGE}, after: $commitsAfter) @include(if: $commits) {
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid } }
      }
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, BASE_REF_FORCE_PUSHED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT], first: ${PAGE}, after: $timelineAfter) @include(if: $timeline) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename }
      }
    }
  }
}`;

export const THREAD_COMMENTS_QUERY = `query BridgeThreadComments($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: ${PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId pullRequestReview { databaseId } body author { __typename ... on User { databaseId } ... on Bot { databaseId } } }
      }
    }
  }
}`;

export const SECOND_READ_QUERY = `query BridgeSecondRead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid baseRefOid baseRefName
      reviews(first: ${PAGE}) { nodes { databaseId state } }
    }
  }
}`;

// ---------------------------------------------------------------- transport

export class ReadMutationDenied extends Error {
  constructor() {
    super('BRIDGE_READ_MUTATION_DENIED');
  }
}

/** The reader is read-only by construction; this keeps that true for any document handed to the transport. */
export function assertQueryOnly(document: string): void {
  if (/mutation|subscription/iu.test(document)) throw new ReadMutationDenied();
}

export type GhExec = (args: readonly string[], options: { timeoutMs: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultGhExec: GhExec = (args, options) =>
  new Promise((resolve) => {
    execFile('gh', [...args], { timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, exitCode: 0 });
      const failure = error as NodeJS.ErrnoException;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: typeof failure.code === 'number' ? failure.code : 1 });
    });
  });

const printable = (text: string): string => Array.from(text, (ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('');
const scrub = (text: string): string => printable(redactSecrets(text).replace(/gh[pousr]_[A-Za-z0-9_]+/gu, '[REDACTED]')).slice(0, 200);

/** `gh api graphql` with the host's own gh authentication (no App token is ever added). Strings go as raw `-f`, numbers and booleans as typed `-F`. */
export function ghGraphqlTransport(exec: GhExec = defaultGhExec, timeoutMs = 30_000): GraphqlTransport {
  return async (query, variables) => {
    assertQueryOnly(query);
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') args.push('-f', `${key}=${value}`);
      else if (typeof value === 'number' || typeof value === 'boolean') args.push('-F', `${key}=${String(value)}`);
      else throw new Error('GH_GRAPHQL_VARIABLE_TYPE');
    }
    const done = await exec(args, { timeoutMs });
    if (done.exitCode !== 0) throw new Error(`GH_GRAPHQL_FAILED:${done.exitCode}:${scrub(done.stderr)}`);
    try {
      return JSON.parse(done.stdout) as unknown;
    } catch {
      throw new Error('GH_GRAPHQL_MALFORMED');
    }
  };
}

// ---------------------------------------------------------------- raw pages

const authorSchema = z.object({ __typename: z.string(), databaseId: z.number().int().optional() }).nullable();
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodTypeAny>(node: T) => z.object({ pageInfo: pageInfoSchema, nodes: z.array(node.nullable()) });

const rawReviewSchema = z.object({
  databaseId: z.number().int(),
  state: z.string(),
  submittedAt: z.string().nullable(),
  commit: z.object({ oid: z.string() }).nullable(),
  author: authorSchema,
  body: z.string(),
});
const rawCommentSchema = z.object({
  databaseId: z.number().int(),
  pullRequestReview: z.object({ databaseId: z.number().int() }).nullable(),
  body: z.string(),
  author: authorSchema,
});
const rawThreadSchema = z.object({ id: z.string(), isResolved: z.boolean(), comments: connection(rawCommentSchema) });
const prSchema = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  merged: z.boolean(),
  closed: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  baseRefName: z.string(),
  baseRefOid: z.string(),
  reviews: connection(rawReviewSchema).optional(),
  reviewThreads: connection(rawThreadSchema).optional(),
  commits: connection(z.object({ commit: z.object({ oid: z.string() }) })).optional(),
  timelineItems: connection(z.object({ __typename: z.string() })).optional(),
});
const envelopeSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: prSchema.nullable() }).nullable() }).nullable().optional(),
  errors: z.array(z.unknown()).optional(),
});
const threadEnvelopeSchema = z.object({
  data: z.object({ node: z.object({ comments: connection(rawCommentSchema) }).nullable() }).nullable().optional(),
  errors: z.array(z.unknown()).optional(),
});

export type RawAuthor = z.infer<typeof authorSchema>;
export type RawReview = z.infer<typeof rawReviewSchema>;
export type RawComment = z.infer<typeof rawCommentSchema>;
export interface RawThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly comments: readonly RawComment[];
}
/** Everything the query returns, bodies included. In memory only: normalizeSnapshot() is the last consumer. */
export interface RawPullRequest {
  readonly state: PrState;
  readonly merged: boolean;
  readonly closed: boolean;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly headRepository: string | null;
  readonly baseRefName: string;
  readonly baseRefOid: string;
  readonly reviews: readonly RawReview[];
  readonly threads: readonly RawThread[];
  readonly commits: readonly string[];
  readonly timeline: readonly string[];
  /** Number of requests spent (diagnostics). */
  readonly requests: number;
}
export type PullRequestRead =
  | { readonly complete: true; readonly pr: RawPullRequest }
  | { readonly complete: false; readonly reason: string };

class Incomplete extends Error {}

type ConnectionName = 'reviews' | 'reviewThreads' | 'commits' | 'timelineItems';
const CONNECTIONS: readonly { name: ConnectionName; flag: string; after: string }[] = [
  { name: 'reviews', flag: 'reviews', after: 'reviewsAfter' },
  { name: 'reviewThreads', flag: 'threads', after: 'threadsAfter' },
  { name: 'commits', flag: 'commits', after: 'commitsAfter' },
  { name: 'timelineItems', flag: 'timeline', after: 'timelineAfter' },
];

/** Reads one PR completely or reports why it could not. Never throws for transport failures, GraphQL errors or caps. */
export async function readPullRequest(transport: GraphqlTransport, ref: PullRequestRef, limits: ReadLimits = DEFAULT_READ_LIMITS): Promise<PullRequestRead> {
  let requests = 0;
  const send = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    if (requests >= limits.maxRequests) throw new Incomplete('request_cap');
    requests += 1;
    let body: unknown;
    try {
      body = await transport(query, variables);
    } catch {
      throw new Incomplete('request_failed');
    }
    if (typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors) && (body as { errors: unknown[] }).errors.length > 0) {
      throw new Incomplete('graphql_errors');
    }
    return body;
  };
  try {
    const pages = new Map<ConnectionName, { nodes: unknown[]; pages: number; next: string | null | undefined }>();
    for (const c of CONNECTIONS) pages.set(c.name, { nodes: [], pages: 0, next: undefined });
    let first: z.infer<typeof prSchema> | undefined;
    let pending: ConnectionName[] = CONNECTIONS.map((c) => c.name);
    while (pending.length > 0) {
      const variables: Record<string, unknown> = { owner: ref.owner, name: ref.name, number: ref.number };
      for (const c of CONNECTIONS) {
        const on = pending.includes(c.name);
        variables[c.flag] = on;
        const cursor = pages.get(c.name)!.next;
        if (on && cursor) variables[c.after] = cursor;
      }
      const parsed = envelopeSchema.safeParse(await send(PULL_REQUEST_QUERY, variables));
      if (!parsed.success) throw new Incomplete('malformed_response');
      const pr = parsed.data.data?.repository?.pullRequest;
      if (!pr) throw new Incomplete('pull_request_not_found');
      if (!first) first = pr;
      else if (pr.headRefOid !== first.headRefOid || pr.baseRefOid !== first.baseRefOid || pr.baseRefName !== first.baseRefName || pr.state !== first.state) {
        throw new Incomplete('moved_during_read');
      }
      const still: ConnectionName[] = [];
      for (const name of pending) {
        const conn = pr[name];
        if (!conn) throw new Incomplete('malformed_response');
        const acc = pages.get(name)!;
        acc.pages += 1;
        acc.nodes.push(...conn.nodes);
        if (conn.pageInfo.hasNextPage) {
          if (!conn.pageInfo.endCursor) throw new Incomplete('malformed_response');
          if (acc.pages >= limits.maxPages) throw new Incomplete('page_cap');
          acc.next = conn.pageInfo.endCursor;
          still.push(name);
        }
      }
      pending = still;
    }
    if (!first) throw new Incomplete('malformed_response');
    const nodesOf = <T>(name: ConnectionName): T[] => pages.get(name)!.nodes.filter((n) => n !== null) as T[];
    const threadsRaw = nodesOf<z.infer<typeof rawThreadSchema>>('reviewThreads');
    const threads: RawThread[] = [];
    for (const thread of threadsRaw) {
      const comments = thread.comments.nodes.filter((n): n is RawComment => n !== null);
      let { hasNextPage, endCursor } = thread.comments.pageInfo;
      let pageCount = 1;
      while (hasNextPage) {
        if (!endCursor) throw new Incomplete('malformed_response');
        if (pageCount >= limits.maxPages) throw new Incomplete('page_cap');
        const parsed = threadEnvelopeSchema.safeParse(await send(THREAD_COMMENTS_QUERY, { id: thread.id, after: endCursor }));
        const conn = parsed.success ? parsed.data.data?.node?.comments : undefined;
        if (!conn) throw new Incomplete('malformed_response');
        pageCount += 1;
        comments.push(...conn.nodes.filter((n): n is RawComment => n !== null));
        ({ hasNextPage, endCursor } = conn.pageInfo);
      }
      threads.push({ id: thread.id, isResolved: thread.isResolved, comments });
    }
    return {
      complete: true,
      pr: {
        state: first.state,
        merged: first.merged,
        closed: first.closed,
        headRefName: first.headRefName,
        headRefOid: first.headRefOid,
        headRepository: first.headRepository?.nameWithOwner ?? null,
        baseRefName: first.baseRefName,
        baseRefOid: first.baseRefOid,
        reviews: nodesOf<RawReview>('reviews'),
        threads,
        commits: nodesOf<{ commit: { oid: string } }>('commits').map((n) => n.commit.oid),
        timeline: nodesOf<{ __typename: string }>('timelineItems').map((n) => n.__typename),
        requests,
      },
    };
  } catch (error) {
    if (error instanceof Incomplete) return { complete: false, reason: error.message };
    return { complete: false, reason: 'unexpected_error' };
  }
}

// ---------------------------------------------------------------- normalisation

/** CRLF -> LF, trailing whitespace stripped per line, leading and trailing blank lines removed. */
export function normalizeBody(body: string): string {
  const lines = body.replace(/\r\n/gu, '\n').split('\n').map((line) => line.replace(/\s+$/u, ''));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

const part = (label: string, text: string): string => `${label}:${Buffer.byteLength(text, 'utf8')}:${text}\n`;

/** sha256 over a length-prefixed encoding of the normalised top-level body and the review's unresolved thread comments,
 * ordered by thread id then comment databaseId. Length prefixes make the encoding injective. */
export function feedbackDigest(topLevel: string, comments: readonly { threadId: string; databaseId: number; body: string }[]): string {
  const sorted = [...comments].sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : a.databaseId - b.databaseId));
  const hash = createHash('sha256');
  hash.update('osstack-bridge-feedback-v1\n');
  hash.update(part('body', topLevel));
  for (const c of sorted) {
    hash.update(part('thread', c.threadId));
    hash.update(part('comment', String(c.databaseId)));
    hash.update(part('text', c.body));
  }
  return hash.digest('hex');
}

const REVIEW_STATES: ReadonlySet<string> = new Set<ReviewState>(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

function reviewerOf(author: RawAuthor, registry: ProducerRegistry): { app_id: number | null; actor_id: number } {
  if (!author || author.databaseId === undefined || author.databaseId <= 0) return { app_id: null, actor_id: 0 };
  if (author.__typename === 'Bot') {
    const entry = [...registry.reviewers, ...registry.publisher].find((p) => p.actor_id === author.databaseId);
    return { app_id: entry?.app_id ?? null, actor_id: author.databaseId };
  }
  // User (or any other typename that carries an id): never an App.
  return { app_id: null, actor_id: author.databaseId };
}

/** Raw pages -> PrSnapshot. Bodies, paths, logins and URLs are dropped here. An incomplete read yields a snapshot with
 * `complete: false` and empty facts, which decideChainStep treats as "decide nothing". PENDING reviews (never visible
 * to others) and reviews without a usable timestamp are skipped. */
export function normalizeSnapshot(read: PullRequestRead, registry: ProducerRegistry, observedAt: number): PrSnapshot {
  if (!read.complete) {
    return { pr_state: 'OPEN', head: '', base_sha: '', base_ref: '', observed_at: observedAt, reviews: [], complete: false, moved: false };
  }
  const { pr } = read;
  const unresolved = new Map<number, { threadId: string; databaseId: number; body: string }[]>();
  for (const thread of pr.threads) {
    if (thread.isResolved) continue;
    for (const comment of thread.comments) {
      const reviewId = comment.pullRequestReview?.databaseId;
      if (reviewId === undefined) continue;
      const body = normalizeBody(comment.body);
      if (body === '') continue;
      const list = unresolved.get(reviewId) ?? [];
      list.push({ threadId: thread.id, databaseId: comment.databaseId, body });
      unresolved.set(reviewId, list);
    }
  }
  const reviews: SnapshotReview[] = [];
  for (const raw of pr.reviews) {
    if (!REVIEW_STATES.has(raw.state) || raw.submittedAt === null) continue;
    const submitted = Date.parse(raw.submittedAt);
    if (!Number.isFinite(submitted)) continue;
    const top = normalizeBody(raw.body);
    const comments = unresolved.get(raw.databaseId) ?? [];
    const hasFeedback = top !== '' || comments.length > 0;
    reviews.push({
      review_id: raw.databaseId,
      state: raw.state as ReviewState,
      submitted_at: submitted,
      review_commit: raw.commit?.oid ?? '',
      reviewer: reviewerOf(raw.author, registry),
      has_feedback: hasFeedback,
      feedback_digest: hasFeedback ? feedbackDigest(top, comments) : null,
    });
  }
  return { pr_state: pr.state, head: pr.headRefOid, base_sha: pr.baseRefOid, base_ref: pr.baseRefName, observed_at: observedAt, reviews, complete: true, moved: false };
}

// ---------------------------------------------------------------- second read

const secondReadSchema = z.object({
  data: z
    .object({
      repository: z.object({
        pullRequest: z
          .object({
            headRefOid: z.string(),
            baseRefOid: z.string(),
            baseRefName: z.string(),
            reviews: z.object({ nodes: z.array(z.object({ databaseId: z.number().int(), state: z.string() }).nullable()) }),
          })
          .nullable(),
      }).nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.unknown()).optional(),
});

/** One small query before a would_reserve / would_mark_ready is recorded. Returns true ("moved") when the head, base sha,
 * base ref or any selected review's state differs, when a selected review is not on the first page of reviews, and on any
 * failure: a decision that cannot be confirmed is discarded. */
export async function secondRead(
  transport: GraphqlTransport,
  ref: PullRequestRef,
  expected: { head: string; base_sha: string; base_ref: string; reviews: readonly { review_id: number; state: ReviewState }[] },
): Promise<boolean> {
  try {
    const parsed = secondReadSchema.safeParse(await transport(SECOND_READ_QUERY, { owner: ref.owner, name: ref.name, number: ref.number }));
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) return true;
    const pr = parsed.data.data?.repository?.pullRequest;
    if (!pr) return true;
    if (pr.headRefOid !== expected.head || pr.baseRefOid !== expected.base_sha || pr.baseRefName !== expected.base_ref) return true;
    const states = new Map<number, string>();
    for (const node of pr.reviews.nodes) if (node) states.set(node.databaseId, node.state);
    return expected.reviews.some((r) => states.get(r.review_id) !== r.state);
  } catch {
    return true;
  }
}
