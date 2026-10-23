import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  PostDiffInput,
  parseStagedPorcelainV1ZPaths,
  type PostDiffInput as PostDiffInputType,
} from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GitCommitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export interface StageCandidateInput {
  workspace_path: string;
  expected_base_commit_sha?: string;
  commands: string[];
  hardened?: boolean;
}

export interface CommitStagedCandidateInput {
  workspace_path: string;
  expected_base_commit_sha: string;
  expected_diff_sha256: string;
  idempotency_key: string;
  message: string;
  hardened?: boolean;
}

export interface AssertGuardedCandidateBaseInput {
  workspace_path: string;
  remote: string;
  base: string;
}

export interface AssertGuardedMergedCandidateInput {
  workspace_path: string;
  remote: string;
  base: string;
  expected_merge_commit_sha: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(
  workspacePath: string,
  args: readonly string[],
  hardened = false,
): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      {
        cwd: workspacePath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          ...(hardened ? { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } : {}),
        },
      },
    );
    return result.stdout;
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const detail = String(failure.stderr ?? failure.stdout ?? "").trim();
    throw new Error(
      `git ${args.join(" ")} failed${
        failure.code === undefined ? "" : ` (${String(failure.code)})`
      }${detail === "" ? "" : `: ${detail}`}`,
    );
  }
}

async function assertHardenedGitFilters(workspacePath: string): Promise<void> {
  const config = await git(workspacePath, ["config", "--local", "--null", "--list"], true);
  if (config.split("\0").some(entry => /^filter\..*\.(?:clean|smudge|process)\n/i.test(entry)))
    throw new Error("guarded Git filters are unsupported for hardened candidates");
}

async function head(workspacePath: string): Promise<string> {
  const value = (await git(workspacePath, ["rev-parse", "HEAD"])).trim();
  if (!GitCommitSha.test(value)) {
    throw new Error("Git HEAD is not a full commit SHA");
  }
  return value;
}

async function cleanStatus(workspacePath: string): Promise<string> {
  return await git(workspacePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
}

export async function assertGuardedCandidateBase(
  input: AssertGuardedCandidateBaseInput,
): Promise<{ base_commit_sha: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.remote)) {
    throw new Error("guarded candidate remote name is invalid");
  }
  await git(input.workspace_path, [
    "check-ref-format",
    "--branch",
    input.base,
  ]);
  if (await cleanStatus(input.workspace_path) !== "") {
    throw new Error(
      "guarded candidate requires a clean initial worktree",
    );
  }
  await git(input.workspace_path, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    input.remote,
    `refs/heads/${input.base}`,
  ]);
  const fetchedBase = (
    await git(input.workspace_path, [
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ])
  ).trim();
  if (!GitCommitSha.test(fetchedBase)) {
    throw new Error("fetched guarded base is not a full commit SHA");
  }
  const currentHead = await head(input.workspace_path);
  if (currentHead !== fetchedBase) {
    throw new Error(
      "guarded candidate HEAD is not the exact fetched base commit",
    );
  }
  if (await cleanStatus(input.workspace_path) !== "") {
    throw new Error(
      "guarded candidate worktree changed during base verification",
    );
  }
  return { base_commit_sha: fetchedBase };
}

export async function assertGuardedCandidateHead(
  workspacePath: string,
  expectedBaseCommitSha: string,
): Promise<void> {
  if (!GitCommitSha.test(expectedBaseCommitSha)) {
    throw new Error("expected guarded base is not a full commit SHA");
  }
  if (await head(workspacePath) !== expectedBaseCommitSha) {
    throw new Error(
      "candidate HEAD changed after exact remote-base verification",
    );
  }
  if (await cleanStatus(workspacePath) !== "") {
    throw new Error(
      "guarded Builder requires a clean base worktree",
    );
  }
}

