import { join } from "node:path";
import { readdirSync, rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { AttentionExperience, AttentionStore, DecisionProbes, DecisionQueries, createScratchDirSync, openDb, parseAttentionReminderPolicy, type AttentionSender } from "@osstack/core";
import { localAttentionSender } from "../attention-local-delivery.js";
import { answerDecision } from "./answer.js";
import { listDecisions } from "./list.js";
import { createDecisionNoticeSource } from "./notices.js";
import { buildAttentionWebhookNotice, webhookAttentionSender } from "../attention-webhook-delivery.js";
import { ManagedNativeUpgradePort } from "../upgrade-native-port.js";
import { tryDecisionRpc } from "./try-rpc.js";

const credential = "c".repeat(32);
const principal = { principal_id: "human", client_session_id: "local", read_scopes: [], write_scopes: [], operator_scopes: [], stop_scopes: [] };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); });
function setup() {
  const root = createScratchDirSync("tests", "decision-probe");
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const queries = new DecisionQueries(db);
  const probes = new DecisionProbes(db);
  const authenticate = (value: unknown) => {
    if (value !== credential) throw Error("permission_denied");
    return principal;
  };
  const list = (extra = {}) => listDecisions(queries, { credential, ...extra }, authenticate);
  const notices = createDecisionNoticeSource(queries, () => [], Date.now);
  const forward = vi.fn(async () => { throw Error("unexpected_forward"); });
  const answer = (id: string, extra = {}) => answerDecision({ queries, db, authenticate, forward, resolveHermes: forward },
    { credential, source: "probe", source_id: id, answer: "blue", answer_id: "try:1", source_revision: "1", ...extra });
  const attention = new AttentionStore(db, path);
  const experience = new AttentionExperience(attention, attention.claimOwner("owner"), { externalDecisions: notices, reminders: true });
  const create = () => probes.create({ created_by: "owner", now: Date.now() }).probe;
  return { root, db, probes, clock, create, list, notices, forward, answer, experience, authenticate };
}

it("lists, notifies, answers and continues without changing work tables", async () => {
  const f = setup();
  const tables = ["engineering_contained_missions", "engineering_contained_events", "engineering_revision_chains",
    "runs", "events", "approvals", "clarifies", "autonomy_run_projection", "kanban_cards", "kanban_card_events"];
  const counts = () => tables.map(table => f.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
  const before = counts();
  const { probe_id } = f.create();
  const page = await f.list();
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ source: "probe", source_id: probe_id, scope_id: null, source_revision: "1",
    summary: "osstack test card: pick a colour. No work depends on it.", allowed_answers: ["red", "green", "blue"], waiting_since: 1000 });
  expect((await f.list({ scope_id: "a".repeat(64) })).items).toEqual([]);
  expect(f.notices.pending()).toHaveLength(1);
  const sender = vi.fn<AttentionSender>().mockResolvedValue(undefined);
  for (let scan = 0; scan < 2; scan++) { f.experience.enqueueExternal(); await f.experience.drain(sender); }
  expect(sender).toHaveBeenCalledTimes(1);
  const message = sender.mock.calls[0]![0];
  await localAttentionSender(f.root)(message, new AbortController().signal);
  expect(readdirSync(join(f.root, "attention-notifications"))).toHaveLength(1);
  expect(buildAttentionWebhookNotice(message)).toMatchObject({ decision: { source: "probe", source_id: probe_id } });
  expect(() => buildAttentionWebhookNotice({ ...message, decision: { ...message.decision!, source: "unknown" } })).toThrow();
  const writes = () => f.db.prepare("SELECT total_changes()").pluck().get();
  const start = writes();
  for (const [input, code] of [[{ params: { text: "x" } }, "invalid_answer"], [{ answer: "purple" }, "invalid_answer"],
    [{ source_revision: "01" }, "stale_revision"], [{ credential: "z".repeat(32) }, "permission_denied"], [{ credential: undefined }, "bad_request"]] as const)
    expect(await f.answer(probe_id, input)).toMatchObject({ accepted: false, code });
  expect(writes()).toBe(start);
  expect(await f.answer(probe_id)).toMatchObject({ accepted: true, outcome: "applied", current: { state: "answered" } });
  expect(await f.answer(probe_id)).toMatchObject({ accepted: true, replay: true });
  expect(await f.answer(probe_id, { params: { note: "x" } })).toMatchObject({ code: "answer_id_conflict" });
  expect(await f.answer(probe_id, { source_revision: "2" })).toMatchObject({ code: "answer_id_conflict" });
  expect(await f.answer("missing", { answer_id: "unused" })).toMatchObject({ outcome: "refused", code: "not_found", current: { state: "not_found" } });
  expect(await f.answer(probe_id, { answer: "red" })).toMatchObject({ outcome: "conflict", code: "answer_id_conflict" });
  expect(await f.answer(probe_id, { answer_id: "second" })).toMatchObject({ code: "already_resolved" });
  expect(f.notices.pending()).toEqual([]);
  expect(f.probes.continue(probe_id, 2000).code).toBe("continued");
  expect(f.forward).not.toHaveBeenCalled();
  expect(counts()).toEqual(before);
});

