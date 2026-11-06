import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "./attention-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";
import { openDb } from "./db.js";
import { ENGINEERING_MERGER_DDL } from "./engineering-merger-ddl.js";
import {
  EMPTY_CODES_DIGEST, MergerShadowError, MergerShadowStore, mergerShadowWriter, type MergerDecisionInput, type MergerOutcomeInput,
} from "./engineering-merger-store.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const A = "a".repeat(40); const B = "b".repeat(40); const BASE = "c".repeat(40); const EV = "e".repeat(64);
const REPO = "o/r";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function setup() {
  const root = realpathSync(createScratchDirSync("tests", "merger"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const missions = new ContainedMissionStore(attention, owner);
  const store = new MergerShadowStore(attention, owner);
  let n = 0; let pr = 0;
  const mission = () => { n += 1; return missions.authorize(principal, { scope_id: scope.scope_id, spec: { goal: `g${n}` }, claim: { repo_identity: "repo", branch: `b${n}`, worktree_identity: `w${n}` } }, 1000).mission_id; };
  const pr_ = () => { pr += 1; return { repository: REPO, pr_number: pr, mission_id: mission() }; };
  return { db, path, attention, owner, store, mission, pr: pr_ };
}
type Fixture = ReturnType<typeof setup>;
type K = ReturnType<Fixture["pr"]>;
function code(fn: () => unknown): string { try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); } return "no_error"; }
const take = (f: Fixture, k: K, now = 1): number => f.store.beginObservation(k.repository, k.pr_number, now);

const dec = (k: K, over: Partial<MergerDecisionInput> = {}): MergerDecisionInput => ({
  ...k, head_sha: A, base_sha: BASE, verdict: "refused", codes: ["G5.base_moved"], gates: { second_read: true }, merge_request: null, evidence_digest: EV, observed_at: 100, ...over,
});
const wm = (k: K, over: Partial<MergerDecisionInput> = {}): MergerDecisionInput =>
  dec(k, { verdict: "would_merge", codes: [], merge_request: { sha: A, merge_method: "squash" }, ...over });
const unev = (k: K, over: Partial<MergerDecisionInput> = {}): MergerDecisionInput => dec(k, { verdict: "unevaluated", codes: ["U.read_failed:x"], ...over });
const out = (k: K, kind: MergerOutcomeInput["outcome"], over: Partial<MergerOutcomeInput> = {}): MergerOutcomeInput => ({
  repository: k.repository, pr_number: k.pr_number, mission_id: k.mission_id, outcome: kind, head_at_close: A, observed_at: 50,
  ...(kind === "merged" ? { merged_at: "2026-11-06T10:00:00Z", merge_commit: B, merged_by_actor_id: 269190136, merged_by_type: "User" as const, owner_approved_head: true } : {}), ...over,
});

/** A raw decision INSERT behind an advanced fence, to attempt row shapes the store never writes. */
function rawDecision(f: Fixture, over: Record<string, unknown> = {}, verdict: "would_merge" | "refused" | "unevaluated" = "refused") {
  const k = f.pr(); const t = take(f, k);
  f.db.prepare("UPDATE engineering_merger_shadow_watermarks SET accepted_seq=? WHERE repository=? AND pr_number=?").run(t, k.repository, k.pr_number);
  const codes = verdict === "would_merge" ? "[]" : verdict === "unevaluated" ? '["U.x"]' : '["G5.base_moved"]';
  const row: Record<string, unknown> = {
    repository: k.repository, pr_number: k.pr_number, mission_id: k.mission_id, observation_seq: t, head_sha: A, base_sha: BASE, verdict, codes_json: codes,
    codes_digest: verdict === "would_merge" ? EMPTY_CODES_DIGEST : sha(codes), gates_json: "{}",
    merge_request_json: verdict === "would_merge" ? JSON.stringify({ sha: A, merge_method: "squash" }) : null, evidence_digest: EV, observed_at: 1, created_at: 1, ...over,
  };
  const cols = Object.keys(row);
  return () => f.db.prepare(`INSERT INTO engineering_merger_shadow_decisions(${cols.join(",")}) VALUES(${cols.map(c => `@${c}`).join(",")})`).run(row);
}