export async function assertGuardedMergedCandidate(
  input: AssertGuardedMergedCandidateInput,
): Promise<void> {
  if (!GitCommitSha.test(input.expected_merge_commit_sha)) {
    throw new Error("expected guarded merge is not a full commit SHA");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.remote)) {
    throw new Error("guarded candidate remote name is invalid");
  }
  await git(input.workspace_path, [
    "check-ref-format",
    "--branch",
    input.base,
  ]);
  if (await cleanStatus(input.workspace_path) !== "") {
    throw new Error(
      "post-merge deployment requires a clean candidate worktree",
    );
  }
  await git(input.workspace_path, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    input.remote,
    `refs/heads/${input.base}`,
  ]);
  const fetchedMerge = (
    await git(input.workspace_path, [
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ])
  ).trim();
  if (fetchedMerge !== input.expected_merge_commit_sha) {
    throw new Error(
      "fetched deployment base does not match recorded merge commit",
    );
  }
  const [candidateTree, mergeTree] = await Promise.all([
    git(input.workspace_path, ["rev-parse", "HEAD^{tree}"]),
    git(input.workspace_path, [
      "rev-parse",
      `${input.expected_merge_commit_sha}^{tree}`,
    ]),
  ]);
  if (candidateTree.trim() !== mergeTree.trim()) {
    throw new Error(
      "local deployment tree does not match the recorded merged tree",
    );
  }
  if (await cleanStatus(input.workspace_path) !== "") {
    throw new Error(
      "candidate worktree changed during merged-tree verification",
    );
  }
}

async function baseGitBlob(
  workspacePath: string,
  baseCommitSha: string,
  path: string,
): Promise<string | undefined> {
  const entry = await git(workspacePath, [
    "ls-tree",
    "-z",
    "--full-tree",
    baseCommitSha,
    "--",
    path,
  ]);
  if (entry === "") return undefined;
  return await git(workspacePath, ["show", `${baseCommitSha}:${path}`]);
}

