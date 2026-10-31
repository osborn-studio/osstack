import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type HardenedGitContext, HardenedGitError, type HardenedGitOptions, runHardenedGit } from "./hardened-git.js";
import { assertRepoConfigUnchanged, filterNeutralizingConfig } from "./repo-config.js";
import { SafeFileError, safeReadFile, safeRelativePathSegments, safeRemoveFile, safeWriteFile } from "./safe-write.js";

export const CONTAINED_WORKSPACE_ERROR_CODES = [
  "WORKSPACE_INVALID_COMMIT",
  "WORKSPACE_INVALID_BRANCH",
  "WORKSPACE_TREE_SYMLINK",
  "WORKSPACE_TREE_SUBMODULE",
  "WORKSPACE_TREE_UNSUPPORTED_ENTRY",
  "WORKSPACE_TREE_UNSAFE_PATH",
  "WORKSPACE_TREE_LIMIT",
  "WORKSPACE_BLOB_MISMATCH",
  "WORKSPACE_TREE_UNSUPPORTED_ATTRIBUTE",
  "WORKSPACE_INDEX_MISMATCH",
  "PLUMBING_COMMIT_INVALID_FILES",
  "PLUMBING_COMMIT_BRANCH_MISMATCH",
  "PLUMBING_COMMIT_STALE_HEAD",
] as const;
export type ContainedWorkspaceErrorCode = (typeof CONTAINED_WORKSPACE_ERROR_CODES)[number];

