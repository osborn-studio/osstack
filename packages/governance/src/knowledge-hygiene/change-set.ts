import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertKnowledgeHygieneRepositoryPathV1 } from "./path-pattern.js";
import {
  KnowledgeHygieneChangeSetV1,
  type KnowledgeHygieneChangeStatusV1,
  type KnowledgeHygieneChangeV1,
} from "./types.js";

const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export type KnowledgeHygieneGitErrorCode =
  | "invalid_input"
  | "invalid_repository"
  | "not_git_repository"
  | "invalid_ref"
  | "timeout"
  | "command_failed";

export class KnowledgeHygieneGitError extends Error {
  readonly code: KnowledgeHygieneGitErrorCode;

  constructor(code: KnowledgeHygieneGitErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeHygieneGitError";
    this.code = code;
  }
}

export interface KnowledgeHygieneGitRunOptionsV1 {
  cwd: string;
  timeout_ms: number;
}

export interface KnowledgeHygieneGitRunResultV1 {
  stdout: string;
  stderr: string;
}

export type KnowledgeHygieneGitRunnerV1 = (
  args: readonly string[],
  options: KnowledgeHygieneGitRunOptionsV1,
) => Promise<KnowledgeHygieneGitRunResultV1>;

export interface KnowledgeHygieneChangeSetPortsV1 {
  run_git?: KnowledgeHygieneGitRunnerV1;
}

interface CommonChangeSetInput {
  repo_root: string;
  config_sha256?: string;
  timeout_ms?: number;
}

export type BuildKnowledgeHygieneChangeSetInputV1 =
  | (CommonChangeSetInput & { mode: "worktree" })
  | (CommonChangeSetInput & {
      mode: "range";
      base_ref: string;
      head_ref: string;
    })
  | (CommonChangeSetInput & {
      mode: "base_to_worktree";
      base_ref: string;
    });

const defaultGitRunner: KnowledgeHygieneGitRunnerV1 = (
  args,
  options,
) => new Promise((resolvePromise, rejectPromise) => {
  execFile(
    "git",
    [...args],
    {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      timeout: options.timeout_ms,
    },
    (error, stdout, stderr) => {
      if (error) {
        rejectPromise(Object.assign(error, { stderr, stdout }));
        return;
      }
      resolvePromise({ stdout, stderr });
    },
  );
});

function rawErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isTimeout(error: unknown): boolean {
  return (
    rawErrorCode(error) === "ETIMEDOUT" ||
    (typeof error === "object" &&
      error !== null &&
      "killed" in error &&
      error.killed === true)
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runGit(
  runner: KnowledgeHygieneGitRunnerV1,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  failureCode: KnowledgeHygieneGitErrorCode,
): Promise<string> {
  try {
    const result = await runner(args, { cwd, timeout_ms: timeoutMs });
    return result.stdout;
  } catch (error) {
    if (isTimeout(error)) {
      throw new KnowledgeHygieneGitError(
        "timeout",
        `git command timed out after ${timeoutMs}ms`,
      );
    }
    throw new KnowledgeHygieneGitError(failureCode, message(error));
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeChangedPath(path: string): string {
  try {
    assertKnowledgeHygieneRepositoryPathV1(path);
  } catch (error) {
    throw new KnowledgeHygieneGitError("command_failed", message(error));
  }
  return path;
}

function statusFromCode(code: string): KnowledgeHygieneChangeStatusV1 {
  if (code === "??") return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

function sortChanges(
  changes: readonly KnowledgeHygieneChangeV1[],
): KnowledgeHygieneChangeV1[] {
  return [...changes].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.old_path ?? "", right.old_path ?? "") ||
      compareText(left.status, right.status),
  );
}

function parsePorcelainStatus(output: string): KnowledgeHygieneChangeV1[] {
  const records = output.split("\0");
  const changes: KnowledgeHygieneChangeV1[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new KnowledgeHygieneGitError(
        "command_failed",
        "unexpected git status record",
      );
    }
    const code = record.slice(0, 2);
    const path = normalizeChangedPath(record.slice(3));
    const status = statusFromCode(code);
    if (status === "renamed") {
      const oldPath = records[index + 1];
      if (!oldPath) {
        throw new KnowledgeHygieneGitError(
          "command_failed",
          "git rename record is missing old path",
        );
      }
      index += 1;
      changes.push({
        path,
        old_path: normalizeChangedPath(oldPath),
        status,
      });
    } else {
      changes.push({ path, status });
    }
  }
  return sortChanges(changes);
}

function parseNameStatus(output: string): KnowledgeHygieneChangeV1[] {
  const records = output.split("\0");
  const changes: KnowledgeHygieneChangeV1[] = [];
  let index = 0;
  while (index < records.length) {
    const code = records[index];
    index += 1;
    if (!code) continue;
    if (code.startsWith("R")) {
      const oldPath = records[index];
      const newPath = records[index + 1];
      index += 2;
      if (!oldPath || !newPath) {
        throw new KnowledgeHygieneGitError(
          "command_failed",
          "git rename record is incomplete",
        );
      }
      changes.push({
        path: normalizeChangedPath(newPath),
        old_path: normalizeChangedPath(oldPath),
        status: "renamed",
      });
      continue;
    }
    const path = records[index];
    index += 1;
    if (!path) {
      throw new KnowledgeHygieneGitError(
        "command_failed",
        "git name-status record is missing path",
      );
    }
    changes.push({
      path: normalizeChangedPath(path),
      status: statusFromCode(code),
    });
  }
  return sortChanges(changes);
}

function parseUntracked(output: string): KnowledgeHygieneChangeV1[] {
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => ({
      path: normalizeChangedPath(path),
      status: "untracked" as const,
    }));
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

async function contentSha256(
  repoRoot: string,
  path: string,
): Promise<string | undefined> {
  const absolutePath = resolve(repoRoot, path);
  if (!isInsideRoot(repoRoot, absolutePath)) {
    throw new KnowledgeHygieneGitError(
      "command_failed",
      `changed path resolves outside repository: ${path}`,
    );
  }
  try {
    const metadata = await lstat(absolutePath);
    const hash = createHash("sha256");
    if (metadata.isSymbolicLink()) {
      hash.update(await readlink(absolutePath));
      return hash.digest("hex");
    }
    if (!metadata.isFile()) return undefined;

    const handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) return undefined;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  } catch (error) {
    throw new KnowledgeHygieneGitError(
      "command_failed",
      `cannot hash changed path ${path}: ${message(error)}`,
    );
  }
}

async function addWorktreeContentHashes(
  repoRoot: string,
  changes: readonly KnowledgeHygieneChangeV1[],
): Promise<KnowledgeHygieneChangeV1[]> {
  const hashedChanges: KnowledgeHygieneChangeV1[] = [];
  for (const change of changes) {
    if (change.status === "deleted") {
      hashedChanges.push(change);
      continue;
    }
    const hash = await contentSha256(repoRoot, change.path);
    hashedChanges.push(
      hash === undefined ? change : { ...change, content_sha256: hash },
    );
  }
  return hashedChanges;
}

function changedPaths(changes: readonly KnowledgeHygieneChangeV1[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.path);
    if (change.old_path) paths.add(change.old_path);
  }
  return [...paths].sort(compareText);
}

function validateInput(input: BuildKnowledgeHygieneChangeSetInputV1): void {
  if (typeof input.repo_root !== "string" || input.repo_root.length === 0) {
    throw new KnowledgeHygieneGitError("invalid_input", "repo_root is required");
  }
  if (
    input.mode !== "worktree" &&
    input.mode !== "range" &&
    input.mode !== "base_to_worktree"
  ) {
    throw new KnowledgeHygieneGitError("invalid_input", "unsupported change-set mode");
  }
  if (
    input.timeout_ms !== undefined &&
    (!Number.isInteger(input.timeout_ms) || input.timeout_ms <= 0)
  ) {
    throw new KnowledgeHygieneGitError(
      "invalid_input",
      "timeout_ms must be a positive integer",
    );
  }
  if (
    input.config_sha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(input.config_sha256)
  ) {
    throw new KnowledgeHygieneGitError(
      "invalid_input",
      "config_sha256 must be 64 lowercase hex characters",
    );
  }
  if (
    (input.mode === "range" || input.mode === "base_to_worktree") &&
    (typeof input.base_ref !== "string" || input.base_ref.length === 0)
  ) {
    throw new KnowledgeHygieneGitError("invalid_input", "base_ref is required");
  }
  if (
    input.mode === "range" &&
    (typeof input.head_ref !== "string" || input.head_ref.length === 0)
  ) {
    throw new KnowledgeHygieneGitError("invalid_input", "head_ref is required");
  }
}

