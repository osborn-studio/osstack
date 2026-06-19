import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Scheduler,
  cronExpressionMatches,
  nextCronDelayMs,
  validateCronExpression,
} from "./scheduler.js";
import { SchedulerConfig } from "./types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Scheduler", () => {
  it("manual mode should fire exactly once", async () => {
    const scheduler = new Scheduler(SchedulerConfig.parse({ mode: "manual" }));

    scheduler.start();

    await expect(scheduler.wait()).resolves.toEqual({ cycle: 1 });
    await expect(scheduler.wait()).resolves.toBeNull();
  });

  it("goal mode should stop when the supplied goal is met", async () => {
    const scheduler = new Scheduler(SchedulerConfig.parse({ mode: "goal" }));

    scheduler.start();

    await expect(scheduler.wait(async () => true)).resolves.toEqual({
      cycle: 1,
      goal_met: true,
    });
    await expect(scheduler.wait()).resolves.toBeNull();
  });

  it("goal mode continues when no goal checker is provided", async () => {
    const scheduler = new Scheduler(SchedulerConfig.parse({ mode: "goal" }));

    scheduler.start();

    await expect(scheduler.wait()).resolves.toEqual({ cycle: 1 });
    expect(scheduler.currentCycle).toBe(1);
    expect(scheduler.isRunning).toBe(true);
  });

  it("interval mode waits between repeated ticks", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler(SchedulerConfig.parse({
      mode: "interval",
      interval_ms: 1_000,
      min_interval_ms: 1_000,
    }));

    scheduler.start();

    await expect(scheduler.wait()).resolves.toEqual({ cycle: 1 });
    const second = scheduler.wait();
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    second.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual({ cycle: 2 });
  });

  it("stops explicitly and when max runtime is exhausted", async () => {
    const stopped = new Scheduler(SchedulerConfig.parse({ mode: "manual" }));
    stopped.start();
    stopped.stop();

    await expect(stopped.wait()).resolves.toBeNull();
    expect(stopped.isRunning).toBe(false);

    const exhausted = new Scheduler(SchedulerConfig.parse({ mode: "manual", max_runtime_ms: 0 }));
    exhausted.start();

    await expect(exhausted.wait()).resolves.toBeNull();
  });

  it("matches and validates simple 5-field cron expressions", () => {
    const date = new Date(2026, 5, 19, 6, 0, 0);
    const sunday = new Date(2026, 5, 21, 6, 0, 0);

    expect(cronExpressionMatches("0 6 * * *", date)).toBe(true);
    expect(cronExpressionMatches("0,30 6 * * *", date)).toBe(true);
    expect(cronExpressionMatches("0 6 * * 7", sunday)).toBe(true);
    expect(cronExpressionMatches("30 6 * * *", date)).toBe(false);
    expect(cronExpressionMatches("0 6 * *", date)).toBe(false);
    expect(validateCronExpression("0 24 * * *")?.message).toContain("outside 0-23");
    expect(validateCronExpression("x 6 * * *")?.message).toContain("not an integer");
    expect(validateCronExpression("0 6 * *")?.message).toContain("5 fields");
  });

  it("computes the delay to the next cron minute", () => {
    const from = new Date(2026, 5, 19, 5, 59, 30);

    expect(nextCronDelayMs("0 6 * * *", from)).toBe(30_000);
    expect(nextCronDelayMs("* * * * *", from, { includeCurrentMinute: true })).toBe(0);
    expect(nextCronDelayMs("* * * * *", from)).toBe(30_000);
    expect(nextCronDelayMs("0 24 * * *", from)).toBeInstanceOf(Error);
  });
});
