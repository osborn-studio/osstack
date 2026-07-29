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
  commands: string[];
}

export interface CommitStagedCandidateInput {
  workspace_path: string;
  expected_base_commit_sha: string;
  expected_diff_sha256: string;
  idempotency_key: string;
  message: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(
  workspacePath: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await execFileAsync(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: workspacePath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
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

async function head(workspacePath: string): Promise<string> {
  const value = (await git(workspacePath, ["rev-parse", "HEAD"])).trim();
  if (!GitCommitSha.test(value)) {
    throw new Error("Git HEAD is not a full commit SHA");
  }
  return value;
}

async function gitBlob(
  workspacePath: string,
  spec: string,
): Promise<string | undefined> {
  try {
    await git(workspacePath, ["cat-file", "-e", spec]);
  } catch {
    return undefined;
  }
  return await git(workspacePath, ["show", spec]);
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
      gitBlob(workspacePath, `${baseCommitSha}:${path}`),
      gitBlob(workspacePath, `:${path}`),
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

async function stagedMaterial(workspacePath: string): Promise<{
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
    ]),
    git(workspacePath, [
      "diff",
      "--cached",
      "--binary",
      "--no-ext-diff",
      "HEAD",
      "--",
    ]),
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
  const baseCommitSha = await head(input.workspace_path);
  await git(input.workspace_path, ["add", "-A", "--"]);
  const material = await stagedMaterial(input.workspace_path);
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
  const material = await stagedMaterial(input.workspace_path);
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
  ]);
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
