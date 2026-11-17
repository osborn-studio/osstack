import { createHash } from "node:crypto";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AttentionActions, AttentionStore, ContainedMissionStore, RevisionChainStore, createAutonomyRun, transitionAutonomyRun, appendEvent, DecisionQueries, createScratchDirSync, openDb } from "@osstack/core";
import { listDecisions } from "./list.js";
import { answerDecision } from "./answer.js";
import { ContainedMissionService } from "../contained-mission-rpc.js";
import type { ContainedMissionHost } from "../contained-mission-host.js";
import { EngineeringAccess } from "../engineering-access.js";
import { resolveHermesDecision } from "./hermes-resolve.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => { fn(); }));
function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "decisions-answer"));
  const path = join(root, "db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)");
  const store = new AttentionStore(db, path); const owner = store.claimOwner("owner");
  const scope = store.registerScope(owner, "t", root).scope_id;
  const principal = { principal_id: "human", client_session_id: "desktop", read_scopes: [scope], write_scopes: [scope], stop_scopes: [scope], operator_scopes: [scope] };
  const authority = join(root, "authority.json");
  const writeAuthority = () => writeFileSync(authority, JSON.stringify({ version: 1, principals: [{ ...principal, credential_sha256: createHash("sha256").update("c".repeat(32)).digest("hex") }] }), { mode: 0o600 });
  writeAuthority(); const access = new EngineeringAccess(authority);
  const authenticate = vi.fn((credential: unknown) => access.authenticate(credential));
  const queries = new DecisionQueries(db);
  const actions = new AttentionActions(store, owner);
  let executions = 0;
  const resolveHermes = vi.fn((method: "approval.resolve" | "clarify.resolve", params: Record<string, unknown>) => resolveHermesDecision(db, method, params));
  const forward = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "attention.answer") {
      const input = params as unknown as Parameters<AttentionActions["reserve"]>[0];
      const prior = actions.replay(input); if (prior) return prior;
      const result = actions.reserve(input); executions++;
      db.prepare("UPDATE session_messages SET state='applied' WHERE message_id=?").run(result.message_id);
      return actions.reconcile(result);
    }
    throw Error("unexpected_forward");
  });
  const list = () => listDecisions(queries, { credential: "c".repeat(32) }, authenticate);
  const answer = (input: unknown) => answerDecision({ db, queries, authenticate, forward, resolveHermes }, input);
  const pending = async (source: string) => (await list()).items.find(i => i.source === source)!;
  const request = async (source: string) => { const item = await pending(source); return { credential: "c".repeat(32), source: item.source, source_id: item.source_id, source_revision: item.source_revision!, answer_id: "key:1", answer: item.allowed_answers[0]!, params: {} }; };
  const session = (gate?: string, choices: Array<{ choice_id: string; label: string }> = []) => {
    const decision = { decision_id: "d", question: "Choose?", choices, ...(gate ? { continuation: { version: 1, gate_kind: gate, phase: "build", next_action: "build", evidence_refs: [] } } : {}) };
    db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES('s','t','r','codex-cli',?,?,'awaiting_decision',1,1,1,'native')").run("a".repeat(64), root);
    db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)").run(JSON.stringify(decision));
    store.projectDecision(owner, { scopeId: scope, sessionId: "s", turnId: "turn", sourceVersion: 1, decision, now: 1 });
  };
  const hermes = (kind: "approval" | "clarify") => appendEvent(db, path, { event_id: "request", run_id: "r", session_id: "s", seq: 0, type: `${kind}.requested`, created_at: 1, terminal: false,
    payload: kind === "approval" ? { approval_id: "a", action_summary: "Approve?", risk: "low" } : { clarify_id: "a", question: "Which?" } });
  return { db, path, root, store, owner, scope, principal, writeAuthority, access, authenticate, forward, resolveHermes, hermes, executions: () => executions, answer, pending, request, list, session };
}
for (const kind of ["approval", "clarify", "session"] as const) {
  it(`${kind}: list → answer → list; lost response replays without a second effect and changed content conflicts`, async () => {
    const f = fixture();
    if (kind === "session") f.session();
    else if (kind === "approval") f.hermes("approval");
    else f.hermes("clarify");
    const req = { ...await f.request(kind === "session" ? "session" : "hermes"), params: kind === "approval" ? { choice: "yes" } : { text: "answer" } };
    const first = await f.answer(req); expect(first.accepted).toBe(true);
    const writes = f.db.prepare("SELECT total_changes() n").get();
    expect(await f.answer(req)).toMatchObject({ accepted: true, replay: true });
    expect(await f.answer({ ...req, params: kind === "approval" ? { choice: "no" } : { text: "changed" } })).toMatchObject({ accepted: false, outcome: "conflict" });
    expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(writes);
    expect((await f.list()).items).toEqual([]);
    if (kind === "session") { expect(f.db.prepare("SELECT COUNT(*) n FROM session_messages").get()).toEqual({ n: 1 }); expect(f.executions()).toBe(1); }
    else { expect(f.db.prepare("SELECT COUNT(*) n FROM events WHERE json_extract(payload_json,'$.decisions_answer') IS NOT NULL").get()).toEqual({ n: 1 }); expect(f.resolveHermes).toHaveBeenCalledTimes(1); }
  });
  it(`${kind}: rejects stale revisions and invalid credentials with zero writes`, async () => {
    const f = fixture();
    if (kind === "session") f.session();
    else if (kind === "approval") f.hermes("approval");
    else f.hermes("clarify");
    const req = { ...await f.request(kind === "session" ? "session" : "hermes"), params: kind === "approval" ? { choice: "yes" } : { text: "answer" } };
    const before = f.db.prepare("SELECT total_changes() n").get();
    expect(await f.answer({ ...req, source_revision: "0" })).toMatchObject({ accepted: false, outcome: "stale" });
    expect(await f.answer({ ...req, credential: "x".repeat(32) })).toMatchObject({ accepted: false, code: "permission_denied" });
    expect(await f.answer({ ...req, credential: undefined })).toMatchObject({ accepted: false });
    expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  });
}
it.each(["risk_approval", "task_authorization"])("%s stays local with zero writes", async gate => {
  const f = fixture(); f.session(gate); const item = await f.pending("session");
  const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer({ credential: "c".repeat(32), source: "session", source_id: item.source_id, source_revision: item.source_revision, answer_id: "local:1", answer: "yes" })).toMatchObject({ outcome: "local_only", local_command: "attention answer" });
  expect(f.forward).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});
