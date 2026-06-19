import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveCompletedTaskFile, enqueueTask } from "./task-queue.js";
import type { CompletedTask, Task } from "./types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-task-queue-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("task queue", () => {
  it("enqueues a task JSON file under tasks/", async () => {
    const result = await enqueueTask({
      workspacePath: workspace,
      taskId: "Fix failing tests",
      prompt: "Fix failing tests",
      capability: "code.test",
      priority: 80,
      context: { branch: "main" },
    });

    expect(result.path).toBe(join(workspace, "tasks", "fix-failing-tests.json"));
    expect(result.task).toMatchObject({
      task_id: "Fix failing tests",
      capability: "code.test",
      priority: 80,
      source: "task_queue",
      context: { branch: "main" },
    });
    await expect(readFile(result.path, "utf-8")).resolves.toContain('"prompt": "Fix failing tests"');
  });

  it("allocates unique queue filenames and slugifies empty ids", async () => {
    const first = await enqueueTask({
      workspacePath: workspace,
      taskId: "Fix failing tests",
      prompt: "First",
    });
    const second = await enqueueTask({
      workspacePath: workspace,
      taskId: "Fix failing tests",
      prompt: "Second",
    });
    const emptySlug = await enqueueTask({
      workspacePath: workspace,
      taskId: "!!!",
      prompt: "Generated slug",
    });

    expect(first.path).toBe(join(workspace, "tasks", "fix-failing-tests.json"));
    expect(second.path).toBe(join(workspace, "tasks", "fix-failing-tests-1.json"));
    expect(basename(emptySlug.path)).toMatch(/^task-[a-f0-9]{8}\.json$/);
  });

  it("archives a successful single-task queue file", async () => {
    const taskFile = join(workspace, "tasks", "task.json");
    await mkdir(join(workspace, "tasks"));
    await writeFile(taskFile, JSON.stringify({
      task_id: "task-1",
      capability: "code.write",
      prompt: "Ship it",
    }));

    const result = await archiveCompletedTaskFile(task("task-1", taskFile), completed("task-1", "success"), workspace);

    expect(result.archived).toBe(true);
    expect(result.fromPath).toBe(taskFile);
    expect(result.toPath).toContain(join(workspace, "tasks", "archive"));
    await expect(readFile(taskFile, "utf-8")).rejects.toThrow();
    await expect(readFile(result.toPath!, "utf-8")).resolves.toContain('"task_id":"task-1"');
  });

  it("leaves failed tasks and multi-task files in the queue", async () => {
    const failedFile = join(workspace, "tasks", "failed.json");
    const batchFile = join(workspace, "tasks", "batch.json");
    await mkdir(join(workspace, "tasks"));
    await writeFile(failedFile, JSON.stringify({
      task_id: "failed-task",
      prompt: "Keep visible",
    }));
    await writeFile(batchFile, JSON.stringify([
      { task_id: "batch-task", prompt: "Do one" },
      { task_id: "other-task", prompt: "Do two" },
    ]));

    const failed = await archiveCompletedTaskFile(
      task("failed-task", failedFile),
      completed("failed-task", "failed"),
      workspace,
    );
    const batch = await archiveCompletedTaskFile(
      task("batch-task", batchFile),
      completed("batch-task", "success"),
      workspace,
    );

    expect(failed).toMatchObject({ archived: false, reason: "task did not succeed" });
    expect(batch).toMatchObject({ archived: false, reason: "multi-task files are not auto-archived" });
    await expect(readFile(failedFile, "utf-8")).resolves.toContain("failed-task");
    await expect(readFile(batchFile, "utf-8")).resolves.toContain("batch-task");
  });

  it("reports why successful tasks cannot be archived", async () => {
    const badJsonFile = join(workspace, "tasks", "bad-json.json");
    const invalidItemFile = join(workspace, "tasks", "invalid.json");
    const mismatchFile = join(workspace, "tasks", "mismatch.json");
    await mkdir(join(workspace, "tasks"));
    await writeFile(badJsonFile, "{", "utf-8");
    await writeFile(invalidItemFile, JSON.stringify({ task_id: "invalid", prompt: "" }), "utf-8");
    await writeFile(mismatchFile, JSON.stringify({ task_id: "actual", prompt: "Ship" }), "utf-8");

    await expect(archiveCompletedTaskFile(
      {
        task_id: "no-file",
        capability: "code.write",
        prompt: "Prompt",
        priority: 50,
        source: "task_queue",
      },
      completed("no-file", "success"),
      workspace,
    )).resolves.toMatchObject({ archived: false, reason: "task has no task_file context" });
    await expect(archiveCompletedTaskFile(
      task("bad-json", badJsonFile),
      completed("bad-json", "success"),
      workspace,
    )).resolves.toMatchObject({ archived: false });
    await expect(archiveCompletedTaskFile(
      task("invalid", invalidItemFile),
      completed("invalid", "success"),
      workspace,
    )).resolves.toMatchObject({ archived: false, reason: "task file is not a task queue item" });
    await expect(archiveCompletedTaskFile(
      task("expected", mismatchFile),
      completed("expected", "success"),
      workspace,
    )).resolves.toMatchObject({ archived: false, reason: "task file id does not match completed task" });
  });
});

function task(taskId: string, taskFile: string): Task {
  return {
    task_id: taskId,
    capability: "code.write",
    prompt: "Prompt",
    priority: 50,
    source: "task_queue",
    context: { task_file: taskFile },
  };
}

function completed(taskId: string, outcome: CompletedTask["outcome"]): CompletedTask {
  return {
    task_id: taskId,
    outcome,
    iterations: 1,
    agent_id: "local-command",
    duration_ms: 1,
  };
}
