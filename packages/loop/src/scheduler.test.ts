import { describe, expect, it } from "vitest";
import { Scheduler } from "./scheduler.js";
import { SchedulerConfig } from "./types.js";

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
});
