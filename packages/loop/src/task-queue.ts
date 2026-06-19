import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { Task, type CompletedTask, type Task as LoopTask } from "./types.js";

export interface EnqueueTaskInput {
  workspacePath: string;
  prompt: string;
  capability?: string;
  priority?: number;
  taskId?: string;
  context?: Record<string, unknown>;
}

export interface EnqueuedTask {
  task: LoopTask;
  path: string;
}

export interface ArchiveTaskResult {
  archived: boolean;
  reason?: string;
  fromPath?: string;
  toPath?: string;
}

export async function enqueueTask(input: EnqueueTaskInput): Promise<EnqueuedTask> {
  const taskId = input.taskId ?? `task_${randomUUID().slice(0, 8)}`;
  const task = Task.parse({
    task_id: taskId,
    capability: input.capability ?? "code.write",
    prompt: input.prompt,
    priority: input.priority ?? 50,
    source: "task_queue",
    ...(input.context !== undefined ? { context: input.context } : {}),
  });
  const taskDir = join(input.workspacePath, "tasks");
  await mkdir(taskDir, { recursive: true });
  const path = await uniqueTaskPath(taskDir, `${slugify(taskId)}.json`);
  await writeFile(path, `${JSON.stringify({
    task_id: task.task_id,
    capability: task.capability,
    prompt: task.prompt,
    priority: task.priority,
    ...(task.context !== undefined ? { context: task.context } : {}),
  }, null, 2)}\n`, "utf-8");
  return { task, path };
}

export async function archiveCompletedTaskFile(
  task: LoopTask,
  completed: CompletedTask,
  workspacePath: string,
): Promise<ArchiveTaskResult> {
  if (completed.outcome !== "success") return { archived: false, reason: "task did not succeed" };
  const taskFile = typeof task.context?.["task_file"] === "string"
    ? task.context["task_file"]
    : undefined;
  if (taskFile === undefined) return { archived: false, reason: "task has no task_file context" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(taskFile, "utf-8")) as unknown;
  } catch (error) {
    return { archived: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (Array.isArray(parsed)) return { archived: false, reason: "multi-task files are not auto-archived" };

  const item = TaskQueueItem.safeParse(parsed);
  if (!item.success) return { archived: false, reason: "task file is not a task queue item" };
  if (item.data.task_id !== task.task_id) return { archived: false, reason: "task file id does not match completed task" };

  const archiveDir = join(workspacePath, "tasks", "archive", new Date().toISOString().slice(0, 10));
  await mkdir(archiveDir, { recursive: true });
  const toPath = await uniqueTaskPath(archiveDir, basename(taskFile));
  await rename(taskFile, toPath);
  return { archived: true, fromPath: taskFile, toPath };
}

const TaskQueueItem = z.object({
  task_id: z.string(),
  capability: z.string().optional(),
  prompt: z.string().min(1),
  priority: z.number().min(0).max(100).optional(),
  context: z.record(z.unknown()).optional(),
});

async function uniqueTaskPath(dir: string, filename: string): Promise<string> {
  const base = filename.endsWith(".json") ? filename.slice(0, -5) : filename;
  for (let index = 0; index < 1_000; index++) {
    const candidate = join(dir, index === 0 ? `${base}.json` : `${base}-${index}.json`);
    try {
      await readFile(candidate, "utf-8");
    } catch {
      return candidate;
    }
  }
  throw new Error(`could not allocate unique task path for ${filename}`);
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? `task-${randomUUID().slice(0, 8)}` : slug;
}
