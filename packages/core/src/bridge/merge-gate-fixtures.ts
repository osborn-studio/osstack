import { DEFAULT_MERGE_GATE_OPTIONS, type MergeGateInput, type MergeSnapshot, type MergerRegistry, type MissionMergeEvidence, type SnapshotCheckRun } from "./merge-gates.js";

/** Test fixtures: one fully passing input, mutated one gate at a time. Not exported from the package. */
export const H = "a".repeat(40);
export const OLD_HEAD = "9".repeat(40);
export const BASE_HEAD = "b".repeat(40);
export const START = "c".repeat(40);
export const DIGEST = "d".repeat(64);
export const OWNER = 269190136;
export const APP_A = 5620012;
export const APP_B = 5620053;
export const APP_E = 5620091;
export const ACTIONS = 15368;
export const CHECKS = ["check", "graph-macos-fixtures (22)", "graph-macos-fixtures (24)", "graph-runtime-matrix (20.6.0)", "graph-runtime-matrix (22.23.1)"] as const;

export const REGISTRY: MergerRegistry = {
  repository: "o/r", base_ref: "main", publisher: { actor_id: 9001, app_id: APP_A }, merger: { actor_id: 9002, app_id: APP_E }, evidence_app_id: APP_B,
  counted_approvers: [{ actor_id: OWNER, app_id: null }], required_checks: CHECKS.map(context => ({ context, app_id: ACTIONS })),
  main_quality_ruleset_id: 100, main_update_ruleset_id: 300, mission_ruleset_ids: [200, 201],
};

export function baseEvidence(): MissionMergeEvidence {
  return {
    mission_id: "m_1", spec_digest: "s".repeat(64), start_commit: START, candidate_head: H, repository: "o/r", branch: "osstack/mission/m_1", base: "main",
    base_head: BASE_HEAD, head: H, pr_number: 7, publication_kind: "opened", pushed_commit: H, record_digest: DIGEST, recomputed_digest: DIGEST, event_digest: DIGEST, join_count: 1,
  };
}
const run = (id: number, name: string, app: number, over: Partial<SnapshotCheckRun> = {}): SnapshotCheckRun =>
  ({ id, app_id: app, name, external_id: null, head_sha: H, status: "completed", conclusion: "success", ...over });

export function baseSnapshot(): MergeSnapshot {
  return {
    pr: {
      number: 7, state: "OPEN", is_draft: false, mergeable: "MERGEABLE", merge_state_status: "CLEAN", review_decision: "APPROVED",
      base_repository: "O/R", head_repository: "o/r", is_cross_repository: false, head_ref_name: "osstack/mission/m_1", base_ref_name: "main", head_oid: H,
      author: { type: "Bot", database_id: 9001 }, base_tip_oid: BASE_HEAD, base_tip_crosscheck_oid: BASE_HEAD,
    },
    marker: { marker: { id: "m_1", spec_digest: "s".repeat(64), start: START, head: H }, candidates: 1, malformed: 0, first_line_id: "m_1" },
    files: { complete: true, workflow_paths_changed: false },
    reviews: { complete: true, items: [{ review_id: 1, state: "APPROVED", submitted_at_ms: 1000, commit_oid: H, author_type: "User", author_id: OWNER, author_can_push: true }] },
    threads: { complete: true, unresolved: 0 },
    timeline: { complete: true, force_push_events: 0 },
    verify: { complete: true, runs: [run(10, "osstack/verify", APP_B, { external_id: `m_1:${H}` })] },
    required_runs: { complete: true, runs: CHECKS.map((c, i) => run(20 + i, c, ACTIONS)) },
    base_rules: {
      complete: true, status_checks: CHECKS.map(context => ({ context, integration_id: ACTIONS, ruleset_id: 100 })),
      pull_request: { ruleset_id: 100, required_approving_review_count: 1, require_last_push_approval: true, required_review_thread_resolution: true, dismiss_stale_reviews_on_push: true },
      legacy: { read: "not_protected", checks: [], contexts: [] },
    },
    mission_rules: { complete: true, ruleset_ids: [200, 201], rule_types: ["creation", "update", "non_fast_forward", "deletion"] },
    rulesets: {
      "100": { enforcement: "active", covers_mission_refs: false, covers_base_ref: true, rule_types: ["pull_request", "required_status_checks"], bypass_actors: [] },
      "200": { enforcement: "active", covers_mission_refs: true, covers_base_ref: false, rule_types: ["creation", "update"], bypass_actors: [{ actor_type: "Integration", actor_id: APP_A, bypass_mode: "always" }] },
      "201": { enforcement: "active", covers_mission_refs: true, covers_base_ref: false, rule_types: ["non_fast_forward", "deletion"], bypass_actors: [] },
      "300": { enforcement: "active", covers_mission_refs: false, covers_base_ref: true, rule_types: ["update"], bypass_actors: [{ actor_type: "Integration", actor_id: APP_E, bypass_mode: "pull_request" }] },
    },
  };
}

export function baseInput(): MergeGateInput {
  return { evidence: baseEvidence(), snapshot: baseSnapshot(), second: baseSnapshot(), registry: structuredClone(REGISTRY) };
}
export type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
/** Mutations: snapshot changes apply to both reads (so the second read agrees), evidence and registry changes once. */
export function withSnap(mutate: (s: Mutable<MergeSnapshot>) => void): MergeGateInput {
  const input = baseInput(); mutate(input.snapshot as Mutable<MergeSnapshot>); if (input.second) mutate(input.second as Mutable<MergeSnapshot>); return input;
}
export function withEvidence(mutate: (e: Mutable<MissionMergeEvidence>) => void): MergeGateInput { const input = baseInput(); mutate(input.evidence as Mutable<MissionMergeEvidence>); return input; }
export function withRegistry(mutate: (r: Mutable<MergerRegistry>) => void): MergeGateInput { const input = baseInput(); mutate(input.registry as Mutable<MergerRegistry>); return input; }
export { DEFAULT_MERGE_GATE_OPTIONS };
