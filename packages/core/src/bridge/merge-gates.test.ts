import { describe, expect, it } from "vitest";
import { DEFAULT_MERGE_GATE_OPTIONS, evaluateMergeGates, type MergeGateInput, type MergeGateOptions, type MergeSnapshot } from "./merge-gates.js";
import { type Mutable, ACTIONS, APP_A, APP_B, APP_E, BASE_HEAD, CHECKS, H, OLD_HEAD, OWNER, baseInput, withEvidence, withRegistry, withSnap } from "./merge-gate-fixtures.js";

const run = (input: MergeGateInput, options?: MergeGateOptions) => evaluateMergeGates(input, options);
/** The input fails exactly these codes (every other gate holds). */
function refusedOnly(input: MergeGateInput, ...codes: string[]): void {
  const r = run(input);
  expect(r.verdict).toBe("refused");
  expect(r.codes).toEqual([...codes].sort());
}
function unevaluated(input: MergeGateInput, ...codes: string[]): void {
  const r = run(input);
  expect(r.verdict).toBe("unevaluated");
  expect(r.codes).toEqual([...codes].sort());
}
const review = (id: number, state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED", over: Record<string, unknown> = {}) =>
  ({ review_id: id, state, submitted_at_ms: id * 1000, commit_oid: H, author_type: "User" as const, author_id: OWNER, author_can_push: true, ...over });

describe("control", () => {
  it("returns would_merge with the squash request bound to the live head when every gate holds", () => {
    const r = run(baseInput());
    expect(r).toMatchObject({ verdict: "would_merge", codes: [], request: { sha: H, merge_method: "squash" } });
    expect(r.gates).toMatchObject({ start_is_base: false, second_read: true, g3: { check_run_id: 10, conclusion: "success", duplicates: 0, foreign_same_name: 0 } });
    expect(r.gates.g2c).toEqual({ live: H, pushed: H, candidate: H, evidence: H, marker: H, check: H });
  });
});

describe("ADR-006 negative cases", () => {
  it("1. a non-Mission PR: number or repository does not match the evidence", () => {
    refusedOnly(withSnap(s => { s.pr.number = 8; }), "G2.pr_mismatch");
    refusedOnly(withSnap(s => { s.pr.base_repository = "x/y"; s.pr.head_repository = "x/y"; }), "G2.repository_mismatch");
    refusedOnly(withRegistry(r => { r.repository = "x/y"; }), "G2.repository_mismatch");
    refusedOnly(withSnap(s => { s.pr.is_cross_repository = true; }), "G2.cross_repository");
  });
  it("2. a copied marker on another PR fails on PR number, branch and author, not on the marker", () => {
    const other = withSnap(s => { s.pr.number = 8; s.pr.head_ref_name = "osstack/mission/m_2"; s.pr.author = { type: "User", database_id: 5 }; });
    refusedOnly(other, "G2.author_not_publisher", "G2.branch_mismatch", "G2.pr_mismatch");
  });
  it("2b. an altered marker on the real PR", () => {
    refusedOnly(withSnap(s => { s.marker.marker!.spec_digest = "t".repeat(64); }), "G2.marker_mismatch:spec_digest");
    refusedOnly(withSnap(s => { s.marker.marker!.start = "9".repeat(40); }), "G2.marker_mismatch:start");
    refusedOnly(withSnap(s => { s.marker.marker!.id = "m_9"; }), "G2.first_line_mismatch", "G2.marker_mismatch:id");
    refusedOnly(withSnap(s => { s.marker.first_line_id = "m_9"; }), "G2.first_line_mismatch");
    refusedOnly(withSnap(s => { s.marker.first_line_id = null; }), "G2.first_line_mismatch");
    refusedOnly(withSnap(s => { s.marker.marker = null; }), "G2.marker_missing");
    refusedOnly(withSnap(s => { s.marker.candidates = 2; }), "G2.marker_missing");
    refusedOnly(withSnap(s => { s.marker.malformed = 1; }), "G2.marker_missing");
  });
  it("3. a mismatched head, one party at a time", () => {
    refusedOnly(withEvidence(e => { e.pushed_commit = OLD_HEAD; }), "G2.head_mismatch:pushed");
    refusedOnly(withEvidence(e => { e.pushed_commit = null; }), "G2.head_mismatch:pushed");
    refusedOnly(withEvidence(e => { e.candidate_head = OLD_HEAD; }), "G2.head_mismatch:candidate");
    refusedOnly(withEvidence(e => { e.head = OLD_HEAD; }), "G2.head_mismatch:evidence");
    refusedOnly(withSnap(s => { s.marker.marker!.head = OLD_HEAD; }), "G2.head_mismatch:marker");
    refusedOnly(withSnap(s => { s.verify.runs = s.verify.runs.map(r => ({ ...r, head_sha: OLD_HEAD })); }), "G2.head_mismatch:check", "G3.missing");
  });
  it("3b. a force-pushed live head fails every head-bound party", () => {
    const r = run(withSnap(s => { s.pr.head_oid = OLD_HEAD; }));
    expect(r.verdict).toBe("refused");
    expect(r.codes).toEqual(expect.arrayContaining(["G2.head_mismatch:pushed", "G2.head_mismatch:candidate", "G2.head_mismatch:evidence", "G2.head_mismatch:marker", "G3.missing"]));
  });
  it("4. a moved base", () => {
    refusedOnly(withSnap(s => { s.pr.base_tip_oid = "e".repeat(40); s.pr.base_tip_crosscheck_oid = "e".repeat(40); }), "G5.base_moved");
    refusedOnly(withEvidence(e => { e.base_head = null; }), "G5.base_head_missing");
    refusedOnly(withEvidence(e => { e.base_head = ""; }), "G5.base_head_missing");
    refusedOnly(withSnap(s => { s.pr.base_tip_crosscheck_oid = "e".repeat(40); }), "G5.base_tip_inconsistent");
    unevaluated(withSnap(s => { s.pr.base_tip_crosscheck_oid = null; }), "U.read_incomplete:G5");
    unevaluated(withSnap(s => { s.pr.base_tip_oid = null; }), "U.read_incomplete:G5");
  });
  it("5. an approval that is not provably after the last push", () => {
    refusedOnly(withSnap(s => { s.mission_rules.ruleset_ids = [200]; }), "G6.last_push_unprovable:rulesets");
    refusedOnly(withSnap(s => { s.mission_rules.ruleset_ids = [200, 201, 202]; }), "G6.last_push_unprovable:rulesets");
    refusedOnly(withSnap(s => { s.mission_rules.rule_types = ["creation", "update"]; }), "G6.last_push_unprovable:rulesets");
    refusedOnly(withSnap(s => { s.timeline.force_push_events = 1; }), "G6.force_push_observed");
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "APPROVED", { commit_oid: OLD_HEAD })]; }), "G6.approval_stale_head");
    unevaluated(withSnap(s => { s.timeline.complete = false; }), "U.read_incomplete:timeline");
  });
  it("6. an approval by an App does not count", () => {
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "APPROVED", { author_type: "Bot", author_id: 9001 })]; }), "G6.approval_by_app");
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "APPROVED", { author_type: "Bot", author_id: OWNER })]; }), "G6.approval_by_app");
    refusedOnly(withRegistry(r => { r.counted_approvers = [{ actor_id: OWNER, app_id: 123 }]; }), "G6.no_counted_approval");
  });
  it("7. a check from the wrong producer", () => {
    refusedOnly(withSnap(s => { s.verify.runs = s.verify.runs.map(r => ({ ...r, app_id: ACTIONS })); }), "G3.wrong_producer_only");
    refusedOnly(withSnap(s => { s.verify.runs = s.verify.runs.map(r => ({ ...r, app_id: 15369 })); }), "G3.wrong_producer_only");
    refusedOnly(withSnap(s => { s.required_runs.runs = s.required_runs.runs.map(r => (r.name === "check" ? { ...r, app_id: 999 } : r)); }), "G4.wrong_producer:check");
    refusedOnly(withSnap(s => { s.base_rules.status_checks.push({ context: "extra", integration_id: ACTIONS, ruleset_id: 100 }); }), "G4.required_set_drift");
    refusedOnly(withSnap(s => { s.base_rules.status_checks.pop(); }), "G4.required_set_drift");
    refusedOnly(withSnap(s => { s.base_rules.status_checks[0]!.integration_id = 999; }), "G4.required_set_drift");
    refusedOnly(withSnap(s => { s.base_rules.status_checks[0]!.integration_id = null; }), "G4.required_set_drift");
  });
  it("7b. a verify check bound to another Mission or head is missing", () => {
    refusedOnly(withSnap(s => { s.verify.runs = s.verify.runs.map(r => ({ ...r, external_id: `m_2:${H}` })); }), "G3.missing");
    refusedOnly(withSnap(s => { s.verify.runs = s.verify.runs.map(r => ({ ...r, external_id: `m_1:${OLD_HEAD}` })); }), "G3.missing");
    refusedOnly(withSnap(s => { s.verify.runs = s.verify.runs.map(r => ({ ...r, external_id: null })); }), "G3.missing");
    refusedOnly(withSnap(s => { s.verify.runs = []; }), "G3.missing");
  });
  it("8. a PR that touches workflow files", () => {
    refusedOnly(withSnap(s => { s.files.workflow_paths_changed = true; }), "G4.workflow_paths_changed");
    unevaluated(withSnap(s => { s.files.complete = false; s.files.workflow_paths_changed = true; }), "U.read_incomplete:files");
  });
  it("9. App E missing from main-update", () => {
    refusedOnly(withSnap(s => { s.rulesets["300"]!.bypass_actors = []; }), "G8.merger_not_allowed");
    refusedOnly(withSnap(s => { s.rulesets["300"]!.bypass_actors = [{ actor_type: "Integration", actor_id: APP_E, bypass_mode: "always" }]; }), "G8.merger_not_allowed");
    refusedOnly(withSnap(s => { s.rulesets["300"]!.bypass_actors = [{ actor_type: "Team", actor_id: APP_E, bypass_mode: "pull_request" }]; }), "G8.merger_not_allowed");
    refusedOnly(withSnap(s => { s.rulesets["300"]!.enforcement = "evaluate"; }), "G8.merger_not_allowed");
    refusedOnly(withSnap(s => { s.rulesets["300"]!.rule_types = []; }), "G8.merger_not_allowed");
    refusedOnly(withSnap(s => { s.rulesets["300"]!.covers_base_ref = false; }), "G8.merger_not_allowed");
    refusedOnly(withSnap(s => { s.rulesets["300"]!.bypass_actors!.push({ actor_type: "Integration", actor_id: APP_A, bypass_mode: "always" }); }), "G8.publisher_allowed");
    refusedOnly(withSnap(s => { s.rulesets["300"]!.bypass_actors = null; }), "G8.ruleset_unverifiable");
    refusedOnly(withSnap(s => { delete (s.rulesets as Record<string, unknown>)["300"]; }), "G8.ruleset_unverifiable");
  });
  it("10. a required-check ruleset that can be bypassed", () => {
    refusedOnly(withSnap(s => { s.rulesets["100"]!.bypass_actors = [{ actor_type: "Integration", actor_id: APP_E, bypass_mode: "always" }]; }), "G6.platform_rules_bypass");
    refusedOnly(withSnap(s => { s.rulesets["100"]!.bypass_actors = null; }), "G6.platform_rules_bypass");
    refusedOnly(withSnap(s => { s.rulesets["100"]!.enforcement = "disabled"; }), "G6.platform_rules_bypass");
    refusedOnly(withSnap(s => { delete (s.rulesets as Record<string, unknown>)["100"]; }), "G6.platform_rules_bypass");
    refusedOnly(withSnap(s => { for (const c of s.base_rules.status_checks) c.ruleset_id = 999; }), "G4.checks_bypassable");
    refusedOnly(withSnap(s => { s.base_rules.status_checks[0]!.ruleset_id = null; }), "G4.checks_bypassable");
  });
});

