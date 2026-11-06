import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import type { ChainDecision } from "../bridge/revision-chain.js";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "./attention-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";
import { openDb } from "./db.js";
import { RevisionChainError, RevisionChainStore, revisionChainUpgradeHolds, shadowChainWriter, type NewChainInput } from "./engineering-revision-chain-store.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

const BRANCH = "osstack/mission/x";
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const B2 = "c".repeat(40);
const H1 = "1".repeat(40); const H2 = "2".repeat(40); const H3 = "3".repeat(40); const B1 = "b".repeat(40);

function setup() {
  const root = realpathSync(createScratchDirSync("tests", "chain"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const missions = new ContainedMissionStore(attention, owner);
  const store = new RevisionChainStore(attention, owner);
  let n = 0;
  const mission = () => { n += 1; return missions.authorize(principal, { scope_id: scope.scope_id, spec: { goal: `g${n}` }, claim: { repo_identity: "repo", branch: `b${n}`, worktree_identity: `w${n}` } }, 1000).mission_id; };
  let pr = 100;
  const input = (root_mission_id = mission(), over: Partial<NewChainInput> = {}): NewChainInput => { pr += 1; return { root_mission_id, repository: "o/r", pr_number: pr, branch: "osstack/mission/x", base_ref: "main", published_head: H1, published_base: B1, trace_id: "tr", ...over }; };
  const shadow = (over: Partial<NewChainInput> = {}) => store.createShadowChain(input(undefined, over), 10);
  const live = (rounds: 1 | 2 = 2, over: Partial<NewChainInput> = {}) => store.createLiveChain({ ...input(undefined, over), grant: { rounds } }, 10);
  /** Terminal child with a proven stop; `stopProven=false` leaves the executor stop obligation open. */
  const child = (state: "executing" | "failed" = "executing") => {
    const id = mission();
    if (state === "failed") {
      db.prepare("UPDATE engineering_contained_missions SET stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(id);
      db.prepare("UPDATE engineering_contained_missions SET state='failed',revision=revision+1 WHERE mission_id=?").run(id);
    }
    return id;
  };
  const finish = (id: string, stopProven = true) => {
    db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(id);
    if (stopProven) db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(id);
  };
  return { db, path, root, attention, owner, scope, principal, store, mission, input, shadow, live, child, finish };
}
type Fixture = ReturnType<typeof setup>;
const reserveInput = (head = H1) => ({ head, review_ids: [7], feedback_digest: "d".repeat(64) });
function code(fn: () => unknown): string { try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); } return "no_error"; }

/** A raw chain INSERT, to attempt violations the store would never write. */
function rawChain(f: Fixture, over: Record<string, unknown> = {}) {
  const row = {
    chain_id: `rc_${Math.random().toString(36).slice(2)}`, mode: "live", root_mission_id: f.mission(), current_mission_id: null,
    repository: "o/r", pr_number: 900 + Math.floor(Math.random() * 1e6), branch: "b", base_ref: "main", published_head: H1, published_base: B1,
    grant_json: '{"kind":"live","rounds":2}', rounds_used: 0, state: "awaiting_review", stop_reason: null, review_deadline: null,
    trace_id: "tr", revision: 1, created_at: 1, updated_at: 1, ...over,
  };
  const cols = Object.keys(row);
  f.db.prepare(`INSERT INTO engineering_revision_chains(${cols.join(",")}) VALUES(${cols.map(c => `@${c}`).join(",")})`).run(row);
  return row;
}

it("adds the five tables in migration 51 additively and reopens cleanly from schema 50", () => {
  const root = realpathSync(createScratchDirSync("tests", "chain-upgrade"));
  const path = join(root, "state.db");
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const old = new Database(path); old.pragma("foreign_keys = ON");
  for (const m of MIGRATIONS.filter(x => x.id <= 50)) { old.exec("BEGIN"); old.exec(m.sql); old.pragma(`user_version = ${m.id}`); old.exec("COMMIT"); }
  const before = (old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
  old.close();
  const db = openDb({ path });
  expect(CURRENT_SCHEMA_VERSION).toBe(51);
  expect(db.pragma("user_version", { simple: true })).toBe(51);
  const after = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name);
  expect(after.filter(t => !before.includes(t))).toEqual([
    "engineering_publication_intents", "engineering_revision_chain_events", "engineering_revision_chains", "engineering_revision_reservations", "engineering_shadow_decisions",
  ]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  db.close();
  const reopened = openDb({ path }); expect(reopened.pragma("user_version", { simple: true })).toBe(51); reopened.close();
});

it("creates shadow and live chains with a created event and unique roots", () => {
  const f = setup();
  const s = f.shadow(); const l = f.live(2);
  expect(s).toMatchObject({ mode: "shadow", state: "awaiting_review", rounds_used: 0, revision: 1, current_mission_id: null });
  expect(JSON.parse(s.grant_json)).toEqual({ kind: "shadow_hypothetical" });
  expect(JSON.parse(l.grant_json)).toEqual({ rounds: 2, kind: "live" });
  expect(f.store.events(s.chain_id).map(e => e.kind)).toEqual(["chain_created"]);
  // One chain per (root, mode); a root may carry one shadow and one live chain.
  const dupRoot = f.input(s.root_mission_id);
  expect(code(() => f.store.createShadowChain(dupRoot, 11))).toMatch(/UNIQUE/);
  expect(f.store.createLiveChain({ ...f.input(s.root_mission_id), grant: { rounds: 1 } }, 12).mode).toBe("live");
  // One live chain per PR.
  expect(code(() => f.store.createLiveChain({ ...f.input(undefined, { pr_number: l.pr_number }), grant: { rounds: 1 } }, 13))).toMatch(/UNIQUE/);
  expect(code(() => f.store.createShadowChain({ ...f.input(), pr_number: 0 }, 1))).toBe("invalid_chain");
  expect(code(() => f.store.createShadowChain(f.input(), -1))).toBe("invalid_clock");
  expect(() => f.store.get("rc_missing")).toThrow(RevisionChainError);
});

it("checks the per-mode grant shape and treats missing fields as false", () => {
  const f = setup();
  const bad = (over: Record<string, unknown>) => code(() => rawChain(f, over));
  expect(bad({ grant_json: '{"kind":"live"}' })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"kind":"live","rounds":3}' })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"kind":"live","rounds":0}' })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"kind":"live","rounds":"2"}' })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"kind":"live","rounds":null}' })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"rounds":2}' })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"kind":"shadow_hypothetical","rounds":2}' })).toMatch(/CHECK/);
  expect(bad({ grant_json: "not json" })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"kind":"live","rounds":1}', rounds_used: 2 })).toMatch(/CHECK/);
  expect(bad({ mode: "shadow", grant_json: '{"kind":"live","rounds":2}' })).toMatch(/CHECK/);
  expect(bad({ mode: "shadow", grant_json: "{}" })).toMatch(/CHECK/);
  expect(bad({ mode: "shadow", grant_json: '{"kind":"shadow_hypothetical","rounds":null}' })).toMatch(/CHECK/);
  expect(bad({ mode: "bogus" })).toMatch(/CHECK/);
  expect(bad({ grant_json: '{"kind":"live","rounds":2}', rounds_used: 3 })).toMatch(/CHECK/);
  expect(bad({ mode: "shadow", grant_json: '{"kind":"shadow_hypothetical"}' })).toBe("no_error");
  expect(bad({ grant_json: '{"kind":"live","rounds":1}', rounds_used: 1 })).toBe("no_error");
});

