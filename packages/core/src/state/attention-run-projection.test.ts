import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionObserver } from "./attention-observer.js";
import { appendEvent, insertRun, insertTask, readRunEventPage } from "./run-store.js";
import { projectAttentionRun } from "./attention-run-projection.js";

const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
function setup() {
  const root = realpathSync(createScratchDirSync("tests", "attention-events"));
  const path = join(root, "state.db");
  const db = openDb({ path });
  clean.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  insertTask(db, path, { task_id: "t", title: "task", created_at: 1 });
  insertRun(db, path, { task_id: "t", run_id: "r", session_id: "s", agent_id: "hermes", capability_id: "code", phase: "execute", started_at: 1 });
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("owner");
  const scope = store.registerScope(owner, "t", root);
  const observer = new AttentionObserver(store, owner);
  const event = (seq: number, type = "status", payload: unknown = { status: "running" }) => appendEvent(db, path, {
    event_id: `r:${seq}`, run_id: "r", session_id: "s", seq, type, payload, terminal: type === "done", created_at: seq + 1,
  });
  const facts = () => JSON.parse((db.prepare("SELECT payload_json FROM attention_subjects WHERE kind='run'").get() as { payload_json: string }).payload_json);
  const cursor = () => db.prepare("SELECT * FROM attention_run_cursors WHERE run_id='r'").get() as { last_seq: number; gap: string | null; generation: number } | undefined;
  return { root, path, db, store, owner, scope, observer, event, facts, cursor };
}
it("pages seq zero through a stable watermark without changing the legacy reader", () => {
  const { db, event } = setup();
  for (let seq = 0; seq < 201; seq++) event(seq);
  const first = readRunEventPage(db, { taskId: "t", runId: "r", afterSeq: -1, limit: 200 });
  expect(first.events).toHaveLength(200);
  expect(first).toMatchObject({ nextAfter: 199, highWatermark: 200, hasMore: true, sequenceGap: false });
  event(201);
  const last = readRunEventPage(db, { taskId: "t", runId: "r", afterSeq: first.nextAfter, throughSeq: first.highWatermark, limit: 200 });
  expect(last.events.map((row) => row.seq)).toEqual([200]);
  expect(last.hasMore).toBe(false);
});
it("bounds payload bytes in SQL and refuses invalid cursor arguments", () => {
  const { db, event } = setup();
  event(0, "token.delta", { delta: "x".repeat(1000000) });
  const page = readRunEventPage(db, { taskId: "t", runId: "r", afterSeq: -1, limit: 10 });
  expect(page.events[0]).toMatchObject({ payload_json: null });
  expect(page.events[0]!.payload_bytes).toBeGreaterThan(65536);
  for (const limit of [0, 201, NaN, 1.5])
    expect(() => readRunEventPage(db, { taskId: "t", runId: "r", afterSeq: -1, limit })).toThrow("invalid_event_page");
  for (const throughSeq of [-2, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => readRunEventPage(db, { taskId: "t", runId: "r", afterSeq: -1, limit: 10, throughSeq })).toThrow("invalid_event_page");
});
it("projects actual run events and resumes its durable cursor under a new owner", () => {
  const { event, observer, facts, cursor, db, path, scope } = setup();
  for (let i = 0; i < 205; i++) event(i);
  observer.tick(1000);
  expect(cursor()?.last_seq).toBe(199);
  expect(facts()).toMatchObject({ reason: "event_backlog", event_replay: { complete: false } });
  const reopened = openDb({ path });
  clean.push(() => reopened.close());
  const nextStore = new AttentionStore(reopened, path);
  const owner = nextStore.claimOwner("next");
  new AttentionObserver(nextStore, owner).tick(2000);
  expect(cursor()).toMatchObject({ last_seq: 204, generation: owner.generation });
  expect(facts()).toMatchObject({ observed_status: "running", event_replay: { complete: false, caught_up: true } });
  expect(() => projectAttentionRun(new AttentionStore(db, path), observer.owner, scope, "r", 3000)).toThrow("stale_owner");
});
it("keeps a sequence gap sticky even if a missing event later appears", () => {
  const { event, observer, cursor, facts } = setup();
  event(0); event(2);
  observer.tick(1000);
  expect(cursor()).toMatchObject({ last_seq: 0, gap: "event_sequence_gap" });
  expect(facts().event_replay.complete).toBe(false);
  event(1);
  observer.tick(2000);
  expect(cursor()).toMatchObject({ last_seq: 2, gap: "event_sequence_gap" });
  expect(facts().event_replay.complete).toBe(false);
});
it.each(["invalid", "oversized", "wrong_session"])("does not advance over %s source data", (kind) => {
  const { event, observer, cursor, facts, db } = setup();
  event(0); event(1);
  if (kind === "invalid") db.prepare("UPDATE events SET payload_json='{' WHERE seq=1").run();
  if (kind === "oversized") db.prepare("UPDATE events SET payload_json=? WHERE seq=1").run(JSON.stringify({ delta: "x".repeat(1000000) }));
  if (kind === "wrong_session") db.prepare("UPDATE events SET session_id='unrelated' WHERE seq=1").run();
  observer.tick(1000);
  expect(cursor()?.last_seq).toBe(0);
  expect(facts()).toMatchObject({ reason: "history_gap", event_replay: { complete: false } });
});
it("flags unknown event semantics without blocking a later known event", () => {
  const { event, observer, cursor, facts } = setup();
  event(0, "future.new_kind", {}); event(1, "status", { status: "awaiting_clarify" });
  observer.tick(1000);
  expect(cursor()?.last_seq).toBe(1);
  expect(facts()).toMatchObject({ observed_status: "awaiting_clarify", unsupported_events: 1,
    reason: "unsupported_event_type", event_replay: { complete: false } });
});
it("does not claim caught up when another event arrived after a page watermark", () => {
  const { event, observer, cursor, facts } = setup();
  for (let i = 0; i < 201; i++) event(i);
  observer.tick(1000);
  event(201);
  observer.tick(2000);
  expect(cursor()?.last_seq).toBe(200);
  expect(facts()).toMatchObject({ reason: "event_backlog", event_replay: { complete: false } });
  observer.tick(3000);
  expect(cursor()?.last_seq).toBe(201);
  expect(facts().event_replay).toMatchObject({ complete: false, caught_up: true });
});
it.each(["mutation", "deletion"])("marks an anchor %s unknown without advancing", (kind) => {
  const { event, observer, cursor, facts, db } = setup();
  event(0); observer.tick(1000);
  if (kind === "mutation") db.prepare("UPDATE events SET payload_json=? WHERE seq=0").run(JSON.stringify({ status: "completed" }));
  else db.prepare("DELETE FROM events WHERE seq=0").run();
  event(1);
  observer.tick(2000);
  expect(cursor()).toMatchObject({ last_seq: 0, gap: "event_anchor_changed" });
  expect(facts()).toMatchObject({ observed_status: null, event_replay: { complete: false } });
});
it("retains unknown evidence across source deletion and ID reuse", () => {
  const { event, observer, cursor, facts, db, path } = setup();
  event(0); observer.tick(1000);
  db.prepare("DELETE FROM runs WHERE run_id='r'").run();
  observer.tick(2000);
  expect(facts().state).toBe("source_missing");
  expect(facts().event_replay).toMatchObject({ complete: false, caught_up: false });
  expect(cursor()?.gap).toBe("source_missing");
  insertRun(db, path, { task_id: "t", run_id: "r", session_id: "s-new", agent_id: "hermes", capability_id: "code", phase: "execute", started_at: 3 });
  observer.tick(3000);
  expect(facts()).toMatchObject({ state: "unknown", reason: "source_binding_conflict", event_replay: { complete: false, caught_up: false } });
  expect(cursor()?.last_seq).toBe(0);
});
it("rolls back cursor and projected facts together on a failed projection write", () => {
  const { event, observer, cursor, db, store, owner, scope } = setup();
  observer.tick(1000);
  expect(cursor()?.last_seq).toBe(-1);
  event(0);
  db.exec("CREATE TRIGGER projection_failure BEFORE UPDATE ON attention_subjects WHEN NEW.kind='run' BEGIN SELECT RAISE(ABORT,'projection fault'); END;");
  expect(() => projectAttentionRun(store, owner, scope, "r", 2000)).toThrow("projection fault");
  expect(cursor()?.last_seq).toBe(-1);
  db.exec("DROP TRIGGER projection_failure");
  observer.tick(3000);
  expect(cursor()?.last_seq).toBe(0);
});
it("restricts run pages to the exact default-tenant task and refuses mismatched scopes", () => {
  const { event, observer, db, store, owner, scope } = setup();
  event(0); observer.tick(1000);
  expect(() => readRunEventPage(db, { taskId: "other", runId: "r", afterSeq: -1, limit: 10 })).toThrow("run_source_not_found");
  expect(() => projectAttentionRun(store, owner, { ...scope, repo_path: "/other" }, "r", 2000)).toThrow("attention_scope_conflict");
  db.prepare("UPDATE runs SET tenant_id='another' WHERE run_id='r'").run();
  expect(() => readRunEventPage(db, { taskId: "t", runId: "r", afterSeq: -1, limit: 10 })).toThrow("run_source_not_found");
});
it("reads pending authorities without creating actions or treating event data as approval", () => {
  const { event, observer, facts, db, cursor } = setup();
  event(0, "approval.requested", { approval_id: "approval", action_summary: "publish", risk: "high" });
  observer.tick(1000);
  expect(facts().pending_approvals).toEqual({ ids: ["approval"], count: 1, truncated: false });
  db.prepare("INSERT INTO events(event_id,run_id,session_id,seq,type,created_at,terminal,payload_json) VALUES('r:1','r','s',1,'approval.resolved',2,0,?)")
    .run(JSON.stringify({ approval_id: "approval", status: "accepted", choice: "yes" }));
  observer.tick(2000);
  expect(cursor()?.last_seq).toBe(1);
  expect(facts().pending_approvals.count).toBe(1);
  expect(db.prepare("SELECT COUNT(*) n FROM attention_actions").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT status FROM approvals").get()).toEqual({ status: "pending" });
});
it("a backlogged run does not starve another run or rewrite authoritative business state", () => {
  const { event, observer, db, path } = setup();
  for (let i = 0; i < 500; i++) event(i);
  insertRun(db, path, { task_id: "t", run_id: "second", session_id: "s2", agent_id: "hermes", capability_id: "code", phase: "execute", started_at: 2 });
  appendEvent(db, path, { event_id: "second:0", run_id: "second", session_id: "s2", seq: 0, type: "done",
    terminal: true, created_at: 3, payload: { status: "completed", last_seq: 0 } });
  observer.tick(1000);
  const second = JSON.parse((db.prepare("SELECT payload_json FROM attention_subjects WHERE subject_id='second'").get() as { payload_json: string }).payload_json);
  expect(second).toMatchObject({ observed_status: "completed", state: { phase: "execute", outcome: null }, event_replay: { complete: false, caught_up: true } });
  expect(db.prepare("SELECT last_seq FROM attention_run_cursors WHERE run_id='r'").get()).toEqual({ last_seq: 199 });
  expect(db.prepare("SELECT phase,outcome FROM runs WHERE run_id='second'").get()).toEqual({ phase: "execute", outcome: null });
});
it("bounds pending authority references while preserving the total count", () => {
  const { event, observer, facts } = setup();
  for (let seq = 0; seq < 25; seq++) event(seq, "clarify.requested", { clarify_id: `c${seq}`, question: "Choose" });
  observer.tick(1000);
  expect(facts().pending_clarifies).toMatchObject({ count: 25, truncated: true });
  expect(facts().pending_clarifies.ids).toHaveLength(20);
});
it.each(["delete", "retentant", "identity"])("quarantines every retained subject when task %s invalidates its scope", (kind) => {
  const { event, observer, facts, cursor, db } = setup();
  event(0); observer.tick(1000);
  if (kind === "delete") db.prepare("DELETE FROM tasks WHERE task_id='t'").run();
  if (kind === "retentant") db.prepare("UPDATE tasks SET tenant_id='other' WHERE task_id='t'").run();
  if (kind === "identity") db.prepare("UPDATE tasks SET created_at=2 WHERE task_id='t'").run();
  observer.tick(2000);
  expect(facts()).toMatchObject({ reason: "source_missing", event_replay: { complete: false, caught_up: false } });
  expect(cursor()?.gap).toBe("source_missing");
});
it("discovers the durable event stream even when the run also owns an agent session", () => {
  const { event, observer, facts, cursor, db, root, scope } = setup();
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('session','t','r','hermes','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'running',1,1,1)").run(root);
  event(0); observer.tick(1000);
  expect(cursor()?.last_seq).toBe(0);
  expect(facts().event_replay.caught_up).toBe(true);
  expect(observer.inventory(scope.scope_id, 1000)).toMatchObject({ subject_total: 2, admitted: 2 });
});
it.each(["delete", "mutate"])("never certifies history even when a non-anchor prefix row is %s", (kind) => {
  const { event, observer, facts, db } = setup();
  event(0); event(1); observer.tick(1000);
  if (kind === "delete") db.prepare("DELETE FROM events WHERE seq=0").run();
  else db.prepare("UPDATE events SET payload_json=? WHERE seq=0").run(JSON.stringify({ status: "failed" }));
  observer.tick(2000);
  expect(facts().event_replay).toMatchObject({ complete: false, caught_up: true, completeness_scope: "unverified_retention" });
});
it("detects identical run identity reuse through actual foreign-key anchor cascade", () => {
  const { event, observer, facts, cursor, db, path } = setup();
  event(0); observer.tick(1000);
  db.prepare("DELETE FROM runs WHERE run_id='r'").run();
  expect(db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });
  insertRun(db, path, { task_id: "t", run_id: "r", session_id: "s", agent_id: "hermes", capability_id: "code", phase: "execute", started_at: 1 });
  observer.tick(2000);
  expect(cursor()?.gap).toBe("event_anchor_changed");
  expect(facts()).toMatchObject({ observed_status: null, event_replay: { complete: false, caught_up: false } });
});
it("returns an invalid marker rather than losing the inventory to corrupt subject JSON", () => {
  const { event, observer, db, scope } = setup();
  event(0); observer.tick(1000);
  db.prepare("UPDATE attention_subjects SET payload_json='{' WHERE kind='run'").run();
  const view = observer.inventory(scope.scope_id, 1000);
  expect(view.coverage).toBe("degraded");
  expect(view.subjects[0]?.facts).toMatchObject({ state: "unknown", reason: "invalid_source", event_replay: { complete: false, caught_up: false } });
});
it.each([null, "event_sequence_gap"])("stalls on corrupt cursor facts regardless of existing gap %s", (gap) => {
  const { event, observer, cursor, facts, db } = setup();
  event(0); observer.tick(1000);
  db.prepare("UPDATE attention_run_cursors SET gap=?,facts_json='{' WHERE run_id='r'").run(gap);
  event(1); observer.tick(2000); observer.tick(3000);
  expect(cursor()?.last_seq).toBe(0);
  expect(facts().event_replay).toMatchObject({ complete: false, caught_up: false });
  expect(db.prepare("SELECT facts_json FROM attention_run_cursors").get()).toEqual({ facts_json: "{" });
});
it("marks discovery incomplete for a new run behind the persisted discovery key", () => {
  const { observer, db, path, scope, store } = setup();
  observer.tick(1000);
  db.prepare("UPDATE attention_scopes SET discovery_after='1:z' WHERE scope_id=?").run(scope.scope_id);
  insertRun(db, path, { task_id: "t", run_id: "behind", session_id: "s2", agent_id: "hermes", capability_id: "code", phase: "execute", started_at: 2 });
  observer.tick(2000);
  expect(store.getScope(scope.scope_id)?.scan_complete).toBe(0);
  observer.tick(3000);
  expect(observer.inventory(scope.scope_id, 3000).subject_total).toBe(2);
  expect(store.getScope(scope.scope_id)?.scan_complete).toBe(1);
});
it("run projection failure returns an explicit incomplete event replay marker", () => {
  const { observer, event, db, facts } = setup();
  event(0); observer.tick(1000);
  db.prepare("UPDATE attention_run_cursors SET last_seq=1.5 WHERE run_id='r'").run();
  observer.tick(2000);
  expect(facts()).toMatchObject({ reason: "invalid_source", event_replay: { complete: false, caught_up: false } });
});
it("capacity-rejected runs expose explicit incomplete markers without exceeding 100 admissions", () => {
  const { observer, db, path, scope } = setup();
  for (let i = 0; i < 100; i++) insertRun(db, path, { task_id: "t", run_id: `x${String(i).padStart(3, "0")}`,
    session_id: `s${i}`, agent_id: "hermes", capability_id: "code", phase: "execute", started_at: 2 });
  observer.tick(1000);
  const row = db.prepare("SELECT admitted,payload_json FROM attention_subjects WHERE kind='run' AND subject_id='x099'").get() as { admitted: number; payload_json: string };
  expect(row.admitted).toBe(0);
  expect(JSON.parse(row.payload_json)).toMatchObject({ reason: "capacity_exceeded",
    event_replay: { complete: false, caught_up: false, gap: "capacity_exceeded" } });
  expect(observer.inventory(scope.scope_id, 1000)).toMatchObject({ subject_total: 101, admitted: 100, coverage: "degraded" });
});
it("an explicit operator repair can resume reads but never clears the retained corruption gap", () => {
  const { observer, event, db, cursor, facts } = setup();
  event(0); observer.tick(1000);
  db.prepare("UPDATE attention_run_cursors SET facts_json='{' WHERE run_id='r'").run();
  event(1); observer.tick(2000);
  expect(cursor()?.last_seq).toBe(0);
  db.prepare("UPDATE attention_run_cursors SET facts_json=? WHERE run_id='r'").run(JSON.stringify({ observed_status: null, unsupported_events: 0 }));
  observer.tick(3000);
  expect(cursor()).toMatchObject({ last_seq: 1, gap: "invalid_cursor_facts" });
  expect(facts().event_replay).toMatchObject({ complete: false, caught_up: false });
});

it("bounds a replay page by aggregate payload bytes without inventing a sequence gap", () => {
  const {db,event}=setup();
  for(let seq=0;seq<200;seq++) event(seq,"token.delta",{delta:"x".repeat(40000)});
  const first=readRunEventPage(db,{taskId:"t",runId:"r",afterSeq:-1,limit:200});
  expect(first.events).toHaveLength(1);
  expect(first).toMatchObject({nextAfter:0,hasMore:true,sequenceGap:false,highWatermark:199});
  expect(first.events.reduce((total,row)=>total+Buffer.byteLength(row.payload_json??""),0)).toBeLessThanOrEqual(65536);
  const next=readRunEventPage(db,{taskId:"t",runId:"r",afterSeq:first.nextAfter,throughSeq:first.highWatermark,limit:200});
  expect(next).toMatchObject({nextAfter:1,hasMore:true,sequenceGap:false});
});
