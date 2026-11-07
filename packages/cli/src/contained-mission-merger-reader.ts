// Read-only PR reader for the bridge shadow merger (merger design §3.4, §5.1). Two layers:
//   transports (gh api graphql / gh api --method GET, injectable) -> raw pages -> normalised MergeSnapshot (no bodies)
//   -> MergeGateInput for evaluateMergeGates() (@osstack/core, M-A).
// Query operations and GET requests only; never mints or reads an App token, never imports App-credential modules.
// Lazy-imported only (not part of the CLI startup chunk).
import {
  DEFAULT_MERGE_GATE_OPTIONS,
  evaluateMergeGates,
  type MergeGateInput,
  type MergeGateOptions,
  type MergerRegistry,
  type MergeSnapshot,
  type MergeSnapshotReview,
  type MissionMergeEvidence,
  type RulesetBypass,
  type SnapshotCheckRun,
  type SnapshotPullRequestRule,
  type SnapshotRuleset,
  type SnapshotStatusRule,
} from '@osstack/core';
import { z } from 'zod';
import { defaultGhExec, ghGraphqlTransport, type GhExec, type GraphqlTransport } from './contained-mission-bridge-reader.js';
import { parseMissionMarkers } from './contained-mission-marker.js';

export { ghGraphqlTransport, type GraphqlTransport };

const PAGE = 100;

export interface MergerReadLimits {
  /** Pages per connection or REST list. */
  readonly maxPages: number;
  /** `files` pages (G4b). */
  readonly filesMaxPages: number;
  /** Requests for the whole cycle: the first read and, when it reaches `would_merge`, the second one share this budget. */
  readonly maxRequests: number;
}
export const DEFAULT_MERGER_READ_LIMITS: MergerReadLimits = { maxPages: 10, filesMaxPages: 30, maxRequests: 100 };

// ---------------------------------------------------------------- REST transport (GET only)

export type RestResult =
  | { readonly ok: true; readonly body: unknown }
  /** `status` is the HTTP status when gh reported one. `branchNotProtected` is true only for GitHub's fixed "Branch not protected" message. */
  | { readonly ok: false; readonly status: number | null; readonly branchNotProtected: boolean };
export type RestGet = (path: string) => Promise<RestResult>;

export interface RestScope {
  /** Registered `owner/name`; the only repository a request may name. */
  readonly repository: string;
  /** Registered ruleset ids (quality, update, mission writers/history); the only ids `rulesets/{id}` may name. */
  readonly rulesetIds: readonly number[];
}

export class MergerReadDenied extends Error {
  constructor() {
    super('MERGER_READ_DENIED');
  }
}

const SHA = '[0-9a-f]{40}(?:[0-9a-f]{24})?';
const REF = '[A-Za-z0-9_.-]+(?:%2F[A-Za-z0-9_.-]+)*';
const QUERY = '(?:\\?[A-Za-z0-9_.%=&-]+)?';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
const DOT_SEGMENT = /(?:^|\/|%2F)\.{1,2}(?:\/|%2F|\?|$)/iu;

/** The complete list of paths the merger may GET. Anything else, a foreign repository or an unregistered ruleset id throws `MERGER_READ_DENIED`. */
export function assertRestPathAllowed(path: string, scope: RestScope): void {
  if (typeof path !== 'string' || path.length > 512 || DOT_SEGMENT.test(path)) throw new MergerReadDenied();
  const repo = escapeRe(scope.repository);
  const patterns = [
    new RegExp(`^repos/${repo}/commits/${SHA}/check-suites${QUERY}$`, 'u'),
    new RegExp(`^repos/${repo}/check-suites/[0-9]+/check-runs${QUERY}$`, 'u'),
    new RegExp(`^repos/${repo}/rules/branches/${REF}${QUERY}$`, 'u'),
    new RegExp(`^repos/${repo}/branches/${REF}/protection$`, 'u'),
  ];
  if (patterns.some((p) => p.test(path))) return;
  const ruleset = new RegExp(`^repos/${repo}/rulesets/([0-9]+)$`, 'u').exec(path);
  if (ruleset && scope.rulesetIds.includes(Number(ruleset[1]))) return;
  throw new MergerReadDenied();
}