it("keeps shadow chains out of rounds, children and dispatch states, and requires a stop reason", () => {
  const f = setup();
  const sh = { mode: "shadow", grant_json: '{"kind":"shadow_hypothetical"}' };
  expect(code(() => rawChain(f, { ...sh, rounds_used: 1 }))).toMatch(/CHECK/);
  for (const state of ["revision_reserved", "revising", "publishing"]) expect(code(() => rawChain(f, { ...sh, state }))).toMatch(/CHECK/);
  expect(code(() => rawChain(f, { ...sh, current_mission_id: f.mission() }))).toMatch(/chain_insert_denied/);
  expect(code(() => rawChain(f, { state: "awaiting_decision" }))).toMatch(/CHECK/);
  expect(code(() => rawChain(f, { state: "awaiting_decision", stop_reason: "x" }))).toBe("no_error");
  expect(code(() => rawChain(f, { chain_id: "xx_1" }))).toMatch(/CHECK/);
  expect(code(() => rawChain(f, { revision: 0 }))).toMatch(/CHECK|chain_insert_denied/);
  expect(code(() => rawChain(f, { revision: 2 }))).toMatch(/chain_insert_denied/);
  const s = f.shadow();
  expect(code(() => f.db.prepare("UPDATE engineering_revision_chains SET rounds_used=1,revision=revision+1 WHERE chain_id=?").run(s.chain_id))).toMatch(/CHECK/);
  expect(code(() => f.db.prepare("UPDATE engineering_revision_chains SET state='revising',revision=revision+1 WHERE chain_id=?").run(s.chain_id))).toMatch(/CHECK/);
});

it("fixes identity fields, bumps revision by one, never lowers rounds and treats closed as terminal", () => {
  const f = setup(); const l = f.live(2);
  const upd = (set: string) => code(() => f.db.prepare(`UPDATE engineering_revision_chains SET ${set} WHERE chain_id=?`).run(l.chain_id));
  for (const set of ["chain_id='rc_other',revision=revision+1", "mode='shadow',revision=revision+1", "root_mission_id='cm_x',revision=revision+1",
    "repository='o/x',revision=revision+1", "pr_number=pr_number+1,revision=revision+1", "branch='x',revision=revision+1", "base_ref='dev',revision=revision+1",
    "created_at=9,revision=revision+1", "trace_id='z',revision=revision+1"]) {
    expect(upd(set), set).toMatch(/chain_immutable|FOREIGN KEY|CHECK|constraint/i);
  }
  expect(upd("updated_at=5")).toMatch(/chain_immutable/);
  expect(upd("updated_at=5,revision=revision+2")).toMatch(/chain_immutable/);
  expect(upd("rounds_used=2,revision=revision+1")).toMatch(/chain_immutable/);
  expect(upd("rounds_used=1,revision=revision+1")).toBe("no_error");
  expect(upd("rounds_used=0,revision=revision+1")).toMatch(/chain_immutable/);
  expect(upd("state='closed',revision=revision+1")).toBe("no_error");
  expect(upd("state='awaiting_review',revision=revision+1")).toMatch(/chain_terminal/);
  expect(upd("updated_at=7,revision=revision+1")).toMatch(/chain_terminal/);
});

it("binds current_mission_id to a dispatched reservation and releases it only after a proven stop", () => {
  const f = setup(); const l = f.live(2);
  const c1 = f.child("executing");
  const setCurrent = (id: string | null, c = l) => code(() => f.db.prepare("UPDATE engineering_revision_chains SET current_mission_id=?,revision=revision+1 WHERE chain_id=?").run(id, c.chain_id));
  expect(setCurrent(c1)).toMatch(/chain_current_child_denied/);
  const r = f.store.reserve(l.chain_id, 1, reserveInput(), 20);
  expect(setCurrent(c1)).toMatch(/chain_current_child_denied/); // reserved is not dispatched
  const d = f.store.dispatch(l.chain_id, r.chain.revision, H1, c1, 21);
  expect(d.chain).toMatchObject({ state: "revising", current_mission_id: c1 });
  expect(d.reservation).toMatchObject({ state: "dispatched", child_mission_id: c1 });
  // The child is still running: neither clearing nor swapping is allowed, whatever the reservation says.
  expect(code(() => f.store.clearCurrentMission(l.chain_id, d.chain.revision, 22))).toMatch(/chain_current_child_busy/);
  const v = f.store.voidReservation(l.chain_id, d.chain.revision, H1, "child_failed", 23);
  expect(v.chain).toMatchObject({ state: "awaiting_decision", stop_reason: "child_failed" });
  // Voiding the reservation alone is not enough: the child may still be running.
  expect(code(() => f.store.clearCurrentMission(l.chain_id, v.chain.revision, 24))).toMatch(/chain_current_child_busy/);
  f.finish(c1, false); // terminal, executor stop still owed
  expect(code(() => f.store.clearCurrentMission(l.chain_id, v.chain.revision, 24))).toMatch(/chain_current_child_busy/);
  f.db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(c1);
  const cleared = f.store.clearCurrentMission(l.chain_id, v.chain.revision, 25);
  expect(cleared.current_mission_id).toBeNull();
  expect(code(() => f.store.clearCurrentMission(l.chain_id, cleared.revision, 26))).toBe("no_current_mission");
});

it("swaps current_mission_id to the next dispatched child only when the previous one is terminal and stopped", () => {
  const f = setup(); const l = f.live(2);
  const c1 = f.child("executing"); const c2 = f.child("executing");
  let r = f.store.reserve(l.chain_id, 1, reserveInput(H1), 20);
  r = f.store.dispatch(l.chain_id, r.chain.revision, H1, c1, 21);
  // Publish confirmed: the chain re-opens for review on a new head and the first reservation settles.
  const pi = f.store.recordIntent(l.chain_id, r.chain.revision, { kind: "push", branch: BRANCH, expected_old_head: H1, new_head: H2, expected_base_sha: B1, child_mission_id: c1 }, 22);
  const settled = f.store.settleIntent(pi.intent.intent_id, "confirmed", 23);
  expect(settled.chain).toMatchObject({ state: "awaiting_review", published_head: H2, published_base: B1 });
  const v = f.store.voidReservation(l.chain_id, settled.chain.revision, H1, "completed", 24);
  expect(v.chain.revision).toBe(settled.chain.revision); // settled chain untouched
  expect(code(() => f.store.reserve(l.chain_id, v.chain.revision, reserveInput(H2), 25))).toMatch(/reservation_child_busy/); // c1 still executing
  expect(f.store.get(l.chain_id).current_mission_id).toBe(c1);
  f.finish(c1);
  const r2 = f.store.reserve(l.chain_id, v.chain.revision, reserveInput(H2), 25);
  const d2 = f.store.dispatch(l.chain_id, r2.chain.revision, H2, c2, 27);
  expect(d2.chain.current_mission_id).toBe(c2);
});

