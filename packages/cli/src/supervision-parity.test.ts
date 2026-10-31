// Comparison cases for upstream Firstmate supervision fixes (af1c681..df81d81).
// See docs/design/2026-10-30-firstmate-upstream-delta/supervision-parity.md.
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createScratchDirSync, openDb } from "@osstack/core";
import { SupervisionService, type SupervisionOptions } from "./supervision-service.js";

type Message = { delivery_id: string; scope_id: string; item_id: string };
type Sender = (message: Message, signal: AbortSignal) => Promise<void>;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.useRealTimers();
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function home() {
  const root = realpathSync(createScratchDirSync("tests", "supervision-parity"));
  const path = join(root, "state.db");
  const first = openDb({ path });
  first.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','task','running',1,1)");
  const dbs: Database.Database[] = [first];
  cleanup.push(() => {
    for (const db of dbs) if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  /** A later service is given its own connection, as a second daemon process would have. */
  const service = (sender?: Sender, options: SupervisionOptions = {}, db = first) => {
    const svc = new SupervisionService(db, path, sender as never, options);
    cleanup.push(() => svc.stop());
    return svc;
  };
  return { root, path, first, open: () => { const db = openDb({ path }); dbs.push(db); return db; }, service };
}
function decide(svc: SupervisionService, scopeId: string, turn: string, now = Date.now()) {
  svc.store.projectDecision(svc.observer.owner, {
    scopeId, sessionId: "s", turnId: turn, sourceVersion: 1,
    decision: { decision_id: "d", question: `Choose ${turn}`, choices: [] }, now,
  });
}

// Upstream 6613c3e: an actionable heartbeat backstop counted as an idle
// heartbeat, so the doubled idle interval kept growing and the next real wake
// surfaced late. OSStack's periodic pass has no idle backoff, and retry
// backoff is per delivery row, so one failing notice never delays another.
it("keeps a fixed pass cadence across idle passes and delivers a pass-found decision despite another notice's retry backoff", async () => {
  vi.useFakeTimers();
  const h = home();
  const sent: Array<{ id: string; at: number }> = [];
  let failing = "";
  const svc = h.service(async (message) => {
    if (message.item_id === failing) throw new Error("transport down");
    sent.push({ id: message.delivery_id, at: Date.now() });
  });
  const scope = svc.store.registerScope(svc.observer.owner, "t", h.root);
  const passes: number[] = [];
  const enqueue = svc.experience.enqueue.bind(svc.experience);
  vi.spyOn(svc.experience, "enqueue").mockImplementation((id) => { passes.push(Date.now()); enqueue(id); });
  svc.start();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(30_000);
  expect(passes).toHaveLength(7);
  expect(new Set(passes.slice(1).map((at, i) => at - passes[i]!))).toEqual(new Set([30_000]));
  decide(svc, scope.scope_id, "a");
  failing = svc.store.listItems(scope.scope_id)[0]!.item_id;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(svc.store.db.prepare("SELECT state,attempts FROM attention_deliveries").get()).toEqual({ state: "pending", attempts: 1 });
  // B is found by the periodic pass alone: no dirty signal, no requestScan.
  decide(svc, scope.scope_id, "b");
  const passAt = Date.now() + 30_000;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sent.filter((m) => !m.id.startsWith(failing))).toEqual([{ id: expect.any(String), at: passAt }]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(passes.at(-1)! - passes.at(-2)!).toBe(30_000);
});

// Upstream 8cb06ff: a wake-grant command that failed to take the queue lock
// carried on as if it held it, so it could rewrite grant records and release
// another owner's lock. OSStack takes the write lock as a SQLite transaction:
// a lock or claim failure rolls back, leaves the delivery as it was, and never
// touches the other connection's transaction.
it("leaves deliveries and another writer's lock intact when the write lock cannot be taken, then delivers", async () => {
  const h = home();
  const sent: string[] = [];
  const svc = h.service(async (message) => { sent.push(message.delivery_id); });
  const scope = svc.store.registerScope(svc.observer.owner, "t", h.root);
  decide(svc, scope.scope_id, "a");
  svc.experience.enqueue(scope.scope_id);
  svc.store.db.pragma("busy_timeout = 20");
  const holder = h.open();
  holder.prepare("BEGIN IMMEDIATE").run();
  holder.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('held','held','running',1,1)").run();
  await svc.requestScan();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sent).toEqual([]);
  expect(holder.inTransaction).toBe(true);
  holder.prepare("COMMIT").run();
  expect(svc.store.db.prepare("SELECT state,attempts,error FROM attention_deliveries").get())
    .toEqual({ state: "pending", attempts: 0, error: null });
  expect(svc.store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE task_id='held'").get()).toEqual({ n: 1 });
  // Lock contention is not a take-over: the service keeps running.
  expect(svc.takenOver).toBe(false);
  await vi.waitFor(async () => {
    await svc.requestScan();
    expect(sent).toHaveLength(1);
  });
  expect(svc.store.db.prepare("SELECT state,attempts FROM attention_deliveries").get()).toEqual({ state: "delivered", attempts: 1 });
});
it("rolls back a failed delivery claim without sending, then sends exactly once", async () => {
  const h = home();
  const sent: string[] = [];
  const svc = h.service(async (message) => { sent.push(message.delivery_id); });
  const scope = svc.store.registerScope(svc.observer.owner, "t", h.root);
  decide(svc, scope.scope_id, "a");
  const db = svc.store.db;
  db.exec("CREATE TRIGGER fail_claim BEFORE UPDATE ON attention_deliveries WHEN NEW.state='sending' BEGIN SELECT RAISE(ABORT,'claim fault'); END");
  await svc.requestScan();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
  expect(db.prepare("SELECT state,attempts,error FROM attention_deliveries").get()).toEqual({ state: "pending", attempts: 0, error: null });
  expect(svc.takenOver).toBe(false);
  db.exec("DROP TRIGGER fail_claim");
  await vi.waitFor(async () => {
    await svc.requestScan();
    expect(sent).toHaveLength(1);
  });
  await svc.requestScan();
  expect(sent).toHaveLength(1);
});

// Upstream ffb2aca: a take-over that landed while the old watcher was blocked
// in a wait could not confirm the stop, and the fresh cycle resurfaced an
// episode main had already acknowledged. OSStack's take-over is a new owner
// generation; these cases run two services on one database file, each on its
// own connection.
it("take-over mid-send: the old receipt is fenced, the new owner resends once under the same id, and the old service stops", async () => {
  const h = home();
  const hung = deferred();
  let oldSignal: AbortSignal | undefined;
  const oldSent: string[] = [];
  const old = h.service(async (message, signal) => { oldSent.push(message.delivery_id); oldSignal = signal; await hung.promise; });
  const scope = old.store.registerScope(old.observer.owner, "t", h.root);
  decide(old, scope.scope_id, "done");
  decide(old, scope.scope_id, "a");
  const [doneItem, aItem] = old.store.listItems(scope.scope_id).sort((x, y) => x.decision.question.localeCompare(y.decision.question));
  // One notice is already delivered before the take-over.
  old.experience.enqueue(scope.scope_id);
  old.store.db.prepare("UPDATE attention_deliveries SET state='delivered',attempts=1 WHERE item_id=?").run(aItem!.item_id);
  await old.requestScan();
  await vi.waitFor(() => expect(oldSent).toEqual([`${doneItem!.item_id}:1`]));
  const newSent: string[] = [];
  const next = h.service(async (message) => { newSent.push(message.delivery_id); }, {}, h.open());
  expect(next.observer.owner.generation).toBe(old.observer.owner.generation + 1);
  await vi.waitFor(async () => {
    await next.requestScan();
    expect(newSent).toEqual([`${doneItem!.item_id}:1`]);
  });
  // The old service learns of the take-over at its next fenced access.
  await old.requestScan();
  expect(old.takenOver).toBe(true);
  expect(oldSignal?.aborted).toBe(true);
  await old.stop();
  hung.resolve();
  await Promise.resolve();
  const rows = next.store.db.prepare("SELECT item_id,state,attempts FROM attention_deliveries ORDER BY item_id").all();
  expect(rows).toEqual(expect.arrayContaining([
    { item_id: doneItem!.item_id, state: "delivered", attempts: 2 },
    { item_id: aItem!.item_id, state: "delivered", attempts: 1 },
  ]));
  await expect(old.handle("attention.inventory", { scope_id: scope.scope_id })).rejects.toThrow("stale_owner");
  await next.requestScan();
  expect(newSent).toHaveLength(1);
  expect(oldSent).toHaveLength(1);
});
it("take-over before the old receipt: the late receipt cannot settle the row and stops the old service without another pass", async () => {
  const h = home();
  const hung = deferred();
  const old = h.service(async () => { await hung.promise; });
  const scope = old.store.registerScope(old.observer.owner, "t", h.root);
  decide(old, scope.scope_id, "a");
  await old.requestScan();
  await vi.waitFor(() => expect(old.store.db.prepare("SELECT state FROM attention_deliveries").get()).toEqual({ state: "sending" }));
  const newSent: string[] = [];
  const next = h.service(async (message) => { newSent.push(message.delivery_id); }, {}, h.open());
  // Construction reconciled the interrupted send for the new owner.
  expect(next.store.db.prepare("SELECT state,error FROM attention_deliveries").get()).toEqual({ state: "pending", error: "interrupted_delivery" });
  hung.resolve();
  await vi.waitFor(() => expect(old.takenOver).toBe(true));
  expect(next.store.db.prepare("SELECT state FROM attention_deliveries").get()).toEqual({ state: "pending" });
  await vi.waitFor(async () => {
    await next.requestScan();
    expect(newSent).toHaveLength(1);
  });
});
it("take-over mid-scan: the old in-flight source read cannot commit, and the old service stops while the new owner keeps observing", async () => {
  const h = home();
  const hung = deferred<unknown>();
  const old = h.service(undefined, { loopReader: () => hung.promise });
  const scope = old.store.registerScope(old.observer.owner, "t", h.root);
  const params = { scope_id: scope.scope_id, loop_id: "loop", state_path: join(h.root, "loop.json") };
  const read = old.handle("attention.loop", params);
  const rejected = expect(read).rejects.toThrow("stale_owner");
  const next = h.service(undefined, {
    loopReader: async (input) => ({ ...input, state: "snapshot_available", updated_at: new Date().toISOString(), in_progress: [], pending: [],
      completed_count: 0, wait: null, process_liveness: "unknown", coverage: "snapshot_only",
      gap: "best_effort_snapshot_no_event_replay", recovery_required: false }),
  }, h.open());
  hung.resolve({ loop_id: "loop", path: params.state_path, state: "snapshot_available", updated_at: "x", in_progress: [], pending: [],
    completed_count: 0, process_liveness: "unknown", coverage: "snapshot_only", gap: "best_effort_snapshot_no_event_replay", recovery_required: false });
  await rejected;
  expect(old.takenOver).toBe(true);
  await expect(next.handle("attention.loop", params)).resolves.toMatchObject({ state: "snapshot_available" });
  expect(next.store.db.prepare("SELECT generation FROM attention_subjects").get()).toEqual({ generation: next.observer.owner.generation });
  await next.requestScan();
  expect(next.takenOver).toBe(false);
});
it("a stopped old service's timer never wakes after a take-over", async () => {
  vi.useFakeTimers();
  const h = home();
  const old = h.service(async () => {});
  old.start();
  await vi.advanceTimersByTimeAsync(0);
  const step = vi.spyOn(old.observer, "step");
  h.service(async () => {}, {}, h.open());
  await vi.advanceTimersByTimeAsync(30_000);
  expect(old.takenOver).toBe(true);
  const calls = step.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(step.mock.calls.length).toBe(calls);
});
