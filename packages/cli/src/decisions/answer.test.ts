import { createHash, createHmac } from "node:crypto";
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
it.each(["rejected", "accepted", "absent"])("binds the effective approval status to the receipt (%s)", async stated => {
  const f = fixture();
  f.hermes("approval");
  const req = await f.request("hermes");
  const choice = "yes";
  const status = stated === "absent" ? "accepted" : stated;
  const params = stated === "absent" ? { choice } : { choice, status };
  expect(await f.answer({ ...req, params })).toMatchObject({
    outcome: "applied", replay: false, current: { state: status, item: null },
  });
  expect(f.resolveHermes).toHaveBeenCalledWith("approval.resolve", {
    approval_id: "a", choice, actor: f.principal.principal_id, ...(status === "rejected" ? { status } : {}),
  });
  expect(f.db.prepare("SELECT status, choice FROM approvals").get()).toEqual({ status, choice });
  expect(f.db.prepare("SELECT json_extract(payload_json,'$.decisions_answer.answer_id') FROM events WHERE event_id='request'")
    .pluck().get()).toBe(req.answer_id);
  expect((await f.list()).items).toEqual([]);
  const before = f.db.prepare("SELECT total_changes()").pluck().get();
  const rejected = { choice, status: "rejected" };
  expect(await f.answer({ ...req, params: status === "rejected" ? rejected : { choice } })).toMatchObject({
    outcome: "applied", replay: true, current: { state: status, item: null },
  });
  expect(await f.answer({ ...req, params: status === "rejected" ? { choice } : rejected })).toMatchObject({
    outcome: "conflict", code: "answer_id_conflict",
  });
  expect(f.db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
  expect(f.resolveHermes).toHaveBeenCalledTimes(1);
});

it.each(["approval", "clarify"] as const)("refuses an invalid %s status before writing a receipt", async kind => {
  const f = fixture();
  f.hermes(kind);
  const req = await f.request("hermes");
  const params = kind === "approval" ? { choice: "yes", status: "timed_out" } : { text: "yes", status: "accepted" };
  const before = f.db.prepare("SELECT total_changes()").pluck().get();
  expect(await f.answer({ ...req, params })).toMatchObject({ outcome: "refused", code: "bad_request", current: { state: "pending" } });
  expect(f.resolveHermes).not.toHaveBeenCalled();
  expect(f.db.prepare("SELECT json_extract(payload_json,'$.decisions_answer') FROM events WHERE event_id='request'").pluck().get()).toBeNull();
  expect(f.db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
});

it("replays an approval receipt written with the original digest", async () => {
  const f = fixture();
  f.hermes("approval");
  const req = await f.request("hermes");
  const choice = "no";
  const digest = createHmac("sha256", req.credential).update(JSON.stringify([
    req.source_id, req.answer, choice, req.source_revision, f.principal.principal_id, f.principal.client_session_id,
  ])).digest("hex");
  f.db.prepare("UPDATE approvals SET status='accepted', choice=?, resolved_at=42 WHERE approval_id='a'").run(choice);
  f.db.prepare("UPDATE events SET payload_json=json_set(payload_json,'$.decisions_answer',json(?)) WHERE event_id='request'")
    .run(JSON.stringify({ digest, answer_id: req.answer_id, source_id: req.source_id, actor: f.principal.principal_id, client_session_id: f.principal.client_session_id }));
  const before = f.db.prepare("SELECT total_changes()").pluck().get();
  expect(await f.answer({ ...req, params: { choice } })).toMatchObject({ outcome: "applied", replay: true, current: { state: "accepted" } });
  expect(f.db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
});

it("requires the original Hermes answer_id to replay the same answer", async () => {
  const f = fixture();
  f.hermes("approval");
  const req = { ...await f.request("hermes"), params: { choice: "yes" } };
  expect(await f.answer(req)).toMatchObject({ accepted: true });
  const before = f.db.prepare("SELECT total_changes() n").get();
  expect(await f.answer(req)).toMatchObject({ accepted: true, replay: true });
  expect(await f.answer({ ...req, answer_id: "key:2" })).toMatchObject({ accepted: false, code: "already_resolved" });
  expect(f.resolveHermes).toHaveBeenCalledTimes(1);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});
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
it("forwards keyed chain decisions with the listed revision and keeps grants local", async () => {
  const f = fixture(); const store = new ContainedMissionStore(f.store, f.owner);
  const root = store.authorize(f.principal, { scope_id: f.scope, spec: { goal: "test" }, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1000);
  const chains = new RevisionChainStore(f.store, f.owner);
  const chain = chains.createLiveChain({ root_mission_id: root.mission_id, repository: "owner/repo", pr_number: 1, branch: "b", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace", grant: { rounds: 2 } }, 1000);
  chains.applyDecision(chain.chain_id, chain.revision, { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", from_head: chain.published_head, from_base: chain.published_base, head: chain.published_head, base: chain.published_base, review_ids: [], discards: [] }, 3000);
  const req = await f.request("revision_chain"); const before = f.db.prepare("SELECT total_changes() n").get();
  for (const answer of ["abandon", "takeover", "reconcile"]) {
    f.forward.mockResolvedValueOnce({ replay: true });
    expect(await f.answer({ ...req, answer })).toMatchObject({ accepted: true, outcome: "applied", replay: true });
    expect(f.forward).toHaveBeenLastCalledWith("mission.chain_decide", { credential: req.credential, chain_id: chain.chain_id,
      decision: answer, decision_id: req.answer_id, expected_revision: Number(req.source_revision) });
  }
  f.forward.mockRejectedValueOnce(Error("stale_revision"));
  expect(await f.answer({ ...req, source_revision: "1" })).toMatchObject({ outcome: "stale" });
  f.forward.mockClear();
  for (const revision of ["0", "1.5", "9007199254740992"]) {
    expect(await f.answer({ ...req, source_revision: revision })).toMatchObject({ outcome: "stale", code: "stale_revision" });
  }
  expect(await f.answer({ ...req, params: { unexpected: "value" } })).toMatchObject({ code: "bad_request" });
  expect(await f.answer({ ...req, answer: "grant_revisions" })).toMatchObject({ outcome: "local_only", local_command: "mission grant-revisions" });
  f.principal.write_scopes = []; f.writeAuthority();
  expect(await f.answer(req)).toMatchObject({ code: "permission_denied" });
  expect(f.forward).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
});

it("keeps a listed shadow chain unanswerable", async () => {
  const f = fixture();
  const store = new ContainedMissionStore(f.store, f.owner);
  const root = store.authorize(f.principal, { scope_id: f.scope, spec: { goal: "test" },
    claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1000);
  const chains = new RevisionChainStore(f.store, f.owner);
  const chain = chains.createShadowChain({ root_mission_id: root.mission_id, repository: "owner/repo", pr_number: 1, branch: "b",
    base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace" }, 1000);
  chains.applyDecision(chain.chain_id, chain.revision, { kind: "transition", to: "ready_for_human", reason: "all_participating_approved",
    from_head: chain.published_head, from_base: chain.published_base, head: chain.published_head, base: chain.published_base,
    review_ids: [], discards: [] }, 2000);
  const result = await f.answer({ ...await f.request("revision_chain"), answer: "abandon" });
  expect(result).toMatchObject({ accepted: false, outcome: "not_answerable", current: { item: { allowed_answers: [] } } });
  expect(f.forward).not.toHaveBeenCalled();
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

it("keeps grant and candidate approval answers local across engineering sources", async () => {
  const f = fixture();
  const store = new ContainedMissionStore(f.store, f.owner);
  const m = store.authorize(f.principal, { scope_id: f.scope, spec: { goal: "test" }, claim: { repo_identity: "r", branch: "b", worktree_identity: "w" } }, 1000);
  const chain = new RevisionChainStore(f.store, f.owner).createLiveChain({ root_mission_id: m.mission_id, repository: "o/r", pr_number: 1, branch: "b", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace", grant: { version: 2, rounds: 1 } }, 1000);
  for (const source of ["contained_mission", "ci_repair", "revision_chain"]) {
    for (const answer of ["grant_revisions", "grant_local_failure_repair", "approve_local_failure_repair"]) {
      const candidateApproval = answer === "approve_local_failure_repair";
      for (const params of [{}, candidateApproval ? { candidate: "d".repeat(40) } : { signature: "sig", nonce: "nonce", preview_sha256: "digest" }]) {
        expect(await f.answer({ credential: "c".repeat(32), source, source_id: source === "revision_chain" ? chain.chain_id : m.mission_id,
          source_revision: "1", answer_id: "grant:1", answer, params })).toMatchObject({ accepted: false, outcome: "local_only", code: "local_only",
          local_command: candidateApproval ? "mission approve-local-failure-repair" : "mission grant-revisions" });
      }
    }
  }
  expect(f.forward).not.toHaveBeenCalled();
});

it("keeps re-arm local for Mission and chain answers and refuses abandon on a recheck-only item", async () => {
  const { publishedRecheck } = await import("@osstack/core/dist/state/local-failure-recheck.testkit.js");
  const h = publishedRecheck(); h.recordConfirmation(); h.confirm(); h.open();
  const { db, principal } = h.f, queries = new DecisionQueries(db), authenticate = () => principal;
  const forward = vi.fn(), resolveHermes = vi.fn();
  const req = { credential: "c".repeat(32), source_revision: String(h.chain().revision), answer_id: "decision", answer: "rearm_local_failure_recheck" };
  for (const [source, source_id] of [["revision_chain", h.chain().chain_id], ["contained_mission", h.r.root_mission_id]]) {
    const response = await answerDecision({ db, queries, authenticate, forward, resolveHermes }, { ...req, source, source_id });
    expect(response).toMatchObject({ accepted: false, replay: false, outcome: "local_only", code: "local_only", local_command: "mission recheck-rearm" });
  }
  const response = await answerDecision({ db, queries, authenticate, forward, resolveHermes }, { ...req, source: "revision_chain", source_id: h.chain().chain_id, answer: "abandon" });
  expect(response).toMatchObject({ outcome: "not_answerable", current: { item: { allowed_answers: [] } } });
  expect(forward).not.toHaveBeenCalled();
});