it("lets exactly one in-flight reservation exist per chain and one reservation per (repo, pr, head)", () => {
  const f = setup(); const l = f.live(2);
  const ins = (head: string, over: Record<string, unknown> = {}) => code(() => f.db.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,1,1)`).run(l.repository, l.pr_number, head, l.chain_id, "[1]", "d", over.state ?? "reserved"));
  expect(ins(H1)).toBe("no_error");
  expect(ins(H2)).toMatch(/UNIQUE/); // second in-flight on the same chain, different head
  expect(ins(H1)).toMatch(/UNIQUE|PRIMARY/); // same head
  f.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='x' WHERE head_sha=?").run(H1);
  expect(ins(H2)).toBe("no_error"); // the slot frees once the first is void
  f.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='x' WHERE head_sha=?").run(H2);
  expect(ins(H1)).toMatch(/UNIQUE|PRIMARY/); // a voided head is never reused, even with no reservation in flight
  expect(ins(H2)).toMatch(/UNIQUE|PRIMARY/);
  expect(ins(H3, { state: "dispatched" })).toMatch(/reservation_insert_denied|UNIQUE/);
  expect(code(() => f.db.prepare("INSERT INTO engineering_revision_reservations VALUES('o/r',1,'h','rc_nope','[]','d',NULL,'reserved',NULL,1,1)").run())).toMatch(/FOREIGN KEY|reservation_insert_denied/);
  // The reservation must name the chain's own PR.
  const other = f.live(1);
  expect(code(() => f.db.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
    VALUES('o/r',?,?,?,'[1]','d','reserved',1,1)`).run(other.pr_number + 5000, H3, other.chain_id))).toMatch(/reservation_insert_denied/);
});

