import { realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionActions, reserveSessionInstruction } from "./attention-actions.js";
import { SessionRepository } from "./sessions.js";
import { EngineeringStore, type EngineeringPrincipal } from "./engineering-store.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).forEach(fn => { fn(); }); });
function setup() {
  const root = realpathSync(createScratchDirSync("tests", "engineering"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at,outcome,completed_at) VALUES('r','t','s','codex-cli','code','execute',1,'completed',1)");
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES('s','t','r','codex-cli',?,?,'awaiting_decision',1,1,1,'native')").run("a".repeat(64), root);
  const decision = { decision_id: "d", question: "Keep compatibility?", choices: [{ choice_id: "keep", label: "Keep" }] };
  db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)").run(JSON.stringify(decision));
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const store = new EngineeringStore(attention, owner);
  const request = { scope_id: scope.scope_id, task_id: "t", run_id: "r", session_id: "s", goal: "Observe the reply", request_id: "adopt", completion_level: "observed_turn" as const };
  const adopted = store.adopt(principal, request, 1000);
  const view = store.observe(principal, { mission_id: adopted.mission.mission_id }, 1001);
  const wait = view.waits[0]!;
  const answer = { mission_id: adopted.mission.mission_id, wait_id: wait.wait_id, if_revision: view.mission.revision, decision_ref: wait.decision_ref, action_id: "answer", answer: { kind: "choice" as const, choice_id: "keep" }, interaction_token: wait.interaction_token! };
  return { db, path, root, attention, owner, principal, store, request, adopted, view, wait, answer };
}
it("retains the exact decision and never completes from the earlier Run terminal", () => {
  const f = setup();
  expect(f.view.mission.state).toBe("awaiting_decision"); expect(f.view.waits).toHaveLength(1);
  expect(f.store.observe(f.principal, { mission_id: f.view.mission.mission_id }, 1002).mission.revision).toBe(1);
  expect(f.store.adopt(f.principal, f.request, 1003).replay).toBe(true);
});
it("reserves atomically, replays after token expiry, and commits first dispatch only once", () => {
  const f = setup(); const received = f.store.decide(f.principal, f.answer, 1002);
  expect(received.state).toBe("reserved");
  expect(f.store.decide(f.principal, f.answer, 1_000_000).message_id).toBe(received.message_id);
  expect(f.store.getDispatch(received.message_id)?.phase).toBe("reserved");
  const dispatch = f.store.commitDispatch(received.action_id, f.principal, 1003);
  expect(dispatch.text).toBe("Keep"); f.store.consumeDispatchPermit(dispatch.permit, received.message_id);
  expect(() => f.store.consumeDispatchPermit(dispatch.permit, received.message_id)).toThrow("dispatch_gate_required");
  expect(() => f.store.commitDispatch(received.action_id, f.principal, 1004)).toThrow("dispatch_already_committed");
  expect(f.db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 1 });
});
it("cancel before dispatch persists proof, releases only the proven reservation, and never sends", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  const stop = f.store.cancel(f.principal, { mission_id: a.mission.mission_id, if_revision: a.mission.revision, request_id: "stop" }, 1003);
  expect(stop.mission.state).toBe("cancel_requested");
  expect(f.store.getDispatch(a.message_id)?.phase).toBe("cancelled_before_dispatch");
  expect(() => f.store.commitDispatch(a.action_id, f.principal, 1004)).toThrow();
  expect(f.store.decide(f.principal, f.answer, 1005).state).toBe("cancelled_before_dispatch");
  expect(reserveSessionInstruction(f.db, f.path, { message_id: "new-manual", session_id: "s", turn_id: "turn", direction: "inbound", kind: "instruction.send", payload: { text: "Inspect" }, state: "accepted", created_at: 2 }, 2, 2).session_version).toBe(3);
});
it("write revocation blocks dispatch while an independently authorized operator can stop", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  expect(() => f.store.commitDispatch(a.action_id, { ...f.principal, write_scopes: [] }, 1003)).toThrow("permission_denied");
  const operator = { ...f.principal, principal_id: "operator", write_scopes: [], operator_scopes: f.principal.read_scopes };
  expect(f.store.cancel(operator, { mission_id: a.mission.mission_id, if_revision: a.mission.revision, request_id: "operator-stop" }, 1004).mission.state).toBe("cancel_requested");
});
it("requires the actual FULL connection and rejects stale actor, source and item binding", () => {
  const f = setup();
  expect(() => f.store.decide({ ...f.principal, principal_id: "another" }, f.answer, 1002)).toThrow("permission_denied");
  expect(() => f.store.decide(f.principal, { ...f.answer, decision_ref: { ...f.answer.decision_ref, item_revision: 9 } }, 1002)).toThrow("stale_decision");
  f.db.pragma("synchronous=NORMAL"); expect(() => f.store.decide(f.principal, f.answer, 1002)).toThrow("durability_required");
  f.db.pragma("synchronous=FULL"); f.db.exec("UPDATE agent_sessions SET native_session_id='replaced'");
  expect(() => f.store.decide(f.principal, f.answer, 1002)).toThrow("source_changed");
});
it("rejects abandon on a reserved first dispatch without mutating it", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  const actions = new AttentionActions(f.attention, f.owner);
  actions.recover(); expect(f.store.getDispatch(a.message_id)?.phase).toBe("reserved");
  expect(() => actions.abandon({ scope_id: f.request.scope_id, session_id: "s", message_id: a.message_id, expected_version: 2, reason: "Unknown", evidence_sha256: "b".repeat(64) })).toThrow("not_dispatched_use_cancel");
  expect(f.db.prepare("SELECT COUNT(*) n FROM attention_receipt_resolutions").get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT state FROM attention_actions").get()).toEqual({ state: "reserved" });
});
it("records exact completed turn evidence in the original transaction, without resuming twice", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  f.store.commitDispatch(a.action_id, f.principal, 1003);
  expect(() => f.store.recordCompletion(a.message_id, "done", 3, 1004)).toThrow("completion_transaction_required");
  f.db.transaction(() => {
    new SessionRepository(f.db, f.path).completeInboundTurn({ message_id: a.message_id, expected_version: 2, applied_at: 2, turn: { turn_id: "done", session_id: "s", ordinal: 2, state: "completed", assistant_text: "Kept", decision: null, created_at: 2, updated_at: 2 } });
    f.store.recordCompletion(a.message_id, "done", 3, 1004);
  })();
  const result = f.store.observe(f.principal, { mission_id: a.mission.mission_id }, 1005);
  expect(result.mission.state).toBe("completed"); expect(result.observation_proof).toMatchObject({ action_id: a.action_id, message_id: a.message_id, completed_turn_id: "done", session_version: 3 });
  expect(result.waits[0]?.state).toBe("cleared");
});
it("recovers only the original reserved first dispatch under the new daemon owner", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  const owner = f.attention.claimOwner("new-daemon"); const restarted = new EngineeringStore(f.attention, owner);
  expect(restarted.listReserved()).toEqual([expect.objectContaining({ action_id: a.action_id, message_id: a.message_id })]);
  expect(() => f.store.commitDispatch(a.action_id, f.principal, 1003)).toThrow("stale_owner");
  expect(restarted.commitDispatch(a.action_id, f.principal, 1004).message_id).toBe(a.message_id);
  const nextOwner = f.attention.claimOwner("third-daemon"); const third = new EngineeringStore(f.attention, nextOwner);
  expect(third.listReserved()).toEqual([]);
  expect(() => third.commitDispatch(a.action_id, f.principal, 1005)).toThrow("dispatch_already_committed");
  expect(f.db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 1 });
});
it("endObservation after commitment keeps the unknown original receipt guarded", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  f.store.commitDispatch(a.action_id, f.principal, 1003);
  const end = f.store.endObservation({ ...f.principal, write_scopes: [], stop_scopes: [] }, { mission_id: a.mission.mission_id, if_revision: a.mission.revision, request_id: "end" }, 1004);
  expect(end.mission.state).toBe("observation_ended"); expect(f.store.getDispatch(a.message_id)?.phase).toBe("dispatch_committed");
  expect(f.store.reconcile(f.principal, { kind: "query_action", mission_id: a.mission.mission_id, action_id: a.action_id }, 1005)).toMatchObject({ state: "uncertain" });
  expect(() => reserveSessionInstruction(f.db, f.path, { message_id: "replacement", session_id: "s", turn_id: "turn", direction: "inbound", kind: "instruction.send", payload: { text: "Again" }, state: "accepted", created_at: 2 }, 2, 2)).toThrow("delivery_uncertain");
});
it("an existing resolution stops first dispatch and is never repaired back to reserved", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  f.db.prepare("INSERT INTO attention_receipt_resolutions VALUES(?,'s',2,'abandoned_unknown','operator',?,1003)").run(a.message_id, "b".repeat(64));
  expect(() => f.store.commitDispatch(a.action_id, f.principal, 1004)).toThrow("receipt_resolved");
  new AttentionActions(f.attention, f.owner).recover();
  expect(f.store.getDispatch(a.message_id)?.phase).toBe("reserved");
  expect(f.store.decide(f.principal, f.answer, 1005).state).toBe("abandoned_unknown");
});
it("rejects payload drift, inconsistent action state, and backward phase transitions", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  f.db.prepare("UPDATE session_messages SET payload_json='{" + '"text":"Changed"' + "}' WHERE message_id=?").run(a.message_id);
  expect(() => f.store.commitDispatch(a.action_id, f.principal, 1003)).toThrow("payload_changed");
  f.db.prepare("UPDATE session_messages SET payload_json=? WHERE message_id=?").run(JSON.stringify({ text: "Keep" }), a.message_id);
  f.db.exec("UPDATE attention_actions SET state='uncertain'");
  expect(() => f.store.commitDispatch(a.action_id, f.principal, 1004)).toThrow("needs_reconciliation");
  new AttentionActions(f.attention, f.owner).recover();
  expect(f.db.prepare("SELECT state FROM attention_actions").get()).toEqual({ state: "uncertain" });
  f.db.exec("UPDATE attention_actions SET state='reserved'");
  f.store.commitDispatch(a.action_id, f.principal, 1005);
  expect(() => f.db.exec("UPDATE attention_dispatch_phases SET phase='reserved',committed_by_generation=NULL")).toThrow("dispatch_phase_immutable");
});
it("rolls back answer reservation, phase, intent and source version together on persistence failure", () => {
  const f = setup();
  f.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON engineering_events WHEN NEW.kind='answer_recorded' BEGIN SELECT RAISE(ABORT,'disk_full_injected'); END");
  expect(() => f.store.decide(f.principal, f.answer, 1002)).toThrow("disk_full_injected");
  for (const table of ["session_messages", "attention_actions", "attention_dispatch_phases"]) expect(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
  expect(new SessionRepository(f.db, f.path).getSession("s")?.version).toBe(1);
  expect(f.store.getMission(f.adopted.mission.mission_id).revision).toBe(1);
});
it("rolls back the original completed turn when the engineering proof cannot persist", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  f.db.exec("CREATE TRIGGER injected_completion BEFORE INSERT ON engineering_completions BEGIN SELECT RAISE(ABORT,'proof_failed'); END");
  expect(() => f.db.transaction(() => {
    new SessionRepository(f.db, f.path).completeInboundTurn({ message_id: a.message_id, expected_version: 2, applied_at: 2, turn: { turn_id: "done", session_id: "s", ordinal: 2, state: "completed", assistant_text: "Kept", decision: null, created_at: 2, updated_at: 2 } });
    f.store.recordCompletion(a.message_id, "done", 3, 1004);
  })()).toThrow("proof_failed");
  expect(new SessionRepository(f.db, f.path).getSession("s")?.version).toBe(2);
  expect(new SessionRepository(f.db, f.path).getMessage(a.message_id)?.state).toBe("accepted");
  expect(f.db.prepare("SELECT turn_id FROM session_turns WHERE turn_id='done'").get()).toBeUndefined();
});
it("rejects forged cancellation proof and applied/cancelled contradictions", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002);
  f.store.cancel(f.principal, { mission_id: a.mission.mission_id, if_revision: a.mission.revision, request_id: "stop" }, 1003);
  f.db.exec("UPDATE engineering_events SET payload_json='{}' WHERE kind='stop_requested'");
  expect(f.store.decide(f.principal, f.answer, 1004).state).toBe("needs_reconciliation");
  expect(() => reserveSessionInstruction(f.db, f.path, { message_id: "replacement", session_id: "s", turn_id: "turn", direction: "inbound", kind: "instruction.send", payload: { text: "Again" }, state: "accepted", created_at: 2 }, 2, 2)).toThrow("dispatch_inconsistent");
  f.db.prepare("UPDATE session_messages SET state='applied' WHERE message_id=?").run(a.message_id);
  expect(() => reserveSessionInstruction(f.db, f.path, { message_id: "replacement2", session_id: "s", turn_id: "turn", direction: "inbound", kind: "instruction.send", payload: { text: "Again" }, state: "accepted", created_at: 2 }, 2, 2)).toThrow("dispatch_inconsistent");
});
it("upgrades canonical schema46 without changing existing receipts or granting legacy dispatch", () => {
  const root = realpathSync(createScratchDirSync("tests", "engineering-migration")); const path = join(root, "state.db");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const old = new Database(path);
  for (const migration of MIGRATIONS.filter(m => m.id <= 46)) { old.exec(migration.sql); old.pragma(`user_version=${migration.id}`); }
  old.exec("INSERT INTO attention_actions VALUES('legacy','scope','item','hash','message','uncertain',1,1)"); old.close();
  const upgraded = openDb({ path });
  try {
    expect(upgraded.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(upgraded.prepare("SELECT action_id,state FROM attention_actions").get()).toEqual({ action_id: "legacy", state: "uncertain" });
    expect(upgraded.prepare("SELECT COUNT(*) n FROM attention_dispatch_phases").get()).toEqual({ n: 0 });
  } finally { upgraded.close(); }
});
it("refuses an unknown experimental engineering table before migration", () => {
  const root = realpathSync(createScratchDirSync("tests", "engineering-lineage")); const path = join(root, "state.db");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const old = new Database(path);
  for (const migration of MIGRATIONS.filter(m => m.id <= 46)) { old.exec(migration.sql); old.pragma(`user_version=${migration.id}`); }
  old.exec("CREATE TABLE engineering_missions(secret TEXT); INSERT INTO engineering_missions VALUES('preserve')"); old.close();
  expect(() => openDb({ path })).toThrow("GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT");
  const check = new Database(path); try { expect(check.pragma("user_version", { simple: true })).toBe(46); expect(check.prepare("SELECT secret FROM engineering_missions").get()).toEqual({ secret: "preserve" }); } finally { check.close(); }
});
function finish(f: ReturnType<typeof setup>, store: EngineeringStore, messageId: string) {
  f.db.transaction(() => {
    new SessionRepository(f.db, f.path).completeInboundTurn({ message_id: messageId, expected_version: 2, applied_at: 2, turn: { turn_id: "done", session_id: "s", ordinal: 2, state: "completed", assistant_text: "Kept", decision: null, created_at: 2, updated_at: 2 } });
    store.recordCompletion(messageId, "done", 3, 9000);
  })();
}
function finishManualTurn(f: ReturnType<typeof setup>, state: "idle" | "completed" = "completed") {
  reserveSessionInstruction(f.db, f.path, {
    message_id: "manual-message", session_id: "s", turn_id: "done", direction: "inbound",
    kind: "instruction.send", payload: { text: "Inspect another change" }, state: "accepted", created_at: 9001,
  }, 3, 9001);
  new SessionRepository(f.db, f.path).completeInboundTurn({
    message_id: "manual-message", expected_version: 4, applied_at: 9002,
    turn: { turn_id: "manual-turn", session_id: "s", ordinal: 3, state, assistant_text: "A different result", decision: null, created_at: 9002, updated_at: 9002 },
  });
}
it.each(["idle", "completed"] as const)("keeps the original applied proof without claiming a later manual %s turn as Mission completion", state => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  finish(f, f.store, a.message_id);
  const evidence = f.db.prepare("SELECT * FROM engineering_completions").get();
  finishManualTurn(f, state);
  const view = f.store.observe(f.principal, { mission_id: a.mission.mission_id }, 9003);
  expect(view).toMatchObject({ mission: { state: "observing" }, turn_id: "manual-turn", source_version: 5, observation_proof: null });
  expect(view.waits).toEqual([expect.objectContaining({ state: "cleared", action_id: a.action_id })]);
  expect(f.db.prepare("SELECT * FROM engineering_completions").get()).toEqual(evidence);
  expect(view.events).toContainEqual(expect.objectContaining({ kind: "answer_applied", payload: expect.objectContaining({ action_id: a.action_id, message_id: a.message_id, completed_turn_id: "done", session_version: 3 }) }));
  expect(view.events.some(event => event.kind === "observation_completed")).toBe(false);
  const beforeReplay = f.db.prepare("SELECT total_changes() n").get();
  expect(f.store.reconcile(f.principal, { kind: "query_action", mission_id: a.mission.mission_id, action_id: a.action_id }, 9004)).toMatchObject({ state: "applied", message_id: a.message_id });
  expect(f.store.decide(f.principal, f.answer, 1_000_000)).toMatchObject({ state: "applied", replay: true, message_id: a.message_id });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(beforeReplay);
  const end = f.store.endObservation(f.principal, { mission_id: a.mission.mission_id, if_revision: view.mission.revision, request_id: "end-after-manual-turn" }, 1_000_001);
  expect(end).toMatchObject({ mission: { state: "observation_ended", observation_proof_json: null }, committed_message_ids: [] });
  expect(f.db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 2 });
  expect(f.db.prepare("SELECT * FROM engineering_completions").get()).toEqual(evidence);
});
it.each(["replacement", null])("keeps source identity mismatch absorbing after all original waits cleared: native ID %s", nativeId => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  finish(f, f.store, a.message_id); finishManualTurn(f);
  f.store.refresh(a.mission.mission_id, 9003);
  expect(f.store.getMission(a.mission.mission_id).state).toBe("observing");
  expect(f.db.prepare("SELECT state FROM engineering_waits").get()).toEqual({ state: "cleared" });
  const evidence = f.db.prepare("SELECT * FROM engineering_completions").get();
  f.db.prepare("UPDATE agent_sessions SET native_session_id=? WHERE session_id='s'").run(nativeId);
  expect(f.store.refresh(a.mission.mission_id, 9004)).toBe("identity_mismatch");
  const quarantined = f.store.getMission(a.mission.mission_id);
  expect(quarantined.state).toBe("needs_reconciliation");
  f.db.exec("UPDATE agent_sessions SET native_session_id='native' WHERE session_id='s'");
  const restarted = new EngineeringStore(f.attention, f.attention.claimOwner("after-identity-change"));
  const before = f.db.prepare("SELECT total_changes() n").get();
  for (const now of [9005, 9006, 9007]) expect(restarted.refresh(a.mission.mission_id, now)).toBe("identity_mismatch");
  expect(restarted.getMission(a.mission.mission_id)).toEqual(quarantined);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  expect(f.db.prepare("SELECT * FROM engineering_completions").get()).toEqual(evidence);
  expect(restarted.reconcile(f.principal, { kind: "query_action", mission_id: a.mission.mission_id, action_id: a.action_id }, 9008)).toMatchObject({ state: "applied", message_id: a.message_id });
  const end = restarted.endObservation(f.principal, { mission_id: a.mission.mission_id, if_revision: quarantined.revision, request_id: "end-after-identity-change" }, 9009);
  expect(end.mission.state).toBe("observation_ended");
});
it("persists a real completed turn during a repository outage and projects completion only after observation recovers", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  const moved = `${f.root}-temporarily-unavailable`;
  renameSync(f.root, moved);
  try {
    finish(f, f.store, a.message_id);
    const sessions = new SessionRepository(f.db, f.path);
    expect(sessions.getMessage(a.message_id)?.state).toBe("applied");
    expect(sessions.latestSnapshot("s")).toMatchObject({ turn_id: "done", version: 3, state: "completed", assistant_text: "Kept" });
    expect(f.db.prepare("SELECT state FROM attention_actions").get()).toEqual({ state: "applied" });
    expect(f.db.prepare("SELECT state FROM attention_items").get()).toEqual({ state: "answer_applied" });
    expect(f.db.prepare("SELECT message_id,completed_turn_id,session_version FROM engineering_completions").get()).toEqual({ message_id: a.message_id, completed_turn_id: "done", session_version: 3 });
    expect(f.store.getMission(a.mission.mission_id).state).toBe("answer_recorded");
    // The completion transaction does not attempt repository observation.
    expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_events WHERE kind='source_observation_error'").get()).toEqual({ n: 0 });
    expect(f.store.refresh(a.mission.mission_id, 9001)).toBe("unavailable");
    expect(f.store.getMission(a.mission.mission_id).state).toBe("answer_recorded");
    expect(f.db.prepare("SELECT state FROM engineering_waits").get()).toEqual({ state: "answer_recorded" });
  } finally { renameSync(moved, f.root); }
  expect(f.store.refresh(a.mission.mission_id, 9002)).toBe("available");
  expect(f.store.getMission(a.mission.mission_id).state).toBe("completed");
  expect(f.db.prepare("SELECT state FROM engineering_waits").get()).toEqual({ state: "cleared" });
});
it.each([
  "UPDATE agent_sessions SET native_session_id='changed'",
  "UPDATE runs SET agent_id='changed'",
  "UPDATE attention_scopes SET repo_path='/different-repository'",
])("rolls back completed turn evidence when its database identity changed: %s", mutation => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  f.db.exec(mutation);
  expect(() => finish(f, f.store, a.message_id)).toThrow("source_changed");
  const sessions = new SessionRepository(f.db, f.path);
  expect(sessions.getMessage(a.message_id)?.state).toBe("accepted");
  expect(sessions.latestSnapshot("s")).toMatchObject({ turn_id: "turn", version: 2 });
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_completions").get()).toEqual({ n: 0 });
  expect(f.db.prepare("SELECT COUNT(*) n FROM session_turns WHERE turn_id='done'").get()).toEqual({ n: 0 });
});
it("keeps trusted live dispatch in flight across watchdog ticks and updates both ledgers atomically on completion", () => {
  const f = setup(); let live: string | undefined;
  const store = new EngineeringStore(f.attention, f.owner, { liveSend: () => live });
  const a = store.decide(f.principal, f.answer, 1002); store.commitDispatch(a.action_id, f.principal, 1003); live = a.message_id;
  for (const now of [2000, 3000, 4000]) store.refresh(a.mission.mission_id, now);
  expect(store.getMission(a.mission.mission_id).state).toBe("answer_recorded");
  expect(f.db.prepare("SELECT state FROM attention_actions").get()).toEqual({ state: "reserved" });
  expect(f.db.prepare("SELECT state FROM attention_items").get()).toEqual({ state: "answer_reserved" });
  expect(store.reconcile(f.principal, { kind: "query_action", mission_id: a.mission.mission_id, action_id: a.action_id })).toMatchObject({ state: "in_flight" });
  finish(f, store, a.message_id); live = undefined;
  expect(f.db.prepare("SELECT state FROM attention_actions").get()).toEqual({ state: "applied" });
  expect(f.db.prepare("SELECT state FROM attention_items").get()).toEqual({ state: "answer_applied" });
  store.refresh(a.mission.mission_id, 9001);
  expect(store.getMission(a.mission.mission_id).state).toBe("completed");
});
it("drops live evidence on restart and keeps a committed missing receipt unknown without resend", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  const restarted = new EngineeringStore(f.attention, f.attention.claimOwner("new-owner"));
  restarted.refresh(a.mission.mission_id, 2000);
  expect(restarted.getMission(a.mission.mission_id).state).toBe("needs_reconciliation");
  expect(restarted.reconcile(f.principal, { kind: "query_action", mission_id: a.mission.mission_id, action_id: a.action_id })).toMatchObject({ state: "uncertain" });
  expect(restarted.listReserved()).toEqual([]); expect(f.db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 1 });
  const before = f.db.prepare("SELECT total_changes() n").get();
  for (const now of [3000, 4000, 5000]) restarted.refresh(a.mission.mission_id, now);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});
