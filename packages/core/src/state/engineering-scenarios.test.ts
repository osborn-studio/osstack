import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { reserveSessionInstruction } from "./attention-actions.js";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { SessionRepository } from "./sessions.js";
import { EngineeringStore, type EngineeringPrincipal } from "./engineering-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => { fn(); }));
function setup(fromSchema46 = false) {
  const root = realpathSync(createScratchDirSync("tests", "engineering-scenarios"));
  const path = join(root, "state.db");
  if (fromSchema46) {
    const previous = new Database(path);
    for (const migration of MIGRATIONS.filter((item) => item.id <= 46)) { previous.exec(migration.sql); previous.pragma(`user_version=${migration.id}`); }
    previous.close();
  }
  const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const decision = { decision_id: "decision", question: "Keep compatibility?", choices: [{ choice_id: "keep", label: "Keep" }, { choice_id: "remove", label: "Remove" }] };
  function addSession(sessionId: string, runId: string, turnId: string) {
    db.prepare("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at,outcome,completed_at) VALUES(?,'t',?,'codex-cli','code','execute',1,'completed',1)").run(runId, sessionId);
    db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES(?,'t',?,'codex-cli',?,?,'awaiting_decision',1,1,1,?)").run(sessionId, runId, "a".repeat(64), root, `native-${sessionId}`);
    db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES(?,?,1,'awaiting_decision',?,1,1)").run(turnId, sessionId, JSON.stringify(decision));
  }
  addSession("session", "run", "turn");
  const attention = new AttentionStore(db, path);
  const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const store = new EngineeringStore(attention, owner);
  const request = { scope_id: scope.scope_id, task_id: "t", run_id: "run", session_id: "session", goal: "Observe the reply", request_id: "adopt", completion_level: "observed_turn" as const };
  const mission = store.adopt(principal, request, 1000).mission;
  const view = store.observe(principal, { mission_id: mission.mission_id }, 1001);
  const wait = view.waits[0]!;
  const answer = { mission_id: mission.mission_id, wait_id: wait.wait_id, if_revision: view.mission.revision, decision_ref: wait.decision_ref, action_id: "answer", answer: { kind: "choice" as const, choice_id: "keep" }, interaction_token: wait.interaction_token! };
  const messageCount = () => (db.prepare("SELECT COUNT(*) n FROM session_messages").get() as { n: number }).n;
  const observe = (now = 1002) => store.observe(principal, { mission_id: mission.mission_id }, now);
  const manualAdvance = () => {
    db.exec("UPDATE agent_sessions SET state='idle',version=version+1 WHERE session_id='session'");
    db.exec("INSERT INTO session_turns(turn_id,session_id,ordinal,state,assistant_text,created_at,updated_at) VALUES('manual-turn','session',2,'idle','Handled outside Mission',2,2)");
  };
  const disposition = (snapshot = observe()) => ({ kind: "dispose_wait" as const, mission_id: mission.mission_id, wait_id: wait.wait_id, if_revision: snapshot.mission.revision, wait_revision: snapshot.waits[0]!.revision, request_id: "dispose", observed_source_version: snapshot.source_version!, observed_turn_id: snapshot.turn_id!, observed_snapshot_digest: snapshot.snapshot_digest!, disposition: "human_answered_out_of_band" as const, reason: "Handled in the original Session." });
  return { db, path, root, attention, owner, principal, store, request, mission, view, wait, answer, decision, addSession, messageCount, observe, manualAdvance, disposition };
}