it("adds the four tables in migration 52 additively and reopens cleanly from schema 51", () => {
  const root = realpathSync(createScratchDirSync("tests", "merger-upgrade"));
  const path = join(root, "state.db");
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const old = new Database(path); old.pragma("foreign_keys = ON");
  for (const m of MIGRATIONS.filter(x => x.id <= 51)) { old.exec("BEGIN"); old.exec(m.sql); old.pragma(`user_version = ${m.id}`); old.exec("COMMIT"); }
  const before = (old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
  old.close();
  const db = openDb({ path });
  expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
  expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  const after = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name);
  expect(after.filter(t => !before.includes(t) && t.startsWith("engineering_merger_shadow_"))).toEqual([
    "engineering_merger_shadow_cycles", "engineering_merger_shadow_decisions", "engineering_merger_shadow_outcomes", "engineering_merger_shadow_watermarks",
  ]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  db.close();
  const reopened = openDb({ path }); expect(reopened.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION); reopened.close();
});

it("hashes the empty code list to the constant the migration hard-codes", () => {
  expect(EMPTY_CODES_DIGEST).toBe("4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
  expect(ENGINEERING_MERGER_DDL).toContain(EMPTY_CODES_DIGEST);
});

it("never uses REPLACE in the writer source", () => {
  const src = readFileSync(join(__dirname, "engineering-merger-store.ts"), "utf8");
  expect(src).not.toMatch(/replace/i);
});

it("issues observation numbers per PR, only counting up", () => {
  const f = setup(); const k = f.pr(); const k2 = f.pr();
  expect([take(f, k), take(f, k), take(f, k)]).toEqual([1, 2, 3]);
  expect(take(f, k2)).toBe(1);
  expect(f.store.watermark(k.repository, k.pr_number)).toMatchObject({ issued_seq: 3, accepted_seq: 0 });
});

it("rejects a stale observation after a deduped one (the design counterexample)", () => {
  const f = setup(); const k = f.pr();
  const a = take(f, k); const b = take(f, k); const c = take(f, k);
  expect(f.store.recordDecision(dec(k), a, 10)).toMatchObject({ decision: "recorded" });
  expect(f.store.recordDecision(dec(k), c, 11)).toMatchObject({ decision: "deduped", decision_seq: null }); // watermark -> c although no row
  expect(f.store.watermark(k.repository, k.pr_number)?.accepted_seq).toBe(c);
  expect(code(() => f.store.recordDecision(wm(k, { observed_at: 9_999_999 }), b, 12))).toBe("merger_stale_observation");
  expect(code(() => f.store.recordDecision(wm(k), c, 12))).toBe("merger_stale_observation"); // a number is used once
  expect(f.store.decisions(k.repository, k.pr_number).map(d => d.verdict)).toEqual(["refused"]);
  expect(f.store.watermark(k.repository, k.pr_number)?.accepted_seq).toBe(c);
  expect(f.store.recordDecision(wm(k), take(f, k), 13)).toMatchObject({ decision: "recorded" });
});

it("orders by ticket, not by wall clock: a clock that runs backwards with a rising ticket is accepted", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(dec(k, { observed_at: 5000 }), take(f, k, 5000), 5000);
  expect(f.store.recordDecision(wm(k, { observed_at: 10 }), take(f, k, 10), 10)).toMatchObject({ decision: "recorded" });
  expect(f.store.decisions(k.repository, k.pr_number).map(d => [d.verdict, d.observed_at])).toEqual([["refused", 5000], ["would_merge", 10]]);
});

it("keeps the change sequence: refused, would_merge, refused all stay; identical repeats drop; head A to B to A stays", () => {
  const f = setup(); const k = f.pr();
  const rec = (d: MergerDecisionInput) => f.store.recordDecision(d, take(f, k), 1).decision;
  expect(rec(dec(k))).toBe("recorded");
  expect(rec(wm(k))).toBe("recorded");
  expect(rec(dec(k))).toBe("recorded");
  expect(rec(dec(k))).toBe("deduped");
  expect(rec(dec(k, { head_sha: B }))).toBe("recorded");
  expect(rec(dec(k))).toBe("recorded");
  expect(rec(dec(k, { codes: ["G5.base_moved", "G7.draft"] }))).toBe("recorded");
  expect(f.store.decisions(k.repository, k.pr_number).map(d => `${d.head_sha[0]}:${d.verdict}`)).toEqual(["a:refused", "a:would_merge", "a:refused", "b:refused", "a:refused", "a:refused"]);
  expect(f.store.watermark(k.repository, k.pr_number)).toMatchObject({ issued_seq: 7, accepted_seq: 7 });
});

it("sorts and de-duplicates codes before hashing, so ordering cannot defeat dedupe", () => {
  const f = setup(); const k = f.pr();
  expect(f.store.recordDecision(dec(k, { codes: ["G7.draft", "G5.base_moved"] }), take(f, k), 1).decision).toBe("recorded");
  expect(f.store.recordDecision(dec(k, { codes: ["G5.base_moved", "G7.draft", "G7.draft"] }), take(f, k), 2).decision).toBe("deduped");
  expect(JSON.parse(f.store.decisions(k.repository, k.pr_number)[0]!.codes_json)).toEqual(["G5.base_moved", "G7.draft"]);
});

it("stores would_merge with its merge request and the empty-codes digest", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(wm(k), take(f, k), 1);
  const d = f.store.decisions(k.repository, k.pr_number)[0]!;
  expect(d).toMatchObject({ verdict: "would_merge", codes_json: "[]", codes_digest: EMPTY_CODES_DIGEST, base_sha: BASE, observation_seq: 1 });
  expect(JSON.parse(d.merge_request_json!)).toEqual({ sha: A, merge_method: "squash" });
});

