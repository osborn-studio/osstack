// Test support for the shadow merger service (M-C): a ledger rig whose Missions carry full delivery evidence, a synthetic GitHub (the
// merger reader's world plus the two outcome queries), and a reconciler factory. Not imported by production code.
import { createHash } from 'node:crypto';
import { MergerShadowStore, mergerShadowWriter } from '@osstack/core';
import type { MergerConfig } from './contained-mission-merger-config.js';
import { createRig, type Rig } from './contained-mission-bridge-shadow.testkit.js';
import type { GraphqlTransport } from './contained-mission-bridge-reader.js';
import { formatMissionMarker } from './contained-mission-marker.js';
import {
  MergerShadowReconciler, MERGER_PR_OUTCOME_QUERY, MERGER_PR_STATE_QUERY, createMergerLedgerView, createMergerMissionView, type MergerShadowOptions,
} from './contained-mission-merger-shadow.js';
import { APP, BASE, BRANCH, HEAD, OWNER, REPO, START, makeWorld, registry, run, serve, type Calls, type World } from './contained-mission-merger.testkit.js';

export { APP, BASE, BRANCH, HEAD, OWNER, REPO, START, registry, run };
export const T0 = 1_800_000_000_000;
export const MIN = 60_000;

export const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

export const config = (over: Partial<MergerConfig> = {}): MergerConfig => ({ ...registry, inspection_evidence: false, owner_reviewer_id: OWNER, producers: [APP.actions], ...over });

/** The `delivery_evidence` payload the runner writes (contained-mission-runner.ts), digest included. */
export function evidencePayload(m: { mission_id: string; spec_digest: string }, over: Record<string, unknown> = {}, pr = 7, branch = BRANCH): Record<string, unknown> {
  const body = { schema_version: 1, mission_id: m.mission_id, spec_digest: m.spec_digest, repository: REPO, remote: 'origin', branch, base: 'main', base_head: BASE, start_commit: START,
    head: HEAD, tree: 'd'.repeat(40), draft: true, pr: { number: pr, url: `https://example.invalid/pull/${pr}`, reused: false }, verify: { argv: ['true'], exit_code: 0, evidence: 'e' },
    tier: 'T0', migrations_changed: false, protected_paths_changed: false, ...over };
  return { ...body, evidence_digest: createHash('sha256').update(canonical(body)).digest('hex') };
}

export interface SeededMission { missionId: string; specDigest: string }
export function seedMergerMission(rig: Rig, pr = 7, branch = BRANCH): SeededMission {
  let specDigest = '';
  const missionId = rig.seedMission({
    pr_number: pr, head: HEAD, base_head: BASE, branch,
    evidence: (m) => { specDigest = m.spec_digest; return evidencePayload(m, {}, pr, branch); },
  });
  return { missionId, specDigest };
}

/** Mutable GitHub-side state for the two outcome queries. */
export interface OutcomeWorld {
  state: 'OPEN' | 'CLOSED' | 'MERGED'; head: string; mergedAt: string | null; mergeCommit: string | null;
  mergedBy: { __typename: string; databaseId?: number } | null; reviews: Array<{ databaseId: number; submittedAt: string; commit: string; authorId: number }>; hasPreviousPage: boolean;
  /** Reviews per page (default 100); pages are served newest first through `before`. */
  pageSize?: number;
  /** When set, outcome and state responses carry these GraphQL errors next to their data. */
  errors?: unknown[];
  /** When set, outcome queries throw it. */
  fail?: Error;
}

export interface Rigged {
  rig: Rig; store: MergerShadowStore; world: World; outcome: OutcomeWorld; calls: Calls; outcomeQueries: string[]; logs: string[];
  clock: { now: number }; mission: SeededMission;
  graphql: GraphqlTransport; rest: (path: string) => ReturnType<ReturnType<typeof serve>['rest']>;
  reconciler(over?: Partial<MergerShadowOptions>): MergerShadowReconciler;
  /** Sets the PR state on both the full-read world and the outcome world. */
  setState(state: 'OPEN' | 'CLOSED' | 'MERGED'): void;
  close(): void;
}

export function createRigged(cfg: MergerConfig = config()): Rigged {
  const rig = createRig();
  const store = new MergerShadowStore(rig.attention, rig.owner);
  const mission = seedMergerMission(rig);
  const world = makeWorld();
  world.body = [`Contained Mission \`${mission.missionId}\`, opened by OSStack. Review before merging; OSStack never merges.`, '', 'SECRET-BODY-TOKEN goal text', '',
    formatMissionMarker({ id: mission.missionId, spec_digest: mission.specDigest, head: HEAD, start: START })].join('\n');
  world.runs[1201] = [run(5001, 'osstack/verify', APP.evidence, { external_id: `${mission.missionId}:${HEAD}` })];
  const served = serve(world);
  const outcome: OutcomeWorld = { state: 'OPEN', head: HEAD, mergedAt: null, mergeCommit: null, mergedBy: null, reviews: [], hasPreviousPage: false };
  const outcomeQueries: string[] = [];
  const graphql: GraphqlTransport = async (query, variables) => {
    if (query === MERGER_PR_STATE_QUERY || query === MERGER_PR_OUTCOME_QUERY) {
      outcomeQueries.push(query);
      if (outcome.fail) throw outcome.fail;
      const pr: Record<string, unknown> = { number: Number(variables['number']), state: outcome.state, headRefOid: outcome.head };
      if (query === MERGER_PR_OUTCOME_QUERY) {
        const end = typeof variables['before'] === 'string' ? Number(variables['before']) : outcome.reviews.length;
        const start = Math.max(0, end - (outcome.pageSize ?? 100));
        Object.assign(pr, {
          mergedAt: outcome.mergedAt, mergeCommit: outcome.mergeCommit ? { oid: outcome.mergeCommit } : null, mergedBy: outcome.mergedBy,
          reviews: { pageInfo: { hasPreviousPage: start > 0 || outcome.hasPreviousPage, startCursor: String(start) }, nodes: outcome.reviews.slice(start, end).map((r) => ({
            databaseId: r.databaseId, submittedAt: r.submittedAt, commit: { oid: r.commit }, author: { __typename: 'User', databaseId: r.authorId } })) },
        });
      }
      return { ...(outcome.errors ? { errors: outcome.errors } : {}), data: { repository: { pullRequest: pr } } };
    }
    return served.graphql(query, variables);
  };
  const clock = { now: T0 };
  const logs: string[] = [];
  const reconciler = (over: Partial<MergerShadowOptions> = {}): MergerShadowReconciler => new MergerShadowReconciler({
    missions: createMergerMissionView(rig.missions), ledger: createMergerLedgerView(store), writer: mergerShadowWriter(store), graphql, rest: served.rest, config: cfg,
    now: () => clock.now, log: (line) => { logs.push(line); }, ...over,
  });
  const setState = (state: 'OPEN' | 'CLOSED' | 'MERGED'): void => {
    outcome.state = state;
    world.pr = { ...world.pr, state, ...(state === 'MERGED' ? { merged: true } : {}) };
  };
  return { rig, store, world, outcome, calls: served.calls, outcomeQueries, logs, clock, mission, graphql, rest: served.rest, reconciler, setState, close: () => { rig.close(); } };
}

/** Every Mission-side and chain-side row, serialised, to compare byte for byte. */
export function ledgerDump(rig: Rig): string {
  const tables = (rig.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'engineering_contained%' OR name LIKE 'engineering_workspace%' OR name LIKE 'engineering_revision%' OR name LIKE 'engineering_shadow%') ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, rig.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
}
