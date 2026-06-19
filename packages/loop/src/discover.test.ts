import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitDiffScanner, TaskQueueScanner, createScanner } from "./discover.js";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
  git(["init"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "small.ts"), "export const small = 1;\n");
  writeFileSync(join(repo, "large.ts"), "export const large = 1;\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  return repo;
}

describe("discover scanners", () => {
  it("GitDiffScanner should produce prioritized review tasks for changed files", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "small.ts"), "export const small = 1;\nexport const next = 2;\n");
    writeFileSync(
      join(repo, "large.ts"),
      Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join("\n"),
    );

    const tasks = await new GitDiffScanner(repo).scan();

    expect(tasks.map((task) => task.context?.["file"])).toEqual(["large.ts", "small.ts"]);
    expect(tasks[0]).toMatchObject({
      capability: "code.review",
      source: "git_diff",
    });
    expect(tasks[0]!.priority).toBeGreaterThan(tasks[1]!.priority);
  });

  it("createScanner should create known scanners and noop unsupported sources", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    mkdirSync(join(repo, "tasks"));

    expect(createScanner("git_diff", repo)).toBeInstanceOf(GitDiffScanner);
    expect(createScanner("task_queue", repo)).toBeInstanceOf(TaskQueueScanner);
    await expect(createScanner("manual", repo).scan()).resolves.toEqual([]);
  });

  it("TaskQueueScanner should load JSON task queue entries", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osstack-loop-"));
    mkdirSync(join(repo, "tasks"));
    writeFileSync(join(repo, "tasks", "task.json"), JSON.stringify({
      task_id: "task-queue-1",
      capability: "code.test",
      prompt: "Run the test suite",
      priority: 90,
      context: { package: "@osstack/loop" },
    }));

    const tasks = await new TaskQueueScanner(repo).scan();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      task_id: "task-queue-1",
      capability: "code.test",
      prompt: "Run the test suite",
      priority: 90,
      source: "task_queue",
    });
    expect(tasks[0]!.context?.["task_file"]).toBe(join(repo, "tasks", "task.json"));
  });
});