it("validates rows in code before insert, so an invalid duplicate is rejected rather than silently deduped", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(dec(k), take(f, k), 1);
  // These would be dropped by the dedupe trigger (it runs before the CHECKs) if they reached SQL as a repeat of the first row.
  const bad = (d: MergerDecisionInput) => code(() => f.store.recordDecision(d, take(f, k), 2));
  expect(bad(dec(k, { gates: { big: "x".repeat(17000) } }))).toBe("merger_invalid_input");
  expect(bad(dec(k, { evidence_digest: "short" }))).toBe("merger_invalid_input");
  expect(bad(dec(k, { codes: [] }))).toBe("merger_verdict_codes_mismatch");
  expect(bad(wm(k, { codes: ["x"] }))).toBe("merger_verdict_codes_mismatch");
  expect(bad(wm(k, { merge_request: { sha: B, merge_method: "squash" } }))).toBe("merger_invalid_merge_request");
  expect(bad(wm(k, { merge_request: null }))).toBe("merger_invalid_merge_request");
  expect(bad(wm(k, { base_sha: null }))).toBe("merger_invalid_merge_request"); // malformed would_merge (null base)
  expect(bad(dec(k, { merge_request: { sha: A, merge_method: "squash" } }))).toBe("merger_invalid_merge_request");
  expect(bad(dec(k, { base_sha: null }))).toBe("merger_invalid_input");
  expect(bad(dec(k, { head_sha: "XYZ" }))).toBe("merger_invalid_input");
  expect(bad(dec(k, { head_sha: A.toUpperCase() }))).toBe("merger_invalid_input");
  expect(bad(dec(k, { codes: ["U.read_failed"] }))).toBe("merger_decision_codes_invalid");
  expect(bad(unev(k, { codes: ["G5.base_moved"] }))).toBe("merger_decision_codes_invalid");
  expect(code(() => f.store.recordDecision(dec(k), 0, 2))).toBe("merger_invalid_input");
  expect(code(() => f.store.recordDecision(dec(k), take(f, k), -1))).toBe("merger_invalid_clock");
  expect(code(() => f.store.beginObservation(REPO, 0, 1))).toBe("merger_invalid_input");
  // None of the failures advanced the fence beyond the one accepted decision.
  expect(f.store.watermark(k.repository, k.pr_number)?.accepted_seq).toBe(1);
  expect(f.store.recordDecision(unev(k, { base_sha: null }), take(f, k), 3).decision).toBe("recorded");
});

it("exposes only four write methods through the shadow writer", () => {
  const f = setup();
  expect(Object.keys(mergerShadowWriter(f.store)).sort()).toEqual(["beginObservation", "recordCycle", "recordDecision", "recordOutcome"]);
});

it("never hands out a ticket inside a caller's transaction, where an outer rollback would issue it twice", () => {
  const f = setup(); const k = f.pr();
  f.db.exec("BEGIN");
  expect(code(() => take(f, k))).toBe("merger_nested_transaction");
  f.db.exec("ROLLBACK");
  expect(take(f, k)).toBe(1);
});

it("rejects malformed or forbidden gate payloads before they can be deduplicated or stored", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(dec(k), take(f, k), 1);
  const bad = (gates: unknown) => code(() => f.store.recordDecision(dec(k, { gates: gates as Record<string, unknown> }), take(f, k), 2));
  expect(bad([])).toBe("merger_invalid_input"); // an identical repeat must not slip past the object check via dedupe
  expect(bad("x")).toBe("merger_invalid_input");
  expect(bad({ body: "pr text" })).toBe("merger_invalid_input");
  expect(bad({ g3: { login: "someone", check_run_id: 1, nested: { a: { b: { c: { d: 1 } } } } } })).toBe("merger_invalid_input");
  expect(bad({ g3: { url: "x".repeat(200) } })).toBe("merger_invalid_input");
  expect(bad({ g3: { fn: () => 1 } })).toBe("merger_invalid_input");
  expect(bad({ g3: { n: Number.NaN } })).toBe("merger_invalid_input");
  expect(f.store.watermark(k.repository, k.pr_number)?.accepted_seq).toBe(1);
  expect(code(() => f.store.recordDecision(dec(k, { gates: { g3: { check_run_id: 1, conclusion: "success" }, g2c: { live: A, marker: null } } }), take(f, k), 2))).toBe("no_error");
});

it("records scan cycles through a validated, fenced writer", () => {
  const f = setup(); const k = f.pr();
  const id = f.store.recordCycle(10, 20, [[k.repository, k.pr_number, 1, A, "refused"]], 21);
  expect(id).toBeGreaterThan(0);
  expect(JSON.parse((f.db.prepare("SELECT prs_json FROM engineering_merger_shadow_cycles WHERE seq=?").get(id) as { prs_json: string }).prs_json)).toEqual([[k.repository, k.pr_number, 1, A, "refused"]]);
  expect(code(() => f.store.recordCycle(20, 10, [], 21))).toBe("merger_invalid_input");
  expect(code(() => f.store.recordCycle(10, 20, Array.from({ length: 11 }, () => [k.repository, k.pr_number, 1, A, "refused"] as const), 21))).toBe("merger_invalid_input");
  expect(code(() => f.store.recordCycle(10, 20, [[k.repository, k.pr_number, 1, "nothex", "refused"]], 21))).toBe("merger_invalid_input");
  f.attention.claimOwner("newer");
  expect(code(() => f.store.recordCycle(10, 20, [], 21))).toBe("stale_owner");
});

it("requires durable writes and a current owner fence", () => {
  const f = setup(); const k = f.pr();
  f.db.pragma("synchronous=OFF");
  expect(code(() => take(f, k))).toBe("durability_required");
  f.db.pragma("synchronous=FULL");
  f.attention.claimOwner("newer");
  expect(code(() => take(f, k))).toBe("stale_owner");
  expect(f.store.watermark(k.repository, k.pr_number)).toBeNull();
});

