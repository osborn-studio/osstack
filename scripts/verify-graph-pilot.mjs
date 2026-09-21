#!/usr/bin/env node
// Reproducible end-to-end fixture. Build @osstack/core and @osstack/cli first.
// Creates and removes only its own private temporary home; never uses live data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../packages/core/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "osstack-graph-e2e-"));
const dbPath = join(root, "state.db");
const statePath = join(root, "LOOP-STATE.json");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
let db;
try {
  db = openDb({ path: dbPath });
  db.prepare("INSERT INTO tasks (task_id,title,status,created_at,updated_at) VALUES ('example-task','Example','done',1,2)").run();
  db.prepare("INSERT INTO runs (run_id,task_id,session_id,agent_id,capability_id,phase,outcome,started_at) VALUES ('example-run','example-task','session','agent','code','execute','success',1)").run();
  db.prepare("INSERT INTO kanban_cards (card_id,task_id,title,status,blocked_reason,board,created_at,updated_at) VALUES ('review','example-task','Review','blocked','review pending','demo',1,2)").run();
  db.prepare("INSERT INTO kanban_cards (card_id,title,status,board,created_at,updated_at) VALUES ('next','Next','todo','demo',1,2)").run();
  db.prepare("INSERT INTO kanban_card_links VALUES ('review','next')").run();
  const loop = { loop_id: "example-loop", started_at: "2026-09-11T00:00:00Z", updated_at: "2026-09-11T00:01:00Z", in_progress: [{ task_id: "example-task", capability: "code", prompt: "fixture only", source: "manual" }] };
  writeFileSync(statePath, JSON.stringify(loop));
  const baseline = {
    task: db.prepare("SELECT task_id,status,updated_at FROM tasks WHERE task_id='example-task' AND tenant_id IS NULL").get(),
    runs: db.prepare("SELECT run_id,task_id,phase,outcome,started_at,completed_at FROM runs WHERE task_id='example-task' AND tenant_id IS NULL ORDER BY started_at DESC,run_id").all(),
    cards: db.prepare("SELECT card_id,task_id,status,blocked_reason,updated_at FROM kanban_cards WHERE task_id='example-task' AND board='demo' AND tenant_id IS NULL ORDER BY card_id").all(),
  };
  db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); db = undefined;
  const before = { db: hash(dbPath), state: hash(statePath) };
  const started = performance.now();
  const processResult = spawnSync(process.execPath, [fileURLToPath(new URL("../packages/cli/dist/bin.js", import.meta.url)), "graph", "explain", "--task", "example-task", "--db", dbPath, "--state", statePath, "--board", "demo", "--default-tenant", "--json"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, OSSTACK_HOME: root } });
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(processResult.status, 0, processResult.stderr || String(processResult.error));
  const result = JSON.parse(processResult.stdout);
  assert.deepEqual(result.task, baseline.task);
  assert.deepEqual(result.runs.items, baseline.runs);
  assert.deepEqual(result.cards.items, baseline.cards);
  assert.deepEqual(result.loop.matches.items, [{ location: "in_progress", index: 0, task_id: "example-task" }]);
  assert.equal(result.loop.binding, "caller_supplied_unverified");
  assert.equal(result.relations.items[0].child_status, "todo");
  assert.equal(result.coverage.truncated, false);
  assert.equal(hash(dbPath), before.db); assert.equal(hash(statePath), before.state);
  // Replace ephemeral paths only in the published example, after assertions.
  result.sources.database.path = "<private-fixture>/state.db";
  result.sources.loop.path = "<private-fixture>/LOOP-STATE.json";
  console.log(JSON.stringify({ verification: "passed", baseline: "independent SQL + Loop JSON", elapsed_ms_single_run: elapsedMs, source_bytes_unchanged: true, example: result }, null, 2));
} finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
