import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { insertRun, insertTask } from "./run-store.js";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";
import { FollowUpObligationService } from "./follow-up-obligations.js";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "follow-up")); const path = join(root, "state.db"); const db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  insertTask(db, path, { task_id: "task", title: "private prompt", created_at: 1 });
  insertRun(db, path, { run_id: "run", task_id: "task", session_id: "session", agent_id: "fake", capability_id: "code", phase: "execute", started_at: 1 });
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run("session", "task", "run", "fake", "a".repeat(64), "PRIVATE_NATIVE_ID", root, "running", 0, 1, 1);
  const service = new FollowUpObligationService(db, path, { nowMs: () => 1000 });
  const scope = { repo_path: root, default_tenant: true as const };
  const input = { ...scope, source_session_id: "session", expected_source_version: 1, idempotency_key: "once", actor: "operator", promise: "Review local result", destination_ref: "local_operator", resolution_condition: "session_completed", due_at: 999 };
  return { db, path, root, service, scope, input };
}
it("persists create/event atomically and replays idempotence after source cleanup", () => {
  const f = fixture(); const first = f.service.create(f.input);
  expect(first.obligation).toMatchObject({ state: "open", revision: 1, source_missing: false, external_delivery: "unsupported" });
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE_NATIVE_ID|private prompt/);
  f.db.prepare("DELETE FROM tasks WHERE task_id='task'").run();
  const reopened = openDb({ path: f.path }); cleanup.push(() => reopened.close());
  const replay = new FollowUpObligationService(reopened, f.path).create(f.input);
  expect(replay.duplicate).toBe(true); expect(replay.obligation.obligation_id).toBe(first.obligation.obligation_id); expect(replay.obligation.source_missing).toBe(true);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM follow_up_obligation_events").get()).toEqual({ n: 1 });
  expect(() => f.service.create({ ...f.input, promise: "changed" })).toThrow("follow_up_idempotency_conflict");
});
it("draft is unsent, captures facts, and never resolves a completed source", () => {
  const f = fixture(); const created = f.service.create(f.input).obligation;
  f.db.prepare("UPDATE agent_sessions SET state='completed',version=2,updated_at=2").run();
  const result = f.service.draft({ ...f.scope, obligation_id: created.obligation_id, expected_revision: 1, actor: "operator" }).obligation;
  expect(result).toMatchObject({ state: "drafted", revision: 2, draft: { delivery_state: "unsent", source: { state: "completed", version: 2 } }, resolution: null });
  expect(result.draft!.text).toContain("UNSENT");
  expect(result.draft!.content_digest).toBe(createHash("sha256").update(result.draft!.text).digest("hex"));
  expect(() => f.service.draft({ ...f.scope, obligation_id: created.obligation_id, expected_revision: 1, actor: "other" })).toThrow("follow_up_revision_conflict");
});
it("only verifies an explicitly selected local completed-session condition", () => {
  const f = fixture(); const created = f.service.create(f.input).obligation;
  const request = { ...f.scope, obligation_id: created.obligation_id, expected_revision: 1, actor: "operator", mode: "condition", reason: "Inspect completion" };
  f.db.prepare("UPDATE tasks SET status='done'").run();
  expect(() => f.service.resolve(request)).toThrow("follow_up_condition_not_met");
  f.db.prepare("UPDATE agent_sessions SET state='completed',version=2,updated_at=2").run();
  const result = f.service.resolve(request).obligation;
  expect(result).toMatchObject({ state: "fulfilled_local", resolution: { source: { state: "completed" }, external_delivery: "unsupported" } });
  expect(() => f.service.draft({ ...f.scope, obligation_id: created.obligation_id, expected_revision: 2, actor: "operator" })).toThrow("follow_up_terminal");
});
it("waives missing sources explicitly without deleting the original promise", () => {
  const f = fixture(); const created = f.service.create(f.input).obligation; f.db.prepare("DELETE FROM tasks").run();
  const request = { ...f.scope, obligation_id: created.obligation_id, expected_revision: 1, actor: "operator", reason: "Obsolete", mode: "condition" };
  expect(() => f.service.resolve(request)).toThrow("follow_up_condition_not_met");
  const result = f.service.resolve({ ...request, mode: "waive" }).obligation;
  expect(result).toMatchObject({ state: "waived", promise: f.input.promise, source_missing: true, resolution: { mode: "waive", reason: "Obsolete" } });
  expect(() => f.db.prepare("DELETE FROM follow_up_obligations").run()).toThrow();
  expect(() => f.db.prepare("UPDATE follow_up_obligation_events SET actor='forged'").run()).toThrow();
});
it.each(["task_tenant", "run_tenant", "run_binding", "repo"])("rejects foreign or inconsistent %s sources", kind => {
  const f = fixture();
  if (kind === "task_tenant") f.db.prepare("UPDATE tasks SET tenant_id='other'").run();
  if (kind === "run_tenant") f.db.prepare("UPDATE runs SET tenant_id='other'").run();
  if (kind === "run_binding") f.db.prepare("UPDATE runs SET session_id='other'").run();
  if (kind === "repo") f.db.prepare("UPDATE agent_sessions SET repo_path='/other'").run();
  expect(() => f.service.create(f.input)).toThrow("follow_up_source_unavailable");
});
it("requires a fresh source revision and exact explicit scope on every operation", () => {
  const f = fixture(); expect(() => f.service.create({ ...f.input, expected_source_version: 2 })).toThrow("follow_up_source_revision_conflict");
  const created = f.service.create(f.input).obligation;
  const other = realpathSync(createScratchDirSync("tests", "follow-up-other")); cleanup.push(() => rmSync(other, { recursive: true, force: true }));
  expect(f.service.list({ ...f.scope, repo_path: other }).obligations).toEqual([]);
  expect(() => f.service.draft({ ...f.scope, repo_path: other, obligation_id: created.obligation_id, expected_revision: 1, actor: "operator" })).toThrow("follow_up_not_found");
  expect(() => f.service.list({ repo_path: f.root })).toThrow("invalid_follow_up_request");
});
it("rolls back row mutation when the append-only event cannot be written", () => {
  const f = fixture(); const created = f.service.create(f.input).obligation;
  f.db.exec("CREATE TRIGGER block_event BEFORE INSERT ON follow_up_obligation_events BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  expect(() => f.service.draft({ ...f.scope, obligation_id: created.obligation_id, expected_revision: 1, actor: "operator" })).toThrow("follow_up_database_unavailable");
  expect(f.service.list(f.scope).obligations[0]).toMatchObject({ state: "open", revision: 1, has_draft: false });
});
it("paginates within scope and never mutates on list", () => {
  const f = fixture(); for (let i = 0; i < 3; i++) f.service.create({ ...f.input, idempotency_key: `item-${i}` });
  const first = f.service.list({ ...f.scope, limit: 2 }); const before = f.db.prepare("SELECT total_changes() AS n").get();
  const second = f.service.list({ ...f.scope, limit: 2, cursor: first.next_cursor });
  expect(first.obligations).toHaveLength(2); expect(second.obligations).toHaveLength(1); expect(second.next_cursor).toBeNull(); expect(first.overdue_count).toBe(3);
  expect(new Set([...first.obligations, ...second.obligations].map(row => row.obligation_id)).size).toBe(3);
  expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});
it("does not attach a recreated source to the old obligation", () => {
  const f = fixture(); const row = f.service.create(f.input).obligation;
  f.db.prepare("UPDATE agent_sessions SET request_sha256=?,state='completed',version=2,updated_at=2").run("b".repeat(64));
  expect(f.service.list(f.scope).obligations[0]!.source_missing).toBe(true);
  expect(() => f.service.resolve({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, actor: "operator", reason: "check", mode: "condition" })).toThrow("follow_up_condition_not_met");
});
it("rejects a second connection's stale revision and retains both audit events", () => {
  const f = fixture(); const row = f.service.create(f.input).obligation;
  const second = openDb({ path: f.path }); cleanup.push(() => second.close());
  const request = { ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, actor: "operator" };
  f.service.draft(request);
  expect(() => new FollowUpObligationService(second, f.path).draft(request)).toThrow("follow_up_revision_conflict");
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM follow_up_obligation_events").get()).toEqual({ n: 2 });
});
it("migrates an actual schema 43 database to 44 without rewriting existing source rows", () => {
  const root = realpathSync(createScratchDirSync("tests", "follow-up-upgrade")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.db"); const old = new Database(path);
  for (const migration of MIGRATIONS.filter(row => row.id <= 43)) old.exec(migration.sql);
  old.pragma("user_version=43"); old.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('existing','Preserved','running',1,1)").run(); old.close();
  const upgraded = openDb({ path }); cleanup.push(() => upgraded.close());
  expect(upgraded.pragma("user_version", { simple: true })).toBe(44);
  expect(upgraded.prepare("SELECT title,status FROM tasks WHERE task_id='existing'").get()).toEqual({ title: "Preserved", status: "running" });
  expect(upgraded.prepare("SELECT count(*) AS n FROM follow_up_obligations").get()).toEqual({ n: 0 });
  const readOnly = openDb({ path, readwrite: false }); readOnly.close();
});
it("fails closed without migrating from a service constructor or write against readonly DB", () => {
  const f = fixture(); const ro = openDb({ path: f.path, readwrite: false }); cleanup.push(() => ro.close());
  const service = new FollowUpObligationService(ro, f.path);
  expect(service.list(f.scope).obligations).toEqual([]);
  expect(() => service.create(f.input)).toThrow("follow_up_database_unavailable");
  expect(f.db.prepare("SELECT count(*) AS n FROM follow_up_obligations").get()).toEqual({ n: 0 });
});
it("handles escaped control-heavy local data without truncation or external actions", () => {
  const f = fixture(); const row = f.service.create({ ...f.input, promise: "promise" + "\u0000".repeat(3000) }).obligation;
  const drafted = f.service.draft({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, actor: "operator" }).obligation;
  expect(drafted.draft!.text).toContain(row.promise);
  const waived = f.service.resolve({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 2, actor: "operator", mode: "waive", reason: "reason" + "\u0000".repeat(900) });
  expect(waived.obligation.state).toBe("waived");
});
it("bounds escaped list output and binds cursors to the same repository and filter", () => {
  const f = fixture(); const nested = join(f.root, ...Array.from({ length: 4 }, (_, i) => `${i}-${"a".repeat(150)}`)); mkdirSync(nested, { recursive: true });
  f.db.prepare("UPDATE agent_sessions SET repo_path=?").run(nested);
  for (let i = 0; i < 50; i++) f.service.create({ ...f.input, repo_path: nested, promise: "promise" + "\u0000".repeat(100), idempotency_key: `page-${i}` });
  const page = f.service.list({ ...f.scope, repo_path: nested, limit: 50 });
  expect(page.obligations.length).toBeLessThan(50); expect(page.next_cursor).not.toBeNull(); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
  expect(() => f.service.list({ ...f.scope, limit: 50, cursor: page.next_cursor })).toThrow("follow_up_invalid_cursor");
  expect(() => f.service.list({ ...f.scope, repo_path: nested, state: "drafted", cursor: page.next_cursor })).toThrow("follow_up_invalid_cursor");
  const next = f.service.list({ ...f.scope, repo_path: nested, limit: 50, cursor: page.next_cursor });
  expect(new Set([...page.obligations, ...next.obligations].map(row => row.obligation_id)).size).toBe(50);
});
it("refuses forged external delivery fields and unknown resolve modes without mutation", () => {
  const f = fixture(); const row = f.service.create(f.input).obligation;
  const params = { ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, actor: "operator", reason: "Already sent" };
  for (const extra of [{ mode: "external_delivered" }, { mode: "condition", provider_receipt: "file:///tmp/spool" }, { mode: "waive", approved: true }])
    expect(() => f.service.resolve({ ...params, ...extra })).toThrow("invalid_follow_up_request");
  expect(f.service.list(f.scope).obligations[0]!.state).toBe("open");
});
it("keeps malformed sources visible and waivable while refusing new creation", () => {
  const f = fixture(); const row = f.service.create(f.input).obligation;
  f.db.prepare("UPDATE agent_sessions SET updated_at=-1").run();
  expect(f.service.list(f.scope).obligations[0]!.source_missing).toBe(true);
  expect(() => f.service.create({ ...f.input, idempotency_key: "new" })).toThrow("follow_up_source_unavailable");
  const waived = f.service.resolve({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, mode: "waive", actor: "operator", reason: "Corrupt source" });
  expect(waived.obligation.state).toBe("waived");
});
it("preserves every draft text and exact byte hash in immutable event history", () => {
  const f = fixture(); const row = f.service.create(f.input).obligation;
  const first = f.service.draft({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, actor: "first" }).obligation;
  f.db.prepare("UPDATE agent_sessions SET state='completed',version=2,updated_at=2").run();
  const second = f.service.draft({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 2, actor: "second" }).obligation;
  const events = f.db.prepare("SELECT evidence_json FROM follow_up_obligation_events WHERE transition='drafted' ORDER BY revision").all() as { evidence_json: string }[];
  expect(events.map(row => JSON.parse(row.evidence_json).draft.text)).toEqual([first.draft!.text, second.draft!.text]);
});
it("preserves monotonic local revisions and write timestamps across clock rollback", () => {
  const f = fixture(); const row = f.service.create(f.input).obligation;
  const regressed = new FollowUpObligationService(f.db, f.path, { nowMs: () => 500 });
  const waived = regressed.resolve({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, mode: "waive", actor: "operator", reason: "Clock correction" });
  expect(waived.obligation.updated_at).toBe(1000); expect(waived.obligation.state).toBe("waived");
});
it("archives pending draft from terminal responses while preserving its event proof", () => {
  const f = fixture(); const row = f.service.create({ ...f.input, promise: "P" + "\u0000".repeat(4095) }).obligation;
  const draft = f.service.draft({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 1, actor: "operator" });
  expect(draft.obligation.draft!.text).toContain(row.promise);
  const terminal = f.service.resolve({ ...f.scope, obligation_id: row.obligation_id, expected_revision: 2, mode: "waive", actor: "A" + "\u0000".repeat(127), reason: "R" + "\u0000".repeat(1023) });
  expect(terminal.obligation.draft).toBeNull(); expect(terminal.obligation.promise).toBe(row.promise);
  expect(f.db.prepare("SELECT draft_json IS NOT NULL AS retained FROM follow_up_obligations WHERE obligation_id=?").get(row.obligation_id)).toEqual({ retained: 1 });
});

it("freezes registered migration 44 SQL lineage", () => {
  expect(createHash("sha256").update(MIGRATIONS.find(row => row.id === 44)!.sql).digest("hex")).toBe("4c40310b23a7f7348985d4aecf2042e69843e06361d74a0c5b8792de39897aa6");
});
