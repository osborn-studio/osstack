// Discover — scan for work.
//
// Scanners implement DiscoverScanner and return Task[].
// The MVP ships with GitDiffScanner (reads `git diff --numstat -z`).
//
// Future scanners (L2+):
//   - GhIssueScanner: `gh issue list --json` → Task[]
//   - CiLogScanner: parse CI failure logs → Task[]
//   - TaskQueueScanner: read tasks/ YAML files → Task[]

import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanBranchStewardCandidates } from "@osstack/github";
import { parseTaskQueueFile } from "./task-queue.js";
import { Task, type DiscoverSource, type DiscoverScanner } from "./types.js";

// ── Factory ─────────────────────────────────────────────────────────────

/** Create a scanner for the given source type. */
export function createScanner(source: DiscoverSource, workspacePath: string): DiscoverScanner {
  switch (source) {
    case "git_diff":
      return new GitDiffScanner(workspacePath);
    case "github_branch":
      return new GitHubBranchScanner(workspacePath);
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
      const diffStat = execSync("git diff --numstat -z", {
        cwd: this.workspacePath,
        encoding: "utf-8",
        timeout: 10_000,
      });

      if (!diffStat) return [];

      const records = diffStat.split("\0");
      const tasks: Task[] = [];

      for (let index = 0; index < records.length; index++) {
        const line = records[index]!;
        // NUL termination preserves paths without display truncation or quoting.
        const match = line.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
        if (!match) continue;

        let file = match[3]!;
        if (file === "") {
          // Rename records store the old and new paths in the next two fields.
          file = records[index + 2] ?? "";
          index += 2;
        }
        if (!file || match[1] === "-" || match[2] === "-") continue;
        const changes = parseInt(match[1]!, 10) + parseInt(match[2]!, 10);

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

// ── GitHubBranchScanner ────────────────────────────────────────────────

export class GitHubBranchScanner implements DiscoverScanner {
  readonly source: DiscoverSource = "github_branch";

  constructor(private workspacePath: string) {}

  async scan(): Promise<Task[]> {
    const repo = inferGitHubRepoSlug(this.workspacePath);
    if (repo === undefined) return [];

    let report: Awaited<ReturnType<typeof scanBranchStewardCandidates>>;
    try {
      report = await scanBranchStewardCandidates(
        {
          repo,
          base: "main",
          remote: "origin",
          branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
          sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
          maxChangedFiles: 80,
          maxBehindBy: 25,
          prThreshold: 80,
          autoMergeThreshold: 90,
        },
        undefined,
        { cwd: this.workspacePath },
      );
    } catch {
      return [];
    }

    return report.candidates.map((candidate) =>
      Task.parse({
        task_id: githubBranchTaskId(candidate.head),
        capability: "release.verify",
        prompt: `Evaluate ${candidate.remote}/${candidate.head} for safe PR creation into ${candidate.base}.`,
        priority: candidate.score,
        source: "github_branch",
        context: {
          repo: candidate.repo,
          base: candidate.base,
          head: candidate.head,
          score: candidate.score,
          action: candidate.action,
          reasons: candidate.reasons,
        },
      }),
    );
  }
}

function githubBranchTaskId(head: string): string {
  const sanitizedHead = head.replace(/[^a-zA-Z0-9._-]/g, "-");
  const stableHash = createHash("sha1").update(head).digest("hex").slice(0, 8);
  return `github-branch-${sanitizedHead}-${stableHash}`;
}

function inferGitHubRepoSlug(workspacePath: string): string | undefined {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();

    return parseGitHubRepoSlug(remoteUrl);
  } catch {
    return undefined;
  }
}

function parseGitHubRepoSlug(remoteUrl: string): string | undefined {
  const match = remoteUrl.match(
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/,
  );
  return match?.[1];
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
        tasks.push(...parseTaskQueueFile(raw, { taskFile: path }));
      } catch {
        // Ignore malformed queue entries; future versions should surface these
        // as loop.error events without stopping discovery from other files.
      }
    }

    return tasks.sort((a, b) => b.priority - a.priority);
  }
}

// ── NoopScanner ─────────────────────────────────────────────────────────

class NoopScanner implements DiscoverScanner {
  constructor(readonly source: DiscoverSource) {}
  async scan(): Promise<Task[]> {
    return [];
  }
}
