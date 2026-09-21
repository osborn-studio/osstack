import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, realpathSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "@osstack/core";
import { explainGraph, handleGraphCommand } from "./graph-command.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "osstack-graph-test-")); roots.push(root);
  const dbPath = join(root, "state.db");
  const statePath = join(root, "LOOP-STATE.json");
  const db = openDb({ path: dbPath });
  db.prepare("INSERT INTO tasks (task_id,title,status,created_at,updated_at,tenant_id) VALUES (?,?,'done',1,2,?)").run("t", "task", "a");
  db.prepare("INSERT INTO runs (run_id,task_id,session_id,agent_id,capability_id,phase,outcome,started_at,tenant_id) VALUES ('r','t','s','agent','code','execute','success',1,'a')").run();
  const card = db.prepare("INSERT INTO kanban_cards (card_id,task_id,title,status,blocked_reason,board,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,2)");
  card.run("c", "t", "card", "blocked", "waiting on review", "b", "a");
  card.run("n", null, "neighbor", "todo", null, "b", "a");
  card.run("secret", "t", "hidden", "done", null, "b", "other");
  card.run("other-board", "t", "hidden", "done", null, "private", "a");
  card.run("null-tenant", "t", "hidden", "done", null, "b", null);
  const link = db.prepare("INSERT INTO kanban_card_links VALUES (?,?)");
  link.run("c", "n"); link.run("n", "c"); link.run("c", "secret"); link.run("c", "other-board"); link.run("c", "null-tenant");
  db.prepare("INSERT INTO runs (run_id,task_id,session_id,agent_id,capability_id,phase,started_at,tenant_id) VALUES ('secret-run','t','s','agent','code','execute',2,'other')").run();
  db.pragma("wal_checkpoint(TRUNCATE)"); db.close();
  const state = { loop_id: "l", started_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:01:00Z", completed_tasks: [{ task_id: "t", run_id: "r", outcome: "success", iterations: 1, agent_id: "agent", duration_ms: 100 }] };
  writeFileSync(statePath, JSON.stringify(state));
  return { root, dbPath, statePath, taskId: "t", board: "b", tenantId: "a", state };
}
function hash(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

describe("graph explain read-only pilot", () => {
  it("joins facts against independent SQL/file baselines with explicit source boundaries", () => {
    const f = fixture(); const before = hash(f.dbPath); const stateBefore = hash(f.statePath);
    const result = explainGraph(f);
    const baseline = new Database(f.dbPath, { readonly: true });
    expect(result.task).toEqual(baseline.prepare("SELECT task_id,status,updated_at FROM tasks WHERE task_id='t' AND tenant_id='a'").get());
    expect(result.runs.items).toEqual(baseline.prepare("SELECT run_id,task_id,phase,outcome,started_at,completed_at FROM runs WHERE task_id='t' AND tenant_id='a' ORDER BY started_at DESC,run_id LIMIT 100").all());
    baseline.close();
    expect(result.cards.items).toEqual([{ card_id: "c", task_id: "t", status: "blocked", blocked_reason: "waiting on review", updated_at: 2 }]);
    expect(result.relations.items).toHaveLength(2);
    expect(result.relations.items[0]).toMatchObject({ parent_id: "c", child_id: "n", child_status: "todo" });
    expect(result.loop.matches.items[0]).toMatchObject({ location: "completed_tasks", task_id: "t", outcome: "success", run_id: "r", run_match: "scoped_run" });
    expect(result.loop.binding).toBe("caller_supplied_unverified");
    expect(result.loop.sha256).toBe(stateBefore);
    expect(result.coverage.loop_task_found).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|other-board|null-tenant/);
    expect(hash(f.dbPath)).toBe(before); expect(hash(f.statePath)).toBe(stateBefore);
  });
  it("retains disagreement without deriving a blocker from links", () => {
    const f = fixture();
    writeFileSync(f.statePath, JSON.stringify({ ...f.state, in_progress: [{ task_id: "t", capability: "code", prompt: "private prompt", source: "manual" }] }));
    const result = explainGraph(f);
    expect(result.task.status).toBe("done");
    expect(result.loop.matches.items.map((m) => m.location)).toEqual(["completed_tasks", "in_progress"]);
    expect(result.notices).toContain("multiple_loop_records");
    expect(JSON.stringify(result)).not.toContain("private prompt");
    expect(result.relations.items[0]?.child_status).toBe("todo");
  });
  it("does not fall back to other tenants including NULL", () => {
    const f = fixture();
    expect(() => explainGraph({ ...f, tenantId: null })).toThrow(/task.*scope/i);
    expect(() => explainGraph({ ...f, tenantId: "other" })).toThrow(/task.*scope/i);
    const db = new Database(f.dbPath); db.prepare("UPDATE tasks SET tenant_id=NULL").run(); db.close();
    expect(explainGraph({ ...f, tenantId: null }).cards.items.map((c) => c.card_id)).toEqual(["null-tenant"]);
  });
  it("reports absent Loop evidence rather than no impact", () => {
    const f = fixture(); writeFileSync(f.statePath, JSON.stringify({ ...f.state, completed_tasks: [] }));
    expect(explainGraph(f).coverage.loop_task_found).toBe(false);
    expect(explainGraph(f).notices).toContain("loop_task_not_found");
  });
  it("retains pending/deferred authority and does not authenticate unmatched runs", () => {
    const f = fixture();
    const task = { task_id: "t", capability: "code", prompt: "do not expose", source: "manual" };
    writeFileSync(f.statePath, JSON.stringify({ ...f.state,
      completed_tasks: [{ ...f.state.completed_tasks[0], run_id: "unmatched" }],
      pending: [task], deferred_tasks: [{ task, authorization: "needs_approval", reason: "owner review" }],
    }));
    expect(explainGraph(f).loop.matches.items).toMatchObject([
      { location: "completed_tasks", run_match: "not_in_returned_runs" },
      { location: "pending" }, { location: "deferred_tasks", authorization: "needs_approval", reason: "owner review" },
    ]);
    expect(() => explainGraph({ ...f, taskId: "t' OR 1=1 --" })).toThrow(/scope/);
  });
  it("honors the control-plane reservation through a file symlink", () => {
    const f = fixture(); const alias = join(f.root, "alias.db"); symlinkSync(f.dbPath, alias);
    expect(explainGraph({ ...f, dbPath: alias }).sources.database.path).toBe(realpathSync(f.dbPath));
    writeFileSync(join(f.root, "control-plane-reserved.json"), "{}");
    const before = hash(f.dbPath);
    expect(() => explainGraph({ ...f, dbPath: alias })).toThrow(/RESERVED/);
    expect(hash(f.dbPath)).toBe(before);
  });
  it("rejects a database below a reserved home and checks invalid state before opening DB", () => {
    const f = fixture(); const nested = join(f.root, "backups"); mkdirSync(nested);
    const copy = join(nested, "copy.db"); copyFileSync(f.dbPath, copy);
    writeFileSync(join(f.root, "control-plane-reserved.json"), "{}");
    const names = readdirSync(nested);
    expect(() => explainGraph({ ...f, dbPath: copy })).toThrow(/RESERVED/);
    expect(readdirSync(nested)).toEqual(names);
    rmSync(join(f.root, "control-plane-reserved.json"));
    // If opened first, this corrupt database would produce a SQLite error.
    writeFileSync(copy, "not a SQLite database"); writeFileSync(f.statePath, "{}");
    expect(() => explainGraph({ ...f, dbPath: copy })).toThrow(/Invalid Loop state/);
    expect(readdirSync(nested)).toEqual(names);
  });
  it("reads committed WAL facts while another connection is open without rewriting them", () => {
    const f = fixture(); const writer = new Database(f.dbPath);
    try {
      writer.prepare("UPDATE tasks SET status='running' WHERE task_id='t'").run();
      const before = hash(f.dbPath); const walBefore = hash(`${f.dbPath}-wal`);
      const version = writer.pragma("user_version", { simple: true });
      expect(explainGraph(f).task.status).toBe("running");
      expect(hash(f.dbPath)).toBe(before); expect(hash(`${f.dbPath}-wal`)).toBe(walBefore);
      expect(writer.pragma("user_version", { simple: true })).toBe(version);
    } finally { writer.close(); }
  });
  it("fails safely for missing DB, unsupported schema, invalid and oversized state", () => {
    const f = fixture(); const absent = join(f.root, "absent.db");
    expect(() => explainGraph({ ...f, dbPath: absent })).toThrow(); expect(existsSync(absent)).toBe(false);
    const before = hash(f.dbPath);
    writeFileSync(f.statePath, "{}"); expect(() => explainGraph(f)).toThrow(/Loop state/);
    writeFileSync(f.statePath, " ".repeat(4 * 1024 * 1024 + 1)); expect(() => explainGraph(f)).toThrow(/4 MiB/);
    expect(hash(f.dbPath)).toBe(before);
    writeFileSync(f.statePath, JSON.stringify(f.state));
    const empty = join(f.root, "empty.db"); new Database(empty).close(); const emptyHash = hash(empty);
    expect(() => explainGraph({ ...f, dbPath: empty })).toThrow(); expect(hash(empty)).toBe(emptyHash);
  });
  it("marks every truncated collection without claiming complete impact", () => {
    const f = fixture(); const db = new Database(f.dbPath);
    const insert = db.prepare("INSERT INTO kanban_cards (card_id,task_id,title,status,board,tenant_id,created_at,updated_at) VALUES (?,'t','x','todo','b','a',1,2)");
    const run = db.prepare("INSERT INTO runs (run_id,task_id,session_id,agent_id,capability_id,phase,started_at,tenant_id) VALUES (?,'t','s','a','c','execute',1,'a')");
    for (let i = 0; i < 101; i++) { insert.run(`x${i}`); run.run(`rx${i}`); db.prepare("INSERT INTO kanban_card_links VALUES ('c',?)").run(`x${i}`); }
    db.close(); writeFileSync(f.statePath, JSON.stringify({ ...f.state, completed_tasks: Array(101).fill(f.state.completed_tasks[0]), in_progress: [{ task_id: "t", capability: "code", prompt: "x", source: "manual" }] }));
    const result = explainGraph(f);
    for (const collection of [result.cards, result.runs, result.relations, result.loop.matches]) { expect(collection.items).toHaveLength(100); expect(collection.truncated).toBe(true); }
    expect(result.coverage.truncated).toBe(true);
    expect(result.loop.locations).toContainEqual({ location: "in_progress", total: 1, returned: 0, truncated: true });
  });
  it("does not mark exactly 100 Loop records as truncated", () => {
    const f = fixture();
    writeFileSync(f.statePath, JSON.stringify({ ...f.state, completed_tasks: Array(100).fill(f.state.completed_tasks[0]) }));
    const first = explainGraph(f); const second = explainGraph(f);
    expect(first.loop.matches.items).toHaveLength(100); expect(first.loop.matches.truncated).toBe(false);
    expect(first.loop).toEqual(second.loop); expect(first.relations).toEqual(second.relations);
  });
  it("rejects malformed CLI flags and renders both output formats", async () => {
    const f = fixture(); const deps = { stdout: vi.fn(), stderr: vi.fn() };
    const args = ["explain", "--task", "t", "--db", f.dbPath, "--state", f.statePath, "--board", "b", "--tenant", "a"];
    for (const bad of [[], ["explain"], [...args, "--default-tenant"], [...args, "--db", f.dbPath], [...args, "--unknown"]]) expect(await handleGraphCommand(bad, deps)).toBe(1);
    expect(await handleGraphCommand([...args, "--json"], deps)).toBe(0);
    expect(JSON.parse(deps.stdout.mock.calls.at(-1)?.[0] as string).schema_version).toBe(1);
    expect(await handleGraphCommand(args, deps)).toBe(0);
    expect(deps.stdout.mock.calls.at(-1)?.[0]).toContain("waiting on review");
    expect(await handleGraphCommand(["--help"], deps)).toBe(0);
  });
});
