import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AttentionStore, ContainedMissionStore, EngineeringStore, SessionRepository, createScratchDir, openDb } from "@osstack/core";
import { afterEach, expect, it } from "vitest";
import { engineeringUpgradeHolds } from "./engineering-upgrade-guard.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });

async function fixture() {
  const root = realpathSync(await createScratchDir("tests", "engineering-upgrade"));
  const path = join(root, "state.db");
  const db = openDb({ path });
  db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at,outcome,completed_at) VALUES('r','t','s','codex-cli','code','execute',1,'completed',1)");
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES('s','t','r','codex-cli',?,?,'awaiting_decision',1,1,1,'native')").run("a".repeat(64), root);
  db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)").run(JSON.stringify({ decision_id: "d", question: "Keep?", choices: [{ choice_id: "keep", label: "Keep" }] }));
  const attention = new AttentionStore(db, path);
  const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const store = new EngineeringStore(attention, owner);
  const adopted = store.adopt(principal, { scope_id: scope.scope_id, task_id: "t", run_id: "r", session_id: "s", goal: "Observe", request_id: "adopt", completion_level: "observed_turn" }, 1000);
  const view = store.observe(principal, { mission_id: adopted.mission.mission_id }, 1001);
  const wait = view.waits[0]!;
  const receipt = store.decide(principal, { mission_id: view.mission.mission_id, wait_id: wait.wait_id, if_revision: view.mission.revision, decision_ref: wait.decision_ref, action_id: "answer", answer: { kind: "choice", choice_id: "keep" }, interaction_token: wait.interaction_token! }, 1002);
  return { db, path, principal, store, receipt };
}

it("holds a reserved and then committed reply until its completed turn is persisted", async () => {
  const f = await fixture();
  expect(engineeringUpgradeHolds(f.db)).toBe(1);
  f.store.commitDispatch(f.receipt.action_id, f.principal, 1003);
  expect(engineeringUpgradeHolds(f.db)).toBe(1);
  f.db.transaction(() => {
    new SessionRepository(f.db, f.path).completeInboundTurn({ message_id: f.receipt.message_id, expected_version: 2, applied_at: 2, turn: { turn_id: "done", session_id: "s", ordinal: 2, state: "completed", assistant_text: "Kept", decision: null, created_at: 2, updated_at: 2 } });
    f.store.recordCompletion(f.receipt.message_id, "done", 3, 1004);
  })();
  expect(engineeringUpgradeHolds(f.db)).toBe(0);
});

it("accepts genuine pre-dispatch cancellation and holds tampered proof", async () => {
  const f = await fixture();
  f.store.cancel(f.principal, { mission_id: f.receipt.mission.mission_id, if_revision: f.receipt.mission.revision, request_id: "stop" }, 1003);
  expect(engineeringUpgradeHolds(f.db)).toBe(0);
  f.db.exec("UPDATE engineering_events SET payload_json='{}' WHERE kind='stop_requested'");
  expect(engineeringUpgradeHolds(f.db)).toBe(1);
});

it.each([
  ["missing event", "DELETE FROM engineering_events WHERE kind='stop_requested'"],
  ["wrong intent", "UPDATE engineering_events SET payload_json=json_set(payload_json,'$.stop_intent_id','wrong') WHERE kind='stop_requested'"],
  ["wrong action state", "UPDATE attention_actions SET state='uncertain'"],
  ["applied contradiction", "UPDATE session_messages SET state='applied'"],
  ["manual receipt resolution", "INSERT INTO attention_receipt_resolutions SELECT message_id,'s',2,'abandoned_unknown','operator','evidence',1004 FROM attention_dispatch_phases"],
])("holds a cancelled phase with %s", async (_label, sql) => {
  const f = await fixture();
  f.store.cancel(f.principal, { mission_id: f.receipt.mission.mission_id, if_revision: f.receipt.mission.revision, request_id: "stop" }, 1003);
  expect(engineeringUpgradeHolds(f.db)).toBe(0);
  f.db.exec(sql);
  expect(engineeringUpgradeHolds(f.db)).toBe(1);
});

it("holds unknown phase labels, missing messages and incomplete cancellation proof", () => {
  const db = new Database(":memory:");
  cleanup.push(() => db.close());
  expect(engineeringUpgradeHolds(db)).toBe(0);
  db.exec("CREATE TABLE attention_dispatch_phases(message_id TEXT,phase TEXT); CREATE TABLE session_messages(message_id TEXT,state TEXT); INSERT INTO attention_dispatch_phases VALUES('missing','dispatch_committed'),('unknown','future_phase'),('cancelled','cancelled_before_dispatch'); INSERT INTO session_messages VALUES('unknown','applied'),('cancelled','accepted')");
  expect(engineeringUpgradeHolds(db)).toBe(3);
});

it("holds contained work until the Mission is terminal, stop is proven and the claim is released", async () => {
  const f = await fixture();
  f.store.commitDispatch(f.receipt.action_id, f.principal, 1003);
  const baseline = engineeringUpgradeHolds(f.db);
  const contained = new ContainedMissionStore(f.store.attention, f.store.owner);
  let m = contained.authorize(f.principal, { scope_id: f.store.getMission(f.receipt.mission.mission_id).scope_id, spec: { goal: "fix" }, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 2000);
  expect(engineeringUpgradeHolds(f.db)).toBe(baseline + 1);
  m = contained.transition(m.mission_id, { if_revision: m.revision, to: "awaiting_decision", event: { kind: "halt", payload: {} } }, 2001);
  m = contained.transition(m.mission_id, { if_revision: m.revision, to: "abandoned", event: { kind: "abandon", payload: {} } }, 2001);
  expect(engineeringUpgradeHolds(f.db)).toBe(baseline + 1);
  contained.releaseClaim(m.mission_id, "abandoned", 2002);
  expect(engineeringUpgradeHolds(f.db)).toBe(baseline);
});