/** `gh api` switches to POST as soon as it is given -f/-F, so the argv is fixed: nothing but the path varies. */
export function restArgv(path: string): string[] {
  return ['api', '--method', 'GET', path, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
}
/** Refuses any argv that is not exactly the fixed GET shape for an allowed path. */
export function assertRestArgv(args: readonly string[], scope: RestScope): void {
  const path = args[3];
  if (path === undefined) throw new MergerReadDenied();
  assertRestPathAllowed(path, scope);
  const expected = restArgv(path);
  if (args.length !== expected.length || args.some((a, i) => a !== expected[i])) throw new MergerReadDenied();
}

/** `gh api --method GET` with the host's own gh authentication (no App token is ever added). Failures never carry gh's stderr. */
export function ghRestGetTransport(scope: RestScope, exec: GhExec = defaultGhExec, timeoutMs = 30_000): RestGet {
  return async (path) => {
    const args = restArgv(path);
    assertRestArgv(args, scope);
    const done = await exec(args, { timeoutMs });
    if (done.exitCode === 0) {
      try {
        return { ok: true, body: JSON.parse(done.stdout) as unknown };
      } catch {
        return { ok: false, status: null, branchNotProtected: false };
      }
    }
    // gh writes the response body to stdout and "<message> (HTTP <status>)" to stderr on an API error. Only the status and one fixed message are kept.
    let status: number | null = null;
    let message: string | null = null;
    try {
      const body = JSON.parse(done.stdout) as { status?: unknown; message?: unknown };
      if (typeof body.status === 'number' || typeof body.status === 'string') {
        const n = Number(body.status);
        if (Number.isInteger(n)) status = n;
      }
      if (typeof body.message === 'string') message = body.message;
    } catch {
      // not JSON
    }
    const http = /\(HTTP (\d{3})\)/u.exec(done.stderr);
    if (status === null && http) status = Number(http[1]);
    const notProtected = message === 'Branch not protected' || /^gh: Branch not protected \(HTTP 404\)/mu.test(done.stderr);
    return { ok: false, status, branchNotProtected: notProtected };
  };
}

// ---------------------------------------------------------------- GraphQL document

export const MERGER_PULL_REQUEST_QUERY = `query MergerPullRequest($owner: String!, $name: String!, $number: Int!, $baseRef: String!, $reviews: Boolean!, $reviewsAfter: String, $threads: Boolean!, $threadsAfter: String, $timeline: Boolean!, $timelineAfter: String, $files: Boolean!, $filesAfter: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    ref(qualifiedName: $baseRef) { target { oid } }
    pullRequest(number: $number) {
      number state isDraft mergeable mergeStateStatus reviewDecision body
      baseRepository { nameWithOwner } headRepository { nameWithOwner } isCrossRepository
      headRefName baseRefName headRefOid changedFiles
      author { __typename ... on User { databaseId } ... on Bot { databaseId } }
      baseRef { target { oid } }
      reviews(first: ${PAGE}, after: $reviewsAfter) @include(if: $reviews) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId fullDatabaseId state submittedAt authorCanPushToRepository commit { oid } author { __typename ... on User { databaseId } ... on Bot { databaseId } } }
      }
      reviewThreads(first: ${PAGE}, after: $threadsAfter) @include(if: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved }
      }
      timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT], first: ${PAGE}, after: $timelineAfter) @include(if: $timeline) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename }
      }
      files(first: ${PAGE}, after: $filesAfter) @include(if: $files) {
        pageInfo { hasNextPage endCursor }
        nodes { path changeType }
      }
    }
  }
}`;

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodTypeAny>(node: T) => z.object({ pageInfo: pageInfoSchema, nodes: z.array(node.nullable()) }).optional();
const authorSchema = z.object({ __typename: z.string(), databaseId: z.number().int().nullable().optional() }).nullable();
const reviewSchema = z.object({
  databaseId: z.number().int().nullable(),
  fullDatabaseId: z.union([z.string(), z.number()]).nullable().optional(),
  state: z.string(),
  submittedAt: z.string().nullable(),
  authorCanPushToRepository: z.boolean().nullable().optional(),
  commit: z.object({ oid: z.string() }).nullable(),
  author: authorSchema,
});
const repoName = z.object({ nameWithOwner: z.string() }).nullable();
const prSchema = z.object({
  number: z.number().int(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  body: z.string().nullable(),
  baseRepository: repoName,
  headRepository: repoName,
  isCrossRepository: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  changedFiles: z.number().int().nonnegative(),
  author: authorSchema.optional(),
  baseRef: z.object({ target: z.object({ oid: z.string() }).nullable() }).nullable(),
  reviews: connection(reviewSchema),
  reviewThreads: connection(z.object({ id: z.string(), isResolved: z.boolean() })),
  timelineItems: connection(z.object({ __typename: z.string() })),
  files: connection(z.object({ path: z.string(), changeType: z.string() })),
});
const envelopeSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          defaultBranchRef: z.object({ name: z.string() }).nullable(),
          ref: z.object({ target: z.object({ oid: z.string() }).nullable() }).nullable(),
          pullRequest: prSchema.nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.unknown()).optional(),
});