async function stagedGitBlob(
  workspacePath: string,
  path: string,
): Promise<string | undefined> {
  const entry = await git(workspacePath, [
    "ls-files",
    "--stage",
    "-z",
    "--",
    path,
  ]);
  if (entry === "") return undefined;
  return await git(workspacePath, ["show", `:${path}`]);
}

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function dependencyVersions(
  raw: string | undefined,
  path: string,
): Map<string, string> {
  if (raw === undefined) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `cannot classify dependencies in ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    parsed === null
    || Array.isArray(parsed)
    || typeof parsed !== "object"
  ) {
    throw new Error(`cannot classify dependencies in ${path}: expected object`);
  }
  const result = new Map<string, string>();
  const manifest = parsed as Record<string, unknown>;
  for (const section of DEPENDENCY_SECTIONS) {
    const value = manifest[section];
    if (value === undefined) continue;
    if (
      value === null
      || Array.isArray(value)
      || typeof value !== "object"
    ) {
      throw new Error(
        `cannot classify dependencies in ${path}: ${section} must be an object`,
      );
    }
    for (const [name, version] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof version !== "string" || version.length === 0) {
        throw new Error(
          `cannot classify dependency ${name} in ${path}: version must be a string`,
        );
      }
      const existing = result.get(name);
      if (existing !== undefined && existing !== version) {
        throw new Error(
          `cannot classify dependency ${name} in ${path}: conflicting versions`,
        );
      }
      result.set(name, version);
    }
  }
  return result;
}

function dependencyMajor(version: string): number | undefined {
  const normalized = version.replace(/^workspace:/, "");
  const match = normalized.match(/^[~^<>=\s]*(\d+)\./);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function isMajorDependencyChange(
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (from === undefined || to === undefined || from === to) return false;
  const fromMajor = dependencyMajor(from);
  const toMajor = dependencyMajor(to);
  // Unknown non-registry protocols cannot establish a safe same-major
  // relation, so a changed opaque spec is conservatively R3.
  return fromMajor === undefined
    || toMajor === undefined
    || fromMajor !== toMajor;
}

async function dependencyChanges(
  workspacePath: string,
  baseCommitSha: string,
  changedPaths: readonly string[],
): Promise<PostDiffInputType["dependency_changes"]> {
  const changes = new Map<
    string,
    PostDiffInputType["dependency_changes"][number]
  >();
  for (const path of changedPaths) {
    if (path !== "package.json" && !path.endsWith("/package.json")) {
      continue;
    }
    const [beforeRaw, afterRaw] = await Promise.all([
      baseGitBlob(workspacePath, baseCommitSha, path),
      stagedGitBlob(workspacePath, path),
    ]);
    const before = dependencyVersions(beforeRaw, path);
    const after = dependencyVersions(afterRaw, path);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const from = before.get(name);
      const to = after.get(name);
      if (from === to) continue;
      const existing = changes.get(name);
      if (
        existing !== undefined
        && (existing.from !== from || existing.to !== to)
      ) {
        throw new Error(
          `cannot classify dependency ${name}: changed inconsistently across manifests`,
        );
      }
      changes.set(name, {
        name,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        major: isMajorDependencyChange(from, to),
      });
    }
  }
  return [...changes.values()].sort(
    (left, right) => left.name.localeCompare(right.name),
  );
}

async function stagedMaterial(workspacePath: string, hardened = false): Promise<{
  status: string;
  diff: string;
  changedPaths: string[];
}> {
  const [status, diff] = await Promise.all([
    git(workspacePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ], hardened),
    git(workspacePath, [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ], hardened),
  ]);
  return {
    status,
    diff,
    changedPaths: parseStagedPorcelainV1ZPaths(status),
  };
}

export async function stageGuardedCandidate(
  input: StageCandidateInput,
): Promise<PostDiffInputType> {
  if (input.hardened) await assertHardenedGitFilters(input.workspace_path);
  const baseCommitSha = await head(input.workspace_path);
  if (
    input.expected_base_commit_sha !== undefined
    && baseCommitSha !== input.expected_base_commit_sha
  ) {
    throw new Error(
      "candidate base changed after exact remote-base verification",
    );
  }
  await git(input.workspace_path, ["add", "-A", "--"], input.hardened);
  const material = await stagedMaterial(input.workspace_path, input.hardened);
  const dependencies = await dependencyChanges(
    input.workspace_path,
    baseCommitSha,
    material.changedPaths,
  );
  return PostDiffInput.parse({
    base_commit_sha: baseCommitSha,
    changed_paths: material.changedPaths,
    staged_diff_binary: material.diff,
    status_porcelain_v1_z: material.status,
    commands: [...input.commands],
    dependency_changes: dependencies,
  });
}

async function idempotentCommittedHead(
  input: CommitStagedCandidateInput,
): Promise<string | undefined> {
  const currentHead = await head(input.workspace_path);
  if (currentHead === input.expected_base_commit_sha) return undefined;
  const body = await git(input.workspace_path, [
    "show",
    "-s",
    "--format=%B",
    currentHead,
  ]);
  if (
    !body.includes(
      `OSSTACK-IDEMPOTENCY-KEY: ${input.idempotency_key}`,
    )
    || !body.includes(
      `OSSTACK-DIFF-SHA256: ${input.expected_diff_sha256}`,
    )
  ) {
    throw new Error(
      "candidate HEAD advanced without matching idempotency evidence",
    );
  }
  const committedDiff = await git(input.workspace_path, [
    "diff",
    "--binary",
    "--no-ext-diff",
    `${currentHead}^`,
    currentHead,
    "--",
  ]);
  if (digest(committedDiff) !== input.expected_diff_sha256) {
    throw new Error(
      "idempotent candidate commit does not match its recorded diff digest",
    );
  }
  return currentHead;
}

export async function commitGuardedCandidate(
  input: CommitStagedCandidateInput,
): Promise<{ commit: string }> {
  if (input.hardened) await assertHardenedGitFilters(input.workspace_path);
  const material = await stagedMaterial(input.workspace_path, input.hardened);
  if (material.status === "" && material.diff === "") {
    const reused = await idempotentCommittedHead(input);
    if (reused === undefined) {
      throw new Error("guarded candidate has no staged change to commit");
    }
    return { commit: reused };
  }
  const currentHead = await head(input.workspace_path);
  if (currentHead !== input.expected_base_commit_sha) {
    throw new Error(
      "candidate base commit changed after staged risk classification",
    );
  }
  if (digest(material.diff) !== input.expected_diff_sha256) {
    throw new Error(
      "staged candidate changed after risk classification",
    );
  }
  await git(input.workspace_path, [
    "-c",
    "user.name=osstack-autonomy",
    "-c",
    "user.email=osstack-autonomy@example.invalid",
    "commit",
    "-m",
    input.message,
    "-m",
    [
      `OSSTACK-IDEMPOTENCY-KEY: ${input.idempotency_key}`,
      `OSSTACK-DIFF-SHA256: ${input.expected_diff_sha256}`,
    ].join("\n"),
  ], input.hardened);
  const commit = await head(input.workspace_path);
  const after = await git(input.workspace_path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (after !== "") {
    throw new Error(
      "worktree changed during guarded commit; refusing Git delivery",
    );
  }
  return { commit };
}
