import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "../state/attention-store.js";
import { ContainedMissionStore } from "../state/engineering-contained-store.js";
import { openDb } from "../state/db.js";
import type { EngineeringPrincipal } from "../state/engineering-store.js";
import { MergerShadowError, MergerShadowStore, type MergerDecisionInput } from "../state/engineering-merger-store.js";
import { evaluateMergeGates, type MergeGateInput, type MergeSnapshot } from "./merge-gates.js";
import { type Mutable, ACTIONS, APP_A, APP_B, APP_E, CHECKS, H, OLD_HEAD, OWNER, baseInput } from "./merge-gate-fixtures.js";

const RUNS = Number(process.env.OSSTACK_PROPERTY_RUNS ?? 1000);
const SEED = process.env.OSSTACK_PROPERTY_SEED === undefined ? undefined : Number(process.env.OSSTACK_PROPERTY_SEED);

/** An independent, gate-by-gate reference of the ADR-006 predicate. It shares no code with `evaluateMergeGates`. */
function reference(i: MergeGateInput): boolean {
  const { evidence: e, snapshot: s, registry: r } = i; const h = s.pr.head_oid; const lc = (x: string) => x.toLowerCase();
  const verify = s.verify.runs.filter(x => x.name === "osstack/verify" && x.app_id === r.evidence_app_id && x.external_id === `${e.mission_id}:${h}` && x.head_sha === h).sort((a, b) => a.id - b.id)[0];
  const latest = (ctx: string, app: number) => s.required_runs.runs.filter(x => x.name === ctx && x.app_id === app && x.head_sha === h).sort((a, b) => b.id - a.id)[0];
  const want = r.required_checks.map(c => `${c.context}|${c.app_id}`).sort().join(",");
  const have = [...s.base_rules.status_checks.map(c => `${c.context}|${c.integration_id}`), ...s.base_rules.legacy.checks.map(c => `${c.context}|${c.app_id}`)].sort().join(",");
  const latestBy = new Map<string, (typeof s.reviews.items)[number]>();
  for (const x of [...s.reviews.items].filter(x => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(x.state)).sort((a, b) => a.submitted_at_ms - b.submitted_at_ms || a.review_id - b.review_id)) latestBy.set(`${x.author_type}${x.author_id}`, x);
  const q = s.rulesets[String(r.main_quality_ruleset_id)]; const u = s.rulesets[String(r.main_update_ruleset_id)];
  const [wId, hId] = [...r.mission_ruleset_ids]; const w = s.rulesets[String(wId)]; const hi = s.rulesets[String(hId)];
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && b.every(t => a.includes(t));
  return e.join_count === 1 && e.publication_kind === "opened" && e.record_digest === e.recomputed_digest && e.record_digest === e.event_digest
    && s.pr.number === e.pr_number && lc(s.pr.base_repository) === lc(e.repository) && lc(s.pr.head_repository) === lc(e.repository) && lc(e.repository) === lc(r.repository)
    && !s.pr.is_cross_repository && s.pr.head_ref_name === e.branch && s.pr.head_ref_name.startsWith("osstack/mission/") && s.pr.base_ref_name === e.base && e.base === r.base_ref
    && s.pr.author?.type === "Bot" && s.pr.author.database_id === r.publisher.actor_id
    && verify !== undefined && verify.status === "completed" && verify.conclusion === "success"
    && e.pushed_commit === h && e.candidate_head === h && e.head === h && s.marker.marker?.head === h && s.marker.candidates === 1 && s.marker.malformed === 0
    && s.marker.marker.id === e.mission_id && s.marker.marker.spec_digest === e.spec_digest && s.marker.marker.start === e.start_commit && s.marker.first_line_id === e.mission_id
    && s.base_rules.complete && s.required_runs.complete && s.verify.complete && s.files.complete && s.reviews.complete && s.threads.complete && s.timeline.complete && s.mission_rules.complete
    && s.base_rules.legacy.read !== "failed" && s.base_rules.legacy.contexts.length === 0 && want === have
    && s.base_rules.status_checks.every(x => x.ruleset_id === r.main_quality_ruleset_id) && s.base_rules.legacy.checks.length === 0
    && r.required_checks.every(c => s.base_rules.status_checks.some(x => x.context === c.context && x.integration_id === c.app_id && x.ruleset_id === r.main_quality_ruleset_id))
    && r.required_checks.every(c => { const l = latest(c.context, c.app_id); return l !== undefined && l.status === "completed" && l.conclusion === "success"; })
    && !s.files.workflow_paths_changed
    && e.base_head !== null && e.base_head !== "" && s.pr.base_tip_oid === e.base_head && s.pr.base_tip_crosscheck_oid === s.pr.base_tip_oid
    && [...latestBy.values()].some(x => x.author_type === "User" && r.counted_approvers.some(a => a.app_id === null && a.actor_id === x.author_id) && x.state === "APPROVED" && x.commit_oid === h && x.author_can_push)
    && ![...latestBy.values()].some(x => x.state === "CHANGES_REQUESTED")
    && s.timeline.force_push_events === 0 && s.threads.unresolved === 0
    && same([...s.mission_rules.ruleset_ids].map(String).sort(), [...r.mission_ruleset_ids].map(String).sort())
    && w?.enforcement === "active" && hi?.enforcement === "active" && w.covers_mission_refs && hi.covers_mission_refs
    && same(w.rule_types, ["creation", "update"]) && same(hi.rule_types, ["non_fast_forward", "deletion"])
    && w.bypass_actors?.length === 1 && w.bypass_actors[0]?.actor_type === "Integration" && w.bypass_actors[0].actor_id === r.publisher.app_id && hi.bypass_actors?.length === 0
    && s.base_rules.pull_request !== null && s.base_rules.pull_request.ruleset_id === r.main_quality_ruleset_id && s.base_rules.pull_request.required_approving_review_count >= 1
    && s.base_rules.pull_request.require_last_push_approval && s.base_rules.pull_request.required_review_thread_resolution && s.base_rules.pull_request.dismiss_stale_reviews_on_push
    && q?.enforcement === "active" && q.bypass_actors?.length === 0
    && u?.enforcement === "active" && u.covers_base_ref && u.rule_types.includes("update")
    && u.bypass_actors?.some(b => b.actor_type === "Integration" && b.actor_id === r.merger.app_id && b.bypass_mode === "pull_request") === true
    && !u.bypass_actors.some(b => b.actor_type === "Integration" && b.actor_id === r.publisher.app_id)
    && s.pr.state === "OPEN" && !s.pr.is_draft && s.pr.mergeable === "MERGEABLE" && s.pr.merge_state_status === "CLEAN" && s.pr.review_decision === "APPROVED";
}