it("surfaces trigger refusals as coded errors", () => {
  const f = setup(); const k = f.pr();
  try { f.store.recordDecision(dec(k), 1, 1); } catch (e) { expect(e).toBeInstanceOf(MergerShadowError); return; }
  throw new Error("expected a refusal");
});

it("rolls the fence back when a later statement in the same transaction aborts", () => {
  const f = setup(); const k = f.pr();
  f.store.recordOutcome(out(k, "merged"), take(f, k), 1);
  const n = take(f, k);
  // The fence advance succeeds, then the decision aborts (the PR is merged): the advance must not survive.
  expect(code(() => f.store.recordDecision(dec(k), n, 2))).toBe("merger_pr_merged");
  expect(f.store.watermark(k.repository, k.pr_number)).toMatchObject({ accepted_seq: 1, issued_seq: 2 });
});

// ---- raw DDL guards ----

it("keeps the watermark monotone, deletion-proof and insert-shaped", () => {
  const f = setup(); const k = f.pr(); take(f, k); take(f, k); take(f, k);
  const up = (set: string) => code(() => f.db.prepare(`UPDATE engineering_merger_shadow_watermarks SET ${set} WHERE pr_number=?`).run(k.pr_number));
  expect(up("issued_seq=1")).toBe("merger_watermark_regressed");
  expect(up("pr_number=99")).toBe("merger_watermark_regressed");
  expect(up("repository='x/y'")).toBe("merger_watermark_regressed");
  expect(up("accepted_seq=5")).toMatch(/CHECK/); // cannot pass issued_seq
  expect(up("accepted_seq=2")).toBe("no_error");
  expect(up("accepted_seq=2")).toBe("merger_stale_observation");
  expect(up("accepted_seq=1")).toMatch(/merger_watermark_regressed|merger_stale_observation/);
  expect(code(() => f.db.prepare("DELETE FROM engineering_merger_shadow_watermarks").run())).toBe("merger_shadow_immutable");
  const ins = (i: number, a: number, pr = 777) => code(() => f.db.prepare("INSERT INTO engineering_merger_shadow_watermarks(repository,pr_number,issued_seq,accepted_seq,updated_at) VALUES('o/r',?,?,?,1)").run(pr, i, a));
  expect(ins(5, 5)).toBe("merger_watermark_insert");
  expect(ins(0, 0)).toBe("merger_watermark_insert");
  expect(ins(1, 1)).toBe("merger_watermark_insert");
  expect(ins(2, 0)).toBe("merger_watermark_insert");
  expect(ins(1, 0)).toBe("no_error");
  expect(code(() => f.db.prepare("INSERT INTO engineering_merger_shadow_watermarks(repository,pr_number,issued_seq,accepted_seq,updated_at) VALUES('o/r',778,NULL,0,1)").run())).toMatch(/NOT NULL|merger_/);
});

it("keeps decisions, outcomes and cycles append-only", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(dec(k), take(f, k), 1);
  f.store.recordOutcome(out(k, "closed_unmerged"), take(f, k), 1);
  f.db.prepare("INSERT INTO engineering_merger_shadow_cycles(started_at,finished_at,prs_json) VALUES(1,2,'[]')").run();
  for (const table of ["decisions", "outcomes", "cycles"]) {
    expect(code(() => f.db.prepare(`UPDATE engineering_merger_shadow_${table} SET seq=seq`).run())).toBe("merger_shadow_immutable");
    expect(code(() => f.db.prepare(`DELETE FROM engineering_merger_shadow_${table}`).run())).toBe("merger_shadow_immutable");
  }
  expect(code(() => f.db.prepare("INSERT INTO engineering_merger_shadow_cycles(started_at,finished_at,prs_json) VALUES(1,2,'{}')").run())).toMatch(/CHECK/);
  expect(code(() => f.db.prepare("INSERT INTO engineering_merger_shadow_cycles(started_at,finished_at,prs_json) VALUES(NULL,2,'[]')").run())).toMatch(/NOT NULL/);
});