// ---------------------------------------------------------------- read state

class Abort extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class Cap extends Error {}
class Budget {
  used = 0;
  constructor(readonly max: number) {}
  take(): void {
    if (this.used >= this.max) throw new Cap();
    this.used += 1;
  }
}

export interface MergerReadDeps {
  readonly graphql: GraphqlTransport;
  readonly rest: RestGet;
  readonly limits?: Partial<MergerReadLimits>;
}

export type MergeSnapshotRead =
  | {
      readonly ok: true;
      readonly snapshot: MergeSnapshot;
      readonly issues: readonly string[];
      /** Type sequence of the retarget / close / reopen / merge / force-push events. MergeSnapshot keeps only the force-push count, so the pair of reads compares this too. */
      readonly timeline_events: readonly string[];
    }
  | { readonly ok: false; readonly codes: readonly string[] };
export type MergeGateInputRead =
  | { readonly ok: true; readonly input: MergeGateInput; readonly issues: readonly string[] }
  | { readonly ok: false; readonly codes: readonly string[] };

const MISSION_BRANCH = /^osstack\/mission\/[A-Za-z0-9_.-]+$/u;
const BASE_REF_NAME = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const REVIEW_STATES: ReadonlySet<string> = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED']);
const encodeRef = (ref: string): string => ref.split('/').map(encodeURIComponent).join('%2F');
const actorType = (a: { __typename: string } | null | undefined): 'Bot' | 'User' | 'Other' => (a?.__typename === 'Bot' ? 'Bot' : a?.__typename === 'User' ? 'User' : 'Other');

// ---------------------------------------------------------------- ruleset conditions

/** GitHub fnmatch (Ruby File.fnmatch with FNM_PATHNAME): `*` stays inside a path segment, `**` followed by `/` matches zero or more directories.
 * A bare `**` is not documented to cross `/`: in an include it is read as `*` (claims less coverage), in an exclude as `.*` (excludes more); both fail closed.
 * Classes and braces are not modelled. */
const globToRegExp = (pattern: string, excluding: boolean): RegExp => {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += excluding ? '.*' : '[^/]*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`${out}$`, 'u');
};
/** Syntax this matcher does not model (classes, braces, escapes). In an include it never matches; in an exclude it is assumed to match (fail closed). */
const UNMODELLED = /[[\]{}\\]/u;
function refMatches(pattern: string, ref: string, defaultRef: string | null, excluding: boolean): boolean {
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return defaultRef !== null && ref === defaultRef;
  if (UNMODELLED.test(pattern)) return excluding;
  return globToRegExp(pattern, excluding).test(ref);
}
/** Every Mission branch name a ruleset must cover: single-character-class probes, so a narrower glob such as `.../a*` does not pass. */
const MISSION_PROBES = ['a', 'Z', '0', '_', '.', '-', 'a.b', 'a_b-c'].map((x) => `refs/heads/osstack/mission/${x}`);

const rulesetSchema = z.object({
  enforcement: z.string(),
  target: z.string().optional(),
  conditions: z.object({ ref_name: z.object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() }).nullable().optional() }).nullable().optional(),
  rules: z.array(z.object({ type: z.string() })).optional(),
  bypass_actors: z.array(z.object({ actor_id: z.number().int().nullable().optional(), actor_type: z.string(), bypass_mode: z.string().optional() })).optional(),
});

type RulesetBody = z.infer<typeof rulesetSchema>;
function normalizeRuleset(body: RulesetBody, baseRef: string, defaultBranch: string | null): SnapshotRuleset {
  const include = body.conditions?.ref_name?.include ?? [];
  const exclude = body.conditions?.ref_name?.exclude ?? [];
  const branchTarget = body.target === 'branch';
  const baseFull = `refs/heads/${baseRef}`;
  const defaultFull = defaultBranch === null ? null : `refs/heads/${defaultBranch}`;
  const coversBase = branchTarget && include.some((p) => refMatches(p, baseFull, defaultFull, false)) && !exclude.some((p) => refMatches(p, baseFull, defaultFull, true));
  const coversMission =
    branchTarget && exclude.length === 0 && include.some((p) => p !== '~DEFAULT_BRANCH' && MISSION_PROBES.every((probe) => refMatches(p, probe, defaultFull, false)));
  const bypass: RulesetBypass[] | null =
    body.bypass_actors === undefined ? null : body.bypass_actors.map((b) => ({ actor_type: b.actor_type, actor_id: b.actor_id ?? null, bypass_mode: b.bypass_mode ?? 'always' }));
  return {
    enforcement: body.enforcement,
    covers_mission_refs: coversMission,
    covers_base_ref: coversBase,
    rule_types: [...new Set((body.rules ?? []).map((r) => r.type))].sort(),
    bypass_actors: bypass,
  };
}

