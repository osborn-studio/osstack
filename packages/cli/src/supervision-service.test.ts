import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { attentionDigest, createScratchDirSync, openDb } from "@osstack/core";
import { SupervisionService, type SupervisionOptions } from "./supervision-service.js";
import { readAttentionLoop } from "./attention-loop-source.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  vi.useRealTimers();
});
function setup(options: SupervisionOptions = {}) {
  const root = realpathSync(createScratchDirSync("tests", "supervision-service"));
  const path = join(root, "state.db");
  const db = openDb({ path });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','task','running',1,1)");
  const service = new SupervisionService(db, path, undefined, options);
  const scope = service.store.registerScope(service.observer.owner, "t", root);
  cleanup.push(async () => {
    await service.stop();
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const params = (id = "loop") => ({ scope_id: scope.scope_id, loop_id: id, state_path: join(root, `${id}.json`) });
  const seed = (id = "loop") => {
    const p = params(id);
    db.prepare("INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'loop',?,?,0,1,1,1,?,?)")
      .run(scope.scope_id, id, attentionDigest([p.state_path, id]), service.observer.owner.generation, JSON.stringify({ state_path: p.state_path }));
  };
  return { service, db, root, scope, params, seed };
}
function snapshot(input: { loop_id: string; path: string }) {
  return { ...input, state: "snapshot_available", updated_at: new Date().toISOString(), in_progress: [], pending: [],
    completed_count: 0, wait: null, process_liveness: "unknown", coverage: "snapshot_only",
    gap: "best_effort_snapshot_no_event_replay", recovery_required: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
it("starts once and makes stop terminal before any later database access", async () => {
  vi.useFakeTimers();
  const { service, db } = setup();
  const tick = vi.spyOn(service.observer, "tick");
  service.start();
  service.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(tick).toHaveBeenCalledTimes(1);
  await service.stop();
  db.close();
  expect(() => service.start()).toThrow("supervision_stopped");
  await expect(service.handle("attention.inventory", { scope_id: "x" }))
    .rejects.toThrow("supervision_stopped");
  await vi.advanceTimersByTimeAsync(60000);
  expect(tick).toHaveBeenCalledTimes(1);
});
it("coalesces dirty passes and times out a stalled source without starving another", async () => {
  vi.useFakeTimers();
  const hanging = deferred<unknown>();
  const reader = vi.fn(async (input) => input.loop_id === "bad" ? hanging.promise : snapshot(input));
  const { service, db, seed } = setup({ loopReader: reader, readTimeoutMs: 20 });
  seed("bad"); seed("good");
  const tick = vi.spyOn(service.observer, "tick");
  const first = service.requestScan();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 100; i++) void service.requestScan("dirty");
  await vi.advanceTimersByTimeAsync(25);
  await first;
  expect(tick).toHaveBeenCalledTimes(2);
  expect(reader.mock.calls.filter(([input]) => input.loop_id === "bad")).toHaveLength(1);
  const rows = db.prepare("SELECT subject_id,payload_json FROM attention_subjects ORDER BY subject_id").all();
  expect(JSON.stringify(rows)).toContain("timeout");
  expect(JSON.stringify(rows)).toContain("snapshot_available");
  hanging.resolve(snapshot({ loop_id: "bad", path: "/ignored" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(db.prepare("SELECT payload_json FROM attention_subjects WHERE subject_id='bad'").get())).toContain("timeout");
});
it("aborts RPC readers and joins logical work without waiting for physical IO", async () => {
  const hanging = deferred<unknown>();
  const reader = vi.fn<NonNullable<SupervisionOptions["loopReader"]>>(() => hanging.promise);
  const { service, db, params } = setup({ loopReader: reader });
  const read = service.handle("attention.loop", params());
  await Promise.resolve();
  await service.stop();
  expect(reader.mock.calls[0]![0].signal.aborted).toBe(true);
  await expect(read).resolves.toMatchObject({ state: "unknown", reason: "aborted" });
  db.close();
  hanging.resolve(snapshot({ loop_id: "loop", path: params().state_path }));
  await Promise.resolve(); await Promise.resolve();
  await expect(service.requestScan()).rejects.toThrow("supervision_stopped");
});
it("does not resurrect a released source when an RPC read completes", async () => {
  const hanging = deferred<unknown>();
  const { service, db, params } = setup({ loopReader: () => hanging.promise });
  const p = params();
  const read = service.handle("attention.loop", p);
  await Promise.resolve();
  await service.handle("attention.release", { scope_id: p.scope_id, kind: "loop", subject_id: p.loop_id, expected_version: 0 });
  hanging.resolve(snapshot({ loop_id: p.loop_id, path: p.state_path }));
  await read;
  expect(db.prepare("SELECT admitted,payload_json FROM attention_subjects").get())
    .toMatchObject({ admitted: 0, payload_json: expect.stringContaining("owner_released") });
});
it("counts timed-out and released physical readers toward the global bound until settlement", async () => {
  vi.useFakeTimers();
  const hanging = deferred<unknown>();
  const reader = vi.fn<NonNullable<SupervisionOptions["loopReader"]>>(() => hanging.promise);
  const { service, params, db } = setup({ loopReader: reader, readTimeoutMs: 10 });
  const reads = Array.from({ length: 100 }, (_, i) => service.handle("attention.loop", params(`old${i}`)));
  await vi.advanceTimersByTimeAsync(11);
  expect(await Promise.all(reads)).toEqual(Array.from({ length: 100 }, () => expect.objectContaining({ reason: "timeout" })));
  expect(reader).toHaveBeenCalledTimes(100);
  for (let i = 0; i < 100; i++) {
    const p = params(`old${i}`);
    await service.handle("attention.release", { scope_id: p.scope_id, kind: "loop", subject_id: p.loop_id, expected_version: 0 });
  }
  expect(await service.handle("attention.loop", params("new"))).toMatchObject({ reason: "read_capacity_exceeded" });
  expect(reader).toHaveBeenCalledTimes(100);
  expect(JSON.stringify(db.prepare("SELECT payload_json FROM attention_subjects WHERE subject_id='new'").get())).toContain("read_capacity_exceeded");
  hanging.resolve({ state: "late" });
  await vi.advanceTimersByTimeAsync(0);
  reader.mockImplementation(async (input) => snapshot(input));
  expect(await service.handle("attention.loop", params("new"))).toMatchObject({ state: "snapshot_available" });
  expect(reader).toHaveBeenCalledTimes(101);
});
it.each([
  ["invalid returned payload", async () => ({}), "invalid_payload"],
  ["bad JSON", async () => { throw new SyntaxError("bad JSON"); }, "invalid_payload"],
  ["rejected reader", async () => { throw new Error("read failed"); }, "read_failed"],
] as const)("records %s independently and permits a later successful read", async (_label, failing, reason) => {
  const reader = vi.fn<NonNullable<SupervisionOptions["loopReader"]>>(failing);
  const { service, params, db } = setup({ loopReader: reader });
  expect(await service.handle("attention.loop", params())).toMatchObject({ state: "unknown", reason });
  expect(JSON.stringify(db.prepare("SELECT payload_json FROM attention_subjects").get())).toContain(reason);
  reader.mockImplementation(async (input) => snapshot(input));
  expect(await service.handle("attention.loop", params())).toMatchObject({ state: "snapshot_available" });
});
it("keeps source_missing distinct from reader rejection", async () => {
  const { service, params } = setup({ loopReader: readAttentionLoop });
  expect(await service.handle("attention.loop", params())).toMatchObject({ state: "source_missing" });
});
it("shares one physical read between an RPC and a scan", async () => {
  const hanging = deferred<unknown>();
  const reader = vi.fn<NonNullable<SupervisionOptions["loopReader"]>>(() => hanging.promise);
  const { service, params } = setup({ loopReader: reader });
  const rpc = service.handle("attention.loop", params());
  const pass = service.requestScan();
  await Promise.resolve(); await Promise.resolve();
  expect(reader).toHaveBeenCalledTimes(1);
  hanging.resolve(snapshot({ loop_id: "loop", path: params().state_path }));
  await Promise.all([rpc, pass]);
});
it("drops results after a binding replacement without changing the replacement", async () => {
  const hanging = deferred<unknown>();
  const { service, params, db } = setup({ loopReader: () => hanging.promise });
  const read = service.handle("attention.loop", params());
  db.prepare("UPDATE attention_subjects SET binding_hash='replacement',payload_json=?").run(JSON.stringify({ state: "replacement" }));
  hanging.resolve(snapshot({ loop_id: "loop", path: params().state_path }));
  await read;
  expect(db.prepare("SELECT payload_json FROM attention_subjects").get()).toEqual({ payload_json: '{"state":"replacement"}' });
});
it("fences a stale owner and lets the next service reobserve the persisted binding", async () => {
  const hanging = deferred<unknown>();
  const { service, params, db } = setup({ loopReader: () => hanging.promise });
  const read = service.handle("attention.loop", params());
  const rejected = expect(read).rejects.toThrow("stale_owner");
  const next = new SupervisionService(db, db.name, undefined, { loopReader: async (input) => snapshot(input) });
  try {
    hanging.resolve(snapshot({ loop_id: "loop", path: params().state_path }));
    await rejected;
    await expect(next.handle("attention.loop", params())).resolves.toMatchObject({ state: "snapshot_available" });
    expect(db.prepare("SELECT generation,payload_json FROM attention_subjects").get()).toMatchObject({
      generation: next.observer.owner.generation, payload_json: expect.stringContaining("snapshot_available"),
    });
  } finally { await next.stop(); }
});
it("waits for the bounded notification drain before stop resolves", async () => {
  const { service } = setup();
  const draining = deferred<void>();
  Object.defineProperty(service, "sender", { value: async () => {} });
  vi.spyOn(service.experience, "drain").mockReturnValue(draining.promise);
  await service.requestScan();
  let stopped = false;
  const stop = service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  draining.resolve();
  await stop;
  expect(stopped).toBe(true);
});
it("does not touch SQLite when a physical reader rejects after stop and close", async () => {
  const late = deferred<void>();
  const { service, db, params } = setup({ loopReader: async () => { await late.promise; throw new Error("late failure"); } });
  const read = service.handle("attention.loop", params());
  await Promise.resolve();
  await service.stop();
  db.close();
  const prepare = vi.spyOn(db, "prepare");
  const write = vi.spyOn(service.store, "write");
  late.resolve();
  await read;
  await Promise.resolve(); await Promise.resolve();
  expect(prepare).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it("isolates malformed saved Loop metadata and retries scans after a failed tick", async () => {
  const reader = vi.fn<NonNullable<SupervisionOptions["loopReader"]>>(async (input) => snapshot(input));
  const { service, seed, db } = setup({ loopReader: reader });
  seed("bad"); seed("good");
  db.prepare("UPDATE attention_subjects SET payload_json='{' WHERE subject_id='bad'").run();
  const tick = vi.spyOn(service.observer, "tick");
  tick.mockImplementationOnce(() => { throw new Error("disk busy"); });
  await service.requestScan();
  await service.requestScan();
  expect(reader).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(db.prepare("SELECT payload_json FROM attention_subjects WHERE subject_id='bad'").get())).toContain("invalid_payload");
  expect(JSON.stringify(db.prepare("SELECT payload_json FROM attention_subjects WHERE subject_id='good'").get())).toContain("snapshot_available");
});
it("does not lose a dirty signal between the last pass and promise cleanup", async () => {
  const { service } = setup();
  const tick = vi.spyOn(service.observer, "tick");
  vi.spyOn(service.experience, "enqueue").mockImplementationOnce(() => {
    queueMicrotask(() => queueMicrotask(() => { void service.requestScan("late dirty"); }));
  });
  await service.requestScan();
  expect(tick).toHaveBeenCalledTimes(2);
});
it("uses a one-second default logical deadline", async () => {
  vi.useFakeTimers();
  const { service, params } = setup({ loopReader: () => new Promise(() => {}) });
  let done = false;
  const read = service.handle("attention.loop", params()).then((result) => { done = true; return result; });
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await read).toMatchObject({ reason: "timeout" });
});