/** Mutations, each a small change to one fact. Applied to both reads so the second read agrees and the gate itself decides. */
type Mut = (i: MergeGateInput) => void; // evidence / registry fields are assigned through casts below
const both = (f: (s: Mutable<MergeSnapshot>) => void): Mut => i => { f(i.snapshot as Mutable<MergeSnapshot>); if (i.second) f(i.second as Mutable<MergeSnapshot>); };
const MUTATIONS: ReadonlyArray<readonly [string, Mut]> = [
  ["pr number", both(s => { s.pr.number = 99; })], ["repo", both(s => { s.pr.head_repository = "x/y"; })], ["cross", both(s => { s.pr.is_cross_repository = true; })],
  ["branch", both(s => { s.pr.head_ref_name = "osstack/mission/other"; })], ["base ref", both(s => { s.pr.base_ref_name = "dev"; })],
  ["author id", both(s => { s.pr.author = { type: "Bot", database_id: 1 }; })], ["author type", both(s => { s.pr.author = { type: "User", database_id: 9001 }; })],
  ["head", both(s => { s.pr.head_oid = OLD_HEAD; })], ["pushed", i => { i.evidence.pushed_commit = OLD_HEAD; }], ["candidate", i => { i.evidence.candidate_head = OLD_HEAD; }],
  ["evidence head", i => { i.evidence.head = OLD_HEAD; }], ["marker head", both(s => { s.marker.marker!.head = OLD_HEAD; })], ["marker id", both(s => { s.marker.marker!.id = "m_x"; })],
  ["marker spec", both(s => { s.marker.marker!.spec_digest = "z"; })], ["marker count", both(s => { s.marker.candidates = 2; })],
  ["base tip", both(s => { s.pr.base_tip_oid = "e".repeat(40); s.pr.base_tip_crosscheck_oid = "e".repeat(40); })], ["base head", i => { i.evidence.base_head = "e".repeat(40); }],
  ["base head null", i => { i.evidence.base_head = null; }], ["tip crosscheck", both(s => { s.pr.base_tip_crosscheck_oid = null; })],
  ["verify app", both(s => { s.verify.runs[0]!.app_id = ACTIONS; })], ["verify external", both(s => { s.verify.runs[0]!.external_id = `m_1:${OLD_HEAD}`; })],
  ["verify conclusion", both(s => { s.verify.runs[0]!.conclusion = "failure"; })], ["verify head", both(s => { s.verify.runs[0]!.head_sha = OLD_HEAD; })],
  ["required app", both(s => { s.required_runs.runs[1]!.app_id = APP_B; })], ["required conclusion", both(s => { s.required_runs.runs[2]!.conclusion = "skipped"; })],
  ["required missing", both(s => { s.required_runs.runs.pop(); })], ["status check extra", both(s => { s.base_rules.status_checks.push({ context: "x", integration_id: ACTIONS, ruleset_id: 100 }); })], ["status check dup", both(s => { s.base_rules.status_checks.push({ ...s.base_rules.status_checks[0]!, ruleset_id: 999 }); })],
  ["status check ruleset", both(s => { s.base_rules.status_checks[0]!.ruleset_id = 5; })], ["legacy ctx", both(s => { s.base_rules.legacy.contexts = ["c"]; })],
  ["workflow", both(s => { s.files.workflow_paths_changed = true; })], ["review author", both(s => { s.reviews.items[0]!.author_id = 5; })],
  ["review bot", both(s => { s.reviews.items[0]!.author_type = "Bot"; })], ["review commit", both(s => { s.reviews.items[0]!.commit_oid = OLD_HEAD; })],
  ["review push", both(s => { s.reviews.items[0]!.author_can_push = false; })], ["review state", both(s => { s.reviews.items[0]!.state = "COMMENTED"; })],
  ["changes requested", both(s => { s.reviews.items.push({ review_id: 9, state: "CHANGES_REQUESTED", submitted_at_ms: 9, commit_oid: OLD_HEAD, author_type: "User", author_id: 5, author_can_push: true }); })],
  ["threads", both(s => { s.threads.unresolved = 1; })], ["force push", both(s => { s.timeline.force_push_events = 1; })],
  ["mission ids", both(s => { s.mission_rules.ruleset_ids = [200]; })], ["writers bypass", both(s => { s.rulesets["200"]!.bypass_actors = []; })],
  ["history bypass", both(s => { s.rulesets["201"]!.bypass_actors = [{ actor_type: "Integration", actor_id: APP_A, bypass_mode: "always" }]; })],
  ["writers enforcement", both(s => { s.rulesets["200"]!.enforcement = "disabled"; })], ["quality bypass", both(s => { s.rulesets["100"]!.bypass_actors = null; })],
  ["pr rule", both(s => { s.base_rules.pull_request!.require_last_push_approval = false; })], ["update bypass", both(s => { s.rulesets["300"]!.bypass_actors = []; })],
  ["update publisher", both(s => { s.rulesets["300"]!.bypass_actors!.push({ actor_type: "Integration", actor_id: APP_A, bypass_mode: "always" }); })],
  ["state", both(s => { s.pr.state = "CLOSED"; })], ["draft", both(s => { s.pr.is_draft = true; })], ["mergeable", both(s => { s.pr.mergeable = "CONFLICTING"; })],
  ["merge state", both(s => { s.pr.merge_state_status = "BEHIND"; })], ["review decision", both(s => { s.pr.review_decision = "REVIEW_REQUIRED"; })],
  ["join", i => { i.evidence.join_count = 2; }], ["publication", i => { i.evidence.publication_kind = "evidence_missing"; }], ["digest", i => { i.evidence.event_digest = "0".repeat(64); }],
  ["incomplete reviews", both(s => { s.reviews.complete = false; })], ["incomplete files", both(s => { s.files.complete = false; })],
  ["second read missing", i => { i.second = null; }], ["second differs", i => { if (i.second) i.second.pr.is_draft = true; }],
];