it("denies reservations and intents on shadow chains and freezes chain and key fields on live rows", () => {
  const f = setup(); const s = f.shadow(); const l = f.live(2); const l2 = f.live(2);
  const insRes = (c: { chain_id: string; repository: string; pr_number: number }, head: string) => code(() => f.db.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,'[1]','d','reserved',1,1)`).run(c.repository, c.pr_number, head, c.chain_id));
  const insIntent = (c: { chain_id: string; repository: string; pr_number: number }, kid: string | null = null) => code(() => f.db.prepare(`INSERT INTO engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,expected_base_sha,child_mission_id,binding_json,state,created_at,updated_at)
    VALUES(?,?,'push',?,?,?,?,?,?,?,'{}','pending',1,1)`).run(`pi_${Math.random()}`, c.chain_id, c.repository, c.pr_number, BRANCH, H1, H2, B1, kid));
  expect(insRes(s, H1)).toMatch(/bridge_shadow_write_denied/);
  expect(insIntent(s)).toMatch(/bridge_shadow_write_denied/);
  expect(code(() => f.store.reserve(s.chain_id, 1, reserveInput(), 1))).toBe("bridge_shadow_write_denied");
  expect(code(() => f.store.recordIntent(s.chain_id, 1, { kind: "push", branch: BRANCH }, 1))).toBe("bridge_shadow_write_denied");
  expect(insIntent(l, null)).toMatch(/intent_binding_mismatch/); // no dispatched child yet
  const lc = f.child("executing");
  const lr = f.store.reserve(l.chain_id, 1, reserveInput(H1), 2);
  f.store.dispatch(l.chain_id, lr.chain.revision, H1, lc, 3);
  expect(insRes(l, H2)).toMatch(/UNIQUE|reservation_child_busy/);
  expect(insIntent(l, lc)).toBe("no_error");
  // A live row cannot be re-pointed at a shadow chain, nor at another chain, nor have its key changed.
  const updRes = (set: string) => code(() => f.db.prepare(`UPDATE engineering_revision_reservations SET ${set} WHERE chain_id=?`).run(l.chain_id));
  expect(updRes(`chain_id='${s.chain_id}'`)).toMatch(/reservation_immutable/);
  expect(updRes(`chain_id='${l2.chain_id}'`)).toMatch(/reservation_immutable/);
  expect(updRes("head_sha='x'")).toMatch(/reservation_immutable/);
  expect(updRes("pr_number=pr_number+1")).toMatch(/reservation_immutable/);
  expect(updRes("repository='o/z'")).toMatch(/reservation_immutable/);
  expect(updRes("feedback_digest='z'")).toMatch(/reservation_immutable/);
  expect(updRes("review_ids_json='[2]'")).toMatch(/reservation_immutable/);
  expect(code(() => f.db.prepare("DELETE FROM engineering_revision_reservations").run())).toMatch(/reservation_immutable/);
  const updInt = (set: string) => code(() => f.db.prepare(`UPDATE engineering_publication_intents SET ${set} WHERE chain_id=?`).run(l.chain_id));
  for (const set of [`chain_id='${s.chain_id}'`, `chain_id='${l2.chain_id}'`, "kind='check'", "new_head='x'", "expected_old_head='x'", "expected_base_sha='x'", "branch='x'", "pr_number=pr_number+1", "binding_json='{\"a\":1}'", "intent_id='pi_z'", "created_at=9"]) {
    expect(updInt(set), set).toMatch(/intent_immutable/);
  }
  expect(code(() => f.db.prepare("DELETE FROM engineering_publication_intents").run())).toMatch(/intent_immutable/);
});

it("limits reservation and intent state transitions", () => {
  const f = setup(); const l = f.live(2); const c1 = f.child("executing");
  const r = f.store.reserve(l.chain_id, 1, reserveInput(), 20);
  const updRes = (set: string) => code(() => f.db.prepare(`UPDATE engineering_revision_reservations SET ${set} WHERE chain_id=?`).run(l.chain_id));
  expect(updRes("state='dispatched'")).toMatch(/CHECK/); // dispatched needs a child
  expect(updRes("state='void'")).toMatch(/CHECK/); // void needs a reason
  expect(updRes(`state='dispatched',child_mission_id='${c1}'`)).toBe("no_error");
  expect(updRes("state='reserved',child_mission_id=NULL")).toMatch(/reservation_immutable|reservation_transition_denied/);
  expect(updRes("child_mission_id=NULL")).toMatch(/reservation_immutable|CHECK/);
  expect(updRes("state='void',settled_reason='r'")).toBe("no_error");
  for (const to of ["reserved", "dispatched", "void"]) expect(updRes(`state='${to}',settled_reason='r2'`)).toMatch(/reservation_transition_denied|CHECK/);
  expect(updRes("updated_at=9")).toMatch(/reservation_transition_denied/);
  void r;

  const l2 = f.live(2); const k = f.child("executing");
  const rr = f.store.reserve(l2.chain_id, 1, reserveInput(), 20);
  const dd = f.store.dispatch(l2.chain_id, rr.chain.revision, H1, k, 21);
  const mk = () => f.store.recordIntent(l2.chain_id, f.store.get(l2.chain_id).revision, { kind: "check", branch: "b" }, 22).intent.intent_id;
  const setState = (id: string, to: string) => code(() => f.db.prepare("UPDATE engineering_publication_intents SET state=? WHERE intent_id=?").run(to, id));
  const a = mk(); expect(setState(a, "pending")).toBe("no_error");
  expect(setState(a, "confirmed")).toBe("no_error");
  for (const to of ["pending", "failed", "uncertain", "confirmed"]) expect(setState(a, to)).toMatch(/intent_transition_denied/);
  const b = mk(); expect(setState(b, "failed")).toBe("no_error"); expect(setState(b, "confirmed")).toMatch(/intent_transition_denied/);
  const c = mk(); expect(setState(c, "uncertain")).toBe("no_error"); expect(setState(c, "pending")).toMatch(/intent_transition_denied/);
  expect(setState(c, "uncertain")).toBe("no_error");
  expect(setState(c, "confirmed")).toBe("no_error");
  const d = mk(); expect(setState(d, "uncertain")).toBe("no_error"); expect(setState(d, "failed")).toBe("no_error");
  expect(setState(mk(), "bogus")).toMatch(/CHECK|intent_transition_denied/);
  void dd;
  // Intent inserts start pending, push intents carry their heads.
  expect(code(() => f.db.prepare(`INSERT INTO engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,binding_json,state,created_at,updated_at)
    VALUES('pi_z',?,'check',?,?,'b','{}','confirmed',1,1)`).run(l2.chain_id, l2.repository, l2.pr_number))).toMatch(/intent_insert_denied/);
  expect(code(() => f.db.prepare(`INSERT INTO engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,binding_json,state,created_at,updated_at)
    VALUES('pi_y',?,'push',?,?,'b','{}','pending',1,1)`).run(l2.chain_id, l2.repository, l2.pr_number))).toMatch(/CHECK|intent_binding_mismatch/);
});

it("keeps events and shadow decisions append-only and shadow decisions shadow-only", () => {
  const f = setup(); const s = f.shadow(); const l = f.live(1);
  expect(code(() => f.db.prepare("UPDATE engineering_revision_chain_events SET kind='x'").run())).toMatch(/chain_event_immutable/);
  expect(code(() => f.db.prepare("DELETE FROM engineering_revision_chain_events").run())).toMatch(/chain_event_immutable/);
  expect(code(() => f.db.prepare("INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,'',?,1)").run(s.chain_id, "{}"))).toMatch(/CHECK/);
  const ins = (chain: string) => code(() => f.db.prepare(`INSERT INTO engineering_shadow_decisions(chain_id,head_sha,base_sha,action,reason,review_ids_json,observed_at,created_at)
    VALUES(?,?,?,'would_reserve','r','[]',1,1)`).run(chain, H1, B1));
  expect(ins(l.chain_id)).toMatch(/shadow_decision_shadow_only/);
  expect(ins(s.chain_id)).toBe("no_error");
  expect(ins(s.chain_id)).toMatch(/UNIQUE|PRIMARY/);
  expect(code(() => f.db.prepare("UPDATE engineering_shadow_decisions SET reason='x'").run())).toMatch(/shadow_decision_immutable/);
  expect(code(() => f.db.prepare("DELETE FROM engineering_shadow_decisions").run())).toMatch(/shadow_decision_immutable/);
  expect(code(() => f.db.prepare(`INSERT INTO engineering_shadow_decisions(chain_id,head_sha,base_sha,action,reason,review_ids_json,observed_at,created_at)
    VALUES(?,?,?,'bogus','r','[]',1,1)`).run(s.chain_id, H2, B1))).toMatch(/CHECK/);
});

const wouldReserve = (over: Partial<Extract<ChainDecision, { kind: "would_reserve" }>> = {}): ChainDecision => ({ kind: "would_reserve", from_head: H1, from_base: B1, head: H1, base: B1, discards: [], review_ids: [7], feedback_digest: "d".repeat(64), back_to_review: false, ...over });
const stopDecision = (reason: "attribution_unknown" | "base_changed" = "attribution_unknown", over: Record<string, unknown> = {}): ChainDecision =>
  ({ kind: "stop", to: "awaiting_decision", reason, from_head: H1, from_base: B1, head: H2, base: B1, discards: [], review_ids: [], shadow_action: "would_stop", ...over }) as ChainDecision;

it("applies shadow decisions in one transaction and stays idempotent across a restart", () => {
  const f = setup(); const s = f.shadow();
  const before = f.store.get(s.chain_id);
  const a = f.store.applyDecision(s.chain_id, 1, wouldReserve(), 100);
  expect(a.revision).toBe(before.revision); // would_reserve does not touch the chain
  expect(f.store.shadowDecisions(s.chain_id)).toHaveLength(1);
  expect(f.store.events(s.chain_id).map(e => e.kind)).toEqual(["chain_created", "observation_cycle"]);
  // "Restart": a new store (and connection) re-runs the same cycle.
  const db2 = openDb({ path: f.path }); db2.pragma("synchronous=FULL"); cleanup.push(() => { db2.close(); });
  const store2 = new RevisionChainStore(new AttentionStore(db2, f.path), f.owner);
  store2.applyDecision(s.chain_id, 1, wouldReserve(), 200);
  expect(store2.shadowDecisions(s.chain_id)).toHaveLength(1);
  expect(store2.shadowDecisions(s.chain_id)[0]).toMatchObject({ head_sha: H1, base_sha: B1, action: "would_reserve", observed_at: 100 });
  expect(store2.events(s.chain_id).map(e => e.kind)).toEqual(["chain_created", "observation_cycle"]); // no second event either
  // A different head is a different decision.
  expect(code(() => store2.applyDecision(s.chain_id, 1, wouldReserve({ head: H2 }), 300))).toBe("stale_decision");
  expect(store2.shadowDecisions(s.chain_id)).toHaveLength(1);
  expect(code(() => f.store.applyDecision(s.chain_id, 9, wouldReserve(), 1))).toBe("version_conflict");
});

it("writes transitions, stops and ready decisions with their events and shadow rows", () => {
  const f = setup(); const s = f.shadow();
  const ready: ChainDecision = { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", from_head: H1, from_base: B1, head: H1, base: B1, discards: [], review_ids: [3, 4], shadow_action: "would_mark_ready" };
  const r = f.store.applyDecision(s.chain_id, 1, ready, 50);
  expect(r).toMatchObject({ state: "ready_for_human", revision: 2, stop_reason: null });
  expect(f.store.shadowDecisions(s.chain_id)).toMatchObject([{ action: "would_mark_ready", review_ids_json: "[3,4]", feedback_digest: null }]);
  // A new change request on the same head returns the chain to review and records the would_reserve.
  const back = f.store.applyDecision(s.chain_id, 2, wouldReserve({ back_to_review: true }), 60);
  expect(back).toMatchObject({ state: "awaiting_review", revision: 3 });
  const stopped = f.store.applyDecision(s.chain_id, 3, stopDecision(), 70);
  expect(stopped).toMatchObject({ state: "awaiting_decision", stop_reason: "attribution_unknown", revision: 4 });
  expect(f.store.shadowDecisions(s.chain_id).map(d => d.action).sort()).toEqual(["would_mark_ready", "would_reserve", "would_stop"]);
  const t = f.store.events(s.chain_id).filter(e => e.kind === "transition").map(e => JSON.parse(e.payload_json));
  expect(t.map(x => [x.from, x.to])).toEqual([["awaiting_review", "ready_for_human"], ["ready_for_human", "awaiting_review"], ["awaiting_review", "awaiting_decision"]]);
  const closed = f.store.applyDecision(s.chain_id, 4, { kind: "transition", to: "closed", reason: "pr_merged", from_head: H1, from_base: B1, head: H1, base: B1, discards: [], review_ids: [] }, 80);
  expect(closed.state).toBe("closed");
  expect(code(() => f.store.applyDecision(s.chain_id, 5, stopDecision(), 90))).toMatch(/chain_terminal/);
  // none changes nothing.
  const l = f.shadow();
  expect(f.store.applyDecision(l.chain_id, 1, { kind: "none", reason: "no_review", discards: [] }, 5)).toEqual(l);
  expect(code(() => f.store.applyDecision(l.chain_id, 1, wouldReserve(), 0.5))).toBe("invalid_clock");
});

it("rolls back the whole decision when the surrounding transaction fails after it", () => {
  const f = setup(); const s = f.shadow();
  const crash = () => f.db.transaction(() => { f.store.applyDecision(s.chain_id, 1, stopDecision(), 5); throw Error("crash"); })();
  expect(code(crash)).toBe("crash");
  expect(f.store.get(s.chain_id)).toEqual(s);
  expect(f.store.events(s.chain_id)).toHaveLength(1);
  expect(f.store.shadowDecisions(s.chain_id)).toHaveLength(0);
  // Replaying the same decision afterwards succeeds exactly once.
  expect(f.store.applyDecision(s.chain_id, 1, stopDecision(), 6).state).toBe("awaiting_decision");
  expect(f.store.shadowDecisions(s.chain_id)).toHaveLength(1);
  // A write refused by a trigger leaves no event or decision behind.
  const k = f.shadow();
  f.store.applyDecision(k.chain_id, 1, { kind: "transition", to: "closed", reason: "pr_closed", from_head: H1, from_base: B1, head: H1, base: B1, discards: [], review_ids: [] }, 5);
  const events = f.store.events(k.chain_id).length;
  expect(code(() => f.store.applyDecision(k.chain_id, 2, stopDecision(), 6))).toMatch(/chain_terminal/);
  expect(f.store.events(k.chain_id)).toHaveLength(events);
  expect(f.store.shadowDecisions(k.chain_id)).toHaveLength(0);
});

it("exposes only the narrow writer to the shadow reconciler", () => {
  const f = setup();
  const writer = shadowChainWriter(f.store);
  expect(Object.keys(writer).sort()).toEqual(["appendEvent", "applyShadowDecision", "createShadowChain", "get", "listOpenShadowChains", "shadowChainForMission", "shadowChainForPr", "shadowDecisions"]);
  for (const forbidden of ["reserve", "dispatch", "voidReservation", "recordIntent", "settleIntent", "createLiveChain", "applyDecision", "clearCurrentMission"]) {
    expect((writer as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
  }
  const s = writer.createShadowChain(f.input(), 5);
  const live: ChainDecision = { kind: "reserve", from_head: H1, from_base: B1, head: H1, base: B1, discards: [], review_ids: [1], feedback_digest: "d" };
  expect(code(() => writer.applyShadowDecision(s.chain_id, 1, live, 6))).toBe("bridge_shadow_write_denied");
  writer.appendEvent(s.chain_id, "read_failed", { code: "x" }, 7);
  expect(writer.applyShadowDecision(s.chain_id, 1, wouldReserve(), 8).revision).toBe(1);
  expect(writer.shadowDecisions(s.chain_id)).toHaveLength(1);
  expect(writer.listOpenShadowChains().map(c => c.chain_id)).toEqual([s.chain_id]);
  // A shadow chain cannot be driven live even through a decision the pure function would never emit for it.
  expect(code(() => f.store.applyDecision(s.chain_id, 1, live, 9))).toBe("bridge_shadow_write_denied");
  expect(f.store.listOpen("live")).toEqual([]);
  expect(code(() => f.store.listOpen("shadow", 0))).toBe("invalid_limit");
  expect(code(() => f.store.events(s.chain_id, -1))).toBe("invalid_limit");
});

it("walks a live chain through reserve, dispatch, publish and settle and then refuses a third round", () => {
  const f = setup(); const l = f.live(2);
  const run = (head: string, next: string, round: number) => {
    const cur = f.store.get(l.chain_id);
    const r = f.store.reserve(l.chain_id, cur.revision, reserveInput(head), 100 + round);
    expect(r.chain).toMatchObject({ state: "revision_reserved", rounds_used: round });
    expect(r.reservation).toMatchObject({ state: "reserved", child_mission_id: null, review_ids_json: "[7]" });
    const c = f.child("executing");
    const d = f.store.dispatch(l.chain_id, r.chain.revision, head, c, 110 + round);
    const pi = f.store.recordIntent(l.chain_id, d.chain.revision, { kind: "push", branch: BRANCH, expected_old_head: head, new_head: next, expected_base_sha: B1, child_mission_id: c }, 120 + round);
    expect(pi.chain.state).toBe("publishing");
    const done = f.store.settleIntent(pi.intent.intent_id, "confirmed", 130 + round, "ok");
    expect(done.chain).toMatchObject({ state: "awaiting_review", published_head: next });
    expect(done.intent).toMatchObject({ state: "confirmed", detail: "ok" });
    f.finish(c);
    f.store.voidReservation(l.chain_id, done.chain.revision, head, "completed", 140 + round);
    return c;
  };
  run(H1, H2, 1); run(H2, H3, 2);
  expect(f.store.confirmedPushHeads(l.chain_id)).toEqual([H2, H3]);
  const cur = f.store.get(l.chain_id);
  expect(cur).toMatchObject({ rounds_used: 2, published_head: H3 });
  expect(code(() => f.store.reserve(l.chain_id, cur.revision, reserveInput(H3), 200))).toBe("rounds_exhausted");
  expect(f.store.reservations(l.chain_id).map(r => r.state)).toEqual(["void", "void"]);
  expect(f.store.intents(l.chain_id)).toHaveLength(2);
});

it("guards live APIs by chain state and by revision", () => {
  const f = setup(); const l = f.live(1);
  expect(code(() => f.store.reserve(l.chain_id, 99, reserveInput(), 1))).toBe("version_conflict");
  expect(code(() => f.store.dispatch(l.chain_id, 1, H1, f.child(), 1))).toBe("state_denied");
  expect(code(() => f.store.recordIntent(l.chain_id, 1, { kind: "push", branch: BRANCH, expected_old_head: H1, new_head: H2, expected_base_sha: B1 }, 1))).toBe("state_denied");
  expect(code(() => f.store.reserve(l.chain_id, 1, { head: "", review_ids: [1], feedback_digest: "d" }, 1))).toBe("invalid_reservation");
  expect(code(() => f.store.reserve(l.chain_id, 1, { head: H1, review_ids: [], feedback_digest: "d" }, 1))).toBe("invalid_reservation");
  const r = f.store.reserve(l.chain_id, 1, reserveInput(), 2);
  expect(code(() => f.store.reserve(l.chain_id, r.chain.revision, reserveInput(H2), 3))).toBe("state_denied");
  expect(code(() => f.store.dispatch(l.chain_id, r.chain.revision, H2, f.child(), 3))).toBe("reservation_not_found");
  expect(code(() => f.store.voidReservation(l.chain_id, r.chain.revision, H1, "", 3))).toBe("invalid_reason");
  const v = f.store.voidReservation(l.chain_id, r.chain.revision, H1, "cancelled", 4);
  expect(v.chain).toMatchObject({ state: "awaiting_decision", stop_reason: "cancelled" });
  expect(code(() => f.store.voidReservation(l.chain_id, v.chain.revision, H1, "again", 5))).toBe("reservation_void");
  // A voided head is never reserved again, and a stopped chain is not reserved at all.
  expect(code(() => f.store.reserve(l.chain_id, v.chain.revision, reserveInput(H1), 6))).toBe("state_denied");
  expect(f.store.get(l.chain_id).rounds_used).toBe(1);
});

it("uses the rounds grant, the in-flight guard and the head guard in the store as well as in the database", () => {
  const f = setup(); const l = f.live(1);
  const r = f.store.reserve(l.chain_id, 1, reserveInput(), 2);
  f.store.voidReservation(l.chain_id, r.chain.revision, H1, "x", 3);
  // After a void the chain is stopped; emulate a human re-opening it only through SQL to hit the guards.
  f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',stop_reason=NULL,revision=revision+1 WHERE chain_id=?").run(l.chain_id);
  const cur = f.store.get(l.chain_id);
  expect(code(() => f.store.reserve(l.chain_id, cur.revision, reserveInput(H2), 4))).toBe("rounds_exhausted");
  const l2 = f.live(2);
  const r2 = f.store.reserve(l2.chain_id, 1, reserveInput(), 2);
  f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',revision=revision+1 WHERE chain_id=?").run(l2.chain_id);
  expect(code(() => f.store.reserve(l2.chain_id, r2.chain.revision + 1, reserveInput(H2), 3))).toBe("chain_busy");
  f.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='x' WHERE chain_id=?").run(l2.chain_id);
  expect(code(() => f.store.reserve(l2.chain_id, r2.chain.revision + 1, reserveInput(H1), 3))).toBe("head_already_reserved");
});

it("stops a chain whose push intent is uncertain and lets a human reconcile it later", () => {
  const f = setup(); const l = f.live(2);
  const r = f.store.reserve(l.chain_id, 1, reserveInput(), 2);
  const kid = f.child("executing");
  const d = f.store.dispatch(l.chain_id, r.chain.revision, H1, kid, 3);
  const pi = f.store.recordIntent(l.chain_id, d.chain.revision, { kind: "push", branch: BRANCH, expected_old_head: H1, new_head: H2, expected_base_sha: B1, child_mission_id: kid }, 4);
  expect(revisionChainUpgradeHolds(f.db)).toBe(2); // one dispatched reservation, one pending intent
  const u = f.store.settleIntent(pi.intent.intent_id, "uncertain", 5, "readback mismatch");
  expect(u.chain).toMatchObject({ state: "awaiting_decision", stop_reason: "intent_uncertain" });
  expect(revisionChainUpgradeHolds(f.db)).toBe(2); // uncertain still holds
  const c = f.store.settleIntent(pi.intent.intent_id, "confirmed", 6);
  expect(c.intent.state).toBe("confirmed");
  expect(c.chain.state).toBe("awaiting_decision"); // the human decides; the store does not resume it
  expect(code(() => f.store.settleIntent(pi.intent.intent_id, "failed", 7))).toMatch(/intent_transition_denied/);
  expect(revisionChainUpgradeHolds(f.db)).toBe(1);
  expect(code(() => f.store.settleIntent(pi.intent.intent_id, "confirmed", 7, "x".repeat(2000)))).toBe("invalid_detail");
});

it("lists open chains by cursor", () => {
  const f = setup();
  const made = [f.shadow(), f.shadow(), f.shadow()];
  const first = f.store.listOpen("shadow", 2);
  expect(first.map(c => c.chain_id)).toEqual(made.map(c => c.chain_id).sort().slice(0, 2));
  expect(first).toHaveLength(2);
  const rest = f.store.listOpen("shadow", 2, { created_at: first[1]!.created_at, chain_id: first[1]!.chain_id });
  expect(rest).toHaveLength(1);
  f.store.applyDecision(made[0]!.chain_id, 1, stopDecision(), 5);
  expect(f.store.listOpen("shadow").map(c => c.chain_id)).not.toContain(made[0]!.chain_id);
});

it("requires durable writes and a current owner fence", () => {
  const f = setup(); const s = f.shadow();
  f.db.pragma("synchronous=OFF");
  expect(code(() => f.store.appendEvent(s.chain_id, "x", {}, 1))).toBe("durability_required");
  f.db.pragma("synchronous=FULL");
  f.attention.claimOwner("newer");
  expect(code(() => f.store.appendEvent(s.chain_id, "x", {}, 1))).toBe("stale_owner");
  expect(f.store.events(s.chain_id)).toHaveLength(1);
});

it("lets exactly one of two racing reconcilers reserve, even on different heads", () => {
  const f = setup(); const l = f.live(2);
  const db2 = openDb({ path: f.path }); db2.pragma("synchronous=FULL"); db2.pragma("busy_timeout=0"); cleanup.push(() => { db2.close(); });
  const store2 = new RevisionChainStore(new AttentionStore(db2, f.path), f.owner);
  // Both read revision 1 and want to reserve a different head of the same chain.
  expect(store2.get(l.chain_id).revision).toBe(1);
  f.store.reserve(l.chain_id, 1, reserveInput(H1), 20);
  expect(code(() => store2.reserve(l.chain_id, 1, reserveInput(H2), 21))).toBe("version_conflict");
  // With a fresh revision the state guard refuses; the database refuses a raw insert regardless.
  expect(code(() => store2.reserve(l.chain_id, store2.get(l.chain_id).revision, reserveInput(H2), 22))).toBe("state_denied");
  expect(code(() => db2.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,'[1]','d','reserved',1,1)`).run(l.repository, l.pr_number, H2, l.chain_id))).toMatch(/UNIQUE/);
  expect(f.store.reservations(l.chain_id).map(r => r.head_sha)).toEqual([H1]);
  expect(f.store.get(l.chain_id).rounds_used).toBe(1);
});

