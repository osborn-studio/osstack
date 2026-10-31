import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionExperience } from "./attention-experience.js";
import { readAttentionReturnBrief } from "./attention-return-brief.js";
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach((f) => { f(); }); });
function setup(opened: number[] = []) {
  const root = mkdtempSync(join(tmpdir(), "return-brief-"));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root).scope_id;
  const open = (now: number, i: number) => store.projectDecision(owner, {
    scopeId: scope, sessionId: "s", turnId: `turn${i}`, sourceVersion: 1,
    decision: { decision_id: "d", question: `Q${i}`, choices: [] }, now,
  });
  const items = opened.map(open);
  return { db, path, store, owner, scope, items, open, ux: new AttentionExperience(store, owner, { reminders: true }) };
}
const settle = (db: ReturnType<typeof setup>["db"], item: string, at: number, state = "answer_applied") =>
  db.prepare("UPDATE attention_items SET state=?,revision=revision+1,updated_at=? WHERE item_id=?").run(state, at, item);

it("bounds every section to [since, now] inclusive and orders deterministically", () => {
  const f = setup([99, 100, 150, 200, 201]);
  const [before, atSince, inside, atNow, after] = f.items.map((i) => i.item_id) as [string, string, string, string, string];
  settle(f.db, before, 99);
  settle(f.db, atSince, 100, "answer_cancelled");
  settle(f.db, atNow, 200);
  // Settled after now: still resolved, but outside this interval.
  settle(f.db, after, 202);
  const brief = readAttentionReturnBrief(f.db, { scope_id: f.scope, since: 100, now: 200 });
  expect(brief.interval).toEqual({ since: 100, now: 200, since_known: true });
  expect(brief.changed_while_away.opened.items.map((i) => i.item_id)).toEqual([atSince, inside, atNow]);
  expect(brief.changed_while_away.opened.total).toBe(3);
  expect(brief.changed_while_away.resolved.items.map((i) => [i.item_id, i.state, i.resolved_at])).toEqual([
    [atSince, "answer_cancelled", 100], [atNow, "answer_applied", 200],
  ]);
  // Waiting is every open decision regardless of when it opened.
  expect(brief.waiting_on_you.items.map((i) => [i.item_id, i.age_ms, i.reminder_count])).toEqual([[inside, 50, 0]]);
  expect(brief).toMatchObject({ execution_takeover: false, authority: "none" });
  expect(() => readAttentionReturnBrief(f.db, { scope_id: f.scope, since: 201, now: 200 })).toThrow("invalid_since");
  expect(() => readAttentionReturnBrief(f.db, { scope_id: f.scope, since: 0, now: 1, limit: 101 })).toThrow("invalid_limit");
});

it("never drops open decisions when the list is bounded", () => {
  const f = setup(Array.from({ length: 30 }, (_, i) => 1000 - i));
  const brief = readAttentionReturnBrief(f.db, { scope_id: f.scope, since: 0, now: 2000, limit: 5 });
  expect(brief.waiting_on_you.total).toBe(30);
  expect(brief.waiting_on_you.omitted).toBe(25);
  expect(brief.waiting_on_you.items.map((i) => i.opened_at)).toEqual([971, 972, 973, 974, 975]);
  expect(brief.changed_while_away.opened).toMatchObject({ total: 30, omitted: 25 });
});

it("reports a decision that re-entered the waiting set as waiting, not resolved", () => {
  const f = setup([10]);
  const id = f.items[0]!.item_id;
  settle(f.db, id, 20, "answer_reserved");
  settle(f.db, id, 30, "answer_uncertain");
  const brief = readAttentionReturnBrief(f.db, { scope_id: f.scope, since: 0, now: 40 });
  expect(brief.changed_while_away.resolved.total).toBe(0);
  expect(brief.waiting_on_you.items.map((i) => i.state)).toEqual(["answer_uncertain"]);
});

it("returns a brief only when leaving away for attended, not when leaving quiet", () => {
  const f = setup([50]);
  expect(f.ux.posture(f.scope, "owner", "quiet", 10)).toMatchObject({ previous: null, entered_at: 10, return_brief: null });
  expect(f.ux.posture(f.scope, "owner", "attended", 100)).toMatchObject({ previous: "quiet", return_brief: null });
  f.ux.posture(f.scope, "owner", "away", 200);
  f.open(250, 1);
  const back = f.ux.posture(f.scope, "owner", "attended", 300);
  expect(back).toMatchObject({ previous: "away", posture: "attended", entered_at: 300, execution_takeover: false });
  expect(back.return_brief?.interval).toEqual({ since: 200, now: 300, since_known: true });
  expect(back.return_brief?.changed_while_away.opened.items.map((i) => i.opened_at)).toEqual([250]);
  expect(back.return_brief?.waiting_on_you.total).toBe(2);
  // Away to quiet is not a return.
  f.ux.posture(f.scope, "owner", "away", 400);
  expect(f.ux.posture(f.scope, "owner", "quiet", 500).return_brief).toBeNull();
});

