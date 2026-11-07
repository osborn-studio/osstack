// Synthetic GitHub for the merger reader tests: serves GraphQL pages and REST GETs from one mutable model, records every request.
import { formatMissionMarker } from './contained-mission-marker.js';
import type { MergerRegistry, MissionMergeEvidence } from '@osstack/core';
import type { GraphqlTransport, RestGet, RestResult } from './contained-mission-merger-reader.js';

export const REPO = 'o/r';
export const HEAD = 'a'.repeat(40);
export const BASE = 'b'.repeat(40);
export const MISSION = 'cm_00000000-0000-4000-8000-000000000001';
export const BRANCH = `osstack/mission/${MISSION}`;
export const SPEC = '5'.repeat(64);
export const START = 'c'.repeat(40);
export const APP = { publisher: 11, evidence: 12, merger: 15, actions: 15368 };
export const BOT = { publisher: 1001, merger: 1005 };
export const OWNER = 269;
export const IDS = { quality: 100, update: 200, writers: 301, history: 302 };

export const evidence: MissionMergeEvidence = {
  mission_id: MISSION, spec_digest: SPEC, start_commit: START, candidate_head: HEAD, repository: REPO, branch: BRANCH, base: 'main', base_head: BASE,
  head: HEAD, pr_number: 7, publication_kind: 'opened', pushed_commit: HEAD, record_digest: 'd'.repeat(64), recomputed_digest: 'd'.repeat(64), event_digest: 'd'.repeat(64), join_count: 1,
};
export const registry: MergerRegistry = {
  repository: REPO, base_ref: 'main',
  publisher: { actor_id: BOT.publisher, app_id: APP.publisher }, merger: { actor_id: BOT.merger, app_id: APP.merger }, evidence_app_id: APP.evidence,
  counted_approvers: [{ actor_id: OWNER, app_id: null }],
  required_checks: [{ context: 'check', app_id: APP.actions }, { context: 'build', app_id: APP.actions }],
  main_quality_ruleset_id: IDS.quality, main_update_ruleset_id: IDS.update, mission_ruleset_ids: [IDS.writers, IDS.history],
};

export type Json = Record<string, unknown>;
export const run = (id: number, name: string, app: number, over: Json = {}): Json => ({ id, name, app: { id: app }, external_id: null, head_sha: HEAD, status: 'completed', conclusion: 'success', ...over });
export const review = (id: number, over: Json = {}): Json => ({
  databaseId: id, state: 'APPROVED', submittedAt: new Date(Date.parse('2026-11-01T00:00:00Z') + id * 1000).toISOString(), authorCanPushToRepository: true,
  commit: { oid: HEAD }, author: { __typename: 'User', databaseId: OWNER }, ...over,
});

const quality = {
  enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request' }, { type: 'required_status_checks' }], bypass_actors: [],
};
export const rulesetBodies = (): Record<number, Json> => ({
  [IDS.quality]: structuredClone(quality),
  [IDS.update]: { enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [{ type: 'update' }], bypass_actors: [{ actor_id: APP.merger, actor_type: 'Integration', bypass_mode: 'pull_request' }] },
  [IDS.writers]: { enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['refs/heads/osstack/mission/**'], exclude: [] } }, rules: [{ type: 'creation' }, { type: 'update' }], bypass_actors: [{ actor_id: APP.publisher, actor_type: 'Integration', bypass_mode: 'always' }] },
  [IDS.history]: { enforcement: 'active', target: 'branch', conditions: { ref_name: { include: ['refs/heads/osstack/mission/**'], exclude: [] } }, rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }], bypass_actors: [] },
});

export interface World {
  renamed?: string[] | undefined;
  pr: Json; body: string; reviews: Json[]; threads: Json[]; timeline: string[]; files: string[]; changedFiles: number | undefined;
  defaultBranch: string | null; crossTip: string | null;
  suites: Record<number, number[]>; runs: Record<number, Json[]>;
  baseRules: Json[]; missionRules: Json[];
  /** Body of `branches/main/protection`, or a RestResult failure. */
  protection: unknown;
  rulesets: Record<number, unknown>;
  /** Wrap-around hook: called with the 1-based GraphQL pass index (a request without cursors starts a pass) before it is answered. */
  onPass?: (pass: number) => void;
  /** Make REST paths matching the pattern fail with the result. */
  failRest: Array<{ match: RegExp; result: RestResult }>;
  /** Per-pass override of GraphQL responses. */
  graphqlHook?: (query: string, variables: Record<string, unknown>) => unknown;
}
export interface Calls { gql: { query: string; variables: Record<string, unknown> }[]; rest: string[] }

export function body(): string {
  return [`Contained Mission \`${MISSION}\`, opened by OSStack. Review before merging; OSStack never merges.`, '', 'SECRET-BODY-TOKEN goal text', '',
    formatMissionMarker({ id: MISSION, spec_digest: SPEC, head: HEAD, start: START })].join('\n');
}