it("serialises a second writer behind the first one's write lock instead of corrupting state", () => {
  const f = setup(); const l = f.live(2);
  const db2 = openDb({ path: f.path }); db2.pragma("synchronous=FULL"); db2.pragma("busy_timeout=0"); cleanup.push(() => { db2.close(); });
  const store2 = new RevisionChainStore(new AttentionStore(db2, f.path), f.owner);
  f.db.exec("BEGIN IMMEDIATE");
  const attempt = code(() => store2.reserve(l.chain_id, 1, reserveInput(H1), 5));
  expect(attempt).toMatch(/database is locked|SQLITE_BUSY/i);
  f.db.exec("ROLLBACK");
  expect(store2.reserve(l.chain_id, 1, reserveInput(H1), 6).chain.rounds_used).toBe(1);
  expect(f.store.reservations(l.chain_id)).toHaveLength(1);
});

it("treats migrations as the single source for the DDL export", () => {
  expect(MIGRATIONS.at(-1)).toMatchObject({ id: 51, name: "engineering_revision_chains" });
});

it("keeps one child at a time even after the dispatched reservation is voided while its child still runs (invariant 3)", () => {
  const f = setup(); const l = f.live(2); const c1 = f.child("executing");
  const r = f.store.reserve(l.chain_id, 1, reserveInput(H1), 2);
  const d = f.store.dispatch(l.chain_id, r.chain.revision, H1, c1, 3);
  const v = f.store.voidReservation(l.chain_id, d.chain.revision, H1, "operator_void", 4);
  const insert = (head: string) => code(() => f.db.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,'[1]','d','reserved',1,1)`).run(l.repository, l.pr_number, head, l.chain_id));
  // The void freed the in-flight slot, but c1 is still executing and is still the chain's current child.
  expect(f.store.get(l.chain_id).current_mission_id).toBe(c1);
  expect(insert(H2)).toMatch(/reservation_child_busy/);
  // Through the store, once a human has re-opened the chain for review on a new head.
  f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',stop_reason=NULL,published_head=?,revision=revision+1 WHERE chain_id=?").run(H2, l.chain_id);
  expect(code(() => f.store.reserve(l.chain_id, v.chain.revision + 1, reserveInput(H2), 5))).toMatch(/reservation_child_busy/);
  expect(f.store.reservations(l.chain_id)).toHaveLength(1);
  // The pointer is not what protects the chain: clear it only after c1 is done and the guard opens by itself.
  f.finish(c1);
  expect(insert(H2)).toBe("no_error");
});

it("refuses to dispatch a reservation while any other child of the chain still runs", () => {
  const f = setup(); const l = f.live(2); const c1 = f.child("executing"); const c2 = f.child("executing");
  const r = f.store.reserve(l.chain_id, 1, reserveInput(H1), 2);
  const d = f.store.dispatch(l.chain_id, r.chain.revision, H1, c1, 3);
  f.store.voidReservation(l.chain_id, d.chain.revision, H1, "operator_void", 4);
  // Defence in depth: even with the insert guard out of the way, the dispatch guard holds.
  f.db.exec("DROP TRIGGER engineering_reservation_child_exclusive_insert");
  f.db.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,'[1]','d','reserved',1,1)`).run(l.repository, l.pr_number, H2, l.chain_id);
  expect(code(() => f.db.prepare("UPDATE engineering_revision_reservations SET state='dispatched',child_mission_id=? WHERE head_sha=?").run(c2, H2))).toMatch(/reservation_child_busy/);
});