async function resolveRef(
  runner: KnowledgeHygieneGitRunnerV1,
  cwd: string,
  ref: string,
  timeoutMs: number,
): Promise<string> {
  const output = await runGit(
    runner,
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd,
    timeoutMs,
    "invalid_ref",
  );
  return output.trim();
}

export async function buildKnowledgeHygieneChangeSet(
  input: BuildKnowledgeHygieneChangeSetInputV1,
  ports: KnowledgeHygieneChangeSetPortsV1 = {},
): Promise<KnowledgeHygieneChangeSetV1> {
  validateInput(input);
  const timeoutMs = input.timeout_ms ?? DEFAULT_GIT_TIMEOUT_MS;
  const runner = ports.run_git ?? defaultGitRunner;
  let requestedRoot: string;
  try {
    requestedRoot = await realpath(resolve(input.repo_root));
  } catch (error) {
    throw new KnowledgeHygieneGitError("invalid_repository", message(error));
  }

  const topLevelOutput = await runGit(
    runner,
    ["rev-parse", "--show-toplevel"],
    requestedRoot,
    timeoutMs,
    "not_git_repository",
  );
  let repoRoot: string;
  try {
    repoRoot = await realpath(topLevelOutput.trim());
  } catch (error) {
    throw new KnowledgeHygieneGitError("invalid_repository", message(error));
  }

  const baseRef = input.mode === "worktree" ? "HEAD" : input.base_ref;
  const baseSha = await resolveRef(runner, repoRoot, baseRef, timeoutMs);
  let changes: KnowledgeHygieneChangeV1[];
  let headRef: string | undefined;
  let headSha: string | undefined;

  if (input.mode === "range") {
    headRef = input.head_ref;
    headSha = await resolveRef(runner, repoRoot, headRef, timeoutMs);
    const output = await runGit(
      runner,
      ["diff", "--name-status", "-z", "--find-renames", baseSha, headSha, "--"],
      repoRoot,
      timeoutMs,
      "command_failed",
    );
    changes = parseNameStatus(output);
  } else if (input.mode === "worktree") {
    const output = await runGit(
      runner,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      repoRoot,
      timeoutMs,
      "command_failed",
    );
    changes = await addWorktreeContentHashes(repoRoot, parsePorcelainStatus(output));
  } else {
    const [trackedOutput, untrackedOutput] = await Promise.all([
      runGit(
        runner,
        ["diff", "--name-status", "-z", "--find-renames", baseSha, "--"],
        repoRoot,
        timeoutMs,
        "command_failed",
      ),
      runGit(
        runner,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        repoRoot,
        timeoutMs,
        "command_failed",
      ),
    ]);
    changes = await addWorktreeContentHashes(
      repoRoot,
      sortChanges([
        ...parseNameStatus(trackedOutput),
        ...parseUntracked(untrackedOutput),
      ]),
    );
  }

  changes = sortChanges(changes);
  const paths = changedPaths(changes);
  const portableIdentity = {
    schema_version: "1",
    mode: input.mode,
    base_ref: baseRef,
    base_sha: baseSha,
    ...(headRef === undefined ? {} : { head_ref: headRef }),
    ...(headSha === undefined ? {} : { head_sha: headSha }),
    ...(input.config_sha256 === undefined
      ? {}
      : { config_sha256: input.config_sha256 }),
    changes,
    changed_paths: paths,
  } as const;
  const diffId = `diff_${createHash("sha256")
    .update(JSON.stringify(portableIdentity))
    .digest("hex")}`;

  return KnowledgeHygieneChangeSetV1.parse({
    ...portableIdentity,
    repo_root: repoRoot,
    diff_id: diffId,
  });
}
