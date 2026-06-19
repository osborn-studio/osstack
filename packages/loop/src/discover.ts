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
import type { Task, DiscoverSource, DiscoverScanner } from "./types.js";

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

  constructor(_workspacePath: string) {}

  async scan(): Promise<Task[]> {
    // MVP: no-op. Future: read tasks/**/*.yaml or tasks/**/*.md
    return [];
  }
}

// ── NoopScanner ─────────────────────────────────────────────────────────

class NoopScanner implements DiscoverScanner {
  constructor(readonly source: DiscoverSource) {}
  async scan(): Promise<Task[]> {
    return [];
  }
}