it("binds a push intent to the chain's branch, heads, base and dispatched child", () => {
  const f = setup(); const l = f.live(2); const c1 = f.child("executing"); const other = f.child("executing");
  const r = f.store.reserve(l.chain_id, 1, reserveInput(H1), 2);
  const d = f.store.dispatch(l.chain_id, r.chain.revision, H1, c1, 3);
  const ok = { kind: "push" as const, branch: BRANCH, expected_old_head: H1, new_head: H2, expected_base_sha: B1, child_mission_id: c1 };
  const attempt = (over: Record<string, unknown>) => code(() => f.store.recordIntent(l.chain_id, d.chain.revision, { ...ok, ...over } as typeof ok, 4));
  expect(attempt({ branch: "other" })).toBe("intent_binding_mismatch");
  expect(attempt({ expected_old_head: H3 })).toBe("intent_binding_mismatch");
  expect(attempt({ expected_base_sha: B1.replace("b", "c") })).toBe("intent_binding_mismatch");
  expect(attempt({ child_mission_id: other })).toBe("intent_binding_mismatch");
  expect(attempt({ child_mission_id: undefined })).toBe("intent_binding_mismatch");
  expect(attempt({ new_head: undefined })).toBe("intent_binding_mismatch");
  expect(f.store.intents(l.chain_id)).toHaveLength(0);
  // The database enforces the same at INSERT, independent of the store.
  const raw = (o: Record<string, unknown>) => code(() => f.db.prepare(`INSERT INTO engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,expected_base_sha,child_mission_id,binding_json,state,created_at,updated_at)
    VALUES(@id,@chain,'push',@repo,@pr,@branch,@old,@new,@base,@child,'{}','pending',1,1)`).run({ id: `pi_${Math.random()}`, chain: l.chain_id, repo: l.repository, pr: l.pr_number, branch: BRANCH, old: H1, new: H2, base: B1, child: c1, ...o }));
  expect(raw({ branch: "other" })).toMatch(/intent_binding_mismatch/);
  expect(raw({ old: H3 })).toMatch(/intent_binding_mismatch/);
  expect(raw({ base: "zz" })).toMatch(/intent_binding_mismatch/);
  expect(raw({ child: other })).toMatch(/intent_binding_mismatch/);
  expect(raw({ child: null })).toMatch(/intent_binding_mismatch/);
  expect(raw({})).toBe("no_error");
});