it.each([undefined, "another-message"])("recovers a delivery-unknown wait only when its original completion arrives (live marker: %s)", liveMarker => {
  const f = setup();
  const store = new EngineeringStore(f.attention, f.owner, { liveSend: () => liveMarker });
  const a = store.decide(f.principal, f.answer, 1002); store.commitDispatch(a.action_id, f.principal, 1003);
  store.refresh(a.mission.mission_id, 2000);
  expect(store.getMission(a.mission.mission_id).state).toBe("needs_reconciliation");
  expect(f.db.prepare("SELECT state FROM engineering_waits").get()).toEqual({ state: "delivery_unknown" });
  expect(f.db.prepare("SELECT state FROM attention_actions").get()).toEqual({ state: "uncertain" });
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_completions").get()).toEqual({ n: 0 });
  const beforeReplay = f.db.prepare("SELECT total_changes() n").get();
  expect(store.reconcile(f.principal, { kind: "query_action", mission_id: a.mission.mission_id, action_id: a.action_id }, 2001)).toMatchObject({ state: "uncertain", message_id: a.message_id });
  expect(store.decide(f.principal, f.answer, 2002)).toMatchObject({ state: "uncertain", message_id: a.message_id, replay: true });
  expect(() => store.commitDispatch(a.action_id, f.principal, 2003)).toThrow("dispatch_already_committed");
  expect(store.listReserved()).toEqual([]);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(beforeReplay);

  // This injects the original durable callback, not a retry or a new turn. It
  // tests recovery semantics; it does not explain a historical live-run fault.
  finish(f, store, a.message_id);
  const view = store.observe(f.principal, { mission_id: a.mission.mission_id }, 9001);
  expect(view).toMatchObject({ mission: { state: "completed" }, observation_proof: {
    action_id: a.action_id, message_id: a.message_id, completed_turn_id: "done", session_version: 3,
  } });
  expect(view.waits[0]?.state).toBe("cleared");
  expect(f.db.prepare("SELECT state FROM attention_actions").get()).toEqual({ state: "applied" });
  expect(f.db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_completions").get()).toEqual({ n: 1 });
  expect(view.events.filter(event => event.kind === "answer_applied")).toHaveLength(1);
});
it("preserves an identity fault when a late original applied receipt is durably recorded", () => {
  const f = setup(); let liveMessage: string | undefined;
  const store = new EngineeringStore(f.attention, f.owner, { liveSend: () => liveMessage });
  const a = store.decide(f.principal, f.answer, 1002); store.commitDispatch(a.action_id, f.principal, 1003); liveMessage = a.message_id;
  f.db.exec("UPDATE agent_sessions SET native_session_id='replacement' WHERE session_id='s'");
  expect(store.refresh(a.mission.mission_id, 2000)).toBe("identity_mismatch");
  f.db.exec("UPDATE agent_sessions SET native_session_id='native' WHERE session_id='s'");
  finish(f, store, a.message_id); liveMessage = undefined;
  const view = store.observe(f.principal, { mission_id: a.mission.mission_id }, 9001);
  expect(view).toMatchObject({ mission: { state: "needs_reconciliation" }, source_status: "identity_mismatch", observation_proof: null });
  expect(view.waits[0]?.state).toBe("needs_reconciliation");
  expect(store.reconcile(f.principal, { kind: "query_action", mission_id: a.mission.mission_id, action_id: a.action_id }, 9002)).toMatchObject({ state: "applied", message_id: a.message_id });
  expect(f.db.prepare("SELECT message_id,completed_turn_id FROM engineering_completions").get()).toEqual({ message_id: a.message_id, completed_turn_id: "done" });
  expect(store.listReserved()).toEqual([]);
  expect(f.db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 1 });
  expect(view.events.some(event => event.kind === "observation_completed")).toBe(false);
});
it("does not poison a reserved answer after a transient repository outage and records one reason", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); const moved = `${f.root}-temporarily-unavailable`;
  renameSync(f.root, moved);
  try {
    expect(f.store.refresh(a.mission.mission_id, 2000)).toBe("unavailable");
    expect(f.store.refresh(a.mission.mission_id, 3000)).toBe("unavailable");
    expect(f.store.getMission(a.mission.mission_id).state).toBe("answer_recorded");
    expect(f.db.prepare("SELECT state FROM engineering_waits").get()).toEqual({ state: "answer_recorded" });
    expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_events WHERE kind='source_observation_error'").get()).toEqual({ n: 1 });
    expect(JSON.parse((f.db.prepare("SELECT payload_json FROM engineering_events WHERE kind='source_observation_error'").get() as { payload_json: string }).payload_json)).toMatchObject({ reason: "repository_unavailable", category: "unavailable" });
  } finally { renameSync(moved, f.root); }
  expect(f.store.refresh(a.mission.mission_id, 4000)).toBe("available");
  expect(f.store.commitDispatch(a.action_id, f.principal, 4001).message_id).toBe(a.message_id);
});
it("keeps identity mismatch absorbing even if the original native ID later reappears", () => {
  const f = setup(); f.db.exec("UPDATE agent_sessions SET native_session_id='changed'");
  f.store.refresh(f.adopted.mission.mission_id, 2000); f.db.exec("UPDATE agent_sessions SET native_session_id='native'");
  f.store.refresh(f.adopted.mission.mission_id, 3000);
  expect(f.store.getMission(f.adopted.mission.mission_id).state).toBe("needs_reconciliation");
  expect(f.db.prepare("SELECT state FROM engineering_waits").get()).toEqual({ state: "needs_reconciliation" });
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_events WHERE kind='source_observation_error'").get()).toEqual({ n: 1 });
});
it("does not mutate the ledger when an unexpected source implementation error occurs", () => {
  const f = setup(); const before = f.db.prepare("SELECT total_changes() n").get();
  vi.spyOn(SessionRepository.prototype, "latestSnapshot").mockImplementation(() => { throw new TypeError("injected coding defect"); });
  expect(() => f.store.refresh(f.adopted.mission.mission_id, 2000)).toThrow("injected coding defect");
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  expect(f.db.prepare("SELECT state FROM engineering_waits").get()).toEqual({ state: "open" });
});
it("uses canonical parsed decisions for refresh and defer when strings need trimming", () => {
  const f = setup(); f.db.prepare("UPDATE session_turns SET decision_json=? WHERE turn_id='turn'").run(JSON.stringify({ decision_id: "d", question: "  Keep compatibility?  ", choices: [{ choice_id: "keep", label: " Keep " }] }));
  f.store.refresh(f.adopted.mission.mission_id, 2000);
  expect(f.store.getMission(f.adopted.mission.mission_id).state).toBe("awaiting_decision");
  expect(f.store.defer(f.principal, { mission_id: f.adopted.mission.mission_id, wait_id: f.wait.wait_id, if_revision: 1, wait_revision: 1, request_id: "defer-canonical", revisit_at: new Date(10_000).toISOString(), reason: "Later" }, 2001).mission.state).toBe("awaiting_decision");
});
it("does not write idle watchdog heartbeats before the bounded freshness interval", () => {
  const f = setup(); const before = f.db.prepare("SELECT total_changes() n").get();
  for (let now = 2000; now < 60_000; now += 1000) f.store.refresh(f.adopted.mission.mission_id, now);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  f.store.refresh(f.adopted.mission.mission_id, 61_000);
  expect(f.store.getMission(f.adopted.mission.mission_id).observed_at).toBe(61_000);
});
it("keeps completed Missions absorbing and committed/applied replay read-only", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  const pendingBefore = f.db.prepare("SELECT total_changes() n").get();
  expect(f.store.decide(f.principal, f.answer, 1_000_000).state).toBe("uncertain"); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(pendingBefore);
  finish(f, f.store, a.message_id); f.store.refresh(a.mission.mission_id, 9001); const done = f.store.getMission(a.mission.mission_id);
  const before = f.db.prepare("SELECT total_changes() n").get();
  expect(f.store.decide(f.principal, f.answer, 1_000_001).state).toBe("applied");
  for (const operation of ["cancel", "endObservation"] as const) expect(() => f.store[operation](f.principal, { mission_id: done.mission_id, if_revision: done.revision, request_id: operation }, 1_000_002)).toThrow("mission_terminal");
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before); expect(f.store.getMission(done.mission_id).state).toBe("completed");
});
it("bounds stop retries, preserves the first intent, and exposes only this Mission's unresolved committed message", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  let intent: string | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    const mission = f.store.getMission(a.mission.mission_id);
    const result = f.store.cancel(f.principal, { mission_id: mission.mission_id, if_revision: mission.revision, request_id: `stop-${attempt}` }, 2000 + attempt);
    intent ??= result.stop_intent_id; expect(result.stop_intent_id).toBe(intent); expect(result.committed_message_ids).toEqual([a.message_id]);
  }
  const current = f.store.getMission(a.mission.mission_id);
  expect(() => f.store.cancel(f.principal, { mission_id: current.mission_id, if_revision: current.revision, request_id: "stop-over-budget" }, 3000)).toThrow("stop_attempt_budget_exhausted");
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_requests WHERE operation='cancel'").get()).toEqual({ n: 8 });
});
it("allows ending observation then stopping only its unresolved commitment without replacing the first intent", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); f.store.commitDispatch(a.action_id, f.principal, 1003);
  const end = f.store.endObservation(f.principal, { mission_id: a.mission.mission_id, if_revision: a.mission.revision, request_id: "end" }, 2000);
  const stop = f.store.cancel(f.principal, { mission_id: end.mission.mission_id, if_revision: end.mission.revision, request_id: "later-stop" }, 2001);
  expect(stop.stop_intent_id).toBe(end.stop_intent_id); expect(stop.committed_message_ids).toEqual([a.message_id]);
});
it("preflights dispatch without writes and deduplicates bounded block reasons", () => {
  const f = setup(); const a = f.store.decide(f.principal, f.answer, 1002); const before = f.db.prepare("SELECT total_changes() n").get();
  expect(() => f.store.preflightDispatch(a.action_id, { ...f.principal, write_scopes: [] })).toThrow("permission_denied");
  expect(f.store.preflightDispatch(a.action_id, f.principal).message_id).toBe(a.message_id); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  for (let i = 0; i < 10; i++) f.store.recordDispatchBlocked(a.action_id, "permission_denied", 2000 + i);
  expect(f.db.prepare("SELECT COUNT(*) n FROM engineering_events WHERE kind='dispatch_blocked'").get()).toEqual({ n: 1 });
});
it("reopens schema47 read-only and read-write with every additive table recognized by lineage", () => {
  const root = realpathSync(createScratchDirSync("tests", "engineering-reopen")); const path = join(root, "state.db"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  openDb({ path }).close();
  const names = [...MIGRATIONS.find(m => m.id === 47)!.sql.matchAll(/^\s*CREATE\s+TABLE\s+(\w+)\s*\(/gm)].map(match => match[1]!);
  expect(names.sort()).toEqual(["attention_dispatch_phases", "engineering_completions", "engineering_events", "engineering_interactions", "engineering_missions", "engineering_requests", "engineering_waits"]);
  for (const readwrite of [false, true]) { const db = openDb({ path, readwrite }); try { expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION); for (const name of names) expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)).toEqual({ name }); } finally { db.close(); } }
});
it.each(["attention_dispatch_phases", "engineering_completions", "engineering_events", "engineering_interactions", "engineering_missions", "engineering_requests", "engineering_waits"])("recognizes %s as required released schema47 lineage, not an unregistered draft", table => {
  const root = realpathSync(createScratchDirSync("tests", "engineering-lineage-required")); const path = join(root, "state.db"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb({ path }); db.pragma("foreign_keys=OFF"); db.exec(`DROP TABLE ${table}`); db.close();
  expect(() => openDb({ path, readwrite: false })).toThrow("GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT");
});
