import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorktreeHandle {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  rootPath: string;
}

export interface CreateWorktreeOptions {
  repoPath: string;
  runId: string;
  rootPath?: string;
  branchPrefix?: string;
  baseRef?: string;
}

export interface CommitWorktreeResult {
  committed: boolean;
  commit?: string;
}

export interface CleanupOrphanedWorktreesOptions {
  rootPath?: string;
  branchPrefix?: string;
}

export interface CleanupWorktreeOptions {
  removeBranch?: boolean;
}

export interface CleanupOrphanedWorktreesResult {
  removed: WorktreeHandle[];
}

const DEFAULT_BRANCH_PREFIX = "osstack/loop";

export async function createWorktree(options: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const repoPath = await gitOutput(options.repoPath, ["rev-parse", "--show-toplevel"]);
  const rootPath = await resolveRootPath(options.rootPath);
  await mkdir(rootPath, { recursive: true });

  const branchPrefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const safeRunId = sanitizePathPart(options.runId);
  const suffix = randomUUID().slice(0, 8);
  const branch = `${branchPrefix}/${safeRunId}-${suffix}`;
  const worktreePath = join(rootPath, `${safeRunId}-${suffix}`);
  const baseRef = options.baseRef ?? "HEAD";

  await runGit(repoPath, ["worktree", "add", "-b", branch, worktreePath, baseRef]);

  return {
    repoPath,
    worktreePath,
    branch,
    baseRef,
    rootPath,
  };
}

export async function commitWorktreeChanges(
  handle: WorktreeHandle,
  message: string,
): Promise<CommitWorktreeResult> {
  const status = await gitOutput(handle.worktreePath, ["status", "--porcelain"]);
  if (status.trim() === "") return { committed: false };

  await runGit(handle.worktreePath, ["add", "-A"]);
  await runGit(handle.worktreePath, [
    "-c",
    "user.name=osstack-loop",
    "-c",
    "user.email=osstack-loop@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  const commit = await gitOutput(handle.worktreePath, ["rev-parse", "HEAD"]);
  return { committed: true, commit };
}

export async function mergeWorktree(handle: WorktreeHandle): Promise<void> {
  await runGit(handle.repoPath, ["merge", "--ff-only", handle.branch]);
}

export async function cleanupWorktree(
  handle: WorktreeHandle,
  options: CleanupWorktreeOptions = {},
): Promise<void> {
  await runGit(handle.repoPath, ["worktree", "remove", "--force", handle.worktreePath], { allowFailure: true });
  if (options.removeBranch !== false) {
    await runGit(handle.repoPath, ["branch", "-D", handle.branch], { allowFailure: true });
  }
}

export async function cleanupOrphanedWorktrees(
  repoPath: string,
  options: CleanupOrphanedWorktreesOptions = {},
): Promise<CleanupOrphanedWorktreesResult> {
  const normalizedRepo = await gitOutput(repoPath, ["rev-parse", "--show-toplevel"]);
  const rootPath = await resolveRootPath(options.rootPath);
  const branchPrefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const entries = parseWorktreeList(await gitOutput(normalizedRepo, ["worktree", "list", "--porcelain"]));
  const removed: WorktreeHandle[] = [];

  for (const entry of entries) {
    if (entry.branch === undefined) continue;
    if (!entry.branch.startsWith(`${branchPrefix}/`)) continue;
    if (!isPathInside(entry.worktreePath, rootPath)) continue;
    const handle: WorktreeHandle = {
      repoPath: normalizedRepo,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      baseRef: entry.head ?? "HEAD",
      rootPath,
    };
    await cleanupWorktree(handle);
    removed.push(handle);
  }

  return { removed };
}

interface GitCommandOptions {
  allowFailure?: boolean;
}

async function runGit(cwd: string, args: string[], options: GitCommandOptions = {}): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure === true) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed (${code ?? 1}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await runGit(cwd, args)).trim();
}

interface ListedWorktree {
  worktreePath: string;
  head?: string;
  branch?: string;
}

function parseWorktreeList(output: string): ListedWorktree[] {
  const entries: ListedWorktree[] = [];
  let current: Partial<ListedWorktree> = {};

  for (const line of output.split("\n")) {
    if (line.trim() === "") {
      pushCurrent(entries, current);
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) current.worktreePath = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
  }
  pushCurrent(entries, current);
  return entries;
}

function pushCurrent(entries: ListedWorktree[], current: Partial<ListedWorktree>): void {
  if (current.worktreePath !== undefined) entries.push(current as ListedWorktree);
}

async function resolveRootPath(rootPath: string | undefined): Promise<string> {
  const resolved = rootPath === undefined
    ? join(tmpdir(), "osstack-worktrees")
    : isAbsolute(rootPath) ? rootPath : join(process.cwd(), rootPath);
  await mkdir(resolved, { recursive: true });
  return await realpath(resolved);
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized === "" ? "run" : sanitized.slice(0, 48);
}

function isPathInside(path: string, rootPath: string): boolean {
  const rel = relative(rootPath, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