describe("each remaining gate", () => {
  it("G0 and G1", () => {
    refusedOnly(withEvidence(e => { e.join_count = 2; }), "G0.join_ambiguous");
    refusedOnly(withEvidence(e => { e.join_count = 0; }), "G0.join_ambiguous");
    for (const kind of ["evidence_missing", "opened_before_cancel", null] as const) refusedOnly(withEvidence(e => { e.publication_kind = kind; }), `G1.not_opened:${kind ?? "null"}`);
    refusedOnly(withEvidence(e => { e.recomputed_digest = "0".repeat(64); }), "G1.evidence_digest_mismatch");
    refusedOnly(withEvidence(e => { e.event_digest = "0".repeat(64); }), "G1.evidence_digest_mismatch");
  });
  it("G2 binding", () => {
    refusedOnly(withSnap(s => { s.pr.head_ref_name = "feature/x"; }), "G2.branch_mismatch");
    refusedOnly(withEvidence(e => { e.branch = "feature/x"; }), "G2.branch_mismatch");
    refusedOnly(withSnap(s => { s.pr.base_ref_name = "dev"; }), "G2.base_ref_mismatch");
    refusedOnly(withSnap(s => { s.pr.base_ref_name = "dev"; }), "G2.base_ref_mismatch");
    refusedOnly(withEvidence(e => { e.base = "dev"; }), "G2.base_not_registered", "G2.base_ref_mismatch");
    refusedOnly(withSnap(s => { s.pr.author = null; }), "G2.author_not_publisher");
    refusedOnly(withSnap(s => { s.pr.author = { type: "User", database_id: 9001 }; }), "G2.author_not_publisher");
    refusedOnly(withSnap(s => { s.pr.author = { type: "Bot", database_id: APP_A }; }), "G2.author_not_publisher"); // the App id is not the bot user id
    expect(run(withSnap(s => { s.pr.base_repository = "O/R"; })).verdict).toBe("would_merge"); // case-insensitive
  });
  it("G3 result and duplicates", () => {
    refusedOnly(withSnap(s => { s.verify.runs[0]!.conclusion = "failure"; }), "G3.not_success:failure");
    refusedOnly(withSnap(s => { s.verify.runs[0]!.status = "in_progress"; s.verify.runs[0]!.conclusion = null; }), "G3.not_success:in_progress");
    refusedOnly(withSnap(s => { s.verify.runs[0]!.conclusion = "neutral"; }), "G3.not_success:neutral");
    const dup = (low: string, high: string) => withSnap(s => {
      const r = s.verify.runs[0]!; s.verify.runs = [{ ...r, id: 10, conclusion: low }, { ...r, id: 20, conclusion: high }];
    });
    refusedOnly(dup("failure", "success"), "G3.not_success:failure");
    const ok = run(dup("success", "failure"));
    expect(ok.verdict).toBe("would_merge");
    expect(ok.gates.g3).toMatchObject({ check_run_id: 10, duplicates: 1 });
    unevaluated(withSnap(s => { s.verify.complete = false; }), "U.read_incomplete:G3");
    // a same-named check from another App changes nothing when the real one is present
    expect(run(withSnap(s => { s.verify.runs.push({ ...s.verify.runs[0]!, id: 5, app_id: ACTIONS }); })).gates.g3).toMatchObject({ check_run_id: 10, foreign_same_name: 1 });
  });
  it("G3 selects among runs of the live head: a lower-id run stamped with another head cannot mask the real one", () => {
    const i = withSnap(s => { s.verify.runs = [{ ...s.verify.runs[0]!, id: 5, head_sha: OLD_HEAD }, s.verify.runs[0]!]; });
    expect(run(i).verdict).toBe("would_merge");
  });
  it("G4 judges provenance per entry: a duplicate of a required check from another ruleset or legacy protection is a bypass path", () => {
    refusedOnly(withSnap(s => { s.base_rules.status_checks.push({ ...s.base_rules.status_checks[0]!, ruleset_id: 999 }); }), "G4.checks_bypassable");
    refusedOnly(withSnap(s => { s.base_rules.legacy = { read: "ok", checks: [{ context: "check", app_id: ACTIONS }], contexts: [] }; }), "G4.checks_bypassable");
  });
  it("G4 required checks", () => {
    refusedOnly(withSnap(s => { s.required_runs.runs = s.required_runs.runs.filter(r => r.name !== "check"); }), "G4.missing:check");
    refusedOnly(withSnap(s => { s.required_runs.runs.find(r => r.name === "check")!.conclusion = "failure"; }), "G4.not_success:check:failure");
    refusedOnly(withSnap(s => { const r = s.required_runs.runs.find(x => x.name === "check")!; r.status = "queued"; r.conclusion = null; }), "G4.not_success:check:queued");
    refusedOnly(withSnap(s => { s.required_runs.runs = s.required_runs.runs.map(r => ({ ...r, head_sha: OLD_HEAD })); }), ...CHECKS.map(c => `G4.missing:${c}`));
    // the latest run (highest id) decides
    expect(run(withSnap(s => { const r = s.required_runs.runs.find(x => x.name === "check")!; s.required_runs.runs.push({ ...r, id: 99, conclusion: "success" }); r.conclusion = "failure"; })).verdict).toBe("would_merge");
    refusedOnly(withSnap(s => { const r = s.required_runs.runs.find(x => x.name === "check")!; s.required_runs.runs.push({ ...r, id: 99, conclusion: "failure" }); }), "G4.not_success:check:failure");
    refusedOnly(withSnap(s => { s.base_rules.legacy.contexts = ["ci/status"]; }), "G4.unbound_status_context");
    expect(run(withSnap(s => { s.base_rules.legacy = { read: "ok", checks: [], contexts: [] }; })).verdict).toBe("would_merge");
    refusedOnly(withSnap(s => { s.base_rules.legacy = { read: "ok", checks: [{ context: "extra", app_id: ACTIONS }], contexts: [] }; }), "G4.checks_bypassable", "G4.required_set_drift");
    unevaluated(withSnap(s => { s.base_rules.legacy.read = "failed"; }), "U.read_failed:G4.protection");
    unevaluated(withSnap(s => { s.base_rules.complete = false; }), "U.read_incomplete:G4");
    unevaluated(withSnap(s => { s.required_runs.complete = false; }), "U.read_incomplete:G4");
  });
  it("§8 decision 2: skipped and neutral are refused by default and accepted only when GitHub-compatible is chosen", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      const input = withSnap(s => { s.required_runs.runs.find(r => r.name === "check")!.conclusion = conclusion; });
      refusedOnly(input, `G4.not_success:check:${conclusion}`);
      expect(run(input, { ...DEFAULT_MERGE_GATE_OPTIONS, requiredCheckConclusions: "github_compatible" }).verdict).toBe("would_merge");
    }
    // The Mission evidence check stays success-only whatever the option says.
    const verify = withSnap(s => { s.verify.runs[0]!.conclusion = "skipped"; });
    expect(run(verify, { ...DEFAULT_MERGE_GATE_OPTIONS, requiredCheckConclusions: "github_compatible" }).codes).toEqual(["G3.not_success:skipped"]);
    expect(DEFAULT_MERGE_GATE_OPTIONS).toEqual({ startCommit: "record_only", requiredCheckConclusions: "success_only" });
  });
  it("§8 decision 1: start_commit equal to base_head is a recorded fact, refused only on request", () => {
    const input = baseInput();
    expect(run(input).gates.start_is_base).toBe(false);
    expect(run(input).verdict).toBe("would_merge");
    expect(run(input, { ...DEFAULT_MERGE_GATE_OPTIONS, startCommit: "require_equal" })).toMatchObject({ verdict: "refused", codes: ["G5.start_not_base"] });
    const same = withEvidence(e => { e.start_commit = BASE_HEAD; });
    expect(run(same, { ...DEFAULT_MERGE_GATE_OPTIONS, startCommit: "require_equal" }).verdict).toBe("refused"); // marker.start still holds START
    expect(run(same).gates.start_is_base).toBe(true);
  });
  it("G6a counted approval details", () => {
    refusedOnly(withSnap(s => { s.reviews.items = []; }), "G6.no_counted_approval");
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "COMMENTED")]; }), "G6.no_counted_approval");
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "APPROVED", { author_can_push: false })]; }), "G6.no_counted_approval");
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "APPROVED", { author_id: 5 })]; }), "G6.no_counted_approval");
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "APPROVED"), review(2, "CHANGES_REQUESTED")]; }), "G6.approval_superseded", "G6.changes_requested");
    refusedOnly(withSnap(s => { s.reviews.items = [review(1, "APPROVED"), review(2, "DISMISSED")]; }), "G6.approval_superseded");
    unevaluated(withSnap(s => { s.reviews.complete = false; }), "U.read_incomplete:reviews");
  });
  it("G6d changes requested", () => {
    const other = { author_id: 5, commit_oid: OLD_HEAD };
    refusedOnly(withSnap(s => { s.reviews.items.push(review(2, "CHANGES_REQUESTED", other)); }), "G6.changes_requested"); // an old head does not clear it
    refusedOnly(withSnap(s => { s.reviews.items.push(review(2, "CHANGES_REQUESTED", { ...other, author_type: "Bot" })); }), "G6.changes_requested");
    expect(run(withSnap(s => { s.reviews.items.push(review(2, "CHANGES_REQUESTED", other), review(3, "APPROVED", other)); })).verdict).toBe("would_merge");
    expect(run(withSnap(s => { s.reviews.items.push(review(2, "CHANGES_REQUESTED", other), review(3, "DISMISSED", other)); })).verdict).toBe("would_merge");
    expect(run(withSnap(s => { s.reviews.items.push(review(2, "CHANGES_REQUESTED", other), review(3, "COMMENTED", other)); })).codes).toEqual(["G6.changes_requested"]);
    // user 5 and bot 5 are different authors
    refusedOnly(withSnap(s => { s.reviews.items.push(review(2, "CHANGES_REQUESTED", other), review(3, "APPROVED", { ...other, author_type: "Bot" })); }), "G6.changes_requested");
  });
  it("G6b rulesets and bypass lists", () => {
    refusedOnly(withSnap(s => { s.rulesets["200"]!.bypass_actors = null; }), "G6.last_push_unprovable:bypass");
    refusedOnly(withSnap(s => { s.rulesets["201"]!.bypass_actors = null; }), "G6.last_push_unprovable:bypass");
    refusedOnly(withSnap(s => { delete (s.rulesets as Record<string, unknown>)["201"]; }), "G6.last_push_unprovable:bypass");
    refusedOnly(withSnap(s => { s.rulesets["200"]!.bypass_actors!.push({ actor_type: "Integration", actor_id: APP_E, bypass_mode: "always" }); }), "G6.last_push_unprovable:bypass");
    refusedOnly(withSnap(s => { s.rulesets["200"]!.bypass_actors = []; }), "G6.last_push_unprovable:bypass");
    refusedOnly(withSnap(s => { s.rulesets["201"]!.bypass_actors = [{ actor_type: "Integration", actor_id: APP_A, bypass_mode: "always" }]; }), "G6.last_push_unprovable:bypass");
    refusedOnly(withSnap(s => { s.rulesets["200"]!.bypass_actors![0]!.actor_id = APP_E; }), "G6.last_push_unprovable:bypass");
    refusedOnly(withSnap(s => { s.rulesets["200"]!.enforcement = "disabled"; }), "G6.last_push_unprovable:rulesets");
    refusedOnly(withSnap(s => { s.rulesets["201"]!.covers_mission_refs = false; }), "G6.last_push_unprovable:rulesets");
    refusedOnly(withSnap(s => { s.rulesets["200"]!.rule_types = ["creation"]; }), "G6.last_push_unprovable:rulesets");
    unevaluated(withSnap(s => { s.mission_rules.complete = false; }), "U.read_incomplete:G6b");
  });
  it("G6c threads", () => {
    refusedOnly(withSnap(s => { s.threads.unresolved = 1; }), "G6.unresolved_threads");
    unevaluated(withSnap(s => { s.threads.complete = false; }), "U.read_incomplete:threads");
  });
  it("G6e platform rules", () => {
    refusedOnly(withSnap(s => { s.base_rules.pull_request = null; }), "G6.platform_rules_missing");
    refusedOnly(withSnap(s => { s.base_rules.pull_request!.required_approving_review_count = 0; }), "G6.platform_rules_missing");
    refusedOnly(withSnap(s => { s.base_rules.pull_request!.require_last_push_approval = false; }), "G6.platform_rules_missing");
    refusedOnly(withSnap(s => { s.base_rules.pull_request!.required_review_thread_resolution = false; }), "G6.platform_rules_missing");
    refusedOnly(withSnap(s => { s.base_rules.pull_request!.dismiss_stale_reviews_on_push = false; }), "G6.platform_rules_missing");
    refusedOnly(withSnap(s => { s.base_rules.pull_request!.ruleset_id = 999; }), "G6.platform_rules_missing");
  });
  it("G7 state", () => {
    refusedOnly(withSnap(s => { s.pr.state = "CLOSED"; }), "G7.not_open");
    refusedOnly(withSnap(s => { s.pr.state = "MERGED"; }), "G7.not_open");
    refusedOnly(withSnap(s => { s.pr.is_draft = true; }), "G7.draft");
    refusedOnly(withSnap(s => { s.pr.mergeable = "CONFLICTING"; }), "G7.conflicting");
    refusedOnly(withSnap(s => { s.pr.mergeable = "WEIRD"; }), "G7.mergeable:WEIRD");
    unevaluated(withSnap(s => { s.pr.mergeable = "UNKNOWN"; }), "U.mergeability_unknown");
    refusedOnly(withSnap(s => { s.pr.merge_state_status = "BLOCKED"; }), "G7.merge_state:BLOCKED");
    refusedOnly(withSnap(s => { s.pr.review_decision = null; }), "G7.review_decision:NONE");
    refusedOnly(withSnap(s => { s.pr.review_decision = "REVIEW_REQUIRED"; }), "G7.review_decision:REVIEW_REQUIRED");
  });
});

