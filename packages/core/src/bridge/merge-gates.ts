/** Pure shadow-merger gate evaluation (bridge App E, M-A; design `2026-11-06-bridge-shadow-merger.md` §3).
 * No I/O, no clock, no network: the ledger evidence, a normalised live snapshot, an optional second snapshot and the
 * registry arrive as input. Every gate runs (no short-circuit) and every failing code is returned. Reading problems are
 * never refusals: any `U.*` code makes the verdict `unevaluated`, so the comparison with real merges never counts "not
 * seen clearly" as "the shadow said no". */

export type MergeVerdictName = "would_merge" | "refused" | "unevaluated";

/** Owner decisions of design §8 that are still open. The defaults are the strict reading the design recommends. */
export interface MergeGateOptions {
  /** §8 decision 1. `record_only`: write `start_is_base` as a fact and never refuse on it. `require_equal`: `G5.start_not_base` when `start_commit != base_head`. */
  readonly startCommit: "record_only" | "require_equal";
  /** §8 decision 2. `success_only`: `skipped`/`neutral` required checks are refused as `G4.not_success:<ctx>:<conclusion>`. `github_compatible`: also accept them (G3 stays success-only). */
  readonly requiredCheckConclusions: "success_only" | "github_compatible";
}
export const DEFAULT_MERGE_GATE_OPTIONS: MergeGateOptions = Object.freeze({ startCommit: "record_only", requiredCheckConclusions: "success_only" });

/** One `delivery_evidence` plus the ledger row, as the M-C view returns it. */
export interface MissionMergeEvidence {
  mission_id: string; spec_digest: string; start_commit: string; candidate_head: string;
  repository: string; branch: string; base: string; base_head: string | null; head: string; pr_number: number;
  /** `publication().kind`; null when the Mission has no publication. */
  publication_kind: "opened" | "evidence_missing" | "opened_before_cancel" | null;
  pushed_commit: string | null;
  /** `evidence_digest` as recorded, recomputed from the payload without it, and as carried by the `pr_opened` event. */
  record_digest: string; recomputed_digest: string; event_digest: string;
  /** Missions the ledger joins to (repository, PR number). Anything but 1 is ambiguous. */
  join_count: number;
}

export type PrLiveState = "OPEN" | "MERGED" | "CLOSED";
export interface SnapshotPr {
  number: number; state: PrLiveState; is_draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  merge_state_status: string; review_decision: string | null;
  base_repository: string; head_repository: string; is_cross_repository: boolean;
  head_ref_name: string; base_ref_name: string; head_oid: string;
  author: { type: "Bot" | "User" | "Other"; database_id: number | null } | null;
  /** `pullRequest.baseRef.target.oid`; null when unreadable. */
  base_tip_oid: string | null;
  /** `repository.ref(refs/heads/<base>).target.oid`, the cross-check; null when unreadable. */
  base_tip_crosscheck_oid: string | null;
}
export interface SnapshotMarker {
  /** Present only when exactly one well-formed marker was parsed. */
  marker: { id: string; spec_digest: string; start: string; head: string } | null;
  candidates: number; malformed: number;
  first_line_id: string | null;
}
export type ReviewStateName = "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED" | "PENDING";
export interface SnapshotReview {
  review_id: number; state: ReviewStateName; submitted_at_ms: number;
  commit_oid: string | null; author_type: "User" | "Bot" | "Other"; author_id: number | null; author_can_push: boolean;
}
export interface SnapshotCheckRun { id: number; app_id: number | null; name: string; external_id: string | null; head_sha: string; status: string; conclusion: string | null }
export interface SnapshotStatusRule { context: string; integration_id: number | null; ruleset_id: number | null }
export type RulesetBypass = { actor_type: string; actor_id: number | null; bypass_mode: string };
export interface SnapshotRuleset {
  enforcement: string;
  /** Includes the `refs/heads/osstack/mission/**` refs / the base ref respectively. */
  covers_mission_refs: boolean; covers_base_ref: boolean;
  rule_types: readonly string[];
  /** `null` when the response had no `bypass_actors` field (insufficient permission): unprovable, not empty. */
  bypass_actors: readonly RulesetBypass[] | null;
}
export interface SnapshotPullRequestRule {
  ruleset_id: number | null; required_approving_review_count: number;
  require_last_push_approval: boolean; required_review_thread_resolution: boolean; dismiss_stale_reviews_on_push: boolean;
}
export interface MergeSnapshot {
  pr: SnapshotPr;
  marker: SnapshotMarker;
  files: { complete: boolean; workflow_paths_changed: boolean };
  reviews: { complete: boolean; items: readonly SnapshotReview[] };
  threads: { complete: boolean; unresolved: number };
  timeline: { complete: boolean; force_push_events: number };
  /** Every `osstack/verify` run found in App B's check suites on the live head. */
  verify: { complete: boolean; runs: readonly SnapshotCheckRun[] };
  /** Runs for the required contexts, from the registered producers' suites on the live head. */
  required_runs: { complete: boolean; runs: readonly SnapshotCheckRun[] };
  base_rules: {
    complete: boolean;
    status_checks: readonly SnapshotStatusRule[];
    pull_request: SnapshotPullRequestRule | null;
    /** `ok`: protection read; `not_protected`: 404 / "Branch not protected" (empty set); `failed`: any other failure (403 included). */
    legacy: { read: "ok" | "not_protected" | "failed"; checks: readonly { context: string; app_id: number | null }[]; contexts: readonly string[] };
  };
  /** `rules/branches/<mission branch>`: which rulesets contribute which rule types. */
  mission_rules: { complete: boolean; ruleset_ids: readonly number[]; rule_types: readonly string[] };
  /** `rulesets/{id}` for every registered id. */
  rulesets: Readonly<Record<string, SnapshotRuleset | undefined>>;
}