it("refuses an unfenced decision or outcome, even a duplicate of the last one", () => {
  const f = setup(); const k = f.pr();
  const t = take(f, k); f.store.recordDecision(dec(k), t, 1);
  const rawDup = (n: number) => code(() => f.db.prepare(`INSERT INTO engineering_merger_shadow_decisions(repository,pr_number,mission_id,observation_seq,head_sha,base_sha,verdict,codes_json,codes_digest,gates_json,
    evidence_digest,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'{}',?,1,1)`).run(k.repository, k.pr_number, k.mission_id, n, A, BASE, "refused", '["G5.base_moved"]', sha('["G5.base_moved"]'), EV));
  expect(rawDup(99)).toBe("merger_unfenced_decision"); // would be swallowed by dedupe if it did not repeat the fence
  expect(rawDup(t - 1 || 99)).toBe("merger_unfenced_decision");
  const rawOut = (n: number) => code(() => f.db.prepare(`INSERT INTO engineering_merger_shadow_outcomes(repository,pr_number,mission_id,observation_seq,outcome,head_at_close,facts_json,observed_at,created_at)
    VALUES(?,?,?,?,'closed_unmerged',?,'{}',1,1)`).run(k.repository, k.pr_number, k.mission_id, n, A));
  expect(rawOut(t + 3)).toBe("merger_unfenced_outcome");
  expect(code(() => f.db.prepare("INSERT INTO engineering_merger_shadow_decisions(repository,pr_number,mission_id,observation_seq,head_sha,base_sha,verdict,codes_json,codes_digest,gates_json,evidence_digest,observed_at,created_at) VALUES('o/r',424242,?,1,?,?,'refused','[\"x\"]',?,'{}',?,1,1)")
    .run(k.mission_id, A, BASE, sha('["x"]'), EV))).toBe("merger_unfenced_decision"); // no watermark row at all
  // One number carries at most one decision row (unique index) ...
  const diff = (n: number, head: string, c: string) => code(() => f.db.prepare(`INSERT INTO engineering_merger_shadow_decisions(repository,pr_number,mission_id,observation_seq,head_sha,base_sha,verdict,codes_json,codes_digest,gates_json,
    evidence_digest,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'{}',?,1,1)`).run(k.repository, k.pr_number, k.mission_id, n, head, BASE, "refused", c, sha(c), EV));
  expect(diff(t, B, '["G7.draft"]')).toMatch(/UNIQUE/);
  // ... but after a deduped observation (no row) a different decision under the same number still lands: the documented
  // residual, closed by the writer (one fixed statement pair per transaction), not by the database.
  const t2 = take(f, k); f.store.recordDecision(dec(k), t2, 2);
  expect(f.store.decisions(k.repository, k.pr_number)).toHaveLength(1);
  expect(diff(t2, B, '["G7.draft"]')).toBe("no_error");
});

it("accepts no decision after a merge, duplicate or not", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(wm(k), take(f, k), 1);
  f.store.recordOutcome(out(k, "merged"), take(f, k), 2);
  expect(code(() => f.store.recordDecision(dec(k, { head_sha: B }), take(f, k), 3))).toBe("merger_pr_merged");
  expect(code(() => f.store.recordDecision(wm(k), take(f, k), 3))).toBe("merger_pr_merged"); // identical to the last decision
  expect(f.store.decisions(k.repository, k.pr_number)).toHaveLength(1);
  expect(f.store.decisionBeforeMerge(k.repository, k.pr_number)).toMatchObject({ verdict: "would_merge", observation_seq: 1 });
});

it("finds the decision before a merge by observation number, never by wall time", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(dec(k, { observed_at: 9000 }), take(f, k), 9000);
  f.store.recordDecision(wm(k, { observed_at: 100 }), take(f, k), 100);
  f.store.recordOutcome(out(k, "merged", { observed_at: 1 }), take(f, k), 1);
  expect(f.store.decisionBeforeMerge(k.repository, k.pr_number)).toMatchObject({ verdict: "would_merge", observation_seq: 2 });
  expect(f.store.decisionBeforeMerge(f.pr().repository, 999)).toBeNull();
});

it("accepts a decision only as the newest accepted number, and the shapes the schema pins down", () => {
  const f = setup();
  expect(rawDecision(f)).not.toThrow();
  for (const bad of ["{}", "[]", "not json", '"x"', "null", "[1]", '[""]']) expect(code(rawDecision(f, { codes_json: bad, codes_digest: sha(bad) })), bad).not.toBe("no_error");
  expect(code(rawDecision(f, { codes_json: '["U.read_failed"]', codes_digest: sha('["U.read_failed"]') }, "refused"))).toBe("merger_decision_codes_invalid");
  expect(code(rawDecision(f, { codes_json: '["G5.base_moved"]', codes_digest: sha('["G5.base_moved"]') }, "unevaluated"))).toBe("merger_decision_codes_invalid");
  expect(rawDecision(f, {}, "unevaluated")).not.toThrow();
  expect(rawDecision(f, {}, "would_merge")).not.toThrow();
  expect(code(rawDecision(f, { codes_json: '["x"]' }, "would_merge"))).toMatch(/CHECK|merger_/);
  expect(code(rawDecision(f, { codes_digest: sha("[ ]") }, "would_merge"))).toMatch(/CHECK/);
});

it("closes the NULL holes in the decision shape", () => {
  const f = setup();
  const reject = (over: Record<string, unknown>, verdict: "would_merge" | "refused" | "unevaluated" = "would_merge") =>
    expect(code(rawDecision(f, over, verdict)), JSON.stringify(over)).toMatch(/CHECK|NOT NULL|merger_unfenced_decision/);
  reject({ base_sha: null }); // length(NULL) IN (...) is NULL, which a bare CHECK lets through
  reject({ merge_request_json: null });
  reject({ merge_request_json: JSON.stringify({ sha: B, merge_method: "squash" }) });
  reject({ merge_request_json: JSON.stringify({ sha: A, merge_method: "merge" }) });
  reject({ merge_request_json: JSON.stringify({ sha: A }) }); // json_extract(...merge_method) is NULL
  reject({ merge_request_json: JSON.stringify({ merge_method: "squash" }) });
  reject({ merge_request_json: "[]" });
  reject({ merge_request_json: "not json" });
  reject({ base_sha: "" });
  reject({ base_sha: "abc" });
  reject({ base_sha: "Z".repeat(40) });
  reject({ merge_request_json: JSON.stringify({ sha: A, merge_method: "squash" }) }, "refused");
  reject({ base_sha: null }, "refused");
  expect(rawDecision(f, { base_sha: null }, "unevaluated")).not.toThrow();
  for (const col of ["head_sha", "verdict", "codes_json", "codes_digest", "gates_json", "evidence_digest", "observed_at", "created_at", "mission_id", "observation_seq"]) reject({ [col]: null }, "refused");
  reject({ head_sha: A.toUpperCase() }, "refused");
  reject({ evidence_digest: "short" }, "refused");
  reject({ gates_json: "[]" }, "refused");
  reject({ gates_json: "not json" }, "refused");
  reject({ gates_json: JSON.stringify({ x: "y".repeat(17000) }) }, "refused");
  reject({ verdict: "maybe" }, "refused");
  reject({ pr_number: 0 }, "refused");
  reject({ observed_at: -1 }, "refused");
});

