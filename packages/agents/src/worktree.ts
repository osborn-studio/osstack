import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface WorktreeHandle {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  rootPath: string;
  /**
   * Full commit id the task branch was created at. Recorded at creation so a
   * clean tree can still be told apart from "executor committed its own
   * work", and so cleanup never deletes commits made beyond it. Absent on
   * handles rebuilt from `git worktree list` (orphans).
   */
  startCommit?: string;
}

export interface CreateWorktreeOptions {
  repoPath: string;
  runId: string;
  rootPath?: string;
  branchPrefix?: string;
  baseRef?: string;
  /** Register before exposing this directory to any graph producer. */
  graphRetention?: GraphWorktreeRetention;
}

export interface CommitWorktreeResult {
  /** True only when this call created a commit from the worktree's changes. */
  committed: boolean;
  /** The loop's commit when `committed`, or the branch tip when `executorCommitted`. */
  commit?: string;
  /**
   * The task branch already had commits beyond `startCommit` before this call
   * (the executor ran `git commit` itself). Those commits were never part of a
   * loop-made candidate and must be preserved, not landed or deleted.
   */
  executorCommitted?: boolean;
}

export interface CleanupWorktreeResult {
  /** False when the branch was kept, either on request or because it holds unique commits. */
  branchRemoved: boolean;
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
const FULL_COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DISABLE_GIT_HOOKS_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
] as const;

