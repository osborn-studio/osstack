import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionExperience } from "./attention-experience.js";
import { parseAttentionReminderPolicy } from "./attention-reminders.js";
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((f) => { f(); }); });
const policy = { overdueMs: 1000, backoffMaxMs: 3000 };
function setup(opened = [10, 20]) {
  const root = mkdtempSync(join(tmpdir(), "reminders-"));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root).scope_id;
  opened.forEach((now, i) => {
    store.projectDecision(owner, {
      scopeId: scope, sessionId: "s", turnId: `turn${i}`, sourceVersion: 1,
      decision: { decision_id: "d", question: `Q${i}`, choices: [] }, now,
    });
  });
  const items = store.listItems(scope).sort((a, b) => a.created_at - b.created_at);
  return { db, store, owner, scope, items, ux: new AttentionExperience(store, owner, { reminders: true }) };
}
type Sent = { delivery_id: string; item_id: string; reminder?: { sequence: number; age_ms: number } };
function collector() {
  const sent: Sent[] = [];
  return { sent, send: async (m: Sent) => { sent.push(m); } };
}
it("waits for the threshold, then schedules only the oldest overdue decision", () => {
  const { ux, items } = setup();
  expect(ux.scheduleReminders(policy, 1009)).toMatchObject({ scheduled: null });
  expect(ux.scheduleReminders(policy, 1030)).toMatchObject({
    scheduled: { item_id: items[0]!.item_id, sequence: 1, age_ms: 1020 },
  });
  // The first reminder is in flight; the second item is the only other due one.
  expect(ux.scheduleReminders(policy, 1030)).toMatchObject({
    scheduled: { item_id: items[1]!.item_id, sequence: 1 },
  });
  expect(ux.scheduleReminders(policy, 1030)).toMatchObject({ scheduled: null });
});
it("sends reminders through the shared drain with their own delivery identity", async () => {
  const { ux, scope, items } = setup([10]);
  ux.enqueue(scope);
  ux.scheduleReminders(policy, 1010);
  const { sent, send } = collector();
  await ux.drainBatch(send);
  expect(sent.map((m) => m.delivery_id).sort()).toEqual(
    [`${items[0]!.item_id}:1`, `${items[0]!.item_id}:1:r1`].sort()
  );
  expect(sent.find((m) => m.reminder)?.reminder).toEqual({ sequence: 1, age_ms: 1000 });
  expect(sent.find((m) => !m.reminder)).not.toHaveProperty("reminder");
});
it("doubles the repeat interval up to the cap", async () => {
  const { ux } = setup([0]);
  const { sent, send } = collector();
  const due: number[] = [];
  for (let now = 0; now <= 12000; now += 100) {
    if (ux.scheduleReminders(policy, now).scheduled) due.push(now);
    await ux.drain(send, now);
  }
  // threshold 1000, then +1000, +2000, +3000 (cap), +3000 ...
  expect(due).toEqual([1000, 2000, 4000, 7000, 10000]);
  expect(sent.map((m) => m.reminder?.sequence)).toEqual([1, 2, 3, 4, 5]);
});
it("keeps the schedule across an owner restart", async () => {
  const { ux, store } = setup([0]);
  ux.scheduleReminders(policy, 1000);
  await ux.drain(collector().send, 1000);
  const restarted = new AttentionExperience(store, store.claimOwner("b"), { reminders: true });
  expect(restarted.scheduleReminders(policy, 1500)).toMatchObject({ scheduled: null });
  expect(restarted.scheduleReminders(policy, 2000)).toMatchObject({ scheduled: { sequence: 2 } });
});
it("clears a resolved decision and supersedes its pending reminder", async () => {
  const { ux, db, items } = setup([0]);
  ux.scheduleReminders(policy, 1000);
  db.prepare("UPDATE attention_items SET state='continued_externally',revision=revision+1 WHERE item_id=?").run(items[0]!.item_id);
  const { sent, send } = collector();
  await ux.drain(send, 1000);
  expect(sent).toEqual([]);
  expect(ux.scheduleReminders(policy, 5000)).toMatchObject({ scheduled: null, cleared: 1 });
  expect(db.prepare("SELECT COUNT(*) n FROM attention_reminders").get()).toEqual({ n: 0 });
});
it("quiet scopes neither schedule nor reset, and reminders resume afterwards", async () => {
  const { ux, scope } = setup([0]);
  ux.scheduleReminders(policy, 1000);
  await ux.drain(collector().send, 1000);
  ux.posture(scope, "owner", "quiet");
  expect(ux.scheduleReminders(policy, 5000)).toMatchObject({ scheduled: null });
  ux.posture(scope, "owner", "away");
  expect(ux.scheduleReminders(policy, 5000)).toMatchObject({ scheduled: { sequence: 2 } });
});
it("keeps the backoff when an unresolved decision changes revision", async () => {
  const { ux, store, owner, scope, db, items } = setup([0]);
  const { sent, send } = collector();
  ux.scheduleReminders(policy, 1000);
  await ux.drain(send, 1000);
  // A new source version bumps the revision while the decision stays open.
  store.projectDecision(owner, {
    scopeId: scope, sessionId: "s", turnId: "turn0", sourceVersion: 2,
    decision: { decision_id: "d", question: "Q0", choices: [] }, now: 1001,
  });
  expect(db.prepare("SELECT revision,state FROM attention_items WHERE item_id=?").get(items[0]!.item_id))
    .toEqual({ revision: 2, state: "open" });
  expect(ux.scheduleReminders(policy, 1500)).toMatchObject({ scheduled: null, cleared: 0 });
  expect(ux.scheduleReminders(policy, 2000)).toMatchObject({ scheduled: { sequence: 2 } });
  await ux.drain(send, 2000);
  expect(sent.map((m) => m.delivery_id)).toEqual([`${items[0]!.item_id}:1:r1`, `${items[0]!.item_id}:2:r2`]);
});
it("treats a reminder superseded by a revision change as settled", async () => {
  const { ux, store, owner, scope, items } = setup([0]);
  ux.scheduleReminders(policy, 1000);
  store.projectDecision(owner, {
    scopeId: scope, sessionId: "s", turnId: "turn0", sourceVersion: 2,
    decision: { decision_id: "d", question: "Q0", choices: [] }, now: 1000,
  });
  const { sent, send } = collector();
  await ux.drain(send, 1000);
  expect(sent).toEqual([]);
  expect(ux.scheduleReminders(policy, 1999)).toMatchObject({ scheduled: null });
  expect(ux.scheduleReminders(policy, 2000)).toMatchObject({ scheduled: { item_id: items[0]!.item_id, sequence: 2 } });
});
it("does not send queued reminders while reminders are disabled, and resumes when enabled", async () => {
  const { ux, store, owner, scope } = setup([0]);
  ux.scheduleReminders(policy, 1000);
  const disabled = new AttentionExperience(store, owner);
  const { sent, send } = collector();
  ux.enqueue(scope);
  const batch = await disabled.drainBatch(send);
  expect(sent.every((m) => !m.reminder)).toBe(true);
  expect(batch.remainingDue).toBe(0);
  await ux.drain(send, 1000);
  expect(sent.filter((m) => m.reminder).map((m) => m.reminder!.sequence)).toEqual([1]);
});
it("does not schedule over a reminder that is still being retried", async () => {
  const { ux, db } = setup([0]);
  ux.scheduleReminders(policy, 1000);
  await ux.drain(async () => { throw new Error("unavailable"); }, 1000);
  expect(ux.scheduleReminders(policy, 9000)).toMatchObject({ scheduled: null });
  expect(db.prepare("SELECT sequence,state,attempts FROM attention_reminders").get())
    .toEqual({ sequence: 1, state: "pending", attempts: 1 });
});
it("does not let a stale owner schedule reminders", () => {
  const { ux, store } = setup([0]);
  store.claimOwner("b");
  expect(() => ux.scheduleReminders(policy, 1000)).toThrow("stale_owner");
});
it("parses an opt-in policy and refuses non-canonical settings", () => {
  expect(parseAttentionReminderPolicy({})).toBeUndefined();
  expect(parseAttentionReminderPolicy({ OSSTACK_ATTENTION_REMINDERS: "0" })).toBeUndefined();
  expect(parseAttentionReminderPolicy({ OSSTACK_ATTENTION_REMINDERS: "1" }))
    .toEqual({ overdueMs: 1_800_000, backoffMaxMs: 14_400_000 });
  expect(parseAttentionReminderPolicy({
    OSSTACK_ATTENTION_REMINDERS: "1",
    OSSTACK_ATTENTION_REMINDER_OVERDUE_SECS: "60",
    OSSTACK_ATTENTION_REMINDER_BACKOFF_MAX_SECS: "60",
  })).toEqual({ overdueMs: 60_000, backoffMaxMs: 60_000 });
  for (const [overdue, cap] of [["0", "10"], ["010", "20"], ["1e3", "2000"], ["1234567890", "1234567890"], ["30", "20"], [" 30", "60"]] as const)
    expect(() => parseAttentionReminderPolicy({
      OSSTACK_ATTENTION_REMINDERS: "1",
      OSSTACK_ATTENTION_REMINDER_OVERDUE_SECS: overdue,
      OSSTACK_ATTENTION_REMINDER_BACKOFF_MAX_SECS: cap,
    })).toThrow("invalid_attention_reminder_policy");
  expect(() => parseAttentionReminderPolicy({ OSSTACK_ATTENTION_REMINDERS: "yes" }))
    .toThrow("invalid_attention_reminder_policy");
});