it("WD-01 preserves a buried question after unrelated progress", () => {
  const f = setup();
  f.db.exec("INSERT INTO events(event_id,run_id,session_id,seq,type,created_at,payload_json) VALUES('progress','run','session',1,'assistant.message',2,'{\"text\":\"Other work progressed\"}')");
  const view = f.observe();
  expect(view.waits[0]).toMatchObject({ wait_id: f.wait.wait_id, state: "open", decision: f.decision });
  expect(view.mission.state).toBe("awaiting_decision"); expect(f.messageCount()).toBe(0);
});
it("WD-02 ignores an unrelated done event and keeps the blocked decision", () => {
  const f = setup(); f.addSession("other", "other-run", "other-turn");
  f.db.exec("INSERT INTO events(event_id,run_id,session_id,seq,type,created_at,terminal,payload_json) VALUES('done','other-run','other',1,'run.completed',2,1,'{\"text\":\"done\"}')");
  expect(f.observe().waits[0]?.state).toBe("open"); expect(f.observe().observation_proof).toBeNull();
});
it("WD-03 reconstructs open waits even when the incremental event page is empty", () => {
  const f = setup();
  const view = f.store.observe(f.principal, { mission_id: f.mission.mission_id, cursor: f.view.cursor }, 1002);
  expect(view.events).toEqual([]); expect(view.waits).toHaveLength(1); expect(view.waits[0]?.wait_id).toBe(f.wait.wait_id);
});
it("WD-04 keeps the obligation after the source Session disappears", () => {
  const f = setup(); f.db.exec("DELETE FROM agent_sessions WHERE session_id='session'");
  const view = f.observe();
  expect(view.mission.state).toBe("awaiting_decision"); expect(view.waits).toHaveLength(1);
  expect(view.source_status).toBe("unavailable"); expect(view.waits[0]?.state).toBe("open");
  expect(view.observation_proof).toBeNull(); expect(f.messageCount()).toBe(0);
  expect(view.events).toContainEqual(expect.objectContaining({ kind: "source_observation_error", payload: expect.objectContaining({ reason: "source_unavailable" }) }));
});
it("WD-07 refuses an altered content digest without reserving a message", () => {
  const f = setup();
  expect(() => f.store.decide(f.principal, { ...f.answer, decision_ref: { ...f.answer.decision_ref, content_hash: "b".repeat(64) } }, 1002)).toThrow("stale_decision");
  expect(f.messageCount()).toBe(0);
});
it("WD-08 refuses a cross-repository source without relocating the Mission", () => {
  const f = setup(); const other = join(f.root, "other-repository"); mkdirSync(other);
  f.db.prepare("UPDATE agent_sessions SET repo_path=? WHERE session_id='session'").run(other);
  expect(() => f.store.decide(f.principal, f.answer, 1002)).toThrow("source_changed");
  expect(f.store.getMission(f.mission.mission_id).repo_path).toBe(f.root); expect(f.messageCount()).toBe(0);
});
it("WD-09 requires a named explicit choice when two questions are open", () => {
  const f = setup(); f.addSession("other", "other-run", "other-turn");
  const second = f.store.adopt(f.principal, { ...f.request, run_id: "other-run", session_id: "other", request_id: "adopt-other" }, 1002);
  expect(() => f.store.decide(f.principal, { ...f.answer, answer: { kind: "text", text: "continue" } }, 1003)).toThrow("explicit_choice_required");
  expect(f.messageCount()).toBe(0); expect(f.observe().waits[0]?.state).toBe("open");
  expect(f.store.observe(f.principal, { mission_id: second.mission.mission_id }, 1004).waits[0]?.state).toBe("open");
});
it("WD-14 rejects changed payload under the same action key", () => {
  const f = setup(); const receipt = f.store.decide(f.principal, f.answer, 1002);
  expect(() => f.store.decide(f.principal, { ...f.answer, answer: { kind: "choice", choice_id: "remove" } }, 1003)).toThrow("action_conflict");
  expect(f.messageCount()).toBe(1); expect(f.store.getDispatch(receipt.message_id)?.phase).toBe("reserved");
});
it("WD-15 gives only one reservation to two UI windows answering the same revision", () => {
  const f = setup(); const secondWindow = f.observe(1002);
  f.store.decide(f.principal, f.answer, 1003);
  expect(() => f.store.decide(f.principal, { ...f.answer, action_id: "other-window", interaction_token: secondWindow.waits[0]!.interaction_token! }, 1004)).toThrow("version_conflict");
  expect(f.messageCount()).toBe(1);
});
it("WD-20 clears only the answered Mission and leaves the other obligation open", () => {
  const f = setup(); f.addSession("other", "other-run", "other-turn");
  const second = f.store.adopt(f.principal, { ...f.request, run_id: "other-run", session_id: "other", request_id: "adopt-other" }, 1002);
  const receipt = f.store.decide(f.principal, f.answer, 1003); f.store.commitDispatch(receipt.action_id, f.principal, 1004);
  f.db.transaction(() => {
    new SessionRepository(f.db, f.path).completeInboundTurn({ message_id: receipt.message_id, expected_version: 2, applied_at: 1005, turn: { turn_id: "reply", session_id: "session", ordinal: 2, state: "completed", assistant_text: "Kept", decision: null, created_at: 1005, updated_at: 1005 } });
    f.store.recordCompletion(receipt.message_id, "reply", 3, 1005);
  })();
  expect(f.observe(1006).waits[0]?.state).toBe("cleared");
  const other = f.store.observe(f.principal, { mission_id: second.mission.mission_id }, 1006);
  expect(other.waits[0]?.state).toBe("open"); expect(other.mission.state).toBe("awaiting_decision");
});
it("WD-21 rejects the old daemon generation before creating a new effect", () => {
  const f = setup(); const receipt = f.store.decide(f.principal, f.answer, 1002);
  f.attention.claimOwner("replacement-owner");
  expect(() => f.store.commitDispatch(receipt.action_id, f.principal, 1003)).toThrow("stale_owner");
  expect(f.store.getDispatch(receipt.message_id)?.phase).toBe("reserved"); expect(f.messageCount()).toBe(1);
});
it("WD-23 and WD-24 defer without approval and bound unchanged rechecks to one reminder", () => {
  const f = setup();
  f.store.defer(f.principal, { mission_id: f.mission.mission_id, wait_id: f.wait.wait_id, if_revision: 1, wait_revision: 1, request_id: "defer", revisit_at: new Date(2000).toISOString(), reason: "Need input" }, 1002);
  const revision = f.store.getMission(f.mission.mission_id).revision;
  for (let i = 0; i < 100; i += 1) f.store.refresh(f.mission.mission_id, 2001 + i);
  const view = f.observe(2102);
  expect(view.waits[0]).toMatchObject({ state: "deferred", action_id: null, reminder_sent: 1 });
  expect(view.mission.revision).toBe(revision); expect(f.messageCount()).toBe(0);
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_events WHERE kind='decision_reminder_due'").get()).toEqual({ n: 1 });
});
it("WD-29 rejects backwards time and does not extend a replayed token's lifetime", () => {
  const f = setup();
  expect(() => f.store.decide(f.principal, f.answer, 1000)).toThrow("interaction_expired"); expect(f.messageCount()).toBe(0);
  f.store.decide(f.principal, f.answer, 1002);
  const before = f.db.prepare("SELECT issued_at,expires_at FROM engineering_interactions").all();
  expect(f.store.decide(f.principal, f.answer, 1_000_000).replay).toBe(true);
  expect(f.db.prepare("SELECT issued_at,expires_at FROM engineering_interactions").all()).toEqual(before); expect(f.messageCount()).toBe(1);
});
it("WD-39 rejects rewritten content under an immutable decision identity", () => {
  const f = setup();
  expect(() => f.attention.projectDecision(f.owner, { scopeId: f.request.scope_id, sessionId: "session", turnId: "turn", sourceVersion: 1, decision: { ...f.decision, question: "Changed question" }, now: 1002 })).toThrow("decision_content_conflict");
  expect(f.observe().waits[0]?.decision.question).toBe(f.decision.question); expect(f.messageCount()).toBe(0);
});
it("WD-42 keeps direct source advancement in reconciliation until explicit disposition", () => {
  const f = setup(); f.manualAdvance(); const view = f.observe();
  expect(view.waits[0]?.state).toBe("needs_reconciliation"); expect(view.mission.state).toBe("needs_reconciliation");
  expect(view.observation_proof).toBeNull(); expect(f.messageCount()).toBe(0);
});
it("WD-48 binds token and replay to the authenticated principal and client", () => {
  const f = setup();
  expect(() => f.store.decide({ ...f.principal, client_session_id: "other-ui" }, f.answer, 1002)).toThrow("interaction_mismatch");
  f.store.decide(f.principal, f.answer, 1002);
  expect(() => f.store.decide({ ...f.principal, principal_id: "other-person" }, f.answer, 1003)).toThrow("permission_denied");
  expect(() => f.store.decide(f.principal, { ...f.answer, interaction_token: "x".repeat(32) }, 1003)).toThrow("action_conflict"); expect(f.messageCount()).toBe(1);
});
it.each(["replacement-native", null])("WD-55 preserves source identity when native ID becomes %s", (native) => {
  const f = setup(); const source = f.mission.source_instance_id;
  f.db.prepare("UPDATE agent_sessions SET native_session_id=? WHERE session_id='session'").run(native);
  expect(() => f.store.decide(f.principal, f.answer, 1002)).toThrow("source_changed");
  const view = f.observe(); expect(view.mission.source_instance_id).toBe(source); expect(view.mission.state).toBe("needs_reconciliation"); expect(f.messageCount()).toBe(0);
});
it("WD-56 disposes an exact unanswered observation without fabricating applied evidence", () => {
  const f = setup(); f.manualAdvance(); const input = f.disposition();
  expect(f.store.reconcile(f.principal, input, 1003).mission.state).toBe("observing");
  const view = f.observe(1004); expect(view.waits[0]?.state).toBe("superseded"); expect(view.mission.state).toBe("observing");
  expect(view.observation_proof).toBeNull(); expect(f.messageCount()).toBe(0);
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_completions").get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_events WHERE kind='steering_recorded'").get()).toEqual({ n: 1 });
});
it("WD-57 refuses disposal of unknown delivery but permits receipt query and cancellation", () => {
  const f = setup(); const received = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(received.action_id, f.principal, 1003);
  f.db.prepare("UPDATE session_messages SET state='failed' WHERE message_id=?").run(received.message_id);
  const view = f.observe(1004);
  expect(() => f.store.reconcile(f.principal, f.disposition(view), 1005)).toThrow("receipt_requires_reconciliation");
  expect(f.store.reconcile(f.principal, { kind: "query_action", mission_id: f.mission.mission_id, action_id: "answer" }, 1005)).toMatchObject({ message_id: received.message_id, state: "uncertain" });
  expect(f.store.cancel(f.principal, { mission_id: f.mission.mission_id, if_revision: view.mission.revision, request_id: "stop" }, 1006).mission.state).toBe("cancel_requested");
  expect(f.store.getDispatch(received.message_id)?.phase).toBe("dispatch_committed"); expect(f.messageCount()).toBe(1);
});
it("WD-62 preserves cancelled original receipt and rejects replacement answers", () => {
  const f = setup(); const received = f.store.decide(f.principal, f.answer, 1002);
  f.store.cancel(f.principal, { mission_id: f.mission.mission_id, if_revision: received.mission.revision, request_id: "stop" }, 1003);
  expect(f.store.decide(f.principal, f.answer, 1004).state).toBe("cancelled_before_dispatch");
  expect(() => f.store.decide(f.principal, { ...f.answer, answer: { kind: "choice", choice_id: "remove" } }, 1004)).toThrow("action_conflict");
  expect(() => f.store.decide(f.principal, { ...f.answer, action_id: "replacement", if_revision: 3 }, 1004)).toThrow("mission_terminal"); expect(f.messageCount()).toBe(1);
});
it("WD-66 limits observation steering to its owner with current read and write", () => {
  const f = setup(); f.manualAdvance(); const input = f.disposition();
  expect(() => f.store.reconcile({ ...f.principal, principal_id: "other-writer" }, input, 1003)).toThrow("permission_denied");
  expect(() => f.store.reconcile({ ...f.principal, write_scopes: [] }, input, 1003)).toThrow("permission_denied");
  expect(f.observe().waits[0]?.state).toBe("needs_reconciliation"); expect(f.messageCount()).toBe(0);
});
it("P2 requires scope read plus independent stop, while write revocation does not prevent stop", () => {
  const f = setup();
  expect(() => f.store.cancel({ ...f.principal, read_scopes: [] }, { mission_id: f.mission.mission_id, if_revision: 1, request_id: "read-denied" }, 1002)).toThrow("permission_denied");
  expect(() => f.store.cancel({ ...f.principal, stop_scopes: [] }, { mission_id: f.mission.mission_id, if_revision: 1, request_id: "stop-denied" }, 1002)).toThrow("permission_denied");
  expect(f.store.cancel({ ...f.principal, write_scopes: [] }, { mission_id: f.mission.mission_id, if_revision: 1, request_id: "write-revoked-stop" }, 1002).mission.state).toBe("cancel_requested");
});

