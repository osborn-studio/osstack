import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionExperience } from "./attention-experience.js";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => { f(); }));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "experience-"));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)"
  );
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root);
  for (let i = 0; i < 5; i++)
    store.projectDecision(owner, {
      scopeId: scope.scope_id,
      sessionId: "s",
      turnId: `turn${i}`,
      sourceVersion: 1,
      decision: { decision_id: "d", question: "Choose?", choices: [] },
      now: i,
    });
  return {
    db,
    store,
    owner,
    scope: scope.scope_id,
    ux: new AttentionExperience(store, owner),
  };
}
it("briefs never mark seen, explicit acknowledgements are scoped per actor and revision", () => {
  const { ux, scope } = setup();
  const brief = ux.brief(scope, "owner");
  expect(brief.total).toBe(5);
  expect(brief.items).toHaveLength(3);
  expect(ux.brief(scope, "owner").total).toBe(5);
  ux.seen(scope, "owner", brief.items);
  expect(ux.brief(scope, "owner").total).toBe(2);
  expect(ux.brief(scope, "other").total).toBe(5);
  expect(() => ux.seen("other", "owner", brief.items)).toThrow();
});
it("enqueues once and bounds failed delivery at five attempts", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  ux.enqueue(scope);
  expect(
    (
      db.prepare("SELECT COUNT(*) n FROM attention_deliveries").get() as {
        n: number;
      }
    ).n
  ).toBe(5);
  db.exec(
    "DELETE FROM attention_deliveries WHERE delivery_id<>(SELECT MIN(delivery_id) FROM attention_deliveries)"
  );
  let calls = 0;
  for (let i = 0; i < 6; i++)
    await ux.drain(async () => {
      calls++;
      throw new Error("unavailable");
    }, i * 1000000);
  expect(calls).toBe(5);
  expect(ux.brief(scope, "owner").dead_letters).toBe(1);
});
it("quiet suppresses transport without granting execution, timeout does not accept a late receipt", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  ux.posture(scope, "owner", "quiet");
  let calls = 0;
  await ux.drain(async () => {
    calls++;
  });
  expect(calls).toBe(0);
  ux.posture(scope, "owner", "away");
  let finish: (() => void) | undefined;
  await ux.drain(
    async () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    1000,
    1
  );
  finish?.();
  await Promise.resolve();
  expect(
    (
      db
        .prepare(
          "SELECT COUNT(*) n FROM attention_deliveries WHERE state='delivered'"
        )
        .get() as { n: number }
    ).n
  ).toBe(0);
});
it("foreground refuses unknown subjects and cannot fake handoff coverage", () => {
  const { ux, scope } = setup();
  expect(() =>
    ux.foreground(scope, [{ subject_id: "missing", source_version: 1 }])
  ).toThrow("subject_not_covered");
  expect(() => ux.handoff(scope, "unknown", "0".repeat(64))).toThrow(
    "invalid_foreground"
  );
});
it("suppresses queued questions once their revision is resolved", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  db.exec(
    "UPDATE attention_items SET state='continued_externally',revision=revision+1"
  );
  let sent = 0;
  for (let i = 0; i < 5; i++)
    await ux.drain(async () => {
      sent++;
    });
  expect(sent).toBe(0);
  expect(
    (
      db
        .prepare(
          "SELECT COUNT(*) n FROM attention_deliveries WHERE state='superseded'"
        )
        .get() as { n: number }
    ).n
  ).toBe(5);
});

it("drains bounded batches without losing the remaining queue or deduplication identity", async () => {
  const { ux, scope, store, owner, db } = setup();
  for (let i = 5; i < 100; i++) store.projectDecision(owner, {
    scopeId: scope, sessionId: "s", turnId: `turn${i}`, sourceVersion: 1,
    decision: { decision_id: "d", question: `Question ${i}`, choices: [] }, now: i,
  });
  ux.enqueue(scope);
  const sent: string[] = [];
  const send = async (item: { delivery_id: string }) => { sent.push(item.delivery_id); };
  expect(await ux.drainBatch(send, { maxItems: 20 })).toMatchObject({ processed: 20, attempted: 20, delivered: 20, remainingDue: 80, stopped: "limit" });
  expect(await ux.drainBatch(send, { maxItems: 20 })).toMatchObject({ delivered: 20, remainingDue: 60 });
  expect(new Set(sent).size).toBe(40);
  expect(db.prepare("SELECT COUNT(*) n FROM attention_deliveries WHERE state='delivered'").get()).toEqual({ n: 40 });
  ux.enqueue(scope);
  expect(db.prepare("SELECT COUNT(*) n FROM attention_deliveries").get()).toEqual({ n: 100 });
});