export class ContainedWorkspaceError extends Error {
  constructor(
    readonly code: ContainedWorkspaceErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ContainedWorkspaceError";
  }
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface TreeLimits {
  maxFiles?: number;
  maxBlobBytes?: number;
  maxTotalBytes?: number;
}
export interface CreateNoCheckoutWorktreeOptions {
  repoPath: string;
  worktreePath: string;
  branch: string;
  /** Full object id of the commit to start from. */
  startCommit: string;
  /** When set, the repository config must still match this digest before any write. */
  expectedConfigDigest?: string;
  limits?: TreeLimits;
  git?: HardenedGitContext;
}
export interface MaterializedFile {
  path: string;
  mode: "100644" | "100755";
  blob: string;
  size: number;
}
export interface MaterializeResult {
  worktreePath: string;
  commit: string;
  files: MaterializedFile[];
}

export type PlumbingCommitFile = { path: string; action: "write"; content?: Uint8Array | string; executable?: boolean } | { path: string; action: "delete" };
export interface PlumbingCommitAuthor {
  name: string;
  email: string;
  /** Any date format git accepts; defaults to now. */
  date?: string;
}
export interface CommitPlumbingOptions {
  worktree: string;
  branch: string;
  expectedHead: string;
  files: readonly PlumbingCommitFile[];
  message: string;
  author: PlumbingCommitAuthor;
  committer?: PlumbingCommitAuthor;
  expectedConfigDigest?: string;
  git?: HardenedGitContext;
}
export interface PlumbingCommitResult {
  head: string;
  tree: string;
}

const git = (cwd: string, context: HardenedGitContext | undefined, args: string[], extra: Partial<HardenedGitOptions> = {}) =>
  runHardenedGit(args, { ...context, ...extra, cwd });
/**
 * A runner whose every call also disables all configured filter drivers:
 * index writes re-hash racily clean entries, which would otherwise run `clean`.
 */
async function filterFreeGit(cwd: string, context: HardenedGitContext | undefined) {
  const config = await filterNeutralizingConfig(cwd, context);
  return (args: string[], extra: Partial<HardenedGitOptions> = {}) => runHardenedGit(args, { ...context, config, ...extra, cwd });
}
const text = (result: { stdout: Buffer }) => result.stdout.toString("utf8").trim();

function assertCommitId(value: string, label: string): void {
  if (!FULL_SHA.test(value)) throw new ContainedWorkspaceError("WORKSPACE_INVALID_COMMIT", label);
}

async function assertBranch(cwd: string, branch: string, context?: HardenedGitContext): Promise<void> {
  if (branch.startsWith("-") || /[\0\n]/.test(branch)) throw new ContainedWorkspaceError("WORKSPACE_INVALID_BRANCH", branch);
  try {
    await git(cwd, context, ["check-ref-format", `refs/heads/${branch}`]);
  } catch {
    throw new ContainedWorkspaceError("WORKSPACE_INVALID_BRANCH", branch);
  }
}

function blobId(bytes: Uint8Array, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Refresh index stat data; `run` must come from {@link filterFreeGit}. */
async function refreshIndex(run: Awaited<ReturnType<typeof filterFreeGit>>, indexFile?: string): Promise<number> {
  const result = await run(["update-index", "--refresh"], { okExitCodes: [0, 1], ...(indexFile ? { gitEnv: { GIT_INDEX_FILE: indexFile } } : {}) });
  return result.exitCode;
}

interface TreeEntry {
  mode: "100644" | "100755";
  blob: string;
  path: string;
}

function parseTree(listing: Buffer): TreeEntry[] {
  const raw = listing.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(listing)) throw new ContainedWorkspaceError("WORKSPACE_TREE_UNSAFE_PATH", "non-UTF-8 path");
  const entries: TreeEntry[] = [];
  for (const row of raw.split("\0")) {
    if (row === "") continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new ContainedWorkspaceError("WORKSPACE_TREE_UNSUPPORTED_ENTRY", row.slice(0, 80));
    const [, mode, type, blob, path] = match as unknown as [string, string, string, string, string];
    if (mode === "120000") throw new ContainedWorkspaceError("WORKSPACE_TREE_SYMLINK", path);
    if (mode === "160000") throw new ContainedWorkspaceError("WORKSPACE_TREE_SUBMODULE", path);
    if ((mode !== "100644" && mode !== "100755") || type !== "blob") throw new ContainedWorkspaceError("WORKSPACE_TREE_UNSUPPORTED_ENTRY", path);
    try {
      safeRelativePathSegments(path);
    } catch {
      throw new ContainedWorkspaceError("WORKSPACE_TREE_UNSAFE_PATH", path);
    }
    entries.push({ mode, blob, path });
  }
  return entries;
}

/**
 * Raw blobs are written as-is, so a path whose attributes re-encode the
 * worktree copy could never match the index; refuse it up front.
 */
async function rejectReencodedPaths(run: Awaited<ReturnType<typeof filterFreeGit>>, commit: string, entries: readonly TreeEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const listing = await run(["check-attr", `--source=${commit}`, "-z", "--stdin", "working-tree-encoding"], {
    input: entries.map((entry) => `${entry.path}\0`).join(""),
  });
  const fields = listing.stdout.toString("utf8").split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2];
    if (value !== "unspecified" && value !== "unset") throw new ContainedWorkspaceError("WORKSPACE_TREE_UNSUPPORTED_ATTRIBUTE", fields[index]);
  }
}

/**
 * Write every blob of `commit` into `worktreePath` through the safe writer
 * (no checkout, no smudge filters), then point the index at the commit and
 * refresh its stat data so `git status` is clean.
 */