it("WD-11 refuses ordinary answers for risk and task authorization gates", () => {
  const f = setup();
  for (const gate of ["risk_approval", "task_authorization"] as const) {
    const session = `session-${gate}`; const run = `run-${gate}`; const turn = `turn-${gate}`;
    f.addSession(session, run, turn);
    f.db.prepare("UPDATE session_turns SET decision_json=? WHERE turn_id=?").run(JSON.stringify({ ...f.decision, choices: [], continuation: { version: 1, gate_kind: gate, phase: "deploy", next_action: "Deploy", evidence_refs: [] } }), turn);
    expect(() => f.store.adopt(f.principal, { ...f.request, run_id: run, session_id: session, request_id: `adopt-${gate}` }, 1002)).toThrow("signed_approval_required");
  }
  expect(f.messageCount()).toBe(0);
});
it("WD-35 observes legacy approved contracts without manufacturing initial dispatch", () => {
  const f = setup();
  f.db.exec("INSERT INTO contract_approvals(approval_id,contract_id,action,risk,status,requested_at,decided_by_type,decided_by_id,decided_at,created_at,updated_at) VALUES('old-approval','old-contract','start','low','approved',1,'human','human',1,1,1)");
  for (let i = 0; i < 20; i += 1) f.store.refresh(f.mission.mission_id, 1002 + i);
  expect(f.store.listReserved()).toEqual([]); expect(f.messageCount()).toBe(0);
  expect(f.db.prepare("SELECT COUNT(*) n FROM runs").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT COUNT(*) n FROM attention_actions").get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT status FROM contract_approvals WHERE approval_id='old-approval'").get()).toEqual({ status: "approved" });
});
it("WD-47 reports unmetered provider cost as unknown without asserting a hard cap", () => {
  const f = setup(); const view = f.observe();
  expect(view.cost_evidence).toEqual({ status: "unknown", hard_cap_enforced: false, reason: "provider_usage_not_metered_by_adoption_pilot" });
  expect(view.cost_evidence).not.toHaveProperty("cost", 0); expect(view.cost_evidence).not.toHaveProperty("tokens", 0);
});

