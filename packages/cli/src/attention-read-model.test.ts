import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb, AttentionStore, EngineeringStore, reserveSessionInstruction } from "@osstack/core";
import { afterEach, expect, it } from "vitest";
import { readAttentionStatus } from "./attention-read-model.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "attention-")));
  roots.push(root);
  const dbPath = join(root, "state.db");
  const db = openDb({ path: dbPath });
  db.exec(`INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','private title','running',1,1);
    INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1);`);
  const insert =
    db.prepare(`INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at)
    VALUES(?,'t','r','codex-cli',?,?,'awaiting_decision',1,1,1)`);
  insert.run("s", "a".repeat(64), root);
  db.prepare(
    `INSERT INTO session_turns(turn_id,session_id,ordinal,state,assistant_text,decision_json,created_at,updated_at)
    VALUES('turn','s',1,'awaiting_decision','private transcript',?,1,1)`
  ).run(
    JSON.stringify({
      decision_id: "d",
      question: "Choose?",
      choices: [{ choice_id: "a", label: "A" }],
    })
  );
  db.close();
  return {
    root,
    dbPath,
    repoPath: root,
    taskId: "t",
    defaultTenant: true as const,
  };
}
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

it("reads schema 49 with its additive engineering ledger without migrating or inventing live coverage", () => {
  const f = fixture();
  const db = new Database(f.dbPath, { readonly: true, fileMustExist: true });
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(49);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('engineering_missions','attention_dispatch_phases','engineering_completions') ORDER BY name").all()).toEqual([
      { name: "attention_dispatch_phases" },
      { name: "engineering_completions" },
      { name: "engineering_missions" },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'source_observation_%' ORDER BY name").all()).toEqual([
      { name: "source_observation_clock" },
      { name: "source_observation_events" },
      { name: "source_observation_generations" },
      { name: "source_observation_streams" },
    ]);
  } finally {
    db.close();
  }
  const before = hash(f.dbPath);
  const result = readAttentionStatus(f);
  expect(result.mode).toBe("snapshot_only");
  expect(result.coverage.state).toBe("not_monitored");
  expect(result.sessions[0]).toMatchObject({
    session_id: "s",
    state: "awaiting_decision",
    process_liveness: "unknown",
    decision: { decision_id: "d" },
  });
  expect(result.runs[0]?.repo_binding).toBe("unverified");
  expect(JSON.stringify(result)).not.toMatch(
    /private transcript|private title/
  );
  expect(hash(f.dbPath)).toBe(before);
});
it("rejects cross tenant task and excludes cross tenant runs and missing repo bindings", () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  db.prepare("UPDATE agent_sessions SET repo_path=''").run();
  expect(readAttentionStatus(f).completeness.omitted_binding_unknown).toBe(1);
  db.prepare("UPDATE runs SET tenant_id='other'").run();
  expect(readAttentionStatus(f).sessions).toHaveLength(0);
  expect(readAttentionStatus(f).runs).toHaveLength(0);
  db.prepare("UPDATE tasks SET tenant_id='other'").run();
  db.close();
  expect(() => readAttentionStatus(f)).toThrow(/scope/);
});
it("reports malformed decisions and accepted receipts without guessing delivery", () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  db.prepare("UPDATE session_turns SET decision_json='{}'").run();
  db.exec(`INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at)
    VALUES('m','s','turn','inbound','instruction.send','{}','accepted',1)`);
  db.close();
  const result = readAttentionStatus(f);
  expect(result.sessions[0]?.wait.reason).toBe(
    "accepted_in_flight_or_uncertain"
  );
  expect(result.limitations).toContain("invalid_decision:s");
});
it.each([23, 50, 999])("rejects unsupported schema %i without opening a write path", (schema) => {
  const f = fixture();
  const db = new Database(f.dbPath);
  db.pragma(`user_version=${schema}`);
  db.close();
  const before = hash(f.dbPath);
  expect(() => readAttentionStatus(f)).toThrow(/unsupported_schema/);
  expect(hash(f.dbPath)).toBe(before);
});
it("uses keyset pages and reports truncation after 100 records", () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  for (let i = 0; i < 105; i++)
    db.prepare(
      `INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at)
    VALUES(?,'t','s','codex-cli','code','execute',1)`
    ).run(`z${String(i).padStart(3, "0")}`);
  db.close();
  const first = readAttentionStatus(f);
  expect(first.runs).toHaveLength(100);
  expect(first.completeness.truncated).toBe(true);
  const next = readAttentionStatus({
    ...f,
    afterRun: first.completeness.next_after.run!,
  });
  expect(next.runs).toHaveLength(6);
  expect(new Set([...first.runs, ...next.runs].map((r) => r.run_id)).size).toBe(
    106
  );
});