// ---------------------------------------------------------------- one read pass (design 3.4 steps 1-3)

interface Conn {
  nodes: unknown[];
  pages: number;
  next: string | null;
  complete: boolean;
  done: boolean;
}
type ConnName = 'reviews' | 'reviewThreads' | 'timelineItems' | 'files';
const CONNS: readonly { name: ConnName; flag: string; after: string }[] = [
  { name: 'reviews', flag: 'reviews', after: 'reviewsAfter' },
  { name: 'reviewThreads', flag: 'threads', after: 'threadsAfter' },
  { name: 'timelineItems', flag: 'timeline', after: 'timelineAfter' },
  { name: 'files', flag: 'files', after: 'filesAfter' },
];

async function readPass(deps: MergerReadDeps, evidence: MissionMergeEvidence, registry: MergerRegistry, budget: Budget): Promise<MergeSnapshotRead> {
  const limits: MergerReadLimits = { ...DEFAULT_MERGER_READ_LIMITS, ...deps.limits };
  const issues: string[] = [];
  const note = (code: string): void => {
    if (!issues.includes(code)) issues.push(code);
  };
  const scope: RestScope = {
    repository: registry.repository,
    rulesetIds: [registry.main_quality_ruleset_id, registry.main_update_ruleset_id, ...registry.mission_ruleset_ids],
  };
  const [owner, name] = registry.repository.split('/') as [string, string];
  if (!BASE_REF_NAME.test(registry.base_ref) || registry.base_ref.split('/').some((seg) => seg === '.' || seg === '..')) return { ok: false, codes: ['U.read_failed:base_ref'] };

  try {
    // ---- step 1: GraphQL main read
    const conns = new Map<ConnName, Conn>(CONNS.map((c) => [c.name, { nodes: [], pages: 0, next: null, complete: true, done: false }]));
    let scalarsKey: string | undefined;
    let first: z.infer<typeof prSchema> | undefined;
    let defaultBranch: string | null = null;
    let crossTip: string | null = null;
    for (;;) {
      const pending = CONNS.filter((c) => !conns.get(c.name)?.done);
      if (pending.length === 0) break;
      const variables: Record<string, unknown> = { owner, name, number: evidence.pr_number, baseRef: `refs/heads/${registry.base_ref}` };
      for (const c of CONNS) {
        const state = conns.get(c.name) as Conn;
        variables[c.flag] = !state.done;
        if (!state.done && state.next) variables[c.after] = state.next;
      }
      try {
        budget.take();
      } catch {
        if (first === undefined) throw new Abort('U.read_failed:request_cap');
        for (const c of pending) {
          const s = conns.get(c.name) as Conn;
          s.complete = false;
          s.done = true;
        }
        note('request_cap');
        break;
      }
      let body: unknown;
      try {
        body = await deps.graphql(MERGER_PULL_REQUEST_QUERY, variables);
      } catch {
        throw new Abort('U.read_failed:graphql_request');
      }
      if (typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors) && (body as { errors: unknown[] }).errors.length > 0) {
        throw new Abort('U.read_failed:graphql_errors');
      }
      const parsed = envelopeSchema.safeParse(body);
      if (!parsed.success) throw new Abort('U.read_failed:graphql_malformed');
      if (!parsed.data.data) throw new Abort('U.read_failed:graphql_malformed');
      const repository = parsed.data.data.repository;
      const pr = repository?.pullRequest;
      if (!repository || !pr) throw new Abort('U.read_failed:pull_request_not_found');
      const { reviews: _r, reviewThreads: _t, timelineItems: _i, files: _f, ...scalars } = pr;
      const key = JSON.stringify([scalars, repository.defaultBranchRef, repository.ref]);
      if (first === undefined) {
        first = pr;
        scalarsKey = key;
        defaultBranch = repository.defaultBranchRef?.name ?? null;
        crossTip = repository.ref?.target?.oid ?? null;
      } else if (key !== scalarsKey) throw new Abort('U.snapshot_moved:graphql_pages');
      for (const c of pending) {
        const state = conns.get(c.name) as Conn;
        const conn = pr[c.name];
        if (!conn) throw new Abort('U.read_failed:graphql_malformed');
        state.pages += 1;
        for (const node of conn.nodes) {
          if (node === null) state.complete = false;
          else state.nodes.push(node);
        }
        if (!conn.pageInfo.hasNextPage) state.done = true;
        else if (!conn.pageInfo.endCursor) throw new Abort('U.read_failed:graphql_malformed');
        else if (state.pages >= (c.name === 'files' ? limits.filesMaxPages : limits.maxPages)) {
          state.complete = false;
          state.done = true;
          note(`page_cap:${c.name}`);
        } else state.next = conn.pageInfo.endCursor;
      }
    }
    if (first === undefined) throw new Abort('U.read_failed:graphql_malformed');
    const pr = first;
    const head = pr.headRefOid;
    const nodesOf = <T,>(n: ConnName): T[] => (conns.get(n) as Conn).nodes as T[];
    const completeOf = (n: ConnName): boolean => (conns.get(n) as Conn).complete;

    // ---- body -> marker facts; the body is dropped here
    const bodyText = (pr.body ?? '').replace(/\r\n/gu, '\n');
    const parsedMarkers = parseMissionMarkers(bodyText);
    const firstLine = /^Contained Mission `(cm_[0-9a-f-]{36})`/u.exec(bodyText.split('\n', 1)[0] ?? '');
    const marker = {
      marker: parsedMarkers.marker ? { id: parsedMarkers.marker.id, spec_digest: parsedMarkers.marker.spec_digest, start: parsedMarkers.marker.start, head: parsedMarkers.marker.head } : null,
      candidates: parsedMarkers.candidates,
      malformed: parsedMarkers.malformed,
      first_line_id: firstLine?.[1] ?? null,
    };

    // ---- reviews
    let reviewsComplete = completeOf('reviews');
    const reviewItems: MergeSnapshotReview[] = [];
    for (const raw of nodesOf<z.infer<typeof reviewSchema>>('reviews')) {
      if (raw.state === 'PENDING') continue; // never visible to anyone but its author (the host account)
      const at = raw.submittedAt === null ? Number.NaN : Date.parse(raw.submittedAt);
      if (!REVIEW_STATES.has(raw.state) || !Number.isFinite(at)) {
        reviewsComplete = false;
        continue;
      }
      // `databaseId` is null once an id no longer fits 32 bits; `fullDatabaseId` then carries it. An id that fits neither cannot be ordered: incomplete.
      const full = raw.databaseId ?? (raw.fullDatabaseId === null || raw.fullDatabaseId === undefined ? Number.NaN : Number(raw.fullDatabaseId));
      if (!Number.isSafeInteger(full)) {
        reviewsComplete = false;
        continue;
      }
      reviewItems.push({
        review_id: full,
        state: raw.state as MergeSnapshotReview['state'],
        submitted_at_ms: at,
        commit_oid: raw.commit?.oid ?? null,
        author_type: actorType(raw.author),
        author_id: raw.author?.databaseId ?? null,
        author_can_push: raw.authorCanPushToRepository === true,
      });
    }

    // ---- files (G4b). GitHub stops listing at 3 000 files; a short list against `changedFiles` is incomplete.
    // A rename reports only its destination path, so the source (possibly a workflow file) is invisible: a rename is treated as touching workflow paths.
    const changed = nodesOf<{ path: string; changeType: string }>('files');
    const filesComplete = completeOf('files') && changed.length >= pr.changedFiles;
    const workflowPathsChanged = changed.some((f) => f.changeType === 'RENAMED' || /^\.github\/(?:workflows|actions)\//iu.test(f.path));

    // ---- steps 2-3: REST, all GET
    const rest = async (path: string): Promise<RestResult> => {
      try {
        assertRestPathAllowed(path, scope);
      } catch {
        throw new Abort('U.read_failed:denied');
      }
      budget.take();
      try {
        return await deps.rest(path);
      } catch {
        return { ok: false, status: null, branchNotProtected: false };
      }
    };
    /** Pages a REST list. `pick` returns undefined for a malformed page. */
    const pagedList = async (base: string, query: string, pick: (body: unknown) => unknown[] | undefined): Promise<{ items: unknown[]; complete: boolean }> => {
      const items: unknown[] = [];
      for (let page = 1; ; page += 1) {
        let result: RestResult;
        try {
          result = await rest(`${base}?${query}${query ? '&' : ''}per_page=${PAGE}&page=${page}`);
        } catch (error) {
          if (error instanceof Cap) {
            note('request_cap');
            return { items, complete: false };
          }
          throw error;
        }
        if (!result.ok) return { items, complete: false };
        const got = pick(result.body);
        if (got === undefined) return { items, complete: false };
        items.push(...got);
        if (got.length < PAGE) return { items, complete: true };
        if (page >= limits.maxPages) {
          note('page_cap:rest');
          return { items, complete: false };
        }
      }
    };

    const repoPath = `repos/${registry.repository}`;
    const suitesBody = z.object({ check_suites: z.array(z.object({ id: z.number().int(), app: z.object({ id: z.number().int() }).nullable().optional() })) });
    const runsBody = z.object({
      check_runs: z.array(
        z.object({
          id: z.number().int(),
          name: z.string(),
          app: z.object({ id: z.number().int() }).nullable().optional(),
          external_id: z.string().nullable().optional(),
          head_sha: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
        }),
      ),
    });
    /** Runs of the given Apps' check suites on the live head (design G3 / G4: per suite, never `commits/{head}/check-runs`). */
    const collectRuns = async (apps: readonly number[], checkName: string | null): Promise<{ runs: SnapshotCheckRun[]; complete: boolean }> => {
      const runs = new Map<number, SnapshotCheckRun>();
      let complete = true;
      for (const app of apps) {
        const suites = await pagedList(`${repoPath}/commits/${head}/check-suites`, `app_id=${app}`, (body) => {
          const p = suitesBody.safeParse(body);
          return p.success ? p.data.check_suites.filter((s) => s.app?.id === undefined || s.app.id === app) : undefined;
        });
        if (!suites.complete) complete = false;
        const ids = [...new Set((suites.items as { id: number }[]).map((s) => s.id))];
        for (const id of ids) {
          const list = await pagedList(`${repoPath}/check-suites/${id}/check-runs`, `${checkName === null ? '' : `check_name=${encodeURIComponent(checkName)}&`}filter=all`, (body) => {
            const p = runsBody.safeParse(body);
            return p.success ? p.data.check_runs : undefined;
          });
          if (!list.complete) complete = false;
          for (const r of list.items as z.infer<typeof runsBody>['check_runs']) {
            runs.set(r.id, { id: r.id, app_id: r.app?.id ?? null, name: r.name, external_id: r.external_id ?? null, head_sha: r.head_sha, status: r.status, conclusion: r.conclusion });
          }
        }
      }
      return { runs: [...runs.values()].sort((a, b) => a.id - b.id), complete };
    };
    const verify = await collectRuns([registry.evidence_app_id], 'osstack/verify');
    const requiredContexts = new Set(registry.required_checks.map((c) => c.context));
    const producers = [...new Set(registry.required_checks.map((c) => c.app_id))].sort((a, b) => a - b);
    const required = await collectRuns(producers, null);

    // rules/branches/<ref>
    const ruleSchema = z.object({ type: z.string(), ruleset_id: z.number().int().nullable().optional(), parameters: z.unknown().optional() });
    const rulesFor = (ref: string) =>
      pagedList(`${repoPath}/rules/branches/${encodeRef(ref)}`, '', (body) => {
        const p = z.array(ruleSchema).safeParse(body);
        return p.success ? p.data : undefined;
      });
    type Rule = z.infer<typeof ruleSchema>;

    const baseRulesRead = await rulesFor(registry.base_ref);
    let baseRulesComplete = baseRulesRead.complete;
    const statusChecks: SnapshotStatusRule[] = [];
    const prRules: SnapshotPullRequestRule[] = [];
    const statusParams = z.object({ required_status_checks: z.array(z.object({ context: z.string(), integration_id: z.number().int().nullable().optional() })) });
    const prParams = z.object({
      required_approving_review_count: z.number().int().optional(),
      require_last_push_approval: z.boolean().optional(),
      required_review_thread_resolution: z.boolean().optional(),
      dismiss_stale_reviews_on_push: z.boolean().optional(),
    });
    for (const rule of baseRulesRead.items as Rule[]) {
      if (rule.type === 'required_status_checks') {
        const p = statusParams.safeParse(rule.parameters);
        if (!p.success) {
          baseRulesComplete = false;
          continue;
        }
        for (const c of p.data.required_status_checks) statusChecks.push({ context: c.context, integration_id: c.integration_id ?? null, ruleset_id: rule.ruleset_id ?? null });
      } else if (rule.type === 'pull_request') {
        const p = prParams.safeParse(rule.parameters);
        if (!p.success) {
          baseRulesComplete = false;
          continue;
        }
        prRules.push({
          ruleset_id: rule.ruleset_id ?? null,
          required_approving_review_count: p.data.required_approving_review_count ?? 0,
          require_last_push_approval: p.data.require_last_push_approval === true,
          required_review_thread_resolution: p.data.required_review_thread_resolution === true,
          dismiss_stale_reviews_on_push: p.data.dismiss_stale_reviews_on_push === true,
        });
      }
    }
    // Several pull_request rules combine to the strictest; the registered quality ruleset's is the one judged (G6e).
    const pullRequest = prRules.find((r) => r.ruleset_id === registry.main_quality_ruleset_id) ?? prRules[0] ?? null;

    // classic branch protection: 404 ("Branch not protected") = none; anything else that fails = unreadable (403 included)
    let legacy: MergeSnapshot['base_rules']['legacy'] = { read: 'failed', checks: [], contexts: [] };
    {
      let result: RestResult;
      try {
        result = await rest(`${repoPath}/branches/${encodeRef(registry.base_ref)}/protection`);
      } catch (error) {
        if (!(error instanceof Cap)) throw error;
        note('request_cap');
        result = { ok: false, status: null, branchNotProtected: false };
      }
      if (result.ok) {
        const p = z
          .object({
            required_status_checks: z
              .object({
                contexts: z.array(z.string()).optional(),
                checks: z.array(z.object({ context: z.string(), app_id: z.number().int().nullable().optional() })).optional(),
              })
              .nullable()
              .optional(),
          })
          .safeParse(result.body);
        if (p.success) {
          const checks = (p.data.required_status_checks?.checks ?? []).map((c) => ({ context: c.context, app_id: c.app_id !== undefined && c.app_id !== null && c.app_id > 0 ? c.app_id : null }));
          // GitHub's deprecated `contexts` repeats every context of `checks`; only a context without an App-bound entry is a bare commit status.
          const bound = new Set(checks.map((c) => c.context));
          legacy = { read: 'ok', checks, contexts: (p.data.required_status_checks?.contexts ?? []).filter((c) => !bound.has(c)) };
        }
      } else if (result.status === 404) legacy = { read: 'not_protected', checks: [], contexts: [] };
    }

    // rules/branches/<mission branch>: read for the Mission's own (ledger) branch, never for a name taken from the PR
    let missionRules: MergeSnapshot['mission_rules'] = { complete: false, ruleset_ids: [], rule_types: [] };
    if (MISSION_BRANCH.test(evidence.branch)) {
      const read = await rulesFor(evidence.branch);
      const rules = read.items as Rule[];
      const ids = rules.map((r) => r.ruleset_id);
      missionRules = {
        complete: read.complete && ids.every((id) => typeof id === 'number'),
        ruleset_ids: [...new Set(ids.filter((id): id is number => typeof id === 'number'))].sort((a, b) => a - b),
        rule_types: [...new Set(rules.map((r) => r.type))].sort(),
      };
    } else note('mission_branch_invalid');

    // rulesets/{id}: 404 is an answer (the ruleset is gone) and surfaces as an absent ruleset; any other failure, 403 included, is a transient read problem and makes the sections that depend on it incomplete.
    const rulesets: Record<string, SnapshotRuleset | undefined> = {};
    const transient = new Set<number>();
    for (const id of scope.rulesetIds) {
      let result: RestResult;
      try {
        result = await rest(`${repoPath}/rulesets/${id}`);
      } catch (error) {
        if (!(error instanceof Cap)) throw error;
        note('request_cap');
        result = { ok: false, status: null, branchNotProtected: false };
      }
      if (result.ok) {
        const p = rulesetSchema.safeParse(result.body);
        if (p.success) rulesets[String(id)] = normalizeRuleset(p.data, registry.base_ref, defaultBranch);
        else transient.add(id);
      } else if (result.status === 404) rulesets[String(id)] = undefined;
      else transient.add(id);
    }
    const baseComplete = baseRulesComplete && !transient.has(registry.main_quality_ruleset_id) && !transient.has(registry.main_update_ruleset_id);
    const missionComplete = missionRules.complete && !registry.mission_ruleset_ids.some((id) => transient.has(id));

    const snapshot: MergeSnapshot = {
      pr: {
        number: pr.number,
        state: pr.state,
        is_draft: pr.isDraft,
        mergeable: pr.mergeable,
        merge_state_status: pr.mergeStateStatus,
        review_decision: pr.reviewDecision,
        base_repository: pr.baseRepository?.nameWithOwner ?? '',
        head_repository: pr.headRepository?.nameWithOwner ?? '',
        is_cross_repository: pr.isCrossRepository,
        head_ref_name: pr.headRefName,
        base_ref_name: pr.baseRefName,
        head_oid: head,
        author: pr.author ? { type: actorType(pr.author), database_id: pr.author.databaseId ?? null } : null,
        base_tip_oid: pr.baseRef?.target?.oid ?? null,
        base_tip_crosscheck_oid: crossTip,
      },
      marker,
      files: { complete: filesComplete, workflow_paths_changed: workflowPathsChanged },
      reviews: { complete: reviewsComplete, items: reviewItems },
      threads: { complete: completeOf('reviewThreads'), unresolved: nodesOf<{ isResolved: boolean }>('reviewThreads').filter((t) => !t.isResolved).length },
      timeline: { complete: completeOf('timelineItems'), force_push_events: nodesOf<{ __typename: string }>('timelineItems').filter((t) => t.__typename === 'HeadRefForcePushedEvent').length },
      verify: { complete: verify.complete, runs: verify.runs },
      required_runs: { complete: required.complete, runs: required.runs.filter((r) => requiredContexts.has(r.name)) },
      base_rules: { complete: baseComplete, status_checks: statusChecks, pull_request: pullRequest, legacy },
      mission_rules: { ...missionRules, complete: missionComplete },
      rulesets,
    };
    return { ok: true, snapshot, issues, timeline_events: nodesOf<{ __typename: string }>('timelineItems').map((t) => t.__typename) };
  } catch (error) {
    if (error instanceof Abort) return { ok: false, codes: [error.code] };
    if (error instanceof Cap) return { ok: false, codes: ['U.read_failed:request_cap'] };
    return { ok: false, codes: ['U.read_failed:unexpected'] };
  }
}

