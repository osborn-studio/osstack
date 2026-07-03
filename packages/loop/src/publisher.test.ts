import { describe, expect, it, vi } from "vitest";
import {
  isSkillTask,
  PublishConfig,
  PublishResult,
  runPublish,
  skillIdOf,
  type RunPublishDeps,
} from "./publisher.js";
import type { Task } from "./types.js";

function baseConfig(overrides: Partial<PublishConfig> = {}): PublishConfig {
  return PublishConfig.parse(overrides);
}

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "task-1",
    capability: "code.fix",
    prompt: "do something",
    priority: 50,
    source: "manual",
    ...overrides,
  };
}

function instantDeps(runCommand: RunPublishDeps["runCommand"]): RunPublishDeps {
  return { runCommand, sleep: async () => {} };
}

function publishedJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract: "1.1",
    status: "published",
    id: "signals.group-effect-ledger",
    score: 100,
    gate: "team",
    committed: true,
    pushed: true,
    pipeline: "github-actions",
    apiVerified: true,
    apiVersion: "0.1.0",
    url: "https://api.osbornhub.com/api/skills/signals.group-effect-ledger",
    durationMs: 48213,
    reasons: [],
    message: "published",
    ...overrides,
  });
}

describe("isSkillTask", () => {
  it("is true when capability is skill.publish", () => {
    expect(isSkillTask(baseTask({ capability: "skill.publish" }))).toBe(true);
  });

  it("is true when context.publish.skillId is a non-empty string", () => {
    expect(isSkillTask(baseTask({ context: { publish: { skillId: "signals.foo" } } }))).toBe(true);
  });

  it("is false for a plain code.fix task with no publish context", () => {
    expect(isSkillTask(baseTask())).toBe(false);
  });

  it("is false when context.publish.skillId is an empty string", () => {
    expect(isSkillTask(baseTask({ context: { publish: { skillId: "" } } }))).toBe(false);
  });
});

describe("skillIdOf", () => {
  it("reads context.publish.skillId", () => {
    expect(skillIdOf(baseTask({ context: { publish: { skillId: "signals.foo" } } }))).toBe("signals.foo");
  });

  it("returns undefined when absent", () => {
    expect(skillIdOf(baseTask())).toBeUndefined();
  });
});

describe("runPublish", () => {
  it("P1: builds argv with gate, timeout, and no-push flag", async () => {
    const runCommand = vi.fn(async () => ({ stdout: publishedJson(), exitCode: 0 }));
    const cfg = baseConfig({ command: "/hub/osstack_publish.mjs", gate: "client", push: false, apiVerifyTimeoutMs: 1234 });

    await runPublish("signals.foo", cfg, instantDeps(runCommand));

    expect(runCommand).toHaveBeenCalledWith([
      "/hub/osstack_publish.mjs",
      "signals.foo",
      "--gate",
      "client",
      "--no-push",
      "--timeout-ms",
      "1234",
    ]);
  });

  it("P1b: omits --no-push when push is true (default)", async () => {
    const runCommand = vi.fn(async () => ({ stdout: publishedJson(), exitCode: 0 }));
    const cfg = baseConfig({ command: "/hub/osstack_publish.mjs" });

    await runPublish("signals.foo", cfg, instantDeps(runCommand));

    expect(runCommand).toHaveBeenCalledWith([
      "/hub/osstack_publish.mjs",
      "signals.foo",
      "--gate",
      "team",
      "--timeout-ms",
      "420000",
    ]);
  });

  it("P5: parses valid published JSON from the last line, ignoring log noise above it", async () => {
    const noisy = ["[info] locking...", "[info] promoting...", publishedJson()].join("\n");
    const runCommand = vi.fn(async () => ({ stdout: noisy, exitCode: 0 }));

    const result = await runPublish("signals.group-effect-ledger", baseConfig(), instantDeps(runCommand));

    expect(result).toMatchObject({
      status: "published",
      id: "signals.group-effect-ledger",
      score: 100,
      apiVerified: true,
    });
  });

  it("P6: blocked result passes through with reasons", async () => {
    const blocked = JSON.stringify({
      contract: "1.1",
      status: "blocked",
      id: "signals.foo",
      durationMs: 100,
      reasons: ["score<gate"],
      message: "blocked",
    });
    const runCommand = vi.fn(async () => ({ stdout: blocked, exitCode: 2 }));

    const result = await runPublish("signals.foo", baseConfig(), instantDeps(runCommand));

    expect(result).toMatchObject({ status: "blocked", reasons: ["score<gate"] });
  });

  it("P10: busy retries once with backoff, then succeeds", async () => {
    const busy = JSON.stringify({ contract: "1.1", status: "busy", id: "signals.foo", durationMs: 10 });
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: busy, exitCode: 1 })
      .mockResolvedValueOnce({ stdout: publishedJson({ id: "signals.foo" }), exitCode: 0 });
    const sleep = vi.fn(async () => {});

    const result = await runPublish("signals.foo", baseConfig(), { runCommand, sleep });

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(result.status).toBe("published");
  });

  it("P11: malformed stdout synthesizes an error result without crashing", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "not json at all {{{", exitCode: 1 }));

    const result = await runPublish("signals.foo", baseConfig(), instantDeps(runCommand));

    expect(result).toMatchObject({
      contract: "1.1",
      status: "error",
      id: "signals.foo",
      durationMs: 0,
      reasons: ["malformed_output"],
    });
    expect(result.message).toContain("not json at all");
  });

  it("P11b: empty stdout synthesizes an error result", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", exitCode: 1 }));

    const result = await runPublish("signals.foo", baseConfig(), instantDeps(runCommand));

    expect(result.status).toBe("error");
    expect(result.reasons).toEqual(["malformed_output"]);
  });
});

describe("PublishResult schema", () => {
  it("P12: tolerates unknown extra keys via passthrough", () => {
    const parsed = PublishResult.safeParse({
      contract: "1.1",
      status: "published",
      id: "signals.foo",
      durationMs: 10,
      deployedSurfaces: ["api", "vercel"],
      somethingFuture: { nested: true },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>)["deployedSurfaces"]).toEqual(["api", "vercel"]);
    }
  });
});