export function makeWorld(): World {
  return {
    pr: {}, body: body(), reviews: [review(1)], threads: [], timeline: [], files: ['src/a.ts'], changedFiles: undefined, defaultBranch: 'main', crossTip: BASE,
    suites: { [APP.evidence]: [1201], [APP.actions]: [1, 2] },
    runs: { 1201: [run(5001, 'osstack/verify', APP.evidence, { external_id: `${MISSION}:${HEAD}` })], 1: [run(11, 'check', APP.actions), run(12, 'build', APP.actions)], 2: [run(21, 'lint-other', APP.actions)] },
    baseRules: [
      { type: 'deletion', ruleset_id: IDS.quality }, { type: 'non_fast_forward', ruleset_id: IDS.quality },
      { type: 'pull_request', ruleset_id: IDS.quality, parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
      { type: 'required_status_checks', ruleset_id: IDS.quality, parameters: { required_status_checks: [{ context: 'check', integration_id: APP.actions }, { context: 'build', integration_id: APP.actions }] } },
    ],
    missionRules: [{ type: 'creation', ruleset_id: IDS.writers }, { type: 'update', ruleset_id: IDS.writers }, { type: 'non_fast_forward', ruleset_id: IDS.history }, { type: 'deletion', ruleset_id: IDS.history }],
    protection: { ok: false, status: 404, branchNotProtected: true } satisfies RestResult,
    rulesets: rulesetBodies(), failRest: [],
  };
}

const page = <T,>(all: readonly T[], after: unknown, size = 100) => {
  const start = typeof after === 'string' ? Number(after) : 0;
  const end = Math.min(start + size, all.length);
  return { pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null }, nodes: all.slice(start, end) };
};

export function serve(w: World): { graphql: GraphqlTransport; rest: RestGet; calls: Calls } {
  const calls: Calls = { gql: [], rest: [] };
  let pass = 0;
  const graphql: GraphqlTransport = async (query, variables) => {
    calls.gql.push({ query, variables });
    const firstPage = !('reviewsAfter' in variables) && !('threadsAfter' in variables) && !('filesAfter' in variables) && !('timelineAfter' in variables);
    if (firstPage) { pass += 1; w.onPass?.(pass); }
    if (w.graphqlHook) return w.graphqlHook(query, variables);
    const pr: Json = {
      number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', body: w.body,
      baseRepository: { nameWithOwner: REPO }, headRepository: { nameWithOwner: REPO }, isCrossRepository: false,
      headRefName: BRANCH, baseRefName: 'main', headRefOid: HEAD, changedFiles: w.changedFiles ?? w.files.length,
      author: { __typename: 'Bot', databaseId: BOT.publisher }, baseRef: { target: { oid: BASE } }, ...w.pr,
    };
    if (variables['reviews']) pr['reviews'] = page(w.reviews, variables['reviewsAfter']);
    if (variables['threads']) pr['reviewThreads'] = page(w.threads, variables['threadsAfter']);
    if (variables['timeline']) pr['timelineItems'] = page(w.timeline.map((__typename) => ({ __typename })), variables['timelineAfter']);
    if (variables['files']) pr['files'] = page(w.files.map((path) => ({ path, changeType: w.renamed?.includes(path) ? 'RENAMED' : 'MODIFIED' })), variables['filesAfter']);
    return { data: { repository: { defaultBranchRef: w.defaultBranch === null ? null : { name: w.defaultBranch }, ref: w.crossTip === null ? null : { target: { oid: w.crossTip } }, pullRequest: pr } } };
  };
  const ok = (b: unknown): RestResult => ({ ok: true, body: b });
  const rest: RestGet = async (path) => {
    calls.rest.push(path);
    for (const f of w.failRest) if (f.match.test(path)) return f.result;
    const url = new URL(`https://x/${path}`);
    const p = decodeURIComponent(url.pathname.slice(1)).replace(`repos/${REPO}/`, '');
    const q = url.searchParams;
    const per = Number(q.get('per_page') ?? 30);
    const pg = Number(q.get('page') ?? 1);
    const slice = <T,>(all: readonly T[]): T[] => all.slice((pg - 1) * per, pg * per);
    const suiteList = /^commits\/([0-9a-f]+)\/check-suites$/u.exec(p);
    const runList = /^check-suites\/(\d+)\/check-runs$/u.exec(p);
    const rulesetOne = /^rulesets\/(\d+)$/u.exec(p);
    if (suiteList) {
      if (suiteList[1] !== HEAD) return ok({ check_suites: [] });
      const app = Number(q.get('app_id'));
      return ok({ check_suites: slice(w.suites[app] ?? []).map((id) => ({ id, app: { id: app } })) });
    }
    if (runList) {
      const name = q.get('check_name');
      const all = (w.runs[Number(runList[1])] ?? []).filter((r) => name === null || r['name'] === name);
      return ok({ check_runs: slice(all) });
    }
    if (p === 'rules/branches/main') return ok(slice(w.baseRules));
    if (p === `rules/branches/${BRANCH}`) return ok(slice(w.missionRules));
    if (p === 'branches/main/protection') return (w.protection as { ok?: boolean }).ok === false ? (w.protection as RestResult) : ok(w.protection);
    if (rulesetOne) {
      const r = w.rulesets[Number(rulesetOne[1])];
      if (r === undefined) return { ok: false, status: 404, branchNotProtected: false };
      return (r as { ok?: boolean }).ok === false ? (r as RestResult) : ok(r);
    }
    return { ok: false, status: 404, branchNotProtected: false };
  };
  return { graphql, rest, calls };
}