export async function createWorktree(rawOptions: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const options = { ...rawOptions, ...(rawOptions.graphRetention === undefined ? {} : { graphRetention: { ...rawOptions.graphRetention } }) };
  const repoPath = await gitOutput(options.repoPath, ["rev-parse", "--show-toplevel"]);
  const rootPath = await resolveRootPath(options.rootPath);
  await mkdir(rootPath, { recursive: true });

  const branchPrefix = options.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  const safeRunId = sanitizePathPart(options.runId);
  const suffix = randomUUID().slice(0, 8);
  const branch = `${branchPrefix}/${safeRunId}-${suffix}`;
  const worktreePath = join(rootPath, `${safeRunId}-${suffix}`);
  const baseRef = options.baseRef ?? "HEAD";
  // Pin the start to an object id so the branch's own history can be measured later.
  const startCommit = await gitOutput(repoPath, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (!FULL_COMMIT_ID.test(startCommit)) throw new Error(`worktree base ${baseRef} does not resolve to a commit`);

  if (options.graphRetention !== undefined) {
    await persistGraphRetention({ repoPath, worktreePath, branch, baseRef, rootPath }, options.graphRetention);
  }
  await runGit(repoPath, [
    ...DISABLE_GIT_HOOKS_ARGS,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    startCommit,
  ]);

  if (options.graphRetention !== undefined) await runGit(repoPath, ["worktree", "lock", "--reason", "OSStack graph retained", worktreePath]);

  return {
    repoPath,
    worktreePath,
    branch,
    baseRef,
    rootPath,
    startCommit,
  };
}

export async function commitWorktreeChanges(
  handle: WorktreeHandle,
  message: string,
): Promise<CommitWorktreeResult> {
  // Request every untracked path explicitly: repository config such as
  // status.showUntrackedFiles=no must not make untracked-only work look clean,
  // or the caller would report "no changes" and then remove the worktree.
  const status = await gitOutput(handle.worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  const head = await gitOutput(handle.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const executorCommitted = handle.startCommit !== undefined && head !== handle.startCommit;
  if (status.trim() === "") {
    // A clean tree is not "no work" when the executor committed by itself.
    return executorCommitted ? { committed: false, commit: head, executorCommitted: true } : { committed: false };
  }

  await runGit(handle.worktreePath, ["add", "-A"]);
  await runGit(handle.worktreePath, [
    ...DISABLE_GIT_HOOKS_ARGS,
    "-c",
    "user.name=osstack-loop",
    "-c",
    "user.email=osstack-loop@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  const commit = await gitOutput(handle.worktreePath, ["rev-parse", "HEAD"]);
  return { committed: true, commit, ...(executorCommitted ? { executorCommitted: true } : {}) };
}

export interface MergeWorktreeOptions {
  /**
   * Full commit id the caller accepted (verified and committed). The
   * fast-forward lands exactly this commit, and refuses if the task branch no
   * longer points at it, so commits added after acceptance never land.
   */
  expectedCommit: string;
  /**
   * Branch the main checkout must have checked out. Landing refuses when the
   * checkout is on any other branch (or detached), so a run can never
   * fast-forward whatever branch happens to be checked out.
   */
  targetBranch: string;
}

/**
 * Local landing: fast-forward the main checkout's `targetBranch` to the
 * accepted commit. Callers must opt in explicitly; unattended runs keep the
 * task branch for PR delivery instead (humans merge main).
 */
export async function mergeWorktree(handle: WorktreeHandle, options: MergeWorktreeOptions): Promise<void> {
  const { expectedCommit, targetBranch } = options;
  if (typeof expectedCommit !== "string" || !FULL_COMMIT_ID.test(expectedCommit)) {
    throw new Error("accepted worktree commit must be a full commit id");
  }
  await assertLandingTargetBranchName(handle.repoPath, targetBranch);
  const branchHead = await gitOutput(handle.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${handle.branch}^{commit}`]);
  if (branchHead !== expectedCommit) {
    throw new Error(`worktree branch ${handle.branch} differs from the accepted commit; refusing to land`);
  }
  if (handle.startCommit !== undefined) {
    // Only the single accepted commit on top of the recorded start may land;
    // anything else carries history nobody reviewed as this candidate.
    const parent = await gitOutput(handle.repoPath, ["rev-parse", "--verify", "--quiet", `${expectedCommit}^1`]);
    if (parent !== handle.startCommit) {
      throw new Error(`worktree branch ${handle.branch} has commits beyond the accepted commit's start; refusing to land`);
    }
  }
  const checkedOut = await runGit(handle.repoPath, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
  if (checkedOut !== `refs/heads/${targetBranch}`) {
    const current = checkedOut === "" ? "a detached HEAD" : checkedOut.replace(/^refs\/heads\//, "");
    throw new Error(`main checkout is on ${current}, not the landing target ${targetBranch}; refusing to land`);
  }
  await runGit(handle.repoPath, [
    ...DISABLE_GIT_HOOKS_ARGS,
    "merge",
    "--ff-only",
    // Merge the pinned object, not the movable branch name.
    expectedCommit,
  ]);
  const landed = await gitOutput(handle.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}^{commit}`]);
  if (landed !== expectedCommit) throw new Error(`landing target ${targetBranch} did not reach the accepted commit`);
}

async function assertLandingTargetBranchName(repoPath: string, targetBranch: string): Promise<void> {
  if (typeof targetBranch !== "string" || targetBranch.trim() === "" || targetBranch.startsWith("-")) {
    throw new Error("local landing requires an explicit target branch");
  }
  const normalized = await runGit(repoPath, ["check-ref-format", "--normalize", `refs/heads/${targetBranch}`], { allowFailure: true });
  if (normalized !== `refs/heads/${targetBranch}`) throw new Error(`invalid landing target branch: ${targetBranch}`);
}

export async function cleanupWorktree(
  handle: WorktreeHandle,
  options: CleanupWorktreeOptions = {},
): Promise<CleanupWorktreeResult> {
  if (await hasGraphRetention(handle)) return { branchRemoved: false };
  await runGit(handle.repoPath, ["worktree", "remove", "--force", handle.worktreePath], { allowFailure: true });
  if (options.removeBranch === false) return { branchRemoved: false };
  // Never delete commits that exist only on this branch (for example an
  // executor that committed by itself): keep it for inspection or delivery.
  if (!(await branchTipIsSafeToDelete(handle))) return { branchRemoved: false };
  await runGit(handle.repoPath, ["branch", "-D", handle.branch], { allowFailure: true });
  const remaining = await runGit(handle.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${handle.branch}`], { allowFailure: true });
  return { branchRemoved: remaining === "" };
}

/**
 * A task branch may be deleted only when its tip adds nothing: it equals the
 * recorded start, or the main checkout's HEAD or another ref already contains
 * it. A missing branch is trivially safe.
 */
async function branchTipIsSafeToDelete(handle: WorktreeHandle): Promise<boolean> {
  const ref = `refs/heads/${handle.branch}`;
  const tip = await runGit(handle.repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  if (tip === "") return true;
  if (handle.startCommit !== undefined && tip === handle.startCommit) return true;
  if (await runGit(handle.repoPath, ["merge-base", "--is-ancestor", tip, "HEAD"]).then(() => true, () => false)) return true;
  const containing = await runGit(handle.repoPath, ["for-each-ref", "--contains", tip, "--format=%(refname)"], { allowFailure: true });
  return containing.split("\n").map((line) => line.trim()).some((name) => name !== "" && name !== ref);
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
    if (await hasGraphRetention(handle)) continue;
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
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
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


export interface GraphWorktreeRetention {
  runId: string;
  scopeKey: string;
  generation: number;
  workspaceLeaseRef: string;
}
export interface GraphWorktreeRetentionRecord extends GraphWorktreeRetention {
  version: 1;
  repoPath: string;
  commonDir: string;
  worktreePath: string;
  branch: string;
  quarantineReason?: string;
}
async function retentionLocation(handle: WorktreeHandle): Promise<{ path: string; commonDir: string; worktreePath: string }> {
  const commonDir = await realpath(resolve(handle.repoPath, await gitOutput(handle.repoPath, ["rev-parse", "--git-common-dir"])));
  // Resolve parent aliases even after a failed/removed allocation. Never resolve
  // the leaf symlink into another directory and then silently delete it.
  const worktreePath = resolve(handle.worktreePath);
  if (!isAbsolute(handle.worktreePath) || await realpath(handle.rootPath) !== handle.rootPath || !isPathInside(worktreePath, handle.rootPath) || worktreePath === handle.rootPath) throw new Error("invalid exact graph worktree path");
  const key = createHash("sha256").update(worktreePath).digest("hex");
  return { path: join(commonDir, "osstack-graph-retention", `${key}.json`), commonDir, worktreePath };
}
async function hasGraphRetention(handle: WorktreeHandle): Promise<boolean> {
  const { path } = await retentionLocation(handle);
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function syncRetentionDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } catch (error) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; } finally { await directory.close(); }
}
async function saveRetention(path: string, record: GraphWorktreeRetentionRecord, replace = false): Promise<void> {
  const directory = resolve(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = replace ? `${path}.${randomUUID()}` : path;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
  if (replace) await rename(temporary, path);
  await syncRetentionDirectory(directory); await syncRetentionDirectory(resolve(directory, ".."));
}
async function persistGraphRetention(handle: WorktreeHandle, raw: GraphWorktreeRetention): Promise<void> {
  const identity = { ...raw };
  if (!identity.runId || !identity.scopeKey || !identity.workspaceLeaseRef || !Number.isSafeInteger(identity.generation) || identity.generation < 1) throw new Error("invalid graph retention identity");
  const location = await retentionLocation(handle);
  await saveRetention(location.path, { ...identity, version: 1, repoPath: handle.repoPath, commonDir: location.commonDir, worktreePath: location.worktreePath, branch: handle.branch });
}
async function readRetention(handle: WorktreeHandle): Promise<{ path: string; record: Readonly<GraphWorktreeRetentionRecord> }> {
  const location = await retentionLocation(handle);
  const record = JSON.parse(await readFile(location.path, "utf8")) as GraphWorktreeRetentionRecord;
  if (record.version !== 1 || record.commonDir !== location.commonDir || record.worktreePath !== location.worktreePath || record.branch !== handle.branch || record.repoPath !== handle.repoPath || !record.runId || !record.scopeKey || !record.workspaceLeaseRef || !Number.isSafeInteger(record.generation) || record.generation < 1) throw new Error("graph retention identity mismatch or corruption");
  return { path: location.path, record: Object.freeze(record) };
}
/** Quarantine records uncertainty; it never kills producers or fabricates stop evidence. */
export async function quarantineGraphWorktree(handle: WorktreeHandle, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("quarantine reason required");
  const { path, record } = await readRetention(handle);
  await saveRetention(path, { ...record, quarantineReason: reason }, true);
}
/** Explicit trusted host operation under canonical G10 exclusion. verifySafe must
 * authenticate ALL stopped producers and the exported durable digest for this
 * exact retention identity. A boolean or a worker receipt is not a grant.
 * Keep the record even after deletion: generic cleanup never reclaims it. */
export async function cleanupGraphWorktree(handle: WorktreeHandle, options: {
  artifactDigest: string;
  verifySafe: (record: Readonly<GraphWorktreeRetentionRecord>, artifactDigest: string) => void | Promise<void>;
}): Promise<void> {
  const frozenHandle = Object.freeze({ ...handle });
  const { artifactDigest, verifySafe } = options;
  if (!/^[a-f0-9]{64}$/.test(artifactDigest) || typeof verifySafe !== "function") throw new Error("exported artifact and trusted authority required");
  const { record } = await readRetention(frozenHandle);
  if (await verifySafe(record, artifactDigest) !== undefined) throw new Error("nonconforming cleanup authority");
  const current = await readRetention(frozenHandle);
  if (JSON.stringify(current.record) !== JSON.stringify(record)) throw new Error("graph retention changed during cleanup");
  if (await verifySafe(current.record, artifactDigest) !== undefined) throw new Error("nonconforming cleanup authority");
  await runGit(frozenHandle.repoPath, [...DISABLE_GIT_HOOKS_ARGS, "worktree", "remove", "--force", "--force", frozenHandle.worktreePath]);
  await runGit(frozenHandle.repoPath, ["branch", "-D", frozenHandle.branch]);
}