it("would_merge only when the reference predicate holds, and agrees with it on random mutation sets", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 0, max: MUTATIONS.length - 1 }), { maxLength: 4 }), picks => {
    const input = baseInput();
    for (const p of picks) MUTATIONS[p]![1](input);
    const r = evaluateMergeGates(input);
    const ref = reference(input) && input.second !== null && JSON.stringify(input.second) === JSON.stringify(input.snapshot);
    if (r.verdict === "would_merge") { expect(ref).toBe(true); expect(r.codes).toEqual([]); expect(r.request).toEqual({ sha: input.snapshot.pr.head_oid, merge_method: "squash" }); }
    else { expect(r.codes.length).toBeGreaterThan(0); expect(r.verdict === "unevaluated" ? r.codes.every(c => c.startsWith("U.")) : r.codes.every(c => !c.startsWith("U."))).toBe(true); }
    // The reference only passes when nothing was mutated into a failure; the two must agree both ways.
    expect(r.verdict === "would_merge").toBe(ref);
  }), { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) });
});

it("no single-field perturbation of head, base, review author, check app id or external id yields would_merge", () => {
  const hex = fc.stringMatching(/^[0-9a-f]{40}$/).filter(x => x !== H);
  const perturb = fc.oneof(
    hex.map<Mut>(x => both(s => { s.pr.head_oid = x; })),
    hex.map<Mut>(x => both(s => { s.pr.base_tip_oid = x; s.pr.base_tip_crosscheck_oid = x; })),
    hex.map<Mut>(x => i => { i.evidence.base_head = x; }),
    fc.integer({ min: 1, max: 1e9 }).filter(n => n !== OWNER).map<Mut>(n => both(s => { s.reviews.items[0]!.author_id = n; })),
    fc.integer({ min: 1, max: 1e9 }).filter(n => n !== APP_B).map<Mut>(n => both(s => { s.verify.runs[0]!.app_id = n; })),
    fc.integer({ min: 1, max: 1e9 }).filter(n => n !== ACTIONS).map<Mut>(n => both(s => { s.required_runs.runs[fc.sample(fc.integer({ min: 0, max: CHECKS.length - 1 }), 1)[0]!]!.app_id = n; })),
    fc.string({ maxLength: 20 }).filter(x => x !== `m_1:${H}`).map<Mut>(x => both(s => { s.verify.runs[0]!.external_id = x; })),
    fc.integer({ min: 1, max: 1e9 }).filter(n => n !== 9001).map<Mut>(n => both(s => { s.pr.author = { type: "Bot", database_id: n }; })),
    fc.integer({ min: 1, max: 1e9 }).filter(n => n !== APP_E).map<Mut>(n => both(s => { s.rulesets["300"]!.bypass_actors![0]!.actor_id = n; })),
  );
  fc.assert(fc.property(perturb, mut => {
    const input = baseInput(); mut(input);
    expect(evaluateMergeGates(input).verdict).not.toBe("would_merge");
  }), { numRuns: RUNS, ...(SEED === undefined ? {} : { seed: SEED }) });
});