it("Mission requires write permission before forwarding, including replay", async () => {
  const f = fixture(); const missions = new ContainedMissionStore(f.store, f.owner);
  const m = missions.authorize(f.principal, { scope_id: f.scope, spec: { goal: "test" }, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1000);
  missions.transition(m.mission_id, { if_revision: m.revision, to: "awaiting_decision", event: { kind: "halted", payload: {} } }, 2000);
  const req = await f.request("contained_mission"); f.principal.write_scopes = []; f.writeAuthority();
  const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ code: "permission_denied", accepted: false });
  expect(f.forward).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});

it("rejects a Hermes approval whose risk changed after list, without any answer write", async () => {
  const f = fixture();
  f.hermes("approval");
  const req = { ...await f.request("hermes"), params: { choice: "yes" } };
  f.db.exec("UPDATE approvals SET risk='high'");
  const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ outcome: "stale", accepted: false });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});

it("Mission: delegates keyed admission, replays once, conflicts and rejects stale requests before execution", async () => {
  const f = fixture(); const store = new ContainedMissionStore(f.store, f.owner);
  const m = store.authorize(f.principal, { scope_id: f.scope, spec: { goal: "test" }, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1000);
  store.transition(m.mission_id, { if_revision: m.revision, to: "awaiting_decision", event: { kind: "halted", payload: {} } }, 2000);
  let executions = 0;
  const host = { store, isBusy: () => false, runner: { decisionAllowed: () => true, isVerifyResume: () => false,
    decideImmediate: (mission: typeof m) => { executions++; return store.transition(mission.mission_id, { if_revision: mission.revision, to: "abandoned", event: { kind: "decision_abandon", payload: {} } }, 3000); } } } as unknown as ContainedMissionHost;
  const service = new ContainedMissionService({ host, access: f.access, draining: () => false });
  f.forward.mockImplementation((method, params) => service.handle(method, params));
  const req = await f.request("contained_mission");
  const before = store.events(m.mission_id);
  expect(await f.answer({ ...req, source_revision: "1" })).toMatchObject({ outcome: "stale", code: "stale_revision" });
  expect(store.events(m.mission_id)).toEqual(before); expect(executions).toBe(0);
  expect(await f.answer(req)).toMatchObject({ accepted: true, replay: false, current: { state: "abandoned", item: null } });
  expect(await f.answer(req)).toMatchObject({ accepted: true, replay: true });
  expect(await f.answer({ ...req, answer: "extra_repair" })).toMatchObject({ outcome: "conflict", code: "decision_id_conflict" });
  expect(executions).toBe(1); expect((await f.list()).items).toEqual([]);
  f.principal.write_scopes = []; f.writeAuthority(); const written = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ outcome: "refused", code: "permission_denied" });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(written);
});
it("autonomy and loop stay local and never call an execution port", async () => {
  const f = fixture();
  createAutonomyRun(f.db, f.path, { autonomy_run_id: "auto", transition_id: "auto:1", task_id: "t", repo_id: "r", workspace_path: f.root, contract_sha256: "a".repeat(64), budget: {}, attempt: {}, event: {}, occurred_at: 1 });
  transitionAutonomyRun(f.db, f.path, { autonomy_run_id: "auto", transition_id: "auto:2", expected_revision: 1, to_state: "awaiting_approval", event: {}, occurred_at: 4 });
  f.db.exec(`INSERT INTO events(event_id,run_id,session_id,seq,type,created_at,payload_json) VALUES('loop','r','s',1,'loop.escalated',7000,'{"task_id":"t"}')`);
  const before = f.db.prepare("SELECT total_changes() n").get();
  for (const source of ["autonomy", "loop"]) expect(await f.answer(await f.request(source))).toMatchObject({ accepted: false, outcome: "local_only", local_command: source === "autonomy" ? "autonomy approve" : "cockpit retry" });
  expect(await f.answer({ ...await f.request("autonomy"), answer: "reject" })).toMatchObject({ local_command: "autonomy reject" });
  expect(f.forward).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});
