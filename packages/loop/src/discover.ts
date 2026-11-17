// Discover — scan for work.
//
// Scanners implement DiscoverScanner and return Task[].
// The MVP ships with GitDiffScanner (reads `git diff --numstat -z`).
//
// Future scanners (L2+):
//   - GhIssueScanner: `gh issue list --json` → Task[]
//   - CiLogScanner: parse CI failure logs → Task[]
//   - TaskQueueScanner: read tasks/ YAML files → Task[]

import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
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
      const root = gitValue(this.workspacePath, ["rev-parse", "--show-toplevel"]);
      if (!root) return [];
      const diffStat = execFileSync("git", ["diff", "--numstat", "-z", "--", ":/"], {
        cwd: root, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
      });

      if (!diffStat) return [];

      const index = execFileSync("git", ["ls-files", "-s", "-z"], {
        cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
      });
      const indexIds = new Map<string, string>();
      for (const record of index.split("\0")) {
        const match = record.match(/^[0-9]+ ([a-f0-9]+) [0-3]\t([\s\S]+)$/);
        if (match) indexIds.set(match[2]!, match[1]!);
      }

      const records = diffStat.split("\0");
      const changed: { file: string; line: string; changes: number }[] = [];

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

        changed.push({ file, line, changes });
      }

      const present: string[] = [];
      const failed = new Set<string>();
      for (const { file } of changed) {
        try {
          if ((await stat(join(root, file))).isFile()) present.push(file);
          else failed.add(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed.add(file);
        }
      }
      const worktreeIds = await hashWorktreeFiles(root, present, indexIds);
      const presentSet = new Set(present);
      const tasks: Task[] = [];
      for (const { file, line, changes } of changed) {
        if (failed.has(file) || (presentSet.has(file) && !worktreeIds.has(file))) {
          console.warn(`git_diff: skipped ${file}: could not hash worktree file`);
          continue;
        }
        const fields = ["git_diff_blob_v1", file, indexIds.get(file) ?? "missing-index", worktreeIds.get(file) ?? "deleted-worktree"];
        const hash = createHash("sha256");
        for (const field of fields) hash.update(Buffer.from(`${Buffer.byteLength(field)}:`)).update(field);
        const taskId = `git-diff-${hash.digest("hex")}`;

        tasks.push({
          task_id: taskId,
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
    } catch (error) {
      console.warn("git_diff: scan failed", error);
      // Not a git repo or git not available — no tasks
      return [];
    }
  }
}

async function hashWorktreeFiles(root: string, files: string[], indexIds: Map<string, string>): Promise<Map<string, string>> {
  if (files.length === 0) return new Map();
  // Git's stdin-paths format uses LF. Fall back to streaming hashes for paths
  // that cannot be represented there, or if a file changes during the batch.
  const batchFiles = files.filter((file) => !file.includes("\n"));
  const ids = new Map<string, string>();
  try {
    const output = execFileSync("git", ["hash-object", "--stdin-paths"], {
      cwd: root, input: `${batchFiles.join("\n")}\n`, encoding: "utf-8",
      maxBuffer: Math.max(1024 * 1024, batchFiles.length * 128),
    }).trim();
    const hashes = output === "" ? [] : output.split("\n");
    if (hashes.length !== batchFiles.length) throw Error("hash-object returned fewer file ids than requested");
    batchFiles.forEach((file, index) => { ids.set(file, hashes[index]!); });
  } catch (error) {
    console.warn("git_diff: batch hash failed; hashing files individually in process", error);
  }
  const algorithm = [...indexIds.values()][0]?.length === 64 ? "sha256" : "sha1";
  for (const file of files) {
    if (ids.has(file)) continue;
    try {
      const size = (await stat(join(root, file))).size;
      const hash = createHash(algorithm).update(`blob ${size}\0`);
      for await (const chunk of createReadStream(join(root, file))) hash.update(chunk);
      ids.set(file, hash.digest("hex"));
    } catch (error) {
      console.warn(`git_diff: skipped ${file}:`, error);
    }
  }
  return ids;
}

function gitValue(workspacePath: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
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