it("agrees with itself: random second-read perturbations never produce would_merge", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: MUTATIONS.length - 1 }), p => {
    const input = baseInput();
    const second = structuredClone(input.snapshot); input.second = second;
    const m = MUTATIONS[p]![1];
    const probe: MergeGateInput = { ...input, snapshot: second, second: null };
    m(probe);
    const r = evaluateMergeGates(input);
    if (JSON.stringify(second) !== JSON.stringify(input.snapshot)) expect(r.verdict).not.toBe("would_merge");
  }), { numRuns: Math.min(RUNS, 500), ...(SEED === undefined ? {} : { seed: SEED }) });
});

// ---- ledger: dedupe never hides the latest accepted observation ----

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
let root = ""; let store: MergerShadowStore; let missionId = ""; let db: ReturnType<typeof openDb>;
beforeAll(() => {
  root = realpathSync(createScratchDirSync("tests", "merger-prop"));
  const path = join(root, "state.db"); db = openDb({ path }); db.pragma("synchronous=FULL");
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  missionId = new ContainedMissionStore(attention, owner).authorize(principal, { scope_id: scope.scope_id, spec: { goal: "g" }, claim: { repo_identity: "repo", branch: "b", worktree_identity: "w" } }, 1000).mission_id;
  store = new MergerShadowStore(attention, owner);
});
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

