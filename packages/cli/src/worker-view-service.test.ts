import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createScratchDirSync, CURRENT_SCHEMA_VERSION, openDb } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { serializeWorkerView, WorkerViewService } from "./worker-view-service.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(count = 1) {
  const root = realpathSync(createScratchDirSync("tests", "worker-view"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "state.db");
  const db = openDb({ path: dbPath });
  cleanup.push(() => db.close());
  for (let i = 0; i < count; i++) {
    db.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES(?, 'PRIVATE_TITLE', 'running', 1, 1)").run(`t${i}`);
    db.prepare("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at,last_step) VALUES(?,?,?,'codex-cli','code','execute',1,'PRIVATE_STEP')").run(`r${i}`, `t${i}`, `s${i}`);
    db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES(?,?,?,'codex-cli',?,'PRIVATE_NATIVE',?,'awaiting_decision',1,1,1)").run(`s${i}`, `t${i}`, `r${i}`, "a".repeat(64), root);
    db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,assistant_text,decision_json,created_at,updated_at) VALUES(?,?,1,'awaiting_decision','PRIVATE_TRANSCRIPT','PRIVATE_DECISION',1,1)").run(`turn${i}`, `s${i}`);
  }
  let now = 2000;
  const service = new WorkerViewService(db, { nowMs: () => now });
  const params = { repo_path: root, default_tenant: true as const };
  return { root, dbPath, db, service, params, advance: (ms = 900001) => { now += ms; } };
}

