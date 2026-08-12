import { describe, expect, it } from "vitest";
import { OVERFLOW_METHOD, RpcLatencyRecorder } from "./rpc-latency.js";

describe("RpcLatencyRecorder", () => {
  it("returns an empty snapshot before any observations", () => {
    expect(new RpcLatencyRecorder().snapshot()).toEqual([]);
  });

  it("computes p50/p95/max over recorded samples", () => {
    const rec = new RpcLatencyRecorder();
    for (let i = 1; i <= 100; i++) rec.record("stats", i);
    const [row] = rec.snapshot();
    expect(row).toBeDefined();
    expect(row!.method).toBe("stats");
    expect(row!.count).toBe(100);
    expect(row!.window).toBe(100);
    expect(row!.p50_ms).toBe(50);
    expect(row!.p95_ms).toBe(95);
    expect(row!.max_ms).toBe(100);
  });

  it("keeps a single sample consistent across percentiles", () => {
    const rec = new RpcLatencyRecorder();
    rec.record("version", 7);
    const [row] = rec.snapshot();
    expect(row!.p50_ms).toBe(7);
    expect(row!.p95_ms).toBe(7);
    expect(row!.max_ms).toBe(7);
    expect(row!.count).toBe(1);
    expect(row!.window).toBe(1);
  });

  it("bounds the percentile window at 512 samples but counts lifetime totals", () => {
    const rec = new RpcLatencyRecorder();
    // 1000 slow samples first, then 512 fast ones: the ring must have
    // evicted every slow sample, while count still reflects all 1512.
    for (let i = 0; i < 1000; i++) rec.record("task.submit", 500);
    for (let i = 0; i < 512; i++) rec.record("task.submit", 1);
    const [row] = rec.snapshot();
    expect(row!.count).toBe(1512);
    expect(row!.window).toBe(512);
    expect(row!.p50_ms).toBe(1);
    expect(row!.p95_ms).toBe(1);
    // max is lifetime, not windowed — it keeps the historical worst case.
    expect(row!.max_ms).toBe(500);
  });

  it("tracks methods independently and sorts by descending p95", () => {
    const rec = new RpcLatencyRecorder();
    rec.record("version", 1);
    rec.record("session.start", 200);
    rec.record("stats", 20);
    const rows = rec.snapshot();
    expect(rows.map((r) => r.method)).toEqual(["session.start", "stats", "version"]);
  });

  it("caps distinct methods and folds overflow into the (other) bucket", () => {
    const rec = new RpcLatencyRecorder();
    // Method names come from client frames — a hostile or buggy client can
    // send unbounded distinct names. The map must stop growing at the cap.
    for (let i = 0; i < 500; i++) rec.record(`spam.${i}`, 1);
    const rows = rec.snapshot();
    expect(rows.length).toBe(65); // 64 real windows + the overflow bucket
    const other = rows.find((r) => r.method === OVERFLOW_METHOD);
    expect(other).toBeDefined();
    expect(other!.count).toBe(500 - 64);

    // Methods that already own a window keep recording into it.
    rec.record("spam.0", 9);
    const updated = rec.snapshot().find((r) => r.method === "spam.0");
    expect(updated!.count).toBe(2);
    expect(rec.snapshot().length).toBe(65);
  });

  it("ignores negative and non-finite durations", () => {
    const rec = new RpcLatencyRecorder();
    rec.record("stats", -1);
    rec.record("stats", Number.NaN);
    rec.record("stats", Number.POSITIVE_INFINITY);
    expect(rec.snapshot()).toEqual([]);
  });
});