it("advances published_head on settle only while the intent's bindings still match the chain", () => {
  const f = setup(); const l = f.live(2); const c1 = f.child("executing");
  const r = f.store.reserve(l.chain_id, 1, reserveInput(H1), 2);
  const d = f.store.dispatch(l.chain_id, r.chain.revision, H1, c1, 3);
  const pi = f.store.recordIntent(l.chain_id, d.chain.revision, { kind: "push", branch: BRANCH, expected_old_head: H1, new_head: H2, expected_base_sha: B1, child_mission_id: c1 }, 4);
  // The base moved under the intent (a human edit); the confirmation must not republish the chain on the old base.
  f.db.prepare("UPDATE engineering_revision_chains SET published_base=?,revision=revision+1 WHERE chain_id=?").run(B2, l.chain_id);
  const out = f.store.settleIntent(pi.intent.intent_id, "confirmed", 5);
  expect(out.intent.state).toBe("confirmed");
  expect(out.chain).toMatchObject({ state: "publishing", published_head: H1, published_base: B2 });
});

it("rejects decisions that no longer describe the chain row, and reservations on another head", () => {
  const f = setup(); const l = f.live(2); const c1 = f.child("executing");
  const base = { base: B1, discards: [], review_ids: [7] };
  const reserve = (head: string): ChainDecision => ({ kind: "reserve", from_head: H1, from_base: B1, head, feedback_digest: "d", ...base });
  const rev = () => f.store.get(l.chain_id).revision;
  expect(code(() => f.store.applyDecision(l.chain_id, rev(), reserve(H2), 2))).toBe("stale_decision");
  expect(code(() => f.store.reserve(l.chain_id, rev(), reserveInput(H2), 2))).toBe("head_mismatch");
  expect(code(() => f.store.applyDecision(l.chain_id, rev(), { ...reserve(H1), base: B2 } as ChainDecision, 2))).toBe("stale_decision");
  const ready: ChainDecision = { kind: "transition", to: "ready_for_human", reason: "x", from_head: H1, from_base: B1, head: H2, base: B1, discards: [], review_ids: [] };
  expect(code(() => f.store.applyDecision(l.chain_id, rev(), ready, 2))).toBe("stale_decision");
  const stop = (reason: "external_write" | "reviewer_conflict" | "base_changed", head: string, b = B1): ChainDecision => ({ kind: "stop", to: "awaiting_decision", reason, from_head: H1, from_base: B1, head, base: b, discards: [], review_ids: [] });
  expect(code(() => f.store.applyDecision(l.chain_id, rev(), stop("external_write", H1), 2))).toBe("stale_decision"); // the "observed" head is the published one
  expect(code(() => f.store.applyDecision(l.chain_id, rev(), stop("reviewer_conflict", H2), 2))).toBe("stale_decision");
  expect(code(() => f.store.applyDecision(l.chain_id, rev(), stop("base_changed", H1, B1), 2))).toBe("stale_decision");
  const accept: ChainDecision = { kind: "transition", to: "awaiting_review", reason: "push_confirmed", from_head: H1, from_base: B1, head: H2, base: B1, published_head: H2, published_base: B1, discards: [], review_ids: [] };
  expect(code(() => f.store.applyDecision(l.chain_id, rev(), accept, 2))).toBe("stale_decision"); // no confirmed push intent produced H2
  expect(f.store.get(l.chain_id)).toMatchObject({ state: "awaiting_review", published_head: H1, revision: 1 });
  // A stop that carries the observed head records it without making it the published head.
  // A ref-only base change is carried by base_ref, so the same sha under a new ref is not stale.
    expect(code(() => f.store.applyDecision(l.chain_id, rev(), { ...stop("base_changed", H1), base_ref: "main" } as ChainDecision, 2))).toBe("stale_decision");
  const moved = f.store.applyDecision(l.chain_id, rev(), stop("external_write", H3), 3);
  expect(moved).toMatchObject({ state: "awaiting_decision", stop_reason: "external_write", published_head: H1 });
  expect(JSON.parse(f.store.events(l.chain_id).at(-1)!.payload_json)).toMatchObject({ head: H3 });
  // A decision computed before the chain advanced is stale once it has (shadow: ready, then a stale would_reserve on another base).
  const s = f.shadow();
  f.store.applyDecision(s.chain_id, 1, wouldReserve(), 4);
  expect(code(() => f.store.applyDecision(s.chain_id, 1, wouldReserve({ base: B2 }), 5))).toBe("stale_decision");
  void c1;
});

