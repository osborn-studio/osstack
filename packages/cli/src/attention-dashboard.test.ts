import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttentionStore, openDb } from "@osstack/core";
import { insertTask } from "./store.js";
import { readAttentionDashboard } from "./attention-dashboard.js";

let root: string;
let db: Database.Database;
let store: AttentionStore;
const now = 100_000;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "attention-dashboard-"));
  db = openDb({ path: join(root, "state.db") });
  store = new AttentionStore(db, join(root, "state.db"));
  store.claimOwner("test");
});
afterEach(() => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); });
function scope(id: string, repo = root, tenant?: string) {
  insertTask(db, store.path, { task_id: id, title: id, created_at: 1 });
  const owner = { instance_id: "test", generation: 1, home_id: (db.prepare("SELECT home_id FROM daemon_owner").get() as { home_id: string }).home_id };
  const result = store.registerScope(owner, id, repo);
  db.prepare("UPDATE attention_scopes SET sampled_at=?,deadline=?,scan_complete=1 WHERE scope_id=?").run(now, now + 65000, result.scope_id);
  if (tenant) db.prepare("UPDATE tasks SET tenant_id=? WHERE task_id=?").run(tenant, id);
  return result.scope_id;
}
function subject(scopeId: string, id: string, admitted = 1, payload = '{"wait":{"owner":"human"}}') {
  db.prepare("INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'session',?,'hash',1,?,?,?,1,?)").run(scopeId, id, admitted, now, now, payload);
}
function item(scopeId: string, id: string, state = "open") {
  db.prepare("INSERT INTO attention_items(item_id,scope_id,session_id,turn_id,decision_id,content_hash,decision_json,source_version,state,created_at,updated_at) VALUES(?,?,?,'turn',?,'hash','{}',1,?,?,?)").run(id, scopeId, id, id, state, now, now);
}
const options = () => ({ workspacePath: root, service: "running" as const, nowMs: now });

