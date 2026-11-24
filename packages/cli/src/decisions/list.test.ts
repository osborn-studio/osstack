import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDb, AttentionStore, ContainedMissionStore, RevisionChainStore, createAutonomyRun, transitionAutonomyRun } from "@osstack/core";
import { DecisionsListResult } from "@osstack/protocol";
import { DecisionQueries } from "@osstack/core";
import { decisionItem, listDecisions } from "./list.js";
// Split so the repository secret scan does not match this redaction fixture.
const FAKE_TOKEN = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "decisions-"));
  const path = join(root, "state.db");
  const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1),('hidden','private','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root).scope_id;
  const hidden = attention.registerScope(owner, "hidden", root).scope_id;
  const principal = { principal_id: "p", client_session_id: "c", read_scopes: [scope], write_scopes: [scope, hidden], stop_scopes: [], operator_scopes: [] };
  const missions = new ContainedMissionStore(attention, owner);
  let count = 0;
  const mission = (scopeId = scope, ci = false) => {
    const id = ++count;
    const m = missions.authorize(principal, { scope_id: scopeId, spec: { goal: `Review\nsecret ${FAKE_TOKEN}`, ...(ci ? { ci_repair: {} } : {}) }, claim: { repo_identity: "r", branch: `b${id}`, worktree_identity: `w${id}` } }, 1000);
    return missions.transition(m.mission_id, { if_revision: m.revision, to: "awaiting_decision", event: { kind: "halted", payload: { reason: "publication_pending" } } }, 2000);
  };
  const queries = new DecisionQueries(db);
  const list = (params = {}) => listDecisions(queries, params, () => principal);
  return { db, path, root, attention, owner, scope, hidden, principal, missions, mission, queries, list };
}
function seed(f: ReturnType<typeof setup>) {
  f.attention.projectDecision(f.owner, { scopeId: f.scope, sessionId: "s", turnId: "turn", sourceVersion: 1, now: 1500, decision: { decision_id: "d", question: "Continue?", choices: [{ choice_id: "yes", label: "Yes" }], continuation: { version: 1, gate_kind: "risk_approval", phase: "build", next_action: "build", evidence_refs: [] } } });
  const m = f.mission(); const ci = f.mission(f.scope, true);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const chain = chains.createShadowChain({ root_mission_id: m.mission_id, repository: "owner/repo", pr_number: 1, branch: "b", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace" }, 1000);
  chains.applyDecision(chain.chain_id, chain.revision, { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", from_head: "a".repeat(40), from_base: "b".repeat(40), head: "a".repeat(40), base: "b".repeat(40), base_ref: "main", review_ids: [], discards: [] }, 3000);
  createAutonomyRun(f.db, f.path, { autonomy_run_id: "auto", transition_id: "auto:1", task_id: "t", repo_id: "r", workspace_path: f.root, contract_sha256: "a".repeat(64), budget: {}, attempt: {}, event: {}, occurred_at: 1 });
  transitionAutonomyRun(f.db, f.path, { autonomy_run_id: "auto", transition_id: "auto:2", expected_revision: 1, to_state: "awaiting_approval", event: {}, occurred_at: 4 });
  f.db.exec("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('run','t','loop','hermes','x','x',1)");
  f.db.exec("INSERT INTO approvals(approval_id,run_id,status,action_summary,risk,requested_at) VALUES('approval','run','pending','Approve action','high',5)");
  f.db.exec("INSERT INTO clarifies(clarify_id,run_id,status,question,requested_at) VALUES('clarify','run','pending','Which? ',6)");
  f.db.exec(`INSERT INTO events(event_id,run_id,session_id,seq,type,created_at,payload_json) VALUES('escalation','run','loop',1,'loop.escalated',7000,'{"task_id":"task","reason":"needs input"}')`);
  return { m, ci, chain };
}
it("lists all seven sources with uniform fields and ledger waiting times without writing", async () => {
  const f = setup(); const ids = seed(f);
  f.db.pragma("query_only=ON");
  const result = DecisionsListResult.parse(await f.list());
  expect(result.failures).toEqual([]); expect(result.items).toHaveLength(8);
  expect(new Set(result.items.map(i => i.source)).size).toBe(7);
  const by = (s: string) => result.items.find(i => i.source === s)!;
  expect(by("session")).toMatchObject({ scope_id: f.scope, waiting_since: null, allowed_answers: [], requires_local_signature: true });
  expect(by("contained_mission")).toMatchObject({ source_id: ids.m.mission_id, waiting_since: 2000, source_revision: "2", allowed_answers: ["abandon", "approve_publication"] });
  expect(by("ci_repair")).toMatchObject({ source_id: ids.ci.mission_id, waiting_since: 2000, answer_command: { name: "mission.approve_ci_repair", required_params: ["mission_id", "candidate"] } });
  expect(by("revision_chain")).toMatchObject({ source_id: ids.chain.chain_id, waiting_since: 3000 });
  expect(by("autonomy")).toMatchObject({ waiting_since: 4000, requires_local_signature: true });
  expect(by("hermes")).toMatchObject({ waiting_since: 5000 });
  expect(by("loop")).toMatchObject({ waiting_since: 7000 });
  for (const row of result.items) { expect(row.summary).not.toMatch(/[\n\r]/); expect(row.summary.length).toBeLessThanOrEqual(240); expect(row.summary).not.toContain("ghp_"); }
});
it("excludes unreadable Mission and chain scopes including filtered queries", async () => {
  const f = setup(); f.mission(); f.mission(f.hidden); f.mission(f.hidden, true);
  const result = await f.list(); expect(result.items).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(f.hidden);
  expect((await f.list({ scope_id: f.hidden })).items).toEqual([]);
});
it("continues after one source throws and returns only a fixed reason code", async () => {
  const f = setup(); seed(f);
  vi.spyOn(f.queries, "session").mockImplementation(() => { throw Error("private repository PR SHA secret"); });
  const result = await f.list(); expect(result.items).toHaveLength(7);
  expect(result.failures).toEqual([{ source: "session", code: "read_failed" }]);
  expect(JSON.stringify(result)).not.toContain("private repository");
});
it("returns an empty bounded result", async () => {
  expect(await setup().list()).toEqual({ items: [], failures: [], next_cursor: null });
});
it("pages across sources without omissions or duplicates and validates limits", async () => {
  const f = setup(); seed(f); const all = (await f.list()).items;
  const items = []; let cursor: string | undefined;
  do { const page = await f.list({ limit: 2, ...(cursor ? { cursor } : {}) }); expect(page.items.length).toBeLessThanOrEqual(2); items.push(...page.items); cursor = page.next_cursor ?? undefined; } while (cursor);
  expect(items).toEqual(all);
  await expect(f.list({ limit: 101 })).rejects.toThrow("bad_request");
  await expect(f.list({ cursor: "invalid" })).rejects.toThrow("bad_cursor");
});

it("reloads real engineering credentials and binds cursors to current read grants", async () => {
  const f = setup(); seed(f);
  const { createHash } = await import("node:crypto");
  const { writeFileSync } = await import("node:fs");
  const { EngineeringAccess } = await import("../engineering-access.js");
  const credential = "host-credential-".repeat(3);
  const authPath = join(f.root, "authority.json");
  const write = (read_scopes: string[]) => writeFileSync(authPath, JSON.stringify({ version: 1, principals: [{ ...f.principal, write_scopes: [], read_scopes, credential_sha256: createHash("sha256").update(credential).digest("hex") }] }), { mode: 0o600 });
  write([f.scope]); const access = new EngineeringAccess(authPath);
  const auth = (value: unknown) => access.authenticate(value);
  const page = await listDecisions(f.queries, { credential, limit: 1 }, auth);
  expect(page.next_cursor).not.toBeNull();
  write([]);
  await expect(listDecisions(f.queries, { credential, cursor: page.next_cursor }, auth)).rejects.toThrow("bad_cursor");
  const revoked = await listDecisions(f.queries, { credential }, auth);
  expect(revoked.items.some(i => ["contained_mission", "ci_repair", "revision_chain"].includes(i.source))).toBe(false);
  const denied = await listDecisions(f.queries, { credential: "x".repeat(32) }, auth);
  expect(denied.failures.map(failure => failure.code)).toEqual(["permission_denied", "permission_denied", "permission_denied"]);
  expect(denied.items.some(i => i.source === "hermes")).toBe(true);
});
it("filters chain roots before exposing identifiers and reports live grant signatures", async () => {
  const f = setup(); const root = f.mission(f.hidden);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const create = (missionId: string, pr: number) => {
    const chain = chains.createLiveChain({ root_mission_id: missionId, repository: "secret/repo", pr_number: pr, branch: "b", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace", grant: { rounds: 2 } }, 1000);
    return chains.applyDecision(chain.chain_id, chain.revision, { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", from_head: chain.published_head, from_base: chain.published_base, head: chain.published_head, base: chain.published_base, review_ids: [], discards: [] }, 3000);
  };
  const hidden = create(root.mission_id, 1);
  expect(JSON.stringify(await f.list())).not.toContain(hidden.chain_id);
  const visible = create(f.mission().mission_id, 2);
  const entry = (await f.list()).items.find(i => i.source_id === visible.chain_id)!;
  expect(entry).toMatchObject({ allowed_answers: ["abandon", "takeover", "grant_revisions"], requires_local_signature: true });
  const { createDecisionNoticeSource } = await import("./notices.js");
  const notice = createDecisionNoticeSource(f.queries, () => [f.scope], Date.now).pending().find(i => i.source_id === visible.chain_id);
  expect(notice).toMatchObject({ source: "revision_chain", requires_local_signature: true });
});
it("does not replace waiting entry time with later receipt or self-transition timestamps", async () => {
  const f = setup(); const m = f.mission();
  f.missions.record(m.mission_id, "receipt", {}, 9000);
  f.missions.transition(m.mission_id, { if_revision: m.revision, to: "awaiting_decision", event: { kind: "halted", payload: { reason: "publication_pending" } } }, 10000);
  expect((await f.list()).items[0]).toMatchObject({ waiting_since: 2000 });
});
it("excludes resolved Hermes rows and superseded loop escalations", async () => {
  const f = setup(); seed(f);
  f.db.exec("UPDATE approvals SET status='accepted'; UPDATE clarifies SET status='answered'");
  f.db.exec(`INSERT INTO events(event_id,run_id,session_id,seq,type,created_at,payload_json) VALUES('retry','run','loop',2,'loop.execute.done',8000,'{"task_id":"task"}')`);
  const result = await f.list(); expect(result.items.some(i => i.source === "hermes" || i.source === "loop")).toBe(false);
});
it("applies scope filters to task-bound local sources and redacts before truncating", async () => {
  const f = setup(); seed(f);
  const secret = FAKE_TOKEN;
  f.db.prepare("UPDATE approvals SET action_summary=?").run(`prefix\n${"long ".repeat(100)} ${secret}`);
  const all = await f.list({ scope_id: f.scope }); expect(all.items).toHaveLength(8);
  expect((await f.list({ scope_id: f.hidden })).items).toEqual([]);
  const approval = all.items.find(i => i.source_id === "approval:approval")!;
  expect(approval.summary.length).toBe(240); expect(approval.summary).not.toContain(secret);
});
it("gives a command for grant revisions as well as chain decisions", async () => {
  const f = setup();
  const chains = new RevisionChainStore(f.attention, f.owner);
  const chain = chains.createLiveChain({ root_mission_id: f.mission().mission_id, repository: "owner/repo", pr_number: 1, branch: "b", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace", grant: { rounds: 2 } }, 1000);
  chains.applyDecision(chain.chain_id, chain.revision, { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", from_head: chain.published_head, from_base: chain.published_base, head: chain.published_head, base: chain.published_base, review_ids: [], discards: [] }, 3000);
  const entry = (await f.list()).items.find(i => i.source_id === chain.chain_id)!;
  expect(entry.answer_command.alternatives).toContainEqual({ name: "mission grant-revisions", required_params: ["--chain"] });
});
it("uses null when a Mission has no waiting-entry event", async () => {
  const f = setup();
  const m = f.missions.authorize(f.principal, { scope_id: f.scope, spec: { goal: "missing ledger entry" }, claim: { repo_identity: "r", branch: "missing", worktree_identity: "missing" } }, 1000);
  f.db.prepare("UPDATE engineering_contained_missions SET state='awaiting_decision',revision=revision+1,updated_at=9000 WHERE mission_id=?").run(m.mission_id);
  expect((await f.list()).items[0]).toMatchObject({ waiting_since: null });
});
it("bounds large source pages at one hundred rows", async () => {
  const f = setup(); seed(f);
  const insert = f.db.prepare("INSERT INTO approvals(approval_id,run_id,status,action_summary,risk,requested_at) VALUES(?,'run','pending','Review','low',1)");
  f.db.transaction(() => { for (let n = 0; n < 105; n++) insert.run(`bulk-${n.toString().padStart(3, "0")}`); })();
  const first = await f.list({ limit: 100 }); expect(first.items).toHaveLength(100); expect(first.next_cursor).not.toBeNull();
  const second = await f.list({ limit: 100, cursor: first.next_cursor });
  expect(second.items).toHaveLength(13); expect(second.next_cursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map(i => `${i.source}:${i.source_id}`)).size).toBe(113);
});
it.each([
  ["needs_reconciliation", ["abandon", "discard_changes", "adopt_worktree"]],
  ["stop_unknown", ["abandon", "retry_stop_check"]],
] as const)("lists %s with state-specific answers", async (state, answers) => {
  const f = setup(); const m = f.mission();
  f.missions.transition(m.mission_id, { if_revision: m.revision, to: state, event: { kind: "halted", payload: { reason: "test" } } }, 4000);
  expect((await f.list()).items[0]).toMatchObject({ waiting_since: 4000, allowed_answers: answers });
});
it.each(["risk_approval", "task_authorization"])("marks %s as signed and does not offer an unsigned answer", async gate => {
  const f = setup();
  f.attention.projectDecision(f.owner, { scopeId: f.scope, sessionId: "s", turnId: "turn", sourceVersion: 1, now: 1500, decision: { decision_id: "d", question: "Approve?", choices: [{ choice_id: "yes", label: "Yes" }], continuation: { version: 1, gate_kind: gate, phase: "build", next_action: "build", evidence_refs: [] } } });
  expect((await f.list()).items[0]).toMatchObject({ requires_local_signature: true, allowed_answers: [] });
});
it("includes background loop escalation cards and stops listing them after approval", async () => {
  const f = setup();
  // Background loop.start writes these cards without copying the loop events to runs.
  f.db.exec("INSERT INTO kanban_cards(card_id,task_id,title,status,assignee,blocked_reason,created_at,updated_at) VALUES('card_loop_abcdef123456','loop:session:task','Loop escalation: task','blocked','osstack-loop','human input',1,9)");
  f.db.exec(`INSERT INTO kanban_card_events(card_id,board,kind,payload,created_at) VALUES('card_loop_abcdef123456','default','blocked','{"from":"triage","to":"blocked"}',2)`);
  const entry = (await f.list()).items[0]!;
  expect(entry).toMatchObject({ source: "loop", source_id: "card:card_loop_abcdef123456", waiting_since: 2000, allowed_answers: ["approve"], answer_command: { name: "cockpit approve", required_params: ["card_id"] } });
  f.db.exec("UPDATE kanban_cards SET status='done'");
  expect((await f.list()).items).toEqual([]);
});

it("delivers each listed decision once across scans, unrelated updates and restart", async () => {
  const { SupervisionService } = await import("../supervision-service.js");
  const f = setup();
  seed(f);
  const sender = vi.fn<import("@osstack/core").AttentionSender>().mockResolvedValue(undefined);
  let service = new SupervisionService(f.db, f.path, sender);
  try {
    for (let pass = 0; pass < 4; pass++) {
      if (pass === 3) {
        await service.stop();
        service = new SupervisionService(f.db, f.path, sender);
      }
      await service.requestScan();
      await new Promise(resolve => setImmediate(resolve));
      const { items } = await f.list();
      expect(sender).toHaveBeenCalledTimes(items.length);
      for (const decision of items) {
        const messages = sender.mock.calls.map(([message]) => message);
        const matches = messages.filter(message => decision.source === "session"
          ? message.item_id === decision.source_id && !("decision" in message)
          : message.decision?.source_id === decision.source_id && message.decision.source === decision.source);
        expect(matches).toHaveLength(1);
        if (decision.source !== "session") expect(matches[0]?.item_id).toMatch(/^decision:[a-f0-9]{32}$/);
        expect(matches[0]?.question).toBe(decision.summary);
      }
      f.db.exec("UPDATE engineering_contained_missions SET revision=revision+1; UPDATE engineering_revision_chains SET revision=revision+1; UPDATE autonomy_run_projection SET revision=revision+1; UPDATE approvals SET risk='low'");
    }
  } finally { await service.stop(); }
});

it("supersedes a closed readable decision while another source is unavailable, then notifies its next wait", async () => {
  const f = setup();
  seed(f);
  const { AttentionExperience } = await import("@osstack/core");
  const { createDecisionNoticeSource } = await import("./notices.js");
  const provider = createDecisionNoticeSource(f.queries, () => [f.scope], Date.now);
  const ux = new AttentionExperience(f.attention, f.owner, { externalDecisions: provider });
  const sender = vi.fn<import("@osstack/core").AttentionSender>().mockResolvedValue(undefined);
  const original = provider.pending().find(i => i.source_id === "approval:approval")!;
  ux.enqueueExternal();
  vi.spyOn(f.queries, "loop").mockImplementation(() => { throw Error("offline"); });
  f.db.exec("UPDATE approvals SET status='accepted'");
  await ux.drainBatch(sender);
  expect(f.db.prepare("SELECT state FROM attention_deliveries WHERE item_id=?").get(original.item_id)).toEqual({ state: "superseded" });
  f.db.exec("UPDATE approvals SET status='pending',requested_at=9");
  ux.enqueueExternal();
  await ux.drainBatch(sender);
  ux.enqueueExternal();
  await ux.drainBatch(sender);
  const calls = sender.mock.calls.filter(([msg]) => msg.decision?.source_id === "approval:approval");
  expect(calls).toHaveLength(1);
  expect(calls[0]![0].item_id).not.toBe(original.item_id);
});

it.each([1, 2])("offers host-signed renewal (v%s)", async version => {
  const f = setup();
  const chains = new RevisionChainStore(f.attention, f.owner);
  const chain = chains.createLiveChain({ root_mission_id: f.mission().mission_id, repository: "o/r", pr_number: 1, branch: "b", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "trace", grant: { version, rounds: 1 } }, 1000);
  chains.applyDecision(chain.chain_id, chain.revision, { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", from_head: chain.published_head, from_base: chain.published_base, head: chain.published_head, base: chain.published_base, review_ids: [], discards: [] }, 3000);
  const item = (await f.list()).items.find(i => i.source_id === chain.chain_id)!;
  expect(item.allowed_answers).toEqual(["abandon", "takeover", "grant_revisions"]);
  expect(item.requires_local_signature).toBe(true);
  expect(item.answer_command.alternatives).toEqual([{ name: "mission grant-revisions", required_params: ["--chain"] }]);
});

it.each(["publication_pending", "publication_failed:x", "revalidation_failed:x", "repair_cycles_exhausted"])(
  "lists repair child and ordinary Mission answers at %s", reason => {
    const row = { id: "synthetic", scope_id: "scope", revision: "1", waiting_since: 1,
      state: "awaiting_decision", summary: "Repair", kind: "mission", reason };
    const item = (spec: object) => decisionItem("contained_mission", { ...row, details_json: JSON.stringify(spec) });
    const decide = { name: "mission.decide", required_params: ["mission_id", "decision"] };
    const pending = reason === "publication_pending";
    const repair = item({ local_failure_repair: {} });
    expect(repair).toMatchObject({
      allowed_answers: pending ? ["abandon", "approve_local_failure_repair"] : ["abandon"],
      requires_local_signature: pending,
    });
    expect(repair.answer_command).toEqual(pending ? {
      ...decide, alternatives: [{ name: "mission approve-local-failure-repair", required_params: ["--mission", "--candidate"] }],
    } : decide);
    expect(item({})).toMatchObject({ allowed_answers: ["abandon", reason === "repair_cycles_exhausted" ? "extra_repair" : "approve_publication"],
      requires_local_signature: false, answer_command: decide });
  },
);

it.each([null, [], "invalid"])("withholds repair and approval answers for a malformed local binding %j", local => {
  for (const reason of ["publication_pending", "repair_cycles_exhausted"]) {
    const item = decisionItem("contained_mission", { id: "synthetic", scope_id: "scope", revision: "1", waiting_since: 1,
      state: "awaiting_decision", summary: "Repair", kind: "mission", reason, details_json: JSON.stringify({ local_failure_repair: local }) });
    expect(item.allowed_answers).toEqual(["abandon"]);
    expect(item.requires_local_signature).toBe(false);
  }
});

const missionAnswers = (details_json: string, state: string, reason: string) =>
  decisionItem("contained_mission", { id: "synthetic", scope_id: "scope", revision: "1", waiting_since: 1,
    state, summary: "Mission", kind: "mission", reason, details_json }).allowed_answers;

it.each([
  { kind: "plain Mission", spec: {}, resume: false, discard: true },
  { kind: "revision child", spec: { publish_target: {} }, resume: true, discard: true },
  { kind: "local-failure repair child", spec: { local_failure_repair: {} }, resume: false, discard: false },
  { kind: "CI repair child", spec: { ci_repair: {} }, resume: false, discard: true },
  { kind: "malformed bindings", spec: { publish_target: [], local_failure_repair: [] }, resume: false, discard: true },
])("lists resume and reconciliation answers for a $kind", ({ spec, resume, discard }) => {
  const json = JSON.stringify(spec);
  expect(missionAnswers(json, "awaiting_decision", "budget_exhausted")).toEqual(resume ? ["abandon", "resume_budget"] : ["abandon"]);
  expect(missionAnswers(json, "awaiting_decision", "grant_stopped:expired")).toEqual(resume ? ["abandon", "resume_grant"] : ["abandon"]);
  expect(missionAnswers(json, "needs_reconciliation", "")).toEqual(discard
    ? ["abandon", "discard_changes", "adopt_worktree"] : ["abandon", "adopt_worktree"]);
});

it("keeps the state-specific handling of malformed Mission JSON", () => {
  expect(missionAnswers("{", "needs_reconciliation", "")).toEqual(["abandon", "discard_changes", "adopt_worktree"]);
  expect(() => missionAnswers("{", "awaiting_decision", "budget_exhausted")).toThrow(SyntaxError);
});

it("lists a waiting recheck in read scope and preserves existing live and shadow decisions", async () => {
  const { publishedRecheck, runFixture } = await import("@osstack/core/dist/state/local-failure-recheck.testkit.js");
  const h = publishedRecheck();
  h.recordConfirmation(); h.confirm();
  const { db, principal } = h.f, chain = h.chain(), queries = new DecisionQueries(db);
  const items = async (read_scopes = principal.read_scopes) => (await listDecisions(queries, {}, () => ({ ...principal, read_scopes }))).items.filter(i => i.source === "revision_chain");
  const state = (value: string) => db.prepare("UPDATE engineering_revision_chains SET state=?,revision=revision+1 WHERE chain_id=?").run(value, chain.chain_id);
  state("ready_for_human");
  const before = (await items())[0]!;
  const rearm = { name: "mission recheck-rearm", required_params: ["--mission", "--attempt"] };
  const row = h.open();
  expect(await items()).toEqual([{ ...before, answer_command: { ...before.answer_command, alternatives: [...before.answer_command.alternatives!, rearm] } }]);
  state("awaiting_review");
  expect(await items()).toMatchObject([{ source_id: chain.chain_id, allowed_answers: [], requires_local_signature: true, waiting_since: row.created_at,
    answer_command: { name: "mission.chain_decide", required_params: ["chain_id", "decision"], alternatives: [rearm] },
    summary: `recheck waiting: attempt 1 of 3, mission ${row.root_mission_id}` }]);
  expect(await items(["other"])).toEqual([]);
  const shadow = new RevisionChainStore(h.f.attention, h.f.owner).createShadowChain(chain, h.now);
  expect((await items()).map(i => i.source_id)).not.toContain(shadow.chain_id);
  const { runs, input } = runFixture(h, row);
  for (let n = 1; n <= 3; n++) {
    const r = runs.reserve({ ...input, invocation_id: globalThis.crypto.randomUUID() }).run;
    expect(await items()).toEqual([]);
    runs.settleNotStarted(r.run_id, r.revision, "verify_recheck_not_started");
    if (n < 3) expect((await items())[0]?.summary).toBe(`recheck waiting: attempt ${n + 1} of 3, mission ${row.root_mission_id}`);
  }
  expect(await items()).toEqual([]);
});

it("excludes a closed chain with a pending recheck and keeps prior decisions without a recheck", async () => {
  const { publishedRecheck } = await import("@osstack/core/dist/state/local-failure-recheck.testkit.js");
  const h = publishedRecheck(), chain = h.chain(), { db, principal } = h.f;
  const list = async () => (await listDecisions(new DecisionQueries(db), {}, () => principal)).items.filter(i => i.source === "revision_chain");
  for (const mode of ["live", "shadow"] as const) {
    const c = mode === "live" ? chain : new RevisionChainStore(h.f.attention, h.f.owner).createShadowChain(chain, h.now);
    for (const state of ["ready_for_human", "awaiting_decision"]) {
      db.prepare("UPDATE engineering_revision_chains SET state=?,stop_reason=?,revision=revision+1 WHERE chain_id=?").run(state, state === "awaiting_decision" ? "operator_review" : null, c.chain_id);
      const grant = mode === "live" && state === "ready_for_human";
      expect((await list()).find(i => i.source_id === c.chain_id)).toEqual({ source: "revision_chain", source_id: c.chain_id,
        scope_id: principal.read_scopes[0], waiting_since: null, summary: state, requires_local_signature: grant,
        source_revision: String(new RevisionChainStore(h.f.attention, h.f.owner).get(c.chain_id).revision),
        allowed_answers: mode === "shadow" ? [] : ["abandon", "takeover", ...(grant ? ["grant_revisions"] : [])],
        answer_command: { name: "mission.chain_decide", required_params: ["chain_id", "decision"],
          ...(grant && { alternatives: [{ name: "mission grant-revisions", required_params: ["--chain"] }] }) } });
    }
  }
  const pending = publishedRecheck(); pending.recordConfirmation(); pending.confirm(); pending.open();
  pending.f.db.exec("UPDATE engineering_revision_chains SET state='closed',revision=revision+1");
  const result = await listDecisions(new DecisionQueries(pending.f.db), {}, () => pending.f.principal);
  expect(result.failures).toEqual([]); expect(result.items.some(i => i.source === "revision_chain")).toBe(false);
});

const loopSummary = (details_json: string, summary: string, kind = "loop") => {
  const item = decisionItem("loop", { id: "event", scope_id: null, waiting_since: 1, revision: null,
    state: "escalated", reason: null, kind, summary, details_json });
  const card = kind === "loop_card";
  expect(item.allowed_answers).toEqual([card ? "approve" : "retry"]);
  expect(item.answer_command).toEqual(card ? { name: "cockpit approve", required_params: ["card_id"] }
    : { name: "cockpit retry", required_params: ["task_id", "--workspace"] });
  return item.summary;
};

it("locates the kept builder work and appends the original reason", () => {
  const reason = "Repair attempts exhausted";
  const payload = { role: "builder", task_id: "build-1", reason_code: "report_invalid", reason,
    worktree_path: "/private/work", branch: "feature/private" };
  expect(loopSummary(JSON.stringify(payload), reason)).toBe(
    "The builder report was invalid and could not be repaired. The work is kept. See the completed task build-1 in LOOP-STATE.json. Choosing retry redoes the work. — Repair attempts exhausted");
});

it("locates the kept reviewer work when the event has no reason", () => {
  const payload = { role: "reviewer", task_id: "review-1", reason_code: "report_invalid" };
  expect(loopSummary(JSON.stringify(payload), "Loop escalation")).toBe(
    "The reviewer report was invalid and could not be repaired. The work is kept. See the completed task review-1 in LOOP-STATE.json. Choosing retry redoes the work.");
});

it("keeps the complete guidance ahead of a long reason", () => {
  const reason = "details ".repeat(80);
  const payload = { role: "reviewer", task_id: "x".repeat(320), reason_code: "report_invalid", reason };
  const result = loopSummary(JSON.stringify(payload), reason);
  expect(result.length).toBeLessThanOrEqual(240);
  expect(result.startsWith(`The reviewer report was invalid and could not be repaired. The work is kept. See the completed task ${"x".repeat(64)} in LOOP-STATE.json. Choosing retry redoes the work. — details`)).toBe(true);
});

it("redacts the task id before the cut and redacts the reason", () => {
  const reason = `Token ${FAKE_TOKEN}`;
  const payload = { task_id: "x".repeat(60) + FAKE_TOKEN, reason_code: "report_invalid", reason };
  const result = loopSummary(JSON.stringify(payload), reason);
  expect(result).not.toContain(FAKE_TOKEN.slice(0, 4));
  expect(result).toContain(" — Token [REDACTED:secret]");
});

it("omits an unknown role and a missing task id", () => {
  expect(loopSummary('{"role":"Reviewer","reason_code":"report_invalid"}', "Loop escalation")).toBe(
    "The report was invalid and could not be repaired. The work is kept. See the completed task in LOOP-STATE.json. Choosing retry redoes the work.");
});

it.each([
  ["loop", '{"reason_code":"other","task_id":"t"}'],
  ["loop", "{"],
  ["loop", '[{"reason_code":"report_invalid","task_id":"t"}]'],
  ["loop", "null"],
  ["loop", '{"reason_code":"report_invalid","task_id":123}'],
  ["loop_card", '{"reason_code":"report_invalid","task_id":"t"}'],
])("keeps the existing %s summary for %s", (kind, details) => {
  expect(loopSummary(details, "Original text", kind)).toBe("Original text");
});