it("follows composite pages without replaying an exhausted collection", () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  for (let i = 0; i < 105; i++)
    db.prepare(
      `INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at)
    VALUES(?,'t','r','codex-cli',?,?,'idle',1,1,1)`
    ).run(`z${i.toString().padStart(3, "0")}`, "b".repeat(64), f.root);
  db.close();
  const first = readAttentionStatus(f);
  const next = readAttentionStatus({
    ...f,
    cursor: first.completeness.next_cursor!,
  });
  expect(next.runs).toEqual([]);
  expect(next.sessions).toHaveLength(6);
  expect(next.completeness.next_cursor).toBeNull();
  expect(() => readAttentionStatus({ ...f, cursor: "invalid" })).toThrow(
    "invalid_cursor"
  );
});
it("skips corrupt session facts while retaining valid inventory", () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  db.exec(
    "PRAGMA ignore_check_constraints=ON; UPDATE agent_sessions SET version=0"
  );
  db.close();
  expect(readAttentionStatus(f).limitations).toContain("corrupt_session:s");
});

it("retains read-only support for schema 46 without engineering tables", () => {
  const f = fixture();
  const db = new Database(f.dbPath);
  db.exec(`DROP TABLE engineering_completions;
    DROP TABLE attention_dispatch_phases;
    DROP TABLE engineering_interactions;
    DROP TABLE engineering_requests;
    DROP TABLE engineering_events;
    DROP TABLE engineering_waits;
    DROP TABLE engineering_missions;
    PRAGMA user_version=46;`);
  db.close();
  const before = hash(f.dbPath);
  expect(readAttentionStatus(f).sessions[0]?.state).toBe("awaiting_decision");
  expect(hash(f.dbPath)).toBe(before);
});

function cancelledFixture() {
  const f = fixture();
  const db = openDb({ path: f.dbPath }); db.pragma("synchronous=FULL");
  db.exec("UPDATE agent_sessions SET native_session_id='native' WHERE session_id='s'");
  const attention = new AttentionStore(db, f.dbPath); const owner = attention.claimOwner("read-model-test");
  const scope = attention.registerScope(owner, "t", f.root);
  const principal = { principal_id: "owner", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const store = new EngineeringStore(attention, owner);
  const mission = store.adopt(principal, { scope_id: scope.scope_id, task_id: "t", run_id: "r", session_id: "s", goal: "Observe this reply", request_id: "adopt", completion_level: "observed_turn" }, 1000).mission;
  const view = store.observe(principal, { mission_id: mission.mission_id }, 1001); const wait = view.waits[0]!;
  const answer = store.decide(principal, { mission_id: mission.mission_id, wait_id: wait.wait_id, if_revision: view.mission.revision, decision_ref: wait.decision_ref, action_id: "read-model-answer", answer: { kind: "choice", choice_id: "a" }, interaction_token: wait.interaction_token! }, 1002);
  store.cancel(principal, { mission_id: mission.mission_id, if_revision: answer.mission.revision, request_id: "cancel" }, 1003);
  db.close(); return { ...f, messageId: answer.message_id };
}
it("P2-4 reads a proved cancelled-before-dispatch receipt without inventing pending delivery", () => {
  const f = cancelledFixture(); const before = hash(f.dbPath);
  const result = readAttentionStatus(f);
  expect(result.sessions[0]?.wait).toEqual({ reason: "cancelled_before_dispatch", owner: "human", message_id: f.messageId, grant_id: null });
  expect(result.sessions[0]?.process_liveness).toBe("unknown");
  expect(hash(f.dbPath)).toBe(before);
});
it("P2-4 refuses a cancelled phase label when its persisted proof is inconsistent", () => {
  const f = cancelledFixture(); const db = new Database(f.dbPath);
  db.exec("UPDATE engineering_events SET payload_json='{}' WHERE kind='stop_requested'"); db.close();
  expect(readAttentionStatus(f).sessions[0]?.wait).toMatchObject({ reason: "dispatch_inconsistent", owner: "unknown", message_id: f.messageId });
});
it("P2-4 lets a new pending message take precedence over an old cancelled receipt", () => {
  const f = cancelledFixture(); const db = openDb({ path: f.dbPath });
  reserveSessionInstruction(db, f.dbPath, { message_id: "new-pending", session_id: "s", turn_id: "turn", direction: "inbound", kind: "instruction.send", payload: { text: "Inspect current state" }, state: "accepted", created_at: 1004 }, 2, 1004); db.close();
  expect(readAttentionStatus(f).sessions[0]?.wait).toMatchObject({ reason: "accepted_in_flight_or_uncertain", message_id: "new-pending" });
});