export interface MergerRegistry {
  repository: string; base_ref: string;
  publisher: { actor_id: number; app_id: number };
  merger: { actor_id: number; app_id: number };
  evidence_app_id: number;
  counted_approvers: readonly { actor_id: number; app_id: number | null }[];
  required_checks: readonly { context: string; app_id: number }[];
  main_quality_ruleset_id: number; main_update_ruleset_id: number;
  /** Registered mission rulesets (writers and history); told apart by their rule types. */
  mission_ruleset_ids: readonly number[];
}

export interface MergeGateInput {
  evidence: MissionMergeEvidence;
  snapshot: MergeSnapshot;
  /** Full second read (§3.4 step 4), required before `would_merge`; null when it was not performed. */
  second: MergeSnapshot | null;
  registry: MergerRegistry;
}

export interface MergeGateFacts {
  start_is_base: boolean;
  second_read: boolean;
  g2c?: { live: string; pushed: string | null; candidate: string; evidence: string; marker: string | null; check: string | null };
  g3?: { check_run_id: number | null; conclusion: string | null; duplicates: number; foreign_same_name: number };
  g4?: { required: ReadonlyArray<readonly [string, number, number | null, string | null]> };
  g5?: { base_head: string | null; live_tip: string | null };
  g6a?: { review_id: number | null; commit: string | null };
  g6b?: { rulesets: readonly number[]; force_push_events: number };
  g7?: { mergeable: string; merge_state: string };
}
export type MergeVerdict =
  | { verdict: "would_merge"; codes: []; request: { sha: string; merge_method: "squash" }; gates: MergeGateFacts }
  | { verdict: "refused"; codes: string[]; gates: MergeGateFacts }
  | { verdict: "unevaluated"; codes: string[]; gates: MergeGateFacts };

const MISSION_BRANCH = /^osstack\/mission\/[A-Za-z0-9_.-]+$/;
const lower = (s: string): string => s.toLowerCase();