it("delivers real probe identifiers through both attention senders", async () => {
  const f = setup();
  const local = localAttentionSender(f.root);
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const webhook = webhookAttentionSender({ url: new URL("https://fixture.invalid"), key: null }, { send });
  const capture = vi.fn<AttentionSender>().mockResolvedValue(undefined);
  const signal = new AbortController().signal;

  for (let i = 0; i < 200; i++) {
    const { probe_id } = f.create();
    f.experience.enqueueExternal();
    await f.experience.drain(capture);
    expect(capture).toHaveBeenCalledTimes(1);
    const message = capture.mock.calls[0]![0];
    expect(message.decision).toMatchObject({ source: "probe", source_id: probe_id });
    await local(message, signal);
    await webhook(message, signal);
    expect(JSON.parse(String(send.mock.lastCall?.[1]?.body)).decision.source_id).toBe(probe_id);
    expect(await f.answer(probe_id, { answer_id: `try:${probe_id}` })).toMatchObject({ outcome: "applied" });
    capture.mockClear();
  }
  expect(readdirSync(join(f.root, "attention-notifications"))).toHaveLength(200);
  expect(send).toHaveBeenCalledTimes(200);
});

it("pages from a loop card to a probe", async () => {
  const f = setup();
  f.db.exec("INSERT INTO kanban_cards(card_id,task_id,title,status,assignee,created_at,updated_at) VALUES('card_loop_test','loop:t','test','blocked','osstack-loop',1,1)");
  const probe = f.create();
  const page = await f.list({ limit: 1 });
  expect(page.items[0]?.source).toBe("loop");
  expect((await f.list({ limit: 1, cursor: page.next_cursor })).items[0]?.source_id).toBe(probe.probe_id);
});

it("delivers one default reminder before the card expires at one hour", async () => {
  const f = setup();
  const probe = f.create();
  const sender = vi.fn<AttentionSender>().mockResolvedValue(undefined);
  const policy = parseAttentionReminderPolicy({ OSSTACK_ATTENTION_REMINDERS: "1" })!;
  for (const elapsed of [0, 1799999, 1800000, 3599999, 3600000]) {
    const now = probe.created_at + elapsed;
    f.clock.mockReturnValue(now);
    f.experience.enqueueExternal();
    f.experience.scheduleReminders(policy, now);
    await f.experience.drain(sender, now);
  }
  expect(sender.mock.calls.filter(([msg]) => msg.reminder)).toHaveLength(1);
  expect(f.notices.pending()).toEqual([]);
  expect((await f.list()).items).toEqual([]);
  expect(await f.answer(probe.probe_id)).toMatchObject({ code: "already_resolved", current: { state: "expired" } });
});

it("refuses draining writes and authenticates every try RPC", () => {
  const f = setup();
  const id = f.create().probe_id;
  for (const method of ["decisions.try_create", "decisions.try_status", "decisions.try_continue"] as const) {
    const params = method === "decisions.try_create" ? { credential } : { credential, probe_id: id };
    for (const invalid of [undefined, "invalid", "x".repeat(32)])
      expect(() => tryDecisionRpc(method, { ...params, credential: invalid }, f.db, f.authenticate, false)).toThrow("permission_denied");
    expect(() => tryDecisionRpc(method, params, f.db, undefined, false)).toThrow("permission_denied");
    if (method === "decisions.try_status") expect(tryDecisionRpc(method, params, f.db, f.authenticate, true).state).toBe("pending");
    else expect(() => tryDecisionRpc(method, params, f.db, f.authenticate, true)).toThrow("draining");
  }
});

it("qualifies schema 65 with a pending card and rejects mixed or incomplete probe schemas", () => {
  const f = setup();
  f.create();
  const qualify = () => f.db.transaction(() => ManagedNativeUpgradePort.assertStoppedDatabaseQualified(f.db)).exclusive();
  expect(qualify).not.toThrow();
  f.db.pragma("user_version=64");
  expect(qualify).toThrow("upgrade_schema_unqualified");
  f.db.pragma("user_version=65");
  f.db.exec("DROP INDEX decision_probes_answer_id");
  expect(qualify).toThrow("upgrade_schema_tables_missing");
});

it("returns only the public RPC fields and continues the answered card once", async () => {
  const f = setup();
  const create = () => tryDecisionRpc("decisions.try_create", { credential }, f.db, f.authenticate, false);
  const first = create();
  expect(first).toEqual({ probe_id: expect.stringMatching(/^[a-f0-9]{32}$/), state: "pending", revision: 1,
    created_at: 1000, expires_at: 3601000, answer: null, continued_at: null, created: true });
  expect(create()).toEqual({ ...first, created: false });
  const params = { credential, probe_id: first.probe_id };
  const proceed = () => tryDecisionRpc("decisions.try_continue", params, f.db, f.authenticate, false);
  expect(proceed).toThrow("pending");
  await f.answer(first.probe_id);
  const continued = proceed();
  expect(continued).toMatchObject({ state: "continued", answer: "blue", continued_at: 1000, revision: 3 });
  expect(proceed()).toEqual(continued);
  expect(tryDecisionRpc("decisions.try_status", params, f.db, f.authenticate, true)).toEqual(continued);
});