describe("verdict composition", () => {
  it("collects every failing code, sorted, without short-circuiting", () => {
    const r = run(withSnap(s => { s.pr.is_draft = true; s.threads.unresolved = 2; s.files.workflow_paths_changed = true; s.pr.number = 9; }));
    expect(r.verdict).toBe("refused");
    expect(r.codes).toEqual(["G2.pr_mismatch", "G4.workflow_paths_changed", "G6.unresolved_threads", "G7.draft"]);
  });
  it("reports a read problem as unevaluated and withholds the refusal codes", () => {
    const r = run(withSnap(s => { s.pr.is_draft = true; s.reviews.complete = false; }));
    expect(r.verdict).toBe("unevaluated");
    expect(r.codes).toEqual(["U.read_incomplete:reviews"]);
    expect(r.codes.every(c => c.startsWith("U."))).toBe(true);
  });
  it("needs the second read before it says would_merge", () => {
    const missing = baseInput(); missing.second = null;
    unevaluated(missing, "U.second_read_missing");
    expect(run(missing).gates.second_read).toBe(false);
  });
  it("moves to unevaluated when the second read differs, naming the section", () => {
    const moved = (mutate: (s: Mutable<MergeSnapshot>) => void) => { const i = baseInput(); mutate(i.second as Mutable<MergeSnapshot>); return i; };
    unevaluated(moved(s => { s.pr.head_oid = OLD_HEAD; }), "U.snapshot_moved:pr");
    unevaluated(moved(s => { s.marker.marker!.spec_digest = "t".repeat(64); }), "U.snapshot_moved:marker");
    unevaluated(moved(s => { s.pr.base_ref_name = "dev"; }), "U.snapshot_moved:pr");
    unevaluated(moved(s => { s.reviews.items.push(review(2, "COMMENTED")); }), "U.snapshot_moved:reviews");
    unevaluated(moved(s => { s.threads.unresolved = 1; }), "U.snapshot_moved:threads");
    unevaluated(moved(s => { s.required_runs.runs[0]!.id = 777; }), "U.snapshot_moved:required_runs");
    unevaluated(moved(s => { s.rulesets["300"]!.enforcement = "evaluate"; }), "U.snapshot_moved:rulesets");
    unevaluated(moved(s => { s.pr.is_draft = true; s.files.workflow_paths_changed = true; }), "U.snapshot_moved:files", "U.snapshot_moved:pr");
  });
  it("treats the order of arrays in the second read as insignificant", () => {
    const i = baseInput(); i.second!.required_runs = { ...i.second!.required_runs, runs: [...i.second!.required_runs.runs].reverse() }; i.second!.base_rules = { ...i.second!.base_rules, status_checks: [...i.second!.base_rules.status_checks].reverse() }; i.second!.mission_rules.ruleset_ids = [201, 200];
    expect(run(i).verdict).toBe("would_merge");
  });
  it("does not need a second read to refuse", () => {
    const i = withSnap(s => { s.pr.is_draft = true; }); i.second = null;
    expect(run(i)).toMatchObject({ verdict: "refused", codes: ["G7.draft"] });
  });
  it("ignores the merge registry's reviewer app id on the counted list only when it is null", () => {
    expect(run(withRegistry(r => { r.counted_approvers = [{ actor_id: OWNER, app_id: null }, { actor_id: 1, app_id: 77 }]; })).verdict).toBe("would_merge");
  });
  it("is pure: it does not mutate its input", () => {
    const i = baseInput(); const before = JSON.stringify(i); run(i); expect(JSON.stringify(i)).toBe(before);
    expect([APP_A, APP_B, APP_E, BASE_HEAD].length).toBe(4);
  });
});

describe("review authors", () => {
  it("is unevaluated when a stateful review has no stable author, so two unknown authors cannot cancel each other", () => {
    const anon = (id: number, state: "APPROVED" | "CHANGES_REQUESTED") => review(id, state, { author_id: null, author_type: "Other" });
    unevaluated(withSnap(s => { s.reviews.items.push(anon(2, "CHANGES_REQUESTED"), anon(3, "APPROVED")); }), "U.read_failed:G6.review_author");
    expect(run(withSnap(s => { s.reviews.items.push({ ...anon(2, "APPROVED"), state: "COMMENTED" }); })).verdict).toBe("would_merge"); // a comment carries no state
  });
});