// ---- outcomes ----

it("writes outcome segments in order: closed, reopened, merged", () => {
  const f = setup(); const k = f.pr();
  const rec = (kind: MergerOutcomeInput["outcome"], over: Partial<MergerOutcomeInput> = {}) => f.store.recordOutcome(out(k, kind, over), take(f, k), 1);
  for (const kind of ["closed_unmerged", "reopened", "closed_unmerged", "reopened"] as const) expect(rec(kind).outcome).toBe(kind);
  expect(rec("merged")).toMatchObject({ outcome: "merged", merged_by_actor_id: 269190136, owner_approved_head: 1 });
  expect(f.store.outcomes(k.repository, k.pr_number).map(o => o.outcome)).toEqual(["closed_unmerged", "reopened", "closed_unmerged", "reopened", "merged"]);
});

it("accepts closed_unmerged to merged directly", () => {
  const f = setup(); const k = f.pr();
  f.store.recordOutcome(out(k, "closed_unmerged"), take(f, k), 1);
  expect(f.store.recordOutcome(out(k, "merged", { owner_approved_head: null, facts: { reopen_unobserved: true } }), take(f, k), 2).owner_approved_head).toBeNull();
  const k2 = f.pr();
  expect(f.store.recordOutcome(out(k2, "merged"), take(f, k2), 3).outcome).toBe("merged");
});

it("refuses outcome transitions the segment machine does not allow", () => {
  const f = setup();
  const seq = (k: K, ...kinds: MergerOutcomeInput["outcome"][]) => { for (const kind of kinds) f.store.recordOutcome(out(k, kind), take(f, k), 1); };
  const next = (k: K, kind: MergerOutcomeInput["outcome"]) => code(() => f.store.recordOutcome(out(k, kind), take(f, k), 1));
  let k = f.pr(); seq(k, "closed_unmerged"); expect(next(k, "closed_unmerged")).toBe("merger_outcome_transition");
  k = f.pr(); seq(k, "merged"); for (const kind of ["reopened", "closed_unmerged", "observation_expired", "merged"] as const) expect(next(k, kind), kind).toMatch(/merger_outcome_transition|UNIQUE/);
  k = f.pr(); seq(k, "closed_unmerged", "observation_expired"); expect(next(k, "reopened")).toBe("merger_outcome_transition"); expect(next(k, "merged")).toBe("merger_outcome_transition");
  k = f.pr(); expect(next(k, "reopened")).toBe("merger_outcome_transition");
  k = f.pr(); expect(next(k, "observation_expired")).toBe("merger_outcome_transition");
  k = f.pr(); seq(k, "closed_unmerged", "reopened"); expect(next(k, "observation_expired")).toBe("merger_outcome_transition");
});

it("rejects a stale closed_unmerged after a newer reopened", () => {
  const f = setup(); const k = f.pr();
  f.store.recordOutcome(out(k, "closed_unmerged"), take(f, k), 1);
  const stale = take(f, k); const fresh = take(f, k);
  f.store.recordOutcome(out(k, "reopened", { observed_at: 1 }), fresh, 2);
  expect(code(() => f.store.recordOutcome(out(k, "closed_unmerged", { observed_at: 9_999_999 }), stale, 3))).toBe("merger_stale_observation");
  expect(code(() => f.store.recordOutcome(out(k, "reopened"), fresh, 3))).toBe("merger_stale_observation");
  expect(f.store.outcomes(k.repository, k.pr_number).map(o => o.outcome)).toEqual(["closed_unmerged", "reopened"]);
});

