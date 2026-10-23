import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "@osstack/core";
import { afterEach, expect, it } from "vitest";
import { readAttentionStatus } from "./attention-read-model.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "attention-"))); roots.push(root);
  const dbPath = join(root, "state.db"); const db = openDb({ path: dbPath });
  db.exec(`INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','private title','running',1,1);
    INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1);`);
  const insert = db.prepare(`INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at)
    VALUES(?,'t','r','codex-cli',?,?,'awaiting_decision',1,1,1)`);
  insert.run("s", "a".repeat(64), root);
  db.prepare(`INSERT INTO session_turns(turn_id,session_id,ordinal,state,assistant_text,decision_json,created_at,updated_at)
    VALUES('turn','s',1,'awaiting_decision','private transcript',?,1,1)`).run(JSON.stringify({ decision_id: "d", question: "Choose?", choices: [{ choice_id: "a", label: "A" }] }));
  db.close(); return { root, dbPath, repoPath: root, taskId: "t", defaultTenant: true as const };
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

it("reads scoped durable facts without migrating or inventing live coverage", () => {
  const f = fixture(); const before = hash(f.dbPath); const result = readAttentionStatus(f);
  expect(result.mode).toBe("snapshot_only"); expect(result.coverage.state).toBe("not_monitored");
  expect(result.sessions[0]).toMatchObject({ session_id: "s", state: "awaiting_decision", process_liveness: "unknown", decision: { decision_id: "d" } });
  expect(result.runs[0]?.repo_binding).toBe("unverified");
  expect(JSON.stringify(result)).not.toMatch(/private transcript|private title/);
  expect(hash(f.dbPath)).toBe(before);
});
it("rejects cross tenant task and excludes cross tenant runs and missing repo bindings", () => {
  const f = fixture(); const db = new Database(f.dbPath);
  db.prepare("UPDATE agent_sessions SET repo_path=''").run();
  expect(readAttentionStatus(f).completeness.omitted_binding_unknown).toBe(1);
  db.prepare("UPDATE runs SET tenant_id='other'").run();
  expect(readAttentionStatus(f).sessions).toHaveLength(0);
  expect(readAttentionStatus(f).runs).toHaveLength(0);
  db.prepare("UPDATE tasks SET tenant_id='other'").run(); db.close();
  expect(() => readAttentionStatus(f)).toThrow(/scope/);
});
it("reports malformed decisions and accepted receipts without guessing delivery", () => {
  const f = fixture(); const db = new Database(f.dbPath);
  db.prepare("UPDATE session_turns SET decision_json='{}'").run();
  db.exec(`INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at)
    VALUES('m','s','turn','inbound','instruction.send','{}','accepted',1)`); db.close();
  const result = readAttentionStatus(f);
  expect(result.sessions[0]?.wait.reason).toBe("accepted_in_flight_or_uncertain");
  expect(result.limitations).toContain("invalid_decision:s");
});
it("rejects unsupported schema without opening a write path", () => {
  const f = fixture(); const db = new Database(f.dbPath); db.pragma("user_version=999"); db.close();
  const before = hash(f.dbPath); expect(() => readAttentionStatus(f)).toThrow(/unsupported_schema/); expect(hash(f.dbPath)).toBe(before);
});
it("uses keyset pages and reports truncation after 100 records", () => {
  const f = fixture(); const db = new Database(f.dbPath);
  for (let i = 0; i < 105; i++) db.prepare(`INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at)
    VALUES(?,'t','s','codex-cli','code','execute',1)`).run(`z${String(i).padStart(3, "0")}`);
  db.close(); const first = readAttentionStatus(f);
  expect(first.runs).toHaveLength(100); expect(first.completeness.truncated).toBe(true);
  const next = readAttentionStatus({ ...f, afterRun: first.completeness.next_after.run! });
  expect(next.runs).toHaveLength(6);
  expect(new Set([...first.runs, ...next.runs].map((r) => r.run_id)).size).toBe(106);
});