describe("Attention dashboard read model", () => {
  it("distinguishes disabled, unavailable, and not watched without inventing healthy zero counts", () => {
    expect(readAttentionDashboard(db, { ...options(), service: "disabled" })).toMatchObject({ status: "disabled", totals: null });
    expect(readAttentionDashboard(db, { ...options(), service: "unavailable" })).toMatchObject({ status: "unavailable", totals: null });
    expect(readAttentionDashboard(db, options())).toMatchObject({ status: "not_watched", totals: { scopes: 0 } });
  });
  it("filters rows and all totals to canonical workspace and default tenant", () => {
    const other = join(root, "other"); mkdirSync(other);
    const selected = scope("selected"); const elsewhere = scope("other", other); const foreign = scope("foreign", root, "private");
    subject(selected, "s"); item(selected, "i");
    for (const id of [elsewhere, foreign]) { subject(id, id, 0); item(id, id, "answer_uncertain"); }
    const alias = join(root, "alias"); symlinkSync(root, alias);
    const result = readAttentionDashboard(db, { ...options(), workspacePath: alias });
    expect(result).toMatchObject({ status: "available", workspace_path: realpathSync(root), totals: { scopes: 1, subjects: 1, unmonitored_subjects: 0, open_items: 1, uncertain_answers: 0, human_waits: 1 } });
    expect(result.scopes.map(s => s.scope_id)).toEqual([selected]);
    expect(readAttentionDashboard(db, { service: "running", nowMs: now })).toMatchObject({ scope_filter: "local_overview", workspace_path: null, totals: { scopes: 2 } });
  });
  it("keeps complete filtered totals and a deterministic scope cursor when paging", () => {
    for (let n = 0; n < 3; n++) { const s = scope(`s${n}`); subject(s, `s${n}`, n === 0 ? 0 : 1); item(s, `i${n}`); }
    const first = readAttentionDashboard(db, { ...options(), limit: 1 });
    const second = readAttentionDashboard(db, { ...options(), limit: 1, after: first.next_after! });
    expect(first.totals).toEqual(second.totals);
    expect(first.totals).toMatchObject({ scopes: 3, subjects: 3, unmonitored_subjects: 1, open_items: 3 });
    expect(first).toMatchObject({ returned: 1, truncated: true });
    expect(second.scopes[0]!.scope_id > first.scopes[0]!.scope_id).toBe(true);
  });
  it("retains business facts while stale owner, scan deadline, and source gaps degrade observation", () => {
    const s = scope("one"); subject(s, "s"); item(s, "i", "answer_uncertain");
    expect(readAttentionDashboard(db, { ...options(), nowMs: now + 65001 })).toMatchObject({ status: "stale", totals: { uncertain_answers: 1 } });
    db.prepare("UPDATE daemon_owner SET generation=2").run();
    expect(readAttentionDashboard(db, options()).scopes[0]).toMatchObject({ coverage: "stale", reason: "owner_changed" });
    db.prepare("UPDATE daemon_owner SET generation=1").run();
    db.prepare("UPDATE attention_subjects SET payload_json=?").run('{"gap":"history_gap"}');
    expect(readAttentionDashboard(db, options())).toMatchObject({ status: "degraded" });
  });
  it("discloses malformed projection data and missing owner rather than claiming coverage", () => {
    const s = scope("one"); subject(s, "s", 1, "not json");
    expect(readAttentionDashboard(db, options())).toMatchObject({ status: "degraded", totals: { unknown_waits: 1 } });
    db.prepare("DELETE FROM daemon_owner").run();
    expect(readAttentionDashboard(db, options())).toMatchObject({ status: "unavailable", totals: null });
  });
  it("uses read-only SQL and handles old schemas without opening or migrating another DB", () => {
    scope("one"); db.pragma("query_only=ON");
    expect(readAttentionDashboard(db, options()).status).toBe("available");
    const legacy = new Database(":memory:");
    legacy.exec("CREATE TABLE tasks(task_id TEXT)");
    expect(readAttentionDashboard(legacy, options())).toMatchObject({ status: "unavailable", reason: "schema_unavailable", totals: null });
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "tasks" }]);
    legacy.close();
  });
  it("rejects invalid pages and labels an inaccessible explicit workspace unavailable", () => {
    expect(() => readAttentionDashboard(db, { ...options(), limit: 101 })).toThrow("invalid_attention_page");
    expect(() => readAttentionDashboard(db, { ...options(), after: "x' OR 1=1" })).toThrow("invalid_attention_page");
    expect(readAttentionDashboard(db, { ...options(), workspacePath: join(root, "missing") })).toMatchObject({ status: "unavailable", reason: "workspace_unavailable", totals: null });
  });
});

it("counts pending, uncertain, missing, applied answers and dead letters independently without join multiplication", () => {
  const s = scope("counts"); subject(s, "s", 1, '{"wait":{"owner":"system"}}');
  for (const state of ["open", "answer_reserved", "answer_uncertain", "source_missing", "answer_applied", "source_closed", "continued_externally", "answer_abandoned"]) item(s, state, state);
  db.prepare("INSERT INTO attention_deliveries(delivery_id,scope_id,item_id,revision,state) VALUES('dead',?,'open',1,'dead_letter'),('sent',?,'answer_applied',1,'delivered')").run(s,s);
  const result = readAttentionDashboard(db, options());
  expect(result.totals).toMatchObject({ scopes: 1, subjects: 1, system_waits: 1, open_items: 1, pending_answers: 1, uncertain_answers: 1, missing_source_items: 1, applied_answers: 1, dead_letters: 1 });
  expect(result.scopes[0]).toMatchObject({ open_items: 1, pending_answers: 1, uncertain_answers: 1, missing_source_items: 1, applied_answers: 1, dead_letters: 1 });
});

it("counts every stored decision and excludes released subjects from current wait classification", () => {
  const s = scope("released"); subject(s, "s", 0); item(s, "future", "future_state"); item(s, "closed", "source_closed");
  expect(readAttentionDashboard(db, options()).totals).toMatchObject({ items: 2, other_items: 2, human_waits: 0, system_waits: 0, unknown_waits: 0, unmonitored_subjects: 1 });
});
