import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const WORKTREE_METADATA_FILES = [
  "HEAD",
  "index",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "commondir",
  "gitdir",
  "logs/HEAD",
] as const;

export const GIT_HOOKS_DISABLED_ARGS = [
  "-c",
  "core.hooksPath=/dev/null",
] as const;

export interface ReviewerWorkspaceSnapshot {
  schema_version: 1;
  head: string;
  status_sha256: string;
  diff_sha256: string;
  staged_diff_sha256: string;
  untracked_sha256: string;
  ignored_sha256: string;
  git_config_sha256: string;
  hooks_sha256: string;
  worktree_metadata_sha256: string;
  combined_sha256: string;
}

export async function snapshotReviewerWorkspace(
  workspacePath: string,
): Promise<ReviewerWorkspaceSnapshot> {
  const workspace = await realpath(resolve(workspacePath));
  const [
    headOutput,
    status,
    diff,
    stagedDiff,
    untrackedOutput,
    ignoredOutput,
    commonGitOutput,
    worktreeGitOutput,
  ] = await Promise.all([
    execGit(workspace, ["rev-parse", "HEAD"]),
    execGit(workspace, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    execGit(workspace, ["diff", "--binary", "HEAD", "--"]),
    execGit(workspace, ["diff", "--binary", "--cached", "HEAD", "--"]),
    execGit(workspace, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
    execGit(workspace, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]),
    execGit(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    execGit(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]),
  ]);

  const commonGit = await realpath(decodeLine(commonGitOutput));
  const worktreeGit = await realpath(decodeLine(worktreeGitOutput));
  const untrackedPaths = parseNullDelimited(untrackedOutput);
  const ignoredPaths = parseNullDelimited(ignoredOutput);

  const snapshotWithoutCombined = {
    schema_version: 1 as const,
    head: decodeLine(headOutput),
    status_sha256: sha256(status),
    diff_sha256: sha256(diff),
    staged_diff_sha256: sha256(stagedDiff),
    untracked_sha256: await hashUntracked(workspace, untrackedPaths),
    ignored_sha256: await hashIgnoredMetadata(workspace, ignoredPaths),
    git_config_sha256: await hashOptionalFiles(commonGit, [
      "config",
      "config.worktree",
    ]),
    hooks_sha256: await hashTree(join(commonGit, "hooks")),
    worktree_metadata_sha256: await hashOptionalFiles(
      worktreeGit,
      WORKTREE_METADATA_FILES,
    ),
  };
  return {
    ...snapshotWithoutCombined,
    combined_sha256: sha256(JSON.stringify(snapshotWithoutCombined)),
  };
}

export function reviewerWorkspaceMutated(
  before: ReviewerWorkspaceSnapshot,
  after: ReviewerWorkspaceSnapshot,
): boolean {
  return before.combined_sha256 !== after.combined_sha256;
}

async function hashUntracked(
  workspace: string,
  paths: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) {
    const absolute = resolveConfinedPath(workspace, path);
    const metadata = await lstat(absolute, { bigint: true });
    updateField(hash, path);
    updateField(hash, statIdentity(metadata));
    if (metadata.isSymbolicLink()) {
      updateField(hash, await readlink(absolute));
    } else if (metadata.isFile()) {
      for await (const chunk of createReadStream(absolute)) {
        hash.update(chunk as Buffer);
      }
    }
  }
  return hash.digest("hex");
}

async function hashIgnoredMetadata(
  workspace: string,
  paths: readonly string[],
): Promise<string> {
  const records = await mapWithConcurrency(paths, 64, async (path) => {
    const absolute = resolveConfinedPath(workspace, path);
    const metadata = await lstat(absolute, { bigint: true });
    const linkTarget = metadata.isSymbolicLink()
      ? await readlink(absolute)
      : "";
    return `${path}\0${statIdentity(metadata)}\0${linkTarget}`;
  });
  return sha256(records.join("\0"));
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  await hashTreeEntry(hash, root, "");
  return hash.digest("hex");
}

async function hashTreeEntry(
  hash: ReturnType<typeof createHash>,
  root: string,
  relativePath: string,
): Promise<void> {
  const absolute = relativePath === "" ? root : join(root, relativePath);
  let metadata: BigIntStats;
  try {
    metadata = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      updateField(hash, `${relativePath}\0<missing>`);
      return;
    }
    throw error;
  }
  updateField(hash, relativePath);
  updateField(hash, statIdentity(metadata));
  if (metadata.isSymbolicLink()) {
    updateField(hash, await readlink(absolute));
    return;
  }
  if (metadata.isFile()) {
    for await (const chunk of createReadStream(absolute)) {
      hash.update(chunk as Buffer);
    }
    return;
  }
  if (!metadata.isDirectory()) return;

  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    await hashTreeEntry(
      hash,
      root,
      relativePath === "" ? entry.name : join(relativePath, entry.name),
    );
  }
}

async function hashOptionalFiles(
  root: string,
  relativePaths: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of relativePaths) {
    const absolute = join(root, relativePath);
    updateField(hash, relativePath);
    try {
      const metadata = await lstat(absolute, { bigint: true });
      if (metadata.isSymbolicLink()) {
        updateField(hash, `symlink:${metadata.mode}`);
        updateField(hash, await readlink(absolute));
      } else if (metadata.isFile()) {
        updateField(hash, `file:${metadata.mode}`);
        hash.update(await readFile(absolute));
      } else {
        updateField(hash, `other:${metadata.mode}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      updateField(hash, "<missing>");
    }
  }
  return hash.digest("hex");
}

function execGit(
  workspace: string,
  args: readonly string[],
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: workspace,
        timeout: 30_000,
        killSignal: "SIGKILL",
        encoding: "buffer",
        maxBuffer: GIT_OUTPUT_LIMIT,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(
            `reviewer snapshot git ${args[0] ?? "command"} failed: ${safeStderr(stderr)}`,
            { cause: error },
          ));
          return;
        }
        resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function parseNullDelimited(output: Buffer): string[] {
  const value = decodeUtf8(output, "Git path output");
  if (value === "") return [];
  const paths = value.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths;
}

function decodeLine(output: Buffer): string {
  const value = decodeUtf8(output, "Git line output").trim();
  if (value === "") throw new Error("reviewer snapshot received empty Git output");
  return value;
}

function decodeUtf8(output: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw new Error(`reviewer snapshot ${label} is not UTF-8`, { cause: error });
  }
}

function resolveConfinedPath(workspace: string, path: string): string {
  const absolute = resolve(workspace, path);
  if (absolute !== workspace && !absolute.startsWith(`${workspace}${sep}`)) {
    throw new Error(`reviewer snapshot path escapes workspace: ${path}`);
  }
  return absolute;
}

function statIdentity(metadata: {
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
}): string {
  return [
    metadata.mode,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
    metadata.ino,
  ].join(":");
}

function updateField(
  hash: ReturnType<typeof createHash>,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update("\0");
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        const value = values[index];
        if (value === undefined) continue;
        results[index] = await mapper(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeStderr(value: string | Buffer): string {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 300);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}