it("counts superseded items toward bounded work and does not let them starve valid notices", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  db.exec("UPDATE attention_items SET revision=revision+1 WHERE item_id IN (SELECT item_id FROM attention_deliveries ORDER BY delivery_id LIMIT 2)");
  let calls = 0;
  const result = await ux.drainBatch(async () => { if (++calls === 1) throw new Error("transport unavailable"); }, { maxItems: 5 });
  expect(result).toMatchObject({ processed: 5, attempted: 3, superseded: 2, retried: 1, delivered: 2, remainingDue: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM attention_deliveries WHERE state='pending' AND attempts=1").get()).toEqual({ n: 1 });
});

it("rechecks quiet posture between claimed notifications", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  const result = await ux.drainBatch(async () => { ux.posture(scope, "owner", "quiet"); });
  expect(result).toMatchObject({ delivered: 1, processed: 1, remainingDue: 0, stopped: "empty" });
  expect(db.prepare("SELECT COUNT(*) n FROM attention_deliveries WHERE state='pending' AND attempts=0").get()).toEqual({ n: 4 });
});

it("bounds a hung sender by the batch deadline and ignores its late completion", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  let finish: (() => void) | undefined;
  let aborted = false;
  const result = await ux.drainBatch(async (_item, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    await new Promise<void>(resolve => { finish = resolve; });
  }, { maxItems: 5, maxDurationMs: 10 });
  expect(result).toMatchObject({ attempted: 1, delivered: 0, retried: 1, stopped: "deadline" });
  expect(aborted).toBe(true);
  finish?.();
  await Promise.resolve();
  expect(db.prepare("SELECT COUNT(*) n FROM attention_deliveries WHERE state='delivered'").get()).toEqual({ n: 0 });
});

it("cancels a batch in flight without taking more receipts, and pre-abort takes none", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  const controller = new AbortController();
  let calls = 0;
  const result = await ux.drainBatch(async () => { calls++; controller.abort(); await new Promise<void>(() => {}); }, { signal: controller.signal });
  expect(result).toMatchObject({ attempted: 1, cancelled: 1, retried: 0, stopped: "aborted" });
  expect(await ux.drainBatch(async () => { calls++; }, { signal: controller.signal })).toMatchObject({ processed: 0, stopped: "aborted" });
  expect(calls).toBe(1);
  expect(db.prepare("SELECT COUNT(*) n FROM attention_deliveries WHERE attempts=0").get()).toEqual({ n: 5 });
});

it("rejects unbounded batch options before taking a receipt", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  for (const options of [{ maxItems: 0 }, { maxItems: 101 }, { maxItems: 1.5 }, { maxDurationMs: Infinity }, { maxDurationMs: 0 }]) {
    await expect(ux.drainBatch(async () => {}, options)).rejects.toThrow("invalid_delivery_batch_bounds");
  }
  expect(db.prepare("SELECT SUM(attempts) n FROM attention_deliveries").get()).toEqual({ n: 0 });
});

it("claims distinct delivery IDs across concurrent bounded drains", async () => {
  const { ux, scope } = setup();
  ux.enqueue(scope);
  const sent: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const first = ux.drainBatch(async item => { sent.push(item.delivery_id); await hold; }, { maxItems: 1 });
  await Promise.resolve();
  const second = await ux.drainBatch(async item => { sent.push(item.delivery_id); });
  expect(second.delivered).toBe(4);
  release();
  expect((await first).delivered).toBe(1);
  expect(sent).toHaveLength(5);
  expect(new Set(sent).size).toBe(5);
});

it("does not overwrite a changed receipt and counts terminal delivery failures", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  expect(await ux.drainBatch(async item => {
    db.prepare("UPDATE attention_deliveries SET state='pending' WHERE delivery_id=?").run(item.delivery_id);
  }, { maxItems: 1 })).toMatchObject({ attempted: 1, delivered: 0, stale: 1 });
  db.exec("UPDATE attention_deliveries SET attempts=4 WHERE delivery_id=(SELECT MIN(delivery_id) FROM attention_deliveries)");
  expect(await ux.drainBatch(async () => { throw new Error("offline"); }, { maxItems: 1 })).toMatchObject({ attempted: 1, deadLetters: 1, delivered: 0 });
});

 it("repeated caller cancellation does not exhaust the transport failure budget", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  for (let i = 0; i < 6; i++) {
    db.exec("UPDATE attention_deliveries SET next_at=0");
    const controller = new AbortController();
    expect(await ux.drainBatch(async () => { controller.abort(); await new Promise<void>(() => {}); }, {signal: controller.signal})).toMatchObject({ cancelled: 1, deadLetters: 0 });
  }
  expect(db.prepare("SELECT SUM(attempts) n FROM attention_deliveries").get()).toEqual({n: 0});
  expect(await ux.drainBatch(async () => {})).toMatchObject({deadLetters: 0});
});

it("returns a stale receipt after ownership changes during send", async () => {
  const { ux, scope, store } = setup();
  ux.enqueue(scope);
  expect(await ux.drainBatch(async () => { store.claimOwner("replacement"); }, {maxItems: 1})).toMatchObject({stale: 1, delivered: 0});
});
