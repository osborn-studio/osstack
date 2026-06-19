// Discover — scan for work.
//
// Scanners implement DiscoverScanner and return Task[].
// The MVP ships with GitDiffScanner (reads `git diff --stat`).
//
// Future scanners (L2+):
//   - GhIssueScanner: `gh issue list --json` → Task[]
//   - CiLogScanner: parse CI failure logs → Task[]
//   - TaskQueueScanner: read tasks/ YAML files → Task[]

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Task, type DiscoverSource, type DiscoverScanner } from "./types.js";

// ── Factory ─────────────────────────────────────────────────────────────

/** Create a scanner for the given source type. */
export function createScanner(source: DiscoverSource, workspacePath: string): DiscoverScanner {
  switch (source) {
    case "git_diff":
      return new GitDiffScanner(workspacePath);
    case "task_queue":
      return new TaskQueueScanner(workspacePath);
    default:
      return new NoopScanner(source);
  }
}

// ── GitDiffScanner ──────────────────────────────────────────────────────

export class GitDiffScanner implements DiscoverScanner {
  readonly source: DiscoverSource = "git_diff";

  constructor(private workspacePath: string) {}

  async scan(): Promise<Task[]> {
    try {
      const diffStat = execSync("git diff --stat", {
        cwd: this.workspacePath,
        encoding: "utf-8",
        timeout: 10_000,
      });

      if (!diffStat || diffStat.trim() === "") return [];

      const lines = diffStat.trim().split("\n");
      const tasks: Task[] = [];

      for (const line of lines) {
        // Parse "file.ts | 12 +++++++++---"
        const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)/);
        if (!match) continue;

        const file = match[1]!.trim();
        const changes = parseInt(match[2]!, 10);

        tasks.push({
          task_id: randomUUID(),
          capability: "code.review",
          prompt: `Review changes in ${file} (${changes} lines modified). Check for correctness, style, and potential issues.`,
          priority: Math.min(changes * 5, 100),
          source: "git_diff",
          context: {
            file,
            change_lines: changes,
            diff_stat: line,
          },
        });
      }

      return tasks.sort((a, b) => b.priority - a.priority);
    } catch {
      // Not a git repo or git not available — no tasks
      return [];
    }
  }
}

// ── TaskQueueScanner ────────────────────────────────────────────────────

export class TaskQueueScanner implements DiscoverScanner {
  readonly source: DiscoverSource = "task_queue";

  constructor(private workspacePath: string) {}

  async scan(): Promise<Task[]> {
    const taskDir = join(this.workspacePath, "tasks");
    let entries: string[];
    try {
      entries = await readdir(taskDir);
    } catch {
      return [];
    }

    const tasks: Task[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const path = join(taskDir, entry);
      try {
        const raw = JSON.parse(await readFile(path, "utf-8")) as unknown;
        const parsed = TaskQueueFile.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          tasks.push(Task.parse({
            task_id: item.task_id ?? randomUUID(),
            capability: item.capability ?? "code.write",
            prompt: item.prompt,
            priority: item.priority ?? 50,
            source: "task_queue",
            context: {
              ...(item.context ?? {}),
              task_file: path,
            },
          }));
        }
      } catch {
        // Ignore malformed queue entries; future versions should surface these
        // as loop.error events without stopping discovery from other files.
      }
    }

    return tasks.sort((a, b) => b.priority - a.priority);
  }
}

const TaskQueueItem = z.object({
  task_id: z.string().optional(),
  capability: z.string().optional(),
  prompt: z.string().min(1),
  priority: z.number().min(0).max(100).optional(),
  context: z.record(z.unknown()).optional(),
});
const TaskQueueFile = z.union([TaskQueueItem, z.array(TaskQueueItem)]);

// ── NoopScanner ─────────────────────────────────────────────────────────

class NoopScanner implements DiscoverScanner {
  constructor(readonly source: DiscoverSource) {}
  async scan(): Promise<Task[]> {
    return [];
  }
}