/** True when no section of the snapshot is marked incomplete (and the legacy protection read did not fail). */
export function snapshotIsComplete(s: MergeSnapshot): boolean {
  return (
    s.files.complete && s.reviews.complete && s.threads.complete && s.timeline.complete && s.verify.complete && s.required_runs.complete
    && s.base_rules.complete && s.base_rules.legacy.read !== 'failed' && s.mission_rules.complete
  );
}

/** One complete read of the live PR (design 3.4 steps 1-3). */
export async function readMergeSnapshot(deps: MergerReadDeps, evidence: MissionMergeEvidence, registry: MergerRegistry): Promise<MergeSnapshotRead> {
  const limits = { ...DEFAULT_MERGER_READ_LIMITS, ...deps.limits };
  return readPass(deps, evidence, registry, new Budget(limits.maxRequests));
}

/**
 * Builds the `MergeGateInput` evaluateMergeGates() consumes. The second, complete read (design 3.4 step 4) is made only when the first read
 * would otherwise reach `would_merge`; both share one request budget. A second read that fails or is incomplete is `ok: false`: it is never
 * silently compared on a partial basis. Equality of the two snapshots is judged by evaluateMergeGates() (movedFields).
 */
export async function readMergeGateInput(
  deps: MergerReadDeps,
  evidence: MissionMergeEvidence,
  registry: MergerRegistry,
  options: MergeGateOptions = DEFAULT_MERGE_GATE_OPTIONS,
): Promise<MergeGateInputRead> {
  const limits = { ...DEFAULT_MERGER_READ_LIMITS, ...deps.limits };
  const budget = new Budget(limits.maxRequests);
  const first = await readPass(deps, evidence, registry, budget);
  if (!first.ok) return first;
  const firstVerdict = evaluateMergeGates({ evidence, snapshot: first.snapshot, second: null, registry }, options);
  const needsSecond = firstVerdict.verdict === 'unevaluated' && firstVerdict.codes.length === 1 && firstVerdict.codes[0] === 'U.second_read_missing';
  if (!needsSecond) return { ok: true, input: { evidence, snapshot: first.snapshot, second: null, registry }, issues: first.issues };
  const second = await readPass(deps, evidence, registry, budget);
  if (!second.ok) return { ok: false, codes: second.codes.map((c) => c.replace(/^U\./u, 'U.second.')) };
  if (!snapshotIsComplete(second.snapshot)) return { ok: false, codes: ['U.read_incomplete:second'] };
  if (JSON.stringify(first.timeline_events) !== JSON.stringify(second.timeline_events)) return { ok: false, codes: ['U.snapshot_moved:timeline'] };
  return { ok: true, input: { evidence, snapshot: first.snapshot, second: second.snapshot, registry }, issues: [...first.issues, ...second.issues] };
}