it("closes the NULL holes in the outcome shape", () => {
  const f = setup();
  const attempt = (kind: MergerOutcomeInput["outcome"], over: Record<string, unknown>) => {
    const k = f.pr(); const t = take(f, k);
    f.db.prepare("UPDATE engineering_merger_shadow_watermarks SET accepted_seq=? WHERE repository=? AND pr_number=?").run(t, k.repository, k.pr_number);
    const base = out(k, kind);
    const row = { repository: k.repository, pr_number: k.pr_number, mission_id: k.mission_id, observation_seq: t, outcome: kind, head_at_close: A,
      merged_at: base.merged_at ?? null, merge_commit: base.merge_commit ?? null, merged_by_actor_id: base.merged_by_actor_id ?? null, merged_by_type: base.merged_by_type ?? null,
      owner_approved_head: kind === "merged" ? 1 : null, facts_json: "{}", observed_at: 1, created_at: 1, ...over };
    const cols = Object.keys(row);
    return code(() => f.db.prepare(`INSERT INTO engineering_merger_shadow_outcomes(${cols.join(",")}) VALUES(${cols.map(c => `@${c}`).join(",")})`).run(row));
  };
  expect(attempt("merged", {})).toBe("no_error");
  for (const col of ["merged_at", "merge_commit", "merged_by_actor_id", "merged_by_type"]) expect(attempt("merged", { [col]: null }), col).toMatch(/CHECK/);
  for (const col of ["merged_at", "merge_commit", "merged_by_actor_id", "merged_by_type"]) {
    const v = col === "merged_by_actor_id" ? 5 : col === "merged_by_type" ? "User" : col === "merge_commit" ? B : "2026-11-06T10:00:00Z";
    expect(attempt("closed_unmerged", { [col]: v }), col).toMatch(/CHECK/);
  }
  expect(attempt("closed_unmerged", { owner_approved_head: 1 })).toMatch(/CHECK/);
  expect(attempt("merged", { owner_approved_head: 2 })).toMatch(/CHECK/);
  expect(attempt("merged", { merged_by_type: "Organization" })).toMatch(/CHECK/);
  expect(attempt("merged", { merge_commit: "zz" })).toMatch(/CHECK/);
  expect(attempt("merged", { merge_commit: "d".repeat(39) })).toMatch(/CHECK/);
  expect(attempt("merged", { merged_by_actor_id: 0 })).toMatch(/CHECK/);
  expect(attempt("closed_unmerged", { head_at_close: null })).toMatch(/NOT NULL/);
  expect(attempt("closed_unmerged", { head_at_close: "abc" })).toMatch(/CHECK/);
  expect(attempt("closed_unmerged", { facts_json: null })).toMatch(/NOT NULL/);
  expect(attempt("closed_unmerged", { facts_json: "[]" })).toMatch(/CHECK/);
  expect(attempt("closed_unmerged", { facts_json: "nope" })).toMatch(/CHECK/);
  expect(attempt("closed_unmerged", { outcome: null })).toMatch(/NOT NULL/);
  expect(attempt("closed_unmerged", { outcome: "gone" })).toMatch(/CHECK|merger_outcome_transition/);
  expect(attempt("closed_unmerged", { observation_seq: null })).toMatch(/NOT NULL|merger_unfenced_outcome/);
});

// ---- trigger creation order must not matter ----

it("gives the same results with the trigger creation order reversed", () => {
  const stmts = ENGINEERING_MERGER_DDL.split(/\n(?=CREATE )/).map(s => s.trim()).filter(Boolean);
  const run = (reverse: boolean): string[] => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE engineering_contained_missions(mission_id TEXT PRIMARY KEY)");
    const tables = stmts.filter(s => !s.startsWith("CREATE TRIGGER")); const triggers = stmts.filter(s => s.startsWith("CREATE TRIGGER"));
    // Tables and indexes first (triggers reference later tables only at run time), then triggers in either order.
    db.exec([...tables, ...(reverse ? [...triggers].reverse() : triggers)].join("\n"));
    const log: string[] = [];
    const tx = (label: string, sql: string, ...args: unknown[]) => {
      db.exec("BEGIN IMMEDIATE");
      try { db.prepare(sql).run(...args); db.exec("COMMIT"); log.push(`${label}:ok`); } catch (e) { db.exec("ROLLBACK"); log.push(`${label}:${(e as Error).message.split("\n")[0]}`); }
    };
    const take = (): number => { db.exec("BEGIN IMMEDIATE"); const n = (db.prepare("INSERT INTO engineering_merger_shadow_watermarks VALUES('o/r',1,1,0,0) ON CONFLICT(repository,pr_number) DO UPDATE SET issued_seq=issued_seq+1 RETURNING issued_seq").get() as { issued_seq: number }).issued_seq; db.exec("COMMIT"); return n; };
    const adv = (n: number) => db.prepare("UPDATE engineering_merger_shadow_watermarks SET accepted_seq=?,updated_at=0 WHERE repository='o/r' AND pr_number=1").run(n);
    const D = "INSERT INTO engineering_merger_shadow_decisions(repository,pr_number,mission_id,observation_seq,head_sha,base_sha,verdict,codes_json,codes_digest,gates_json,merge_request_json,evidence_digest,observed_at,created_at) VALUES('o/r',1,'m',?,?,?,?,?,?,'{}',?,?,0,0)";
    const W = JSON.stringify({ sha: A, merge_method: "squash" });
    const dec2 = (label: string, n: number, head: string, v: string, codes: string, req: string | null, base: string | null, advance = true) => {
      db.exec("BEGIN IMMEDIATE");
      try { if (advance) adv(n); db.prepare(D).run(n, head, base, v, codes, v === "would_merge" ? EMPTY_CODES_DIGEST : sha(codes), req, EV); db.exec("COMMIT"); log.push(`${label}:ok`); } catch (e) { db.exec("ROLLBACK"); log.push(`${label}:${(e as Error).message.split("\n")[0]}`); }
    };
    db.exec("INSERT INTO engineering_contained_missions(mission_id) VALUES('m')");
    const a = take(); const b = take(); const c = take();
    dec2("a", a, A, "refused", '["A"]', null, BASE); dec2("c-dup", c, A, "refused", '["A"]', null, BASE); dec2("b-stale", b, A, "would_merge", "[]", W, BASE);
    dec2("unfenced-dup", 99, A, "refused", '["A"]', null, BASE, false);
    dec2("null-base", take(), A, "would_merge", "[]", W, null);
    const O = "INSERT INTO engineering_merger_shadow_outcomes(repository,pr_number,mission_id,observation_seq,outcome,head_at_close,merged_at,merge_commit,merged_by_actor_id,merged_by_type,facts_json,observed_at,created_at) VALUES('o/r',1,'m',?,?,?,?,?,?,?,'{}',0,0)";
    const outc = (label: string, n: number, o: string) => {
      db.exec("BEGIN IMMEDIATE");
      try { adv(n); const m = o === "merged" ? ["2026-11-06T00:00:00Z", "d".repeat(40), 1, "User"] : [null, null, null, null]; db.prepare(O).run(n, o, A, ...m); db.exec("COMMIT"); log.push(`${label}:ok`); } catch (e) { db.exec("ROLLBACK"); log.push(`${label}:${(e as Error).message.split("\n")[0]}`); }
    };
    outc("closed", take(), "closed_unmerged");
    const stale = take(); const fresh = take();
    outc("reopened", fresh, "reopened"); outc("stale-closed", stale, "closed_unmerged");
    outc("merged", take(), "merged");
    dec2("after-merge", take(), B, "refused", '["X"]', null, BASE); dec2("dup-after-merge", take(), A, "refused", '["A"]', null, BASE);
    tx("bad-wm", "INSERT INTO engineering_merger_shadow_watermarks VALUES('o/r',2,5,5,0)");
    db.close();
    // A number below the accepted one trips both watermark triggers; which message wins depends on creation order, the refusal does not.
    return log.map(l => l.replace("merger_watermark_regressed", "merger_stale_observation"));
  };
  const forward = run(false); const reversed = run(true);
  expect(reversed).toEqual(forward);
  expect(forward).toEqual([
    "a:ok", "c-dup:ok", "b-stale:merger_stale_observation", "unfenced-dup:merger_unfenced_decision", expect.stringMatching(/^null-base:/), "closed:ok", "reopened:ok",
    "stale-closed:merger_stale_observation", "merged:ok", "after-merge:merger_pr_merged", "dup-after-merge:merger_pr_merged", "bad-wm:merger_watermark_insert",
  ]);
});