export function evaluateMergeGates(input: MergeGateInput, options: MergeGateOptions = DEFAULT_MERGE_GATE_OPTIONS): MergeVerdict {
  const { evidence: e, snapshot: s, registry: r } = input;
  const fail = new Set<string>();
  const unknown = new Set<string>();
  const gates: MergeGateFacts = { start_is_base: e.base_head !== null && e.start_commit === e.base_head, second_read: input.second !== null };
  const head = s.pr.head_oid;

  // G0 -- the ledger join is the identity; more than one Mission for (repository, PR) is ambiguous.
  if (e.join_count !== 1) fail.add("G0.join_ambiguous");

  // G1 -- publication evidence.
  if (e.publication_kind !== "opened") fail.add(`G1.not_opened:${e.publication_kind ?? "null"}`);
  if (e.record_digest !== e.recomputed_digest || e.record_digest !== e.event_digest) fail.add("G1.evidence_digest_mismatch");

  // G2a -- repository, PR, branch and base binding.
  if (s.pr.number !== e.pr_number) fail.add("G2.pr_mismatch");
  if (lower(s.pr.base_repository) !== lower(e.repository) || lower(s.pr.head_repository) !== lower(e.repository) || lower(e.repository) !== lower(r.repository)) fail.add("G2.repository_mismatch");
  if (s.pr.is_cross_repository) fail.add("G2.cross_repository");
  if (s.pr.head_ref_name !== e.branch || !MISSION_BRANCH.test(s.pr.head_ref_name)) fail.add("G2.branch_mismatch");
  if (s.pr.base_ref_name !== e.base) fail.add("G2.base_ref_mismatch");
  if (e.base !== r.base_ref) fail.add("G2.base_not_registered");

  // G2b -- author is App A's bot user.
  if (s.pr.author === null || s.pr.author.type !== "Bot" || s.pr.author.database_id !== r.publisher.actor_id) fail.add("G2.author_not_publisher");

  // G3 -- the Mission evidence check, from App B only, bound to this Mission and head; lowest id decides.
  const wantExternal = `${e.mission_id}:${head}`;
  const verifyRuns = s.verify.runs.filter(x => x.name === "osstack/verify");
  const verifyBound = verifyRuns.filter(x => x.app_id === r.evidence_app_id && x.external_id === wantExternal);
  const verifyMine = verifyBound.filter(x => x.head_sha === head).sort((a, b) => a.id - b.id);
  const verifyForeign = verifyRuns.filter(x => x.app_id !== r.evidence_app_id).length;
  const chosen = verifyMine[0] ?? null;
  gates.g3 = { check_run_id: chosen?.id ?? null, conclusion: chosen?.conclusion ?? null, duplicates: Math.max(0, verifyMine.length - 1), foreign_same_name: verifyForeign };
  if (!s.verify.complete) unknown.add("U.read_incomplete:G3");
  else if (chosen === null) fail.add(verifyForeign > 0 ? "G3.wrong_producer_only" : "G3.missing");
  else if (chosen.status !== "completed" || chosen.conclusion !== "success") fail.add(`G3.not_success:${chosen.conclusion ?? chosen.status}`);

  // G2c -- five-way head equality. A party that does not exist is reported by its own gate, not here.
  const markerHead = s.marker.marker?.head ?? null;
  gates.g2c = { live: head, pushed: e.pushed_commit, candidate: e.candidate_head, evidence: e.head, marker: markerHead, check: chosen?.head_sha ?? verifyBound[0]?.head_sha ?? null };
  if (e.pushed_commit !== head) fail.add("G2.head_mismatch:pushed");
  if (e.candidate_head !== head) fail.add("G2.head_mismatch:candidate");
  if (e.head !== head) fail.add("G2.head_mismatch:evidence");
  if (markerHead !== null && markerHead !== head) fail.add("G2.head_mismatch:marker");
  // A run bound to this Mission and head by external_id but stamped with another head_sha is never selected (G3); say why.
  if (chosen === null && verifyBound.length > 0) fail.add("G2.head_mismatch:check");

  // G2d -- the marker agrees with the ledger.
  const m = s.marker.marker;
  if (m === null || s.marker.candidates !== 1 || s.marker.malformed !== 0) fail.add("G2.marker_missing");
  else {
    if (m.id !== e.mission_id) fail.add("G2.marker_mismatch:id");
    if (m.spec_digest !== e.spec_digest) fail.add("G2.marker_mismatch:spec_digest");
    if (m.start !== e.start_commit) fail.add("G2.marker_mismatch:start");
    if (s.marker.first_line_id !== m.id) fail.add("G2.first_line_mismatch");
  }

  // G4 -- required checks.
  if (!s.base_rules.complete || !s.required_runs.complete) unknown.add("U.read_incomplete:G4");
  if (s.base_rules.legacy.read === "failed") unknown.add("U.read_failed:G4.protection");
  if (!s.files.complete) unknown.add("U.read_incomplete:files");
  if (s.files.workflow_paths_changed) fail.add("G4.workflow_paths_changed");
  const key = (ctx: string, app: number | null): string => `${ctx}\u0000${app ?? "null"}`;
  const wanted = new Set(r.required_checks.map(c => key(c.context, c.app_id)));
  const fromQuality = new Set(s.base_rules.status_checks.filter(c => c.ruleset_id === r.main_quality_ruleset_id).map(c => key(c.context, c.integration_id)));
  const present = new Set<string>([
    ...s.base_rules.status_checks.map(c => key(c.context, c.integration_id)),
    ...s.base_rules.legacy.checks.map(c => key(c.context, c.app_id)),
  ]);
  const setsEqual = present.size === wanted.size && [...wanted].every(k => present.has(k));
  if (s.base_rules.complete && s.base_rules.legacy.read !== "failed") {
    if (!setsEqual) fail.add("G4.required_set_drift");
    if (s.base_rules.legacy.contexts.length > 0) fail.add("G4.unbound_status_context");
    // Provenance is judged per source entry, not on the reduced set: a duplicate from another ruleset or from legacy protection is a bypass path.
    if (s.base_rules.status_checks.some(c => c.ruleset_id !== r.main_quality_ruleset_id) || s.base_rules.legacy.checks.length > 0
      || [...wanted].some(k => present.has(k) && !fromQuality.has(k))) fail.add("G4.checks_bypassable");
  }
  const required: Array<readonly [string, number, number | null, string | null]> = [];
  if (s.required_runs.complete) {
    for (const c of r.required_checks) {
      const sameName = s.required_runs.runs.filter(x => x.name === c.context);
      const mine = sameName.filter(x => x.app_id === c.app_id && x.head_sha === head).sort((a, b) => b.id - a.id);
      const latest = mine[0] ?? null;
      required.push([c.context, c.app_id, latest?.id ?? null, latest?.conclusion ?? null] as const);
      if (latest === null) fail.add(sameName.some(x => x.app_id !== c.app_id) ? `G4.wrong_producer:${c.context}` : `G4.missing:${c.context}`);
      else {
        const ok = latest.status === "completed" && (latest.conclusion === "success"
          || (options.requiredCheckConclusions === "github_compatible" && (latest.conclusion === "skipped" || latest.conclusion === "neutral")));
        if (!ok) fail.add(`G4.not_success:${c.context}:${latest.conclusion ?? latest.status}`);
      }
    }
  }
  gates.g4 = { required };

  // G5 -- the base has not moved since publication.
  gates.g5 = { base_head: e.base_head, live_tip: s.pr.base_tip_oid };
  if (e.base_head === null || e.base_head.length === 0) fail.add("G5.base_head_missing");
  if (s.pr.base_tip_oid === null || s.pr.base_tip_crosscheck_oid === null) unknown.add("U.read_incomplete:G5");
  else {
    if (e.base_head !== null && e.base_head.length > 0 && e.base_head !== s.pr.base_tip_oid) fail.add("G5.base_moved");
    if (s.pr.base_tip_crosscheck_oid !== s.pr.base_tip_oid) fail.add("G5.base_tip_inconsistent");
  }
  if (options.startCommit === "require_equal" && !gates.start_is_base) fail.add("G5.start_not_base");

  // G6a / G6d -- counted approval and standing change requests, both from the same per-author latest-state reduction.
  if (!s.reviews.complete) unknown.add("U.read_incomplete:reviews");
  else {
    const stateful = s.reviews.items.filter(x => x.state === "APPROVED" || x.state === "CHANGES_REQUESTED" || x.state === "DISMISSED");
    // Two authors we cannot tell apart would share one latest-state slot and could erase each other's change request.
    if (stateful.some(x => x.author_id === null)) unknown.add("U.read_failed:G6.review_author");
    const latestBy = new Map<string, SnapshotReview>();
    for (const x of [...stateful].sort((a, b) => a.submitted_at_ms - b.submitted_at_ms || a.review_id - b.review_id)) latestBy.set(`${x.author_type}:${x.author_id ?? "none"}`, x);
    if ([...latestBy.values()].some(x => x.state === "CHANGES_REQUESTED")) fail.add("G6.changes_requested");
    const counted = new Set(r.counted_approvers.filter(a => a.app_id === null).map(a => a.actor_id));
    const isCounted = (x: SnapshotReview): boolean => x.author_type === "User" && x.author_id !== null && counted.has(x.author_id);
    const good = [...latestBy.values()].filter(x => isCounted(x) && x.state === "APPROVED" && x.commit_oid === head && x.author_can_push);
    gates.g6a = { review_id: good[0]?.review_id ?? null, commit: good[0]?.commit_oid ?? null };
    if (good.length === 0) {
      const approvals = stateful.filter(x => x.state === "APPROVED");
      const countedApprovals = approvals.filter(isCounted);
      const explained = new Set<string>();
      if (approvals.some(x => x.author_type === "Bot")) explained.add("G6.approval_by_app");
      if (countedApprovals.some(x => x.commit_oid !== head)) explained.add("G6.approval_stale_head");
      if (countedApprovals.some(x => x.commit_oid === head && latestBy.get(`${x.author_type}:${x.author_id ?? "none"}`)?.state !== "APPROVED")) explained.add("G6.approval_superseded");
      if (explained.size === 0) explained.add("G6.no_counted_approval");
      for (const c of explained) fail.add(c);
    }
  }

  // G6b -- the approval is after the last push: Mission rulesets are intact, no force push, head unchanged (G2c).
  if (!s.timeline.complete) unknown.add("U.read_incomplete:timeline");
  else if (s.timeline.force_push_events > 0) fail.add("G6.force_push_observed");
  gates.g6b = { rulesets: [...s.mission_rules.ruleset_ids].sort((a, b) => a - b), force_push_events: s.timeline.force_push_events };
  if (!s.mission_rules.complete) unknown.add("U.read_incomplete:G6b");
  else {
    const regs = [...r.mission_ruleset_ids].sort((a, b) => a - b);
    const have = gates.g6b.rulesets;
    const idsOk = regs.length === 2 && have.length === regs.length && regs.every((id, i) => id === have[i]);
    const typesOk = ["creation", "update", "non_fast_forward", "deletion"].every(t => s.mission_rules.rule_types.includes(t));
    if (!idsOk || !typesOk) fail.add("G6.last_push_unprovable:rulesets");
    else {
      const configs = regs.map(id => s.rulesets[String(id)]);
      const sameTypes = (c: SnapshotRuleset, want: readonly string[]): boolean => c.rule_types.length === want.length && want.every(t => c.rule_types.includes(t));
      const writers = configs.find((c): c is SnapshotRuleset => c !== undefined && sameTypes(c, ["creation", "update"]));
      const history = configs.find((c): c is SnapshotRuleset => c !== undefined && sameTypes(c, ["non_fast_forward", "deletion"]));
      if (configs.some(c => c === undefined || c.bypass_actors === null)) fail.add("G6.last_push_unprovable:bypass");
      else if (!writers || !history || writers === history) fail.add("G6.last_push_unprovable:rulesets");
      else {
        if (configs.some(c => c === undefined || c.enforcement !== "active" || !c.covers_mission_refs)) fail.add("G6.last_push_unprovable:rulesets");
        const w = writers.bypass_actors ?? [];
        const writersOk = w.length === 1 && w[0]?.actor_type === "Integration" && w[0].actor_id === r.publisher.app_id;
        if (!writersOk || (history.bypass_actors ?? []).length !== 0) fail.add("G6.last_push_unprovable:bypass");
      }
    }
  }

  // G6c -- no unresolved review threads (outdated ones count).
  if (!s.threads.complete) unknown.add("U.read_incomplete:threads");
  else if (s.threads.unresolved > 0) fail.add("G6.unresolved_threads");

  // G6e -- the platform rules that re-check at merge time still exist and cannot be bypassed.
  const pr = s.base_rules.pull_request;
  if (s.base_rules.complete) {
    if (pr === null || pr.ruleset_id !== r.main_quality_ruleset_id || pr.required_approving_review_count < 1 || !pr.require_last_push_approval
      || !pr.required_review_thread_resolution || !pr.dismiss_stale_reviews_on_push) fail.add("G6.platform_rules_missing");
    const quality = s.rulesets[String(r.main_quality_ruleset_id)];
    if (quality === undefined || quality.enforcement !== "active" || quality.bypass_actors === null || quality.bypass_actors.length !== 0) fail.add("G6.platform_rules_bypass");
  }

  // G8 -- App E is on the main-update list in pull_request mode, and App A is not.
  const update = s.rulesets[String(r.main_update_ruleset_id)];
  if (update === undefined || update.bypass_actors === null) fail.add("G8.ruleset_unverifiable");
  else {
    const list = update.bypass_actors;
    const listsMerger = list.some(b => b.actor_type === "Integration" && b.actor_id === r.merger.app_id && b.bypass_mode === "pull_request");
    if (update.enforcement !== "active" || !update.covers_base_ref || !update.rule_types.includes("update") || !listsMerger) fail.add("G8.merger_not_allowed");
    if (list.some(b => b.actor_type === "Integration" && b.actor_id === r.publisher.app_id)) fail.add("G8.publisher_allowed");
  }

  // G7 -- open, mergeable, clean; the request that would be sent is bound to the live head.
  gates.g7 = { mergeable: s.pr.mergeable, merge_state: s.pr.merge_state_status };
  if (s.pr.state !== "OPEN") fail.add("G7.not_open");
  else {
    if (s.pr.is_draft) fail.add("G7.draft");
    if (s.pr.mergeable === "UNKNOWN") unknown.add("U.mergeability_unknown");
    else if (s.pr.mergeable === "CONFLICTING") fail.add("G7.conflicting");
    else if (s.pr.mergeable !== "MERGEABLE") fail.add(`G7.mergeable:${s.pr.mergeable}`);
    if (s.pr.merge_state_status !== "CLEAN") fail.add(`G7.merge_state:${s.pr.merge_state_status}`);
    if (s.pr.review_decision !== "APPROVED") fail.add(`G7.review_decision:${s.pr.review_decision ?? "NONE"}`);
  }

  if (unknown.size > 0) return { verdict: "unevaluated", codes: [...unknown].sort(), gates };
  if (fail.size > 0) return { verdict: "refused", codes: [...fail].sort(), gates };

  // Every first-pass gate holds: the second, complete read must be field-for-field identical.
  if (input.second === null) return { verdict: "unevaluated", codes: ["U.second_read_missing"], gates };
  const moved = movedFields(s, input.second);
  if (moved.length > 0) return { verdict: "unevaluated", codes: moved.map(f => `U.snapshot_moved:${f}`), gates };
  return { verdict: "would_merge", codes: [], request: { sha: head, merge_method: "squash" }, gates };
}

/** Top-level snapshot sections whose normalised content differs. Arrays compare as sets: the reader returns check runs, reviews and rules in whatever order GitHub pages them. */
export function movedFields(a: MergeSnapshot, b: MergeSnapshot): string[] {
  const keys = Object.keys(a) as Array<keyof MergeSnapshot>;
  const all = new Set<string>([...keys, ...(Object.keys(b) as string[])]);
  return [...all].filter(k => canonical((a as unknown as Record<string, unknown>)[k]) !== canonical((b as unknown as Record<string, unknown>)[k])).sort();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