type Triple = string;
const HEADS = ["a".repeat(40), "b".repeat(40)];
type RecordOp = { t: "record"; pick: number; head: number; kind: number; codes: number };
type LedgerOp = { t: "take" } | RecordOp;
it("a deduplicated observation never hides the latest accepted one, and stale tickets never land", () => {
  const ops = fc.array(fc.oneof(
    fc.constant<LedgerOp>({ t: "take" }),
    fc.record({ t: fc.constant("record"), pick: fc.nat(8), head: fc.nat(1), kind: fc.nat(2), codes: fc.nat(2) }),
  ), { minLength: 1, maxLength: 24 });
  let pr = 1000;
  fc.assert(fc.property(ops, plan => {
    pr += 1; const repo = "o/prop";
    const held: number[] = []; let issued = 0; let accepted = 0; const modelRows: Triple[] = []; let latest: Triple | null = null;
    for (const op of plan) {
      if (op.t === "take") { const n = store.beginObservation(repo, pr, 1); issued += 1; expect(n).toBe(issued); held.push(n); continue; }
      if (held.length === 0) continue;
      const rec = op as RecordOp;
      const n = held[rec.pick % held.length]!;
      const verdict = (["would_merge", "refused", "unevaluated"] as const)[rec.kind]!;
      const head = HEADS[rec.head]!;
      const codes = verdict === "would_merge" ? [] : verdict === "refused" ? [["G7.draft"], ["G7.draft", "G5.base_moved"], ["G6.unresolved_threads"]][rec.codes]! : [["U.read_failed:a"], ["U.read_incomplete:G3"], ["U.mergeability_unknown"]][rec.codes]!;
      const input: MergerDecisionInput = { repository: repo, pr_number: pr, mission_id: missionId, head_sha: head, base_sha: "c".repeat(40), verdict, codes, gates: { second_read: true }, evidence_digest: "e".repeat(64), observed_at: 1,
        merge_request: verdict === "would_merge" ? { sha: head, merge_method: "squash" } : null };
      const triple = `${head}|${verdict}|${sha(JSON.stringify([...new Set(codes)].sort()))}`;
      if (n > accepted) {
        const res = store.recordDecision(input, n, 2);
        accepted = n;
        const dup = latest === triple;
        expect(res.decision).toBe(dup ? "deduped" : "recorded");
        if (!dup) modelRows.push(triple);
        latest = triple;
      } else {
        let err: unknown; try { store.recordDecision(input, n, 2); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(MergerShadowError);
        expect((err as MergerShadowError).code).toBe("merger_stale_observation");
      }
      // After every step: the watermark is the highest accepted ticket, and the newest decision row is the newest accepted observation.
      expect(store.watermark(repo, pr)?.accepted_seq ?? 0).toBe(accepted);
      const rows = store.decisions(repo, pr);
      expect(rows.map(r => `${r.head_sha}|${r.verdict}|${r.codes_digest}`)).toEqual(modelRows);
      if (latest !== null) expect(`${rows.at(-1)!.head_sha}|${rows.at(-1)!.verdict}|${rows.at(-1)!.codes_digest}`).toBe(latest);
      for (let k = 1; k < rows.length; k += 1) expect(`${rows[k]!.head_sha}|${rows[k]!.verdict}|${rows[k]!.codes_digest}`).not.toBe(`${rows[k - 1]!.head_sha}|${rows[k - 1]!.verdict}|${rows[k - 1]!.codes_digest}`);
      expect(rows.map(r => r.observation_seq)).toEqual([...rows.map(r => r.observation_seq)].sort((a, b) => a - b));
    }
  }), { numRuns: Math.min(RUNS, 300), ...(SEED === undefined ? {} : { seed: SEED }) });
});