export async function materializeCommit(
  worktreePath: string,
  commit: string,
  options: { limits?: TreeLimits; git?: HardenedGitContext } = {},
): Promise<MaterializeResult> {
  assertCommitId(commit, commit);
  const context = options.git;
  const maxFiles = options.limits?.maxFiles ?? 50_000;
  const maxBlobBytes = options.limits?.maxBlobBytes ?? 64 * 1024 * 1024;
  const maxTotalBytes = options.limits?.maxTotalBytes ?? 512 * 1024 * 1024;
  const run = await filterFreeGit(worktreePath, context);
  const entries = parseTree((await run( ["ls-tree", "-r", "-z", "--full-tree", `${commit}^{tree}`])).stdout);
  if (entries.length > maxFiles) throw new ContainedWorkspaceError("WORKSPACE_TREE_LIMIT", "files");
  await rejectReencodedPaths(run, commit, entries);
  const algorithm = commit.length === 64 ? "sha256" : "sha1";
  const files: MaterializedFile[] = [];
  let total = 0;
  for (const entry of entries) {
    const bytes = (await run(["cat-file", "blob", entry.blob], { maxOutputBytes: maxBlobBytes })).stdout;
    total += bytes.length;
    if (total > maxTotalBytes) throw new ContainedWorkspaceError("WORKSPACE_TREE_LIMIT", "bytes");
    if (blobId(bytes, algorithm) !== entry.blob) throw new ContainedWorkspaceError("WORKSPACE_BLOB_MISMATCH", entry.path);
    await safeWriteFile(worktreePath, entry.path, bytes, entry.mode === "100755" ? 0o755 : 0o644);
    files.push({ path: entry.path, mode: entry.mode, blob: entry.blob, size: bytes.length });
  }
  await run(["read-tree", commit]);
  if ((await refreshIndex(run)) !== 0) throw new ContainedWorkspaceError("WORKSPACE_INDEX_MISMATCH");
  return { worktreePath, commit, files };
}

/** `git worktree add --no-checkout` at a full commit id, then materialize it host-side. */
export async function createNoCheckoutWorktree(options: CreateNoCheckoutWorktreeOptions): Promise<MaterializeResult> {
  const { repoPath, branch, startCommit, git: context } = options;
  assertCommitId(startCommit, startCommit);
  await assertBranch(repoPath, branch, context);
  if (options.expectedConfigDigest !== undefined) await assertRepoConfigUnchanged(repoPath, options.expectedConfigDigest, context);
  const resolved = text(await git(repoPath, context, ["rev-parse", "--verify", "--end-of-options", `${startCommit}^{commit}`]));
  if (resolved !== startCommit) throw new ContainedWorkspaceError("WORKSPACE_INVALID_COMMIT", startCommit);
  const worktreePath = resolve(options.worktreePath);
  await (await filterFreeGit(repoPath, context))(["worktree", "add", "--no-checkout", "-b", branch, "--", worktreePath, startCommit]);
  return materializeCommit(worktreePath, startCommit, { ...(options.limits ? { limits: options.limits } : {}), ...(context ? { git: context } : {}) });
}

function identityEnv(prefix: "AUTHOR" | "COMMITTER", who: PlumbingCommitAuthor) {
  if (/[<>\n\0]/.test(who.name) || /[<>\n\0]/.test(who.email) || who.name.trim() === "" || who.email.trim() === "") {
    throw new ContainedWorkspaceError("PLUMBING_COMMIT_INVALID_FILES", "invalid identity");
  }
  return {
    [`GIT_${prefix}_NAME`]: who.name,
    [`GIT_${prefix}_EMAIL`]: who.email,
    ...(who.date !== undefined ? { [`GIT_${prefix}_DATE`]: who.date } : {}),
  };
}

/**
 * Build a commit from explicit paths with plumbing only (hash-object
 * --no-filters, update-index --cacheinfo, write-tree, commit-tree) and move
 * `refs/heads/<branch>` with a compare-and-swap against `expectedHead`.
 */