it("refuses an old stop once the chain has advanced, even when the caller re-reads the revision", () => {
  const f = setup(); const l = f.live(2); const c1 = f.child("executing");
  const r = f.store.reserve(l.chain_id, 1, reserveInput(H1), 2);
  const d = f.store.dispatch(l.chain_id, r.chain.revision, H1, c1, 3);
  // Computed against H1/B1: someone else wrote H3 to the branch.
  const oldStop: ChainDecision = { kind: "stop", to: "awaiting_decision", reason: "external_write", from_head: H1, from_base: B1, head: H3, base: B1, discards: [], review_ids: [] };
  // Meanwhile the publisher's confirmed push advanced the chain to H2.
  const pi = f.store.recordIntent(l.chain_id, d.chain.revision, { kind: "push", branch: BRANCH, expected_old_head: H1, new_head: H2, expected_base_sha: B1, child_mission_id: c1 }, 4);
  const settled = f.store.settleIntent(pi.intent.intent_id, "confirmed", 5);
  expect(settled.chain.published_head).toBe(H2);
  expect(code(() => f.store.applyDecision(l.chain_id, f.store.get(l.chain_id).revision, oldStop, 6))).toBe("stale_decision");
  expect(f.store.get(l.chain_id).state).toBe("awaiting_review");
  // The same observation computed against the current state is applied.
  expect(f.store.applyDecision(l.chain_id, f.store.get(l.chain_id).revision, { ...oldStop, from_head: H2 } as ChainDecision, 7).state).toBe("awaiting_decision");
  // A base-only move is stale too.
  const s = f.shadow();
  expect(code(() => f.store.applyDecision(s.chain_id, 1, { ...stopDecision(), from_base: B2 } as ChainDecision, 8))).toBe("stale_decision");
});

it("looks up shadow chains by Mission and by PR in any state, (read-only, through the shadow writer)", () => {
  const f = setup(); const w = shadowChainWriter(f.store);
  const s = f.shadow({ pr_number: 77 }); const l = f.live(2, { pr_number: 78 });
  expect(w.shadowChainForMission(s.root_mission_id)?.chain_id).toBe(s.chain_id);
  expect(w.shadowChainForPr("o/r", 77)?.chain_id).toBe(s.chain_id);
  expect(w.shadowChainForMission(l.root_mission_id)).toBeUndefined();
  expect(w.shadowChainForPr("o/r", 78)).toBeUndefined();
  expect(w.shadowChainForPr("o/r", 999)).toBeUndefined();
  // A closed chain is not listed as open but is still found, so a second Mission on its PR is refused.
  f.store.applyDecision(s.chain_id, 1, { kind: "transition", to: "closed", reason: "pr_merged", from_head: s.published_head, from_base: s.published_base, head: s.published_head, base: s.published_base, discards: [], review_ids: [] }, 2);
  expect(w.listOpenShadowChains().map(c => c.chain_id)).not.toContain(s.chain_id);
  expect(w.shadowChainForPr("o/r", 77)?.state).toBe("closed");
  expect(f.store.chainForMission(s.root_mission_id, "live")).toBeUndefined();
});
