import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiscoveryPolicy } from "./discovery-policy.js";
import { LoopEngine } from "./loop-engine.js";
import { readLoopState } from "./state-file.js";
import type { Task } from "./types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-loop-waiting-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Loop Test", "-c", "user.email=loop@example.test", "commit", "--allow-empty", "-m", "fixture"], {
    cwd: workspace, stdio: "ignore",
  });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const task: Task = {
  task_id: "waiting-task",
  capability: "code.test",
  prompt: "Run the requested check",
  priority: 50,
  source: "manual",
};

describe("LoopEngine waiting reasons", () => {
  it.each(["needs_approval", "suggest_only", "blocked"] as const)(
    "reports %s work as deferred rather than completed or idle",
    async (authorization) => {
      const result = await new LoopEngine({
        workspacePath: workspace,
        inputTasks: [task],
        discoveryPolicy: DiscoveryPolicy.parse({ default_authorization: authorization }),
        executeCommand: "node -e \"require('fs').writeFileSync('executed.txt','unexpected')\"",
      }).runCycles({ cycles: 5, stopWhenIdle: true });

      const waitReason = {
        code: "discovery_deferred",
        needs_approval: Number(authorization === "needs_approval"),
        suggest_only: Number(authorization === "suggest_only"),
        blocked: Number(authorization === "blocked"),
      };
      expect(result.cycles).toHaveLength(1);
      expect(result.cycles[0]?.executedTaskCount).toBe(0);
      expect(result.state.completed_tasks).toEqual([]);
      expect(result.state).toMatchObject({ wait_reason: waitReason });
      expect(result.state.deferred_tasks).toMatchObject([{ authorization, task: { task_id: task.task_id } }]);
      expect(result.events.at(-1)?.payload).toMatchObject({
        reason_code: "discovery_deferred",
        wait_reason: waitReason,
      });
      expect(result.events.at(-1)?.payload?.["reason"]).not.toBe("manual run completed");
      expect(result.events.some((event) => event.type === "loop.execute.done")).toBe(false);
      await expect(readFile(join(workspace, "executed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readLoopState(result.jsonPath)).resolves.toMatchObject({ wait_reason: waitReason });
      const markdown = await readFile(result.markdownPath, "utf8");
      expect(markdown).toContain("## Waiting");
      expect(markdown).toContain("discovery_deferred");
      expect(markdown).toContain("No discovered task is authorized to execute.");
      expect(markdown).toContain(task.task_id);
    },
  );

  it("finishes executable work before reporting the remaining deferred work", async () => {
    const result = await new LoopEngine({
      workspacePath: workspace,
      inputTasks: [task, { ...task, task_id: "allowed-task", capability: "code.fix" }],
      discoveryPolicy: DiscoveryPolicy.parse({
        default_authorization: "needs_approval",
        auto_execute_capabilities: ["code.fix"],
      }),
      executeCommand: "true",
    }).runCycles({ cycles: 5, stopWhenIdle: true });

    expect(result.cycles).toHaveLength(2);
    expect(result.cycles[0]?.executedTaskCount).toBe(1);
    expect(result.cycles[0]?.state.wait_reason).toBeUndefined();
    expect(result.cycles[0]?.state.deferred_tasks).toHaveLength(1);
    expect(result.cycles[1]?.skippedTaskCount).toBe(1);
    expect(result.state.completed_tasks.map((completed) => completed.task_id)).toEqual(["allowed-task"]);
    expect(result.state.wait_reason).toEqual({
      code: "discovery_deferred", needs_approval: 1, suggest_only: 0, blocked: 0,
    });
  });

  it("distinguishes an executed run from a later genuinely idle cycle", async () => {
    const options = { workspacePath: workspace, inputTasks: [task], executeCommand: "true" };
    const completed = await new LoopEngine(options).runOnce();
    const idle = await new LoopEngine(options).runCycles({ cycles: 5, stopWhenIdle: true });

    expect(completed.state.wait_reason).toBeUndefined();
    expect(completed.events.at(-1)?.payload?.["reason_code"]).toBe("completed");
    expect(idle.cycles).toHaveLength(1);
    expect(idle.cycles[0]?.skippedTaskCount).toBe(1);
    expect(idle.state.wait_reason).toBeUndefined();
    expect(idle.events.at(-1)?.payload?.["reason_code"]).toBe("idle");
  });

  it.each(["authorized", "removed"] as const)(
    "clears persisted waiting state when the deferred task is %s",
    async (change) => {
      const waiting = await new LoopEngine({
        workspacePath: workspace,
        inputTasks: [task],
        discoveryPolicy: DiscoveryPolicy.parse({}),
      }).runOnce();
      expect(waiting.state.wait_reason?.code).toBe("discovery_deferred");
      expect(waiting.events.at(-1)?.payload?.["reason_code"]).toBe("discovery_deferred");
      const result = await new LoopEngine({
        workspacePath: workspace,
        inputTasks: change === "authorized" ? [task] : [],
        discoveryPolicy: DiscoveryPolicy.parse({ default_authorization: "auto_execute" }),
        executeCommand: "true",
      }).runOnce();

      expect(result.executedTaskCount).toBe(change === "authorized" ? 1 : 0);
      expect(result.state.wait_reason).toBeUndefined();
      expect((await readLoopState(result.jsonPath))?.wait_reason).toBeUndefined();
      await expect(readFile(result.markdownPath, "utf8")).resolves.not.toContain("## Waiting");
    },
  );
});