it("treats migrations as the single source for the merger DDL export", () => {
  expect(MIGRATIONS.at(-1)).toMatchObject({ id: 52, name: "engineering_merger_shadow", sql: ENGINEERING_MERGER_DDL });
});

it("rejects nested sensitive or unknown gate fields at any depth", () => {
  const f = setup(); const k = f.pr();
  const bad = (gates: unknown) => code(() => f.store.recordDecision(dec(k, { gates: gates as Record<string, unknown> }), take(f, k), 2));
  expect(bad({ g3: { body: "private PR body", login: "someone", url: "https://example.com" } })).toBe("merger_invalid_input");
  expect(bad({ g3: { check_run_id: 1, conclusion: "https://x/y" } })).toBe("merger_invalid_input");
  expect(bad({ g2c: { live: "not-an-oid" } })).toBe("merger_invalid_input");
  expect(bad({ g4: { required: [["check", 15368, 1, "success", "extra"]] } })).toBe("merger_invalid_input");
  expect(bad({ g7: { mergeable: "MERGEABLE", note: "x" } })).toBe("merger_invalid_input");
  expect(code(() => f.store.recordDecision(dec(k, { gates: { g3: { check_run_id: 1, conclusion: "success", duplicates: 0, foreign_same_name: 0 }, g4: { required: [["graph-macos-fixtures (22)", 15368, 4, "success"]] }, read_ms: [1, 2] } }), take(f, k), 3))).toBe("no_error");
});

it("keeps one history per PR whatever the repository casing", () => {
  const f = setup(); const k = f.pr();
  f.store.recordOutcome(out(k, "merged"), take(f, k), 1);
  const upper = { ...k, repository: k.repository.toUpperCase() };
  expect(f.store.beginObservation(upper.repository, upper.pr_number, 2)).toBe(2); // same counter
  expect(code(() => f.store.recordDecision(dec(upper), 2, 3))).toBe("merger_pr_merged");
  expect(f.store.watermark(upper.repository, upper.pr_number)).toMatchObject({ repository: k.repository, accepted_seq: 1 });
  expect(code(() => f.db.prepare("INSERT INTO engineering_merger_shadow_watermarks(repository,pr_number,issued_seq,accepted_seq,updated_at) VALUES('O/R',55,1,0,1)").run())).toMatch(/CHECK/);
});

it("refuses an unknown Mission before the fence moves, even for a repeat that dedupe would drop", () => {
  const f = setup(); const k = f.pr();
  f.store.recordDecision(dec(k), take(f, k), 1);
  const n = take(f, k);
  expect(code(() => f.store.recordDecision(dec(k, { mission_id: "missing" }), n, 2))).toBe("merger_unknown_mission");
  expect(code(() => f.store.recordOutcome(out(k, "closed_unmerged", { mission_id: "missing" }), n, 2))).toBe("merger_unknown_mission");
  expect(f.store.watermark(k.repository, k.pr_number)).toMatchObject({ accepted_seq: 1, issued_seq: 2 });
  expect(f.store.recordDecision(dec(k), n, 3).decision).toBe("deduped");
});