describe("worker read-only state views", () => {
  it("projects real durable facts without text, native identity, control authority, or writes", () => {
    const f = fixture();
    const before = f.db.prepare("SELECT total_changes() AS n").get();
    const result = f.service.list(f.params);
    expect(result.total).toBe(2);
    expect(result.coverage).toMatchObject({ graph: "unsupported_authenticated_registration_required", unbound_runs: "excluded_not_bound" });
    expect(result.views.map(v => v.source_kind)).toEqual(["run", "session"]);
    expect(result.views[0]!.state).toBe("outcome_pending");
    expect(result.views[1]).toMatchObject({ state: "awaiting_decision", wait_reason: "decision_record_present", process_liveness: "unknown", latest_turn: { ordinal: 1, state: "awaiting_decision", decision_present: true }, controls: "unsupported" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|assistant_text|native_session_id|payload_json|task_id|source_id/);
    const inspected = f.service.inspect({ ...f.params, view_id: result.views[1]!.view_id });
    expect(inspected.view.state).toBe("awaiting_decision");
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });
  it.each(["UPDATE tasks SET tenant_id='other'", "UPDATE runs SET tenant_id='other'", "UPDATE runs SET session_id='other'", "UPDATE runs SET agent_id='other'", "UPDATE agent_sessions SET repo_path=''", "UPDATE runs SET task_id='other'"])("excludes uncertain scope binding: %s", sql => {
    const f = fixture();
    f.db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('other','','running',1,1)");
    f.db.exec(sql);
    expect(f.service.list(f.params).total).toBe(0);
  });
  it("does not invent repository scope for a run without a Session", () => {
    const f = fixture();
    f.db.exec("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('orphan','t0','unbound','codex-cli','code','execute',1)");
    expect(f.service.list(f.params).total).toBe(2);
  });
  it("canonicalizes request paths but excludes noncanonical stored aliases", () => {
    const f = fixture();
    const alias = join(f.root, "alias"); symlinkSync(f.root, alias);
    expect(f.service.list({ ...f.params, repo_path: alias }).total).toBe(2);
    f.db.prepare("UPDATE agent_sessions SET repo_path=?").run(alias);
    expect(f.service.list(f.params).total).toBe(0);
  });
  it.each([{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { default_tenant: false }, { repo_path: "" }, { repo_path: "relative" }, { repo_path: "/" + "x".repeat(4096) }, { cursor: "" }, { cursor: "x".repeat(2049) }, { secret: "unexpected" }])("rejects malformed scope or bounds: %j", extra => {
    const f = fixture();
    expect(() => f.service.list({ ...f.params, ...extra })).toThrow("invalid_request");
  });
  it("requires explicit tenant and existing accessible directory", () => {
    const f = fixture();
    expect(() => f.service.list({ repo_path: f.root })).toThrow("invalid_request");
    expect(() => f.service.list({ ...f.params, repo_path: join(f.root, "missing") })).toThrow("repository_unavailable");
    expect(() => f.service.list({ ...f.params, repo_path: f.dbPath })).toThrow("repository_unavailable");
  });
  it("rejects a directory without read/search access", () => {
    const f = fixture(); const blocked = join(f.root, "blocked"); mkdirSync(blocked); chmodSync(blocked, 0);
    try { expect(() => f.service.list({ ...f.params, repo_path: blocked })).toThrow("repository_unavailable"); }
    finally { chmodSync(blocked, 0o700); }
  });
  it("bounds pages and traverses each source view exactly once", () => {
    const f = fixture(61);
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = f.service.list({ ...f.params, limit: 50, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(122);
      expect(page.views.length).toBeLessThanOrEqual(50);
      expect(Buffer.byteLength(JSON.stringify(page)) + 1).toBeLessThanOrEqual(65536);
      for (const view of page.views) { expect(ids.has(view.view_id)).toBe(false); ids.add(view.view_id); }
      cursor = page.next_cursor;
    } while (cursor);
    expect(ids.size).toBe(122);
  });
  it("rejects tampering, token type confusion, different repo, new instance, and expiry", () => {
    const f = fixture();
    const page = f.service.list({ ...f.params, limit: 1 });
    const viewId = page.views[0]!.view_id;
    const cursor = page.next_cursor!;
    expect(() => f.service.list({ ...f.params, cursor: "x" + cursor.slice(1) })).toThrow("invalid_cursor");
    expect(() => f.service.list({ ...f.params, cursor: viewId })).toThrow("invalid_cursor");
    expect(() => f.service.inspect({ ...f.params, view_id: cursor })).toThrow("invalid_view");
    const other = join(f.root, "other"); mkdirSync(other);
    expect(() => f.service.inspect({ ...f.params, repo_path: other, view_id: viewId })).toThrow("invalid_view");
    expect(() => f.service.list({ ...f.params, repo_path: other, cursor })).toThrow("invalid_cursor");
    expect(() => new WorkerViewService(f.db).list({ ...f.params, cursor })).toThrow("invalid_cursor");
    expect(() => new WorkerViewService(f.db).inspect({ ...f.params, view_id: viewId })).toThrow("invalid_view");
    f.advance();
    expect(() => f.service.inspect({ ...f.params, view_id: viewId })).toThrow("invalid_view");
    expect(() => f.service.list({ ...f.params, cursor })).toThrow("invalid_cursor");
  });
  it("shortens pages by encoded byte size and resumes without losing rows", () => {
    const f = fixture(60);
    // Encrypted cursor payloads include the internal identity but never expose
    // it. Wide identities exercise the byte budget independently of count.
    f.db.pragma("foreign_keys=OFF");
    for (let i = 0; i < 60; i++) {
      const id = "界".repeat(250) + String(i);
      f.db.prepare("UPDATE runs SET session_id=? WHERE run_id=?").run(id, `r${i}`);
      f.db.prepare("UPDATE session_turns SET session_id=? WHERE session_id=?").run(id, `s${i}`);
      f.db.prepare("UPDATE agent_sessions SET session_id=? WHERE session_id=?").run(id, `s${i}`);
    }
    let cursor: string | undefined;
    let seen = 0; let shortened = false;
    do {
      const page = f.service.list({ ...f.params, limit: 50, ...(cursor ? { cursor } : {}) });
      expect(Buffer.byteLength(JSON.stringify(page)) + 1).toBeLessThanOrEqual(65536);
      seen += page.views.length;
      if (page.next_cursor && page.views.length < 50) shortened = true;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toBe(120); expect(shortened).toBe(true);
  });
  it("bounds the whole cursor chain to 15 minutes while each new view gets its own TTL", () => {
    const f = fixture(2);
    const first = f.service.list({ ...f.params, limit: 1 });
    f.advance(800000);
    const second = f.service.list({ ...f.params, limit: 1, cursor: first.next_cursor! });
    f.advance(100001);
    expect(() => f.service.list({ ...f.params, cursor: second.next_cursor! })).toThrow("invalid_cursor");
    expect(f.service.inspect({ ...f.params, view_id: second.views[0]!.view_id }).view.source_kind).toBe("run");
  });
  it("rejects identities whose JSON escaping exceeds the token budget before encoding", () => {
    const f = fixture(); f.db.pragma("foreign_keys=OFF");
    const id = "\u0001".repeat(256);
    f.db.prepare("UPDATE runs SET session_id=?").run(id);
    f.db.prepare("UPDATE agent_sessions SET session_id=?").run(id);
    expect(() => f.service.list(f.params)).toThrow("source_unavailable");
  });
  it("rejects corrupt oversized identities without returning a partial success", () => {
    const f = fixture(); f.db.pragma("foreign_keys=OFF");
    const id = "s".repeat(257);
    f.db.prepare("UPDATE runs SET session_id=?").run(id);
    f.db.prepare("UPDATE agent_sessions SET session_id=?").run(id);
    expect(() => f.service.list(f.params)).toThrow("source_unavailable");
  });
  it("rechecks scope on inspect and reports delivery uncertainty without reading messages", () => {
    const f = fixture();
    f.db.exec("INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at) VALUES('m','s0','turn0','inbound','instruction.send','PRIVATE_PAYLOAD','failed',1)");
    const page = f.service.list(f.params);
    expect(page.views[1]!.wait_reason).toBe("delivery_unknown");
    const view = page.views[1]!.view_id;
    f.db.exec("UPDATE agent_sessions SET state='completed', version=2, updated_at=9999999");
    expect(f.service.inspect({ ...f.params, view_id: view }).view).toMatchObject({ state: "completed", process_liveness: "unknown", freshness: "unknown", wait_reason: "none", uncertain_delivery_recorded: true });
    f.db.exec("UPDATE tasks SET tenant_id='elsewhere'");
    expect(() => f.service.inspect({ ...f.params, view_id: view })).toThrow("source_not_found");
  });
  it("honors explicit unknown-receipt reconciliation without erasing delivery history", () => {
    const f=fixture();
    f.db.exec("INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at) VALUES('m','s0','turn0','inbound','instruction.send','PRIVATE','failed',1)");
    expect(f.service.list(f.params).views[1]).toMatchObject({wait_reason:"delivery_unknown",uncertain_delivery_recorded:true});
    f.db.prepare("INSERT INTO attention_receipt_resolutions VALUES(?,?,?,'abandoned_unknown',?,?,?)").run('m','s0',1,'operator reconciliation','a'.repeat(64),2);
    expect(f.service.list(f.params).views[1]).toMatchObject({wait_reason:"decision_record_present",uncertain_delivery_recorded:true});
  });
  it("supports an injected readonly DB and constructor performs no DB access", () => {
    const f = fixture();
    const readonly = new Database(f.dbPath, { readonly: true });
    expect(new WorkerViewService(readonly).list(f.params).total).toBe(2);
    readonly.close();
    const service = new WorkerViewService(readonly);
    expect(() => service.list(f.params)).toThrow("source_unavailable");
  });
  it("fails safely on unsupported schema and unknown RPC without migration", () => {
    const f = fixture();
    f.db.pragma(`user_version=${CURRENT_SCHEMA_VERSION + 1}`);
    expect(() => f.service.list(f.params)).toThrow("unsupported_schema");
    expect(f.db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect(() => f.service.handle("worker.cancel", {})).toThrow("unsupported_method");
  });
  it("uses terminal-safe JSON budgeting without changing parsed Unicode identities", () => {
    const value = { path: "\u009b\u202e\u200f\u{e0001}" };
    const text = serializeWorkerView(value);
    expect(text).not.toMatch(/[\p{Cf}\u007f-\u009f]/u);
    expect(JSON.parse(text)).toEqual(value);
    expect(Buffer.byteLength(text)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(value)));
  });
});