it("chain decisions refuse unsafe remote retries; grant revisions stay signed and stale versions are rejected", async () => {
  const f = fixture(); const store = new ContainedMissionStore(f.store, f.owner);
  const root = store.authorize(f.principal, { scope_id: f.scope, spec: { goal: "test" }, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1000);
  const chains = new RevisionChainStore(f.store, f.owner);
  const chain = chains.createLiveChain({ root_mission_id: root.mission_id, repository: "owner/repo", pr_number: 1, branch: "b", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace", grant: { rounds: 2 } }, 1000);
  chains.applyDecision(chain.chain_id, chain.revision, { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", from_head: chain.published_head, from_base: chain.published_base, head: chain.published_head, base: chain.published_base, review_ids: [], discards: [] }, 3000);
  const req = await f.request("revision_chain"); const before = f.db.prepare("SELECT total_changes() n").get();
  for (const answer of ["abandon", "takeover", "reconcile"]) expect(await f.answer({ ...req, answer })).toMatchObject({ outcome: "not_answerable", code: "idempotency_unsupported", local_command: "mission chain-decide" });
  expect(await f.answer({ ...req, source_revision: "1" })).toMatchObject({ outcome: "stale" });
  expect(await f.answer({ ...req, answer: "grant_revisions" })).toMatchObject({ outcome: "local_only", local_command: "mission grant-revisions" });
  f.principal.write_scopes = []; f.writeAuthority();
  expect(await f.answer(req)).toMatchObject({ code: "permission_denied" });
  expect(f.forward).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});

it("keeps a source early acknowledgement as accepted rather than claiming applied", async () => {
  const f = fixture(); const store = new ContainedMissionStore(f.store, f.owner);
  const m = store.authorize(f.principal, { scope_id: f.scope, spec: { goal: "test" }, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1000);
  store.transition(m.mission_id, { if_revision: m.revision, to: "awaiting_decision", event: { kind: "halted", payload: {} } }, 2000);
  f.forward.mockResolvedValue({ accepted: true, decision: "extra_repair", mission: { state: "executing" } });
  expect(await f.answer({ ...await f.request("contained_mission"), answer: "extra_repair" })).toMatchObject({ accepted: true, outcome: "accepted" });
});

it("rolls back Hermes resolution if its receipt cannot commit", async () => {
  const f = fixture();
  f.hermes("clarify");
  const req = { ...await f.request("hermes"), params: { text: "answer" } };
  f.db.exec("CREATE TRIGGER fail_answer BEFORE UPDATE OF payload_json ON events WHEN json_extract(NEW.payload_json,'$.decisions_answer') IS NOT NULL BEGIN SELECT RAISE(ABORT,'receipt_failed'); END");
  expect(await f.answer(req)).toMatchObject({ accepted: false, code: "receipt_failed" });
  expect(f.db.prepare("SELECT status,answer FROM clarifies WHERE clarify_id='a'").get()).toEqual({ status: "pending", answer: null });
  expect((await f.list()).items).toHaveLength(1);
});
it("returns the current Hermes state with conflict when another entry point resolved it", async () => {
  const f = fixture(); f.hermes("approval");
  const req = { ...await f.request("hermes"), params: { choice: "yes" } };
  resolveHermesDecision(f.db, "approval.resolve", { approval_id: "a", choice: "no" });
  const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ accepted: false, outcome: "conflict", code: "already_resolved", current: { state: "accepted", item: null } });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});

it("refuses a Session whose listed revision changed with zero writes", async () => {
  const f = fixture(); f.session(); const req = { ...await f.request("session"), params: { text: "answer" } };
  f.db.exec("UPDATE attention_items SET revision=revision+1");
  const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ accepted: false, outcome: "stale", code: "stale_item" });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before); expect(f.executions()).toBe(0);
});
it("binds a Session choice ID even when two choice labels are identical and records the actor", async () => {
  const f = fixture(); f.session(undefined, [{ choice_id: "yes", label: "Continue" }, { choice_id: "no", label: "Continue" }]);
  const req = await f.request("session");
  expect(await f.answer(req)).toMatchObject({ accepted: true });
  expect(await f.answer({ ...req, answer: "no" })).toMatchObject({ outcome: "conflict" });
  expect(f.executions()).toBe(1);
  const row = f.db.prepare("SELECT payload_json FROM session_messages WHERE direction='inbound'").get() as { payload_json: string };
  expect(JSON.parse(row.payload_json)).toMatchObject({ actor: JSON.stringify(["human", "desktop"]), answer_kind: "yes" });
});
it("passes a Session takeover grant to the existing reservation checks", async () => {
  const f = fixture(); f.session();
  expect(await f.answer({ ...await f.request("session"), params: { text: "answer", takeover: "true", takeover_grant_id: "grant:1" } })).toMatchObject({ accepted: true });
  expect(f.forward).toHaveBeenCalledWith("attention.answer", expect.objectContaining({ takeover: true, takeover_grant_id: "grant:1" }));
  expect(f.executions()).toBe(1);
});

it("keeps the Hermes adapter event sequence available after answering", async () => {
  const f = fixture();
  appendEvent(f.db, f.path, { event_id: "request", run_id: "r", session_id: "s", seq: 0, type: "approval.requested", created_at: 1, terminal: false, payload: { approval_id: "a", action_summary: "Approve?", risk: "low" } });
  expect(await f.answer({ ...await f.request("hermes"), params: { choice: "yes" } })).toMatchObject({ accepted: true });
  expect(() => appendEvent(f.db, f.path, { event_id: "next", run_id: "r", session_id: "s", seq: 1, type: "progress", created_at: 2, terminal: false, payload: {} })).not.toThrow();
});
it("refuses an orphan Hermes row without a request event instead of allocating an adapter sequence", async () => {
  const f = fixture(); f.db.exec("INSERT INTO approvals(approval_id,run_id,status,action_summary,risk,requested_at) VALUES('a','r','pending','Approve?','low',1)");
  const req = { ...await f.request("hermes"), params: { choice: "yes" } }; const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ outcome: "not_answerable", code: "idempotency_unsupported", local_command: "approval.resolve" });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before); expect(f.resolveHermes).not.toHaveBeenCalled();
});
it("refuses producer-supplied answer receipts instead of trusting their actor or claimed success", async () => {
  const f = fixture(); f.hermes("approval");
  f.db.exec(`UPDATE events SET payload_json=json_set(payload_json,'$.decisions_answer',json('{"answer_id":"key:1","digest":"forged","actor":"human"}'))`);
  const req = { ...await f.request("hermes"), params: { choice: "yes" } }; const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ accepted: false, outcome: "conflict", current: { state: "pending" } });
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before); expect(f.resolveHermes).not.toHaveBeenCalled();
});