it("re-entering away resets the interval; repeating away keeps it", () => {
  const f = setup();
  f.ux.posture(f.scope, "owner", "away", 100);
  expect(f.ux.posture(f.scope, "owner", "away", 150).entered_at).toBe(100);
  expect(f.ux.posture(f.scope, "owner", "attended", 200).return_brief?.interval.since).toBe(100);
  f.ux.posture(f.scope, "owner", "away", 300);
  expect(f.ux.posture(f.scope, "owner", "attended", 400).return_brief?.interval.since).toBe(300);
  // Postures are per actor.
  f.ux.posture(f.scope, "other", "away", 350);
  expect(f.ux.returnBrief(f.scope, "other", {}, 500).interval.since).toBe(350);
  expect(() => f.ux.returnBrief(f.scope, "owner", {}, 500)).toThrow("since_required");
});

it("marks a pre-49 away posture as an unknown interval and still bounds it", () => {
  const f = setup([5]);
  f.db.prepare("INSERT INTO attention_postures(scope_id,actor,posture) VALUES(?,?,?)").run(f.scope, "owner", "away");
  const back = f.ux.posture(f.scope, "owner", "attended", 100);
  expect(back.return_brief?.interval).toEqual({ since: null, now: 100, since_known: false });
  expect(back.return_brief?.changed_while_away.opened.total).toBe(1);
});

it("refuses a stale owner without changing posture", () => {
  const f = setup();
  f.ux.posture(f.scope, "owner", "away", 100);
  f.store.claimOwner("b");
  expect(() => f.ux.posture(f.scope, "owner", "attended", 200)).toThrow("stale_owner");
  expect(f.db.prepare("SELECT posture,entered_at FROM attention_postures").get()).toEqual({ posture: "away", entered_at: 100 });
});

it("lists first notices and reminders that dead-lettered in the interval, and undated legacy ones", async () => {
  const f = setup([0]);
  f.ux.enqueue(f.scope);
  f.ux.scheduleReminders({ overdueMs: 10, backoffMaxMs: 20 }, 10);
  for (let i = 0; i < 10; i++) await f.ux.drain(async () => { throw new Error("down"); }, 1000 + i * 1_000_000);
  f.db.exec("INSERT INTO attention_deliveries(delivery_id,scope_id,item_id,revision,state) VALUES('legacy','" + f.scope + "','x',1,'dead_letter')");
  const all = readAttentionReturnBrief(f.db, { scope_id: f.scope, since: 0, now: 100_000_000 });
  expect(all.delivery_problems.items.map((d) => [d.kind, d.sequence, d.error])).toEqual([
    ["first_notice", null, "delivery_failed"], ["reminder", 1, "delivery_failed"],
  ]);
  expect(all.delivery_problems).toMatchObject({ total: 2, omitted: 0, undated: 1 });
  const [first] = all.delivery_problems.items;
  const narrow = readAttentionReturnBrief(f.db, { scope_id: f.scope, since: first!.dead_at + 1, now: 100_000_000 });
  expect(narrow.delivery_problems.items.map((d) => d.kind)).toEqual(["reminder"]);
});

it("records interrupted sends that recovery dead-letters", () => {
  const f = setup([0]);
  f.ux.enqueue(f.scope);
  f.db.exec("UPDATE attention_deliveries SET state='sending',attempts=5");
  f.ux.recoverDeliveries(77);
  expect(readAttentionReturnBrief(f.db, { scope_id: f.scope, since: 77, now: 77 }).delivery_problems.items)
    .toMatchObject([{ kind: "first_notice", error: "interrupted_delivery", dead_at: 77 }]);
});

it("stays read-only: works on a read-only connection and writes nothing", () => {
  const f = setup([10, 20]);
  settle(f.db, f.items[0]!.item_id, 15);
  f.ux.posture(f.scope, "owner", "away", 5);
  const before = f.db.prepare("SELECT total_changes() n").get() as { n: number };
  const preview = f.ux.returnBrief(f.scope, "owner", {}, 30);
  expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  expect(f.db.prepare("SELECT posture FROM attention_postures").get()).toEqual({ posture: "away" });
  const ro = openDb({ path: f.path, readwrite: false });
  try {
    expect(readAttentionReturnBrief(ro, { scope_id: f.scope, since: 5, now: 30 })).toEqual(preview);
  } finally { ro.close(); }
});
