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
  dependency_changes?: PostDiffInputType["dependency_changes"];
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
  return PostDiffInput.parse({
    base_commit_sha: baseCommitSha,
    changed_paths: material.changedPaths,
    staged_diff_binary: material.diff,
    status_porcelain_v1_z: material.status,
    commands: [...input.commands],
    dependency_changes: [...(input.dependency_changes ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name)),
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