export async function commitPlumbing(options: CommitPlumbingOptions): Promise<PlumbingCommitResult> {
  const { worktree, branch, expectedHead, files, git: context } = options;
  assertCommitId(expectedHead, expectedHead);
  await assertBranch(worktree, branch, context);
  const seen = new Set<string>();
  for (const file of files) {
    try {
      safeRelativePathSegments(file.path);
    } catch {
      throw new ContainedWorkspaceError("PLUMBING_COMMIT_INVALID_FILES", file.path);
    }
    if (seen.has(file.path)) throw new ContainedWorkspaceError("PLUMBING_COMMIT_INVALID_FILES", `duplicate ${file.path}`);
    seen.add(file.path);
  }
  if (files.length === 0) throw new ContainedWorkspaceError("PLUMBING_COMMIT_INVALID_FILES", "no files");
  const gitEnv = { ...identityEnv("AUTHOR", options.author), ...identityEnv("COMMITTER", options.committer ?? options.author) };
  const ref = `refs/heads/${branch}`;
  if (options.expectedConfigDigest !== undefined) await assertRepoConfigUnchanged(worktree, options.expectedConfigDigest, context);
  const symbolic = text(await git(worktree, context, ["symbolic-ref", "-q", "HEAD"], { okExitCodes: [0, 1] }));
  if (symbolic !== ref) throw new ContainedWorkspaceError("PLUMBING_COMMIT_BRANCH_MISMATCH", symbolic || "detached");
  const current = text(await git(worktree, context, ["rev-parse", "--verify", "-q", ref], { okExitCodes: [0, 1] }));
  if (current !== expectedHead) throw new ContainedWorkspaceError("PLUMBING_COMMIT_STALE_HEAD", current || "missing");

  const gitDir = text(await git(worktree, context, ["rev-parse", "--absolute-git-dir"]));
  const run = await filterFreeGit(worktree, context);
  const realIndex = join(gitDir, "index");
  const tempIndex = join(gitDir, `osstack-plumbing-${randomBytes(8).toString("hex")}.index`);
  const withIndex = { gitEnv: { GIT_INDEX_FILE: tempIndex } };
  const algorithm = expectedHead.length === 64 ? "sha256" : "sha1";
  try {
    const headTree = text(await run(["rev-parse", "--verify", `${expectedHead}^{tree}`]));
    const hasIndex = await lstat(realIndex).then(
      (stat) => stat.isFile(),
      () => false,
    );
    if (hasIndex) await copyFile(realIndex, tempIndex);
    const indexTree = hasIndex ? text(await run(["write-tree"], { ...withIndex, okExitCodes: [0, 128] })) : "";
    if (indexTree !== headTree) await run(["read-tree", expectedHead], withIndex);

    for (const file of files) {
      if (file.action === "delete") {
        const present = await safeReadFile(worktree, file.path).then(
          () => true,
          (error: unknown) => {
            if (error instanceof SafeFileError && error.code === "SAFE_PATH_NOT_FOUND") return false;
            throw error;
          },
        );
        if (present) await safeRemoveFile(worktree, file.path);
        await run(["update-index", "--force-remove", "--", file.path], withIndex);
        continue;
      }
      if (file.content !== undefined) await safeWriteFile(worktree, file.path, file.content, file.executable ? 0o755 : 0o644);
      const read = await safeReadFile(worktree, file.path);
      const executable = file.content !== undefined ? file.executable === true : read.executable;
      const blob = text(await run(["hash-object", "-w", "--no-filters", "--stdin"], { input: read.bytes }));
      if (blob !== blobId(read.bytes, algorithm)) throw new ContainedWorkspaceError("WORKSPACE_BLOB_MISMATCH", file.path);
      await run(["update-index", "--add", "--cacheinfo", `${executable ? "100755" : "100644"},${blob},${file.path}`], withIndex);
    }
    const tree = text(await run(["write-tree"], withIndex));
    // A nonzero refresh means git's built-in conversions would hash these bytes differently.
    if ((await refreshIndex(run, tempIndex)) !== 0) throw new ContainedWorkspaceError("WORKSPACE_INDEX_MISMATCH");
    const head = text(
      await run(["commit-tree", "--no-gpg-sign", tree, "-p", expectedHead, "-F", "-"], {
        gitEnv,
        input: options.message.endsWith("\n") ? options.message : `${options.message}\n`,
      }),
    );
    assertCommitId(head, head);
    try {
      await run(["update-ref", "-m", "osstack: plumbing commit", ref, head, expectedHead]);
    } catch (error) {
      if (error instanceof HardenedGitError && error.code === "HARDENED_GIT_FAILED") throw new ContainedWorkspaceError("PLUMBING_COMMIT_STALE_HEAD", error.stderr.trim());
      throw error;
    }
    await rename(tempIndex, realIndex);
    return { head, tree };
  } finally {
    await rm(tempIndex, { force: true });
    await rm(`${tempIndex}.lock`, { force: true });
  }
}