it("WD-38 reads committed and applied replays without changing any ledger rows", () => {
  const f = setup(); const receipt = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(receipt.action_id, f.principal, 1003);
  const rows = () => Object.fromEntries(["attention_actions", "attention_items", "engineering_events", "engineering_interactions", "engineering_requests", "engineering_missions", "session_messages"].map((table) => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]));
  for (const state of ["accepted", "applied"]) {
    f.db.prepare("UPDATE session_messages SET state=? WHERE message_id=?").run(state, receipt.message_id);
    const before = rows();
    expect(f.store.decide(f.principal, f.answer, 1_000_000).replay).toBe(true);
    expect(rows()).toEqual(before);
  }
});
it("WD-40 keeps source identity separate from daemon replacement and queries the original action", () => {
  const f = setup(); const receipt = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(receipt.action_id, f.principal, 1003);
  const replacement = f.attention.claimOwner("replacement-daemon");
  const restarted = new EngineeringStore(f.attention, replacement);
  expect(replacement.generation).toBeGreaterThan(f.owner.generation);
  expect(restarted.getMission(f.mission.mission_id)).toMatchObject({ source_instance_id: f.mission.source_instance_id, source_generation: 1 });
  expect(restarted.reconcile(f.principal, { kind: "query_action", mission_id: f.mission.mission_id, action_id: receipt.action_id }, 1004)).toMatchObject({ message_id: receipt.message_id, state: "uncertain" });
  expect(restarted.listReserved()).toEqual([]); expect(f.messageCount()).toBe(1);
});
it("WD-53 upgrades schema46 then releases only a proven uncommitted cancellation", () => {
  const f = setup(true);
  expect(f.db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  const receipt = f.store.decide(f.principal, f.answer, 1002);
  f.store.cancel(f.principal, { mission_id: f.mission.mission_id, if_revision: receipt.mission.revision, request_id: "stop" }, 1003);
  const sql = (f.db.prepare("SELECT sql FROM sqlite_master WHERE name='attention_receipt_resolutions'").get() as { sql: string }).sql;
  expect(sql).toContain("CHECK(disposition='abandoned_unknown')");
  expect(f.store.getDispatch(receipt.message_id)?.phase).toBe("cancelled_before_dispatch");
  expect(f.db.prepare("SELECT COUNT(*) n FROM attention_receipt_resolutions").get()).toEqual({ n: 0 });
  expect(reserveSessionInstruction(f.db, f.path, { message_id: "manual-after-cancel", session_id: "session", turn_id: "turn", direction: "inbound", kind: "instruction.send", payload: { text: "Inspect current state" }, state: "accepted", created_at: 1004 }, 2, 1004).session_version).toBe(3);
});
