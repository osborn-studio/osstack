import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { CandidateEvidenceSchema, CandidateEvidenceContextSchema, assertCandidateEvidenceBinding, type CandidateEvidence, type CandidateEvidenceContext } from "./candidate-evidence.js";

const execFileAsync = promisify(execFile);
const GitCommitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const SafeRemote = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const SafeRef = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith("-"), "unsafe ref starts with '-'")
  .refine(
    (value) => ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    }),
    "ref contains whitespace or control characters",
  );

const GitHubDeliveryInputSchema = z
  .object({
    workspacePath: z
      .string()
      .min(1)
      .refine(isAbsolute, "workspacePath must be absolute"),
    remote: SafeRemote,
    base: SafeRef,
    branch: SafeRef,
    title: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !/[\r\n]/.test(value), "title must be one line"),
    bodyFile: z
      .string()
      .min(1)
      .refine(isAbsolute, "bodyFile must be absolute"),
    mergeStrategy: z.literal("squash"),
    ciTimeoutMs: z.number().int().min(1_000).max(86_400_000),
    candidateEvidence: CandidateEvidenceSchema.optional(),
    evidenceContext: CandidateEvidenceContextSchema.optional(),
  })
  .strict();

export interface DeliveryCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DeliveryCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
  ): Promise<DeliveryCommandResult>;
}

export interface GitHubDeliveryInput {
  workspacePath: string;
  remote: string;
  base: string;
  branch: string;
  title: string;
  bodyFile: string;
  mergeStrategy: "squash";
  ciTimeoutMs: number;
  candidateEvidence?: CandidateEvidence | undefined;
  evidenceContext?: CandidateEvidenceContext | undefined;
}

export interface GitHubDeliveryResult {
  pushedCommit: string;
  pr: {
    number: number;
    url: string;
    reused: boolean;
  };
  mergeCommit: string;
  mergedAt: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_WRITE_ATTEMPTS = 3;
const MAX_BODY_BYTES = 1024 * 1024;
const DELIVERY_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
] as const;

export function githubDeliveryEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GCM_INTERACTIVE: "Never",
  };
  for (const key of DELIVERY_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export const defaultDeliveryCommandRunner: DeliveryCommandRunner = {
  async run(command, args, options) {
    try {
      const completed = await execFileAsync(command, [...args], {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: githubDeliveryEnvironment(),
      });
      return {
        stdout: completed.stdout,
        stderr: completed.stderr,
        exitCode: 0,
      };
    } catch (error) {
      const failure = error as {
        code?: number | string;
        killed?: boolean;
        signal?: string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      const timedOut =
        failure.killed === true ||
        failure.signal === "SIGTERM" ||
        failure.code === "ETIMEDOUT";
      return {
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? ""),
        exitCode:
          timedOut
            ? 124
            : typeof failure.code === "number"
              ? failure.code
              : 1,
      };
    }
  },
};

const RepoView = z
  .object({
    nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  })
  .strict();

const PullRequestIdentity = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url(),
    headRefOid: GitCommitSha,
    state: z.literal("OPEN"),
  })
  .strict();
const PullRequestLookup = PullRequestIdentity.extend({
  state: z.enum(["OPEN", "MERGED"]),
}).strict();
type PullRequestLookup = z.infer<typeof PullRequestLookup>;

const CheckRollup = z
  .object({
    name: z.string().min(1).optional(),
    context: z.string().min(1).optional(),
    workflowName: z.string().min(1).optional(),
    status: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
  })
  .passthrough();

const MergeCandidate = PullRequestIdentity.extend({
  mergeable: z.string().min(1),
  mergeStateStatus: z.string().min(1),
  statusCheckRollup: z.array(CheckRollup),
}).strict();

const MergedPullRequest = z
  .object({
    state: z.literal("MERGED"),
    mergedAt: z.string().datetime(),
    mergeCommit: z.object({ oid: GitCommitSha }).strict(),
    url: z.string().url(),
    headRefOid: GitCommitSha,
  })
  .strict();

const RecoveredMergedPullRequest = MergedPullRequest.extend({
  number: z.number().int().positive(),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  statusCheckRollup: z.array(CheckRollup),
}).strict();

const RulesetRule = z
  .object({
    type: z.string().min(1),
    parameters: z.unknown().optional(),
  })
  .passthrough();

interface ProtectionEvidence {
  protected: boolean;
  requiredChecks: string[];
}

function commandFailure(
  operation: string,
  completed: DeliveryCommandResult,
): Error {
  const detail = (completed.stderr || completed.stdout).trim();
  return new Error(
    `${operation} failed with exit ${completed.exitCode}` +
      (detail === "" ? "" : `: ${detail}`),
  );
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function pullRequestUrl(
  value: string,
  repo: string,
  expectedNumber?: number,
): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("GitHub PR URL is malformed");
  }
  const expectedPath = new RegExp(
    `^/${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/(\\d+)$`,
    "i",
  );
  const match = url.pathname.match(expectedPath);
  const number = Number(match?.[1]);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    match === null ||
    !Number.isInteger(number) ||
    number < 1 ||
    (expectedNumber !== undefined && number !== expectedNumber)
  ) {
    throw new Error("GitHub PR URL does not match the current repository");
  }
  return url;
}

async function assertCandidateBody(bodyFile: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(bodyFile);
  } catch {
    throw new Error(`candidate proof body file does not exist: ${bodyFile}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("candidate proof body must be a regular non-symlink file");
  }
  if (stats.size < 1 || stats.size > MAX_BODY_BYTES) {
    throw new Error(
      `candidate proof body size must be between 1 and ${MAX_BODY_BYTES} bytes`,
    );
  }
}

async function runOrThrow(
  runner: DeliveryCommandRunner,
  input: GitHubDeliveryInput,
  command: string,
  args: readonly string[],
  operation: string,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<DeliveryCommandResult> {
  const completed = await runner.run(command, args, {
    cwd: input.workspacePath,
    timeoutMs,
  });
  if (completed.exitCode !== 0) throw commandFailure(operation, completed);
  return completed;
}

function remoteRepository(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim().replace(/\.git$/i, "");
  const scp = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (scp?.[1] !== undefined) return scp[1];
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return /^[^/]+\/[^/]+$/.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitMissingPullRequest(completed: DeliveryCommandResult): boolean {
  return /no pull request|no pull requests|could not resolve to a pullrequest/i.test(
    `${completed.stderr}\n${completed.stdout}`,
  );
}

async function resolvePullRequest(
  runner: DeliveryCommandRunner,
  input: GitHubDeliveryInput,
  repo: string,
  pushedCommit: string,
  retryMissing = false,
): Promise<PullRequestLookup | undefined> {
  let lastHead: string | undefined;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const completed = await runner.run(
      "gh",
      [
        "pr",
        "view",
        input.branch,
        "--json",
        "number,url,headRefOid,state",
      ],
      {
        cwd: input.workspacePath,
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      },
    );
    if (completed.exitCode !== 0) {
      if (isExplicitMissingPullRequest(completed)) {
        if (retryMissing && attempt < MAX_WRITE_ATTEMPTS) continue;
        return undefined;
      }
      throw commandFailure("GitHub PR lookup", completed);
    }
    const parsed = PullRequestLookup.safeParse(
      parseJson(completed.stdout, "GitHub PR lookup"),
    );
    if (!parsed.success) {
      throw new Error("GitHub PR lookup returned ambiguous or malformed metadata");
    }
    pullRequestUrl(parsed.data.url, repo, parsed.data.number);
    if (parsed.data.headRefOid === pushedCommit) return parsed.data;
    lastHead = parsed.data.headRefOid;
  }
  throw new Error(
    `GitHub PR head SHA ${lastHead ?? "unknown"} does not match pushed SHA ${pushedCommit}`,
  );
}

async function pushCandidate(
  runner: DeliveryCommandRunner,
  input: GitHubDeliveryInput,
): Promise<void> {
  let last: DeliveryCommandResult | undefined;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    last = await runner.run(
      "git",
      ["push", "--set-upstream", input.remote, input.branch],
      {
        cwd: input.workspacePath,
        timeoutMs: PUSH_TIMEOUT_MS,
      },
    );
    if (last.exitCode === 0) return;
  }
  throw commandFailure("git push", last!);
}

async function createPullRequest(
  runner: DeliveryCommandRunner,
  input: GitHubDeliveryInput,
  repo: string,
  pushedCommit: string,
): Promise<PullRequestLookup> {
  let last: DeliveryCommandResult | undefined;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    last = await runner.run(
      "gh",
      [
        "pr",
        "create",
        "--base",
        input.base,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body-file",
        input.bodyFile,
      ],
      {
        cwd: input.workspacePath,
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      },
    );
    if (last.exitCode === 0) {
      pullRequestUrl(last.stdout, repo);
      const resolved = await resolvePullRequest(
        runner,
        input,
        repo,
        pushedCommit,
        true,
      );
      if (resolved === undefined) {
        throw new Error("created PR acknowledgement could not be resolved");
      }
      return resolved;
    }
    const resolved = await resolvePullRequest(
      runner,
      input,
      repo,
      pushedCommit,
      true,
    );
    if (resolved !== undefined) return resolved;
  }
  throw commandFailure("GitHub PR creation", last!);
}

function legacyRequiredChecks(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("legacy branch protection metadata is malformed");
  }
  const status = (value as Record<string, unknown>)["required_status_checks"];
  if (status === null || status === undefined) return [];
  if (typeof status !== "object" || Array.isArray(status)) {
    throw new Error("legacy required status checks metadata is malformed");
  }
  const record = status as Record<string, unknown>;
  const contexts = Array.isArray(record["contexts"])
    ? record["contexts"].filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
  const checks = Array.isArray(record["checks"])
    ? record["checks"]
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? (entry as Record<string, unknown>)["context"]
            : undefined,
        )
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        )
    : [];
  return [...contexts, ...checks];
}

function rulesetRequiredChecks(rules: readonly z.infer<typeof RulesetRule>[]): string[] {
  const contexts: string[] = [];
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    if (
      typeof rule.parameters !== "object" ||
      rule.parameters === null ||
      Array.isArray(rule.parameters)
    ) {
      throw new Error("ruleset required status checks metadata is malformed");
    }
    const required = (rule.parameters as Record<string, unknown>)[
      "required_status_checks"
    ];
    if (!Array.isArray(required)) {
      throw new Error("ruleset required status checks are missing");
    }
    for (const item of required) {
      const context =
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>)["context"]
          : undefined;
      if (typeof context !== "string" || context.length === 0) {
        throw new Error("ruleset required check context is malformed");
      }
      contexts.push(context);
    }
  }
  return contexts;
}

async function readEffectiveProtection(
  runner: DeliveryCommandRunner,
  input: GitHubDeliveryInput,
  repo: string,
  branch: string,
): Promise<ProtectionEvidence> {
  const encodedBranch = encodeURIComponent(branch);
  const legacy = await runner.run(
    "gh",
    [
      "api",
      `repos/${repo}/branches/${encodedBranch}/protection`,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
    ],
    {
      cwd: input.workspacePath,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  let legacyValue: unknown | undefined;
  if (legacy.exitCode === 0) {
    legacyValue = parseJson(legacy.stdout, "legacy branch protection");
  } else if (!/HTTP 404|not protected/i.test(`${legacy.stderr}\n${legacy.stdout}`)) {
    throw commandFailure("legacy branch protection lookup", legacy);
  }

  const effectiveRules = await runner.run(
    "gh",
    [
      "api",
      `repos/${repo}/rules/branches/${encodedBranch}`,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
    ],
    {
      cwd: input.workspacePath,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    },
  );
  if (effectiveRules.exitCode !== 0) {
    throw commandFailure("applicable repository rules lookup", effectiveRules);
  }
  const rulesValue = parseJson(
    effectiveRules.stdout,
    "applicable repository rules",
  );
  const rules = z.array(RulesetRule).safeParse(rulesValue);
  if (!rules.success) {
    throw new Error("applicable repository rules metadata is malformed");
  }
  const requiredChecks = [
    ...(legacyValue === undefined ? [] : legacyRequiredChecks(legacyValue)),
    ...rulesetRequiredChecks(rules.data),
  ];
  return {
    protected: legacyValue !== undefined || rules.data.length > 0,
    requiredChecks: [...new Set(requiredChecks)].sort(),
  };
}

function rollupName(check: z.infer<typeof CheckRollup>): string | undefined {
  return check.context ?? check.name ?? check.workflowName;
}

function checkSucceeded(check: z.infer<typeof CheckRollup>): boolean {
  return (
    check.conclusion?.toUpperCase() === "SUCCESS" ||
    check.state?.toUpperCase() === "SUCCESS"
  );
}

function assertRequiredChecks(
  requiredChecks: readonly string[],
  rollup: readonly z.infer<typeof CheckRollup>[],
): void {
  if (requiredChecks.length === 0) {
    throw new Error("protected base has zero required checks");
  }
  if (rollup.length === 0) {
    throw new Error("current pushed SHA has zero check results");
  }
  for (const required of requiredChecks) {
    const matching = rollup.find((check) => rollupName(check) === required);
    if (matching === undefined) {
      throw new Error(
        `required check ${required} is absent from the current pushed SHA`,
      );
    }
    if (!checkSucceeded(matching)) {
      throw new Error(
        `required check ${required} did not succeed on the current pushed SHA`,
      );
    }
  }
}

async function recoverMergedDelivery(
  runner: DeliveryCommandRunner,
  input: GitHubDeliveryInput,
  repo: string,
  pushedCommit: string,
  pr: PullRequestLookup,
): Promise<GitHubDeliveryResult> {
  if (pr.state !== "MERGED") {
    throw new Error("merged delivery recovery requires a merged PR");
  }
  const baseProtection = await readEffectiveProtection(
    runner,
    input,
    repo,
    input.base,
  );
  if (!baseProtection.protected) {
    throw new Error("base branch has no effective protection");
  }
  const merged = RecoveredMergedPullRequest.parse(
    parseJson(
      (
        await runOrThrow(
          runner,
          input,
          "gh",
          [
            "pr",
            "view",
            String(pr.number),
            "--json",
            "number,state,mergedAt,mergeCommit,url,headRefOid,baseRefName,headRefName,statusCheckRollup",
          ],
          "recovered merged PR proof",
        )
      ).stdout,
      "recovered merged PR proof",
    ),
  );
  pullRequestUrl(merged.url, repo, pr.number);
  if (
    merged.number !== pr.number
    || merged.headRefOid !== pushedCommit
    || merged.baseRefName !== input.base
    || merged.headRefName !== input.branch
  ) {
    throw new Error(
      "recovered merged PR does not match the exact candidate scope",
    );
  }
  assertRequiredChecks(
    baseProtection.requiredChecks,
    merged.statusCheckRollup,
  );
  return {
    pushedCommit,
    pr: {
      number: pr.number,
      url: merged.url,
      reused: true,
    },
    mergeCommit: merged.mergeCommit.oid,
    mergedAt: merged.mergedAt,
  };
}

function assertUniqueCurrentRequiredChecks(requiredChecks: string[], checks: z.infer<typeof CheckRollup>[]): void {
  if (requiredChecks.length === 0 || new Set(requiredChecks).size !== requiredChecks.length) throw new Error("candidate required checks must be nonempty and unique");
  assertRequiredChecks(requiredChecks, checks);
  for (const required of requiredChecks) {
    const matching = checks.filter(check => rollupName(check) === required);
    if (matching.length !== 1 ||
      (matching[0]!.conclusion != null ? matching[0]!.conclusion!.toUpperCase() !== "SUCCESS" : matching[0]!.state?.toUpperCase() !== "SUCCESS") ||
      (matching[0]!.status != null && matching[0]!.status!.toUpperCase() !== "COMPLETED")) throw new Error("candidate current required checks are missing or unsuccessful");
  }
}

/** Stateless current observation only: never push/watch/create/merge or consume cached evidence. */
export async function observeCurrentGreenCandidate(
  value: GitHubDeliveryInput,
  currentContext: CandidateEvidenceContext,
  runner: DeliveryCommandRunner = defaultDeliveryCommandRunner,
): Promise<CandidateEvidence | undefined> {
  const input = GitHubDeliveryInputSchema.parse(value);
  if (input.candidateEvidence !== undefined || input.evidenceContext !== undefined) throw new Error("observer accepts no cached evidence");
  const context = CandidateEvidenceContextSchema.parse(currentContext);
  if (input.branch === input.base || input.branch === "main" || input.branch === "master") throw new Error("refusing protected/base candidate");
  await assertCandidateBody(input.bodyFile);
  for (const ref of [input.branch, input.base]) await runOrThrow(runner, input, "git", ["check-ref-format", "--branch", ref], "observer ref validation");
  const branch = (await runOrThrow(runner, input, "git", ["branch", "--show-current"], "observer branch")).stdout.trim();
  if (branch !== input.branch) throw new Error("observer local branch changed");
  if ((await runOrThrow(runner, input, "git", ["status", "--porcelain=v1", "-z"], "observer clean worktree")).stdout !== "") return undefined;
  const head = GitCommitSha.parse((await runOrThrow(runner, input, "git", ["rev-parse", "HEAD"], "observer local HEAD")).stdout.trim());
  const remoteUrl = (await runOrThrow(runner, input, "git", ["remote", "get-url", input.remote], "observer remote")).stdout;
  const repo = RepoView.parse(parseJson((await runOrThrow(runner, input, "gh", ["repo", "view", "--json", "nameWithOwner"], "observer repository")).stdout, "observer repository")).nameWithOwner;
  if (remoteRepository(remoteUrl)?.toLowerCase() !== repo.toLowerCase()) throw new Error("observer remote repository mismatch");
  const rows = (await runOrThrow(runner, input, "git", ["ls-remote", "--refs", input.remote, `refs/heads/${input.branch}`, `refs/heads/${input.base}`], "observer remote commits")).stdout.trim().split("\n");
  if (rows.length > 2) throw new Error("observer remote metadata has extra rows");
  if (rows.length === 1 && rows[0] === "") return undefined;
  const refs = new Map<string, string>();
  for (const row of rows) {
    const parts = row.split("\t");
    if (parts.length !== 2 || refs.has(parts[1]!) || ![`refs/heads/${input.branch}`, `refs/heads/${input.base}`].includes(parts[1]!)) throw new Error("observer remote metadata malformed");
    refs.set(parts[1]!, GitCommitSha.parse(parts[0]));
  }
  const remoteHead = refs.get(`refs/heads/${input.branch}`), base = refs.get(`refs/heads/${input.base}`);
  if (remoteHead === undefined || base === undefined) return undefined;
  if (remoteHead !== head) return undefined; // A normal pending push, never evidence of current green.
  if ((await readEffectiveProtection(runner, input, repo, input.branch)).protected) throw new Error("observer candidate branch protected");
  const protection = await readEffectiveProtection(runner, input, repo, input.base);
  if (!protection.protected || !protection.requiredChecks.length) return undefined;
  const pr = await resolvePullRequest(runner, input, repo, head);
  if (pr === undefined || pr.state !== "OPEN") return undefined;
  const scope = z.object({ headRefOid: GitCommitSha, baseRefName: z.string(), headRefName: z.string() }).strict().parse(parseJson((await runOrThrow(runner, input, "gh", ["pr", "view", String(pr.number), "--json", "headRefOid,baseRefName,headRefName"], "observer PR scope")).stdout, "observer PR scope"));
  if (scope.headRefOid !== head || scope.baseRefName !== input.base || scope.headRefName !== input.branch) throw new Error("observer PR scope changed");
  const candidate = MergeCandidate.parse(parseJson((await runOrThrow(runner, input, "gh", ["pr", "view", String(pr.number), "--json", "number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup"], "observer current checks")).stdout, "observer current checks"));
  pullRequestUrl(candidate.url, repo, pr.number);
  if (candidate.number !== pr.number || candidate.headRefOid !== head) throw new Error("observer PR identity changed");
  if (candidate.mergeable !== "MERGEABLE" || candidate.mergeStateStatus !== "CLEAN") return undefined;
  try { assertUniqueCurrentRequiredChecks(protection.requiredChecks, candidate.statusCheckRollup); } catch { return undefined; }
  // Observation is only a hint. The consumer repeats all current remote/CI checks before any merge.
  return CandidateEvidenceSchema.parse({ schemaVersion: 1, repo, headSha: head, baseSha: base, ...context, requiredChecks: protection.requiredChecks, observedAt: new Date().toISOString() });
}

export async function deliverToGitHub(
  value: GitHubDeliveryInput,
  runner: DeliveryCommandRunner = defaultDeliveryCommandRunner,
): Promise<GitHubDeliveryResult> {
  const input = GitHubDeliveryInputSchema.parse(value);
  if (
    (input.candidateEvidence === undefined) !==
    (input.evidenceContext === undefined)
  )
    throw new Error("candidate evidence requires current controller context");
  await assertCandidateBody(input.bodyFile);
  if (
    input.branch === input.base ||
    input.branch === "main" ||
    input.branch === "master"
  ) {
    throw new Error("refusing to push a protected/base branch");
  }

  await runOrThrow(
    runner,
    input,
    "gh",
    ["auth", "status"],
    "GitHub authentication",
  );
  await runOrThrow(
    runner,
    input,
    "git",
    ["check-ref-format", "--branch", input.branch],
    "candidate branch validation",
  );
  await runOrThrow(
    runner,
    input,
    "git",
    ["check-ref-format", "--branch", input.base],
    "base branch validation",
  );

  const currentBranch = (
    await runOrThrow(
      runner,
      input,
      "git",
      ["branch", "--show-current"],
      "current branch lookup",
    )
  ).stdout.trim();
  if (currentBranch !== input.branch) {
    throw new Error(
      `current branch ${currentBranch || "(detached)"} does not match ${input.branch}`,
    );
  }
  const status = await runOrThrow(
    runner,
    input,
    "git",
    ["status", "--porcelain=v1", "-z"],
    "worktree status",
  );
  if (status.stdout.length !== 0) {
    throw new Error("GitHub delivery requires a clean committed worktree");
  }

  const remoteUrl = (
    await runOrThrow(
      runner,
      input,
      "git",
      ["remote", "get-url", input.remote],
      "Git remote lookup",
    )
  ).stdout;
  const repo = RepoView.parse(
    parseJson(
      (
        await runOrThrow(
          runner,
          input,
          "gh",
          ["repo", "view", "--json", "nameWithOwner"],
          "GitHub repository lookup",
        )
      ).stdout,
      "GitHub repository lookup",
    ),
  ).nameWithOwner;
  const remoteRepo = remoteRepository(remoteUrl);
  if (
    remoteRepo === undefined ||
    remoteRepo.toLowerCase() !== repo.toLowerCase()
  ) {
    throw new Error(
      "Git remote repository does not match authenticated GitHub repository",
    );
  }

  const candidateProtection = await readEffectiveProtection(
    runner,
    input,
    repo,
    input.branch,
  );
  if (candidateProtection.protected) {
    throw new Error(
      "refusing to push an effectively protected candidate branch",
    );
  }

  const pushedCommit = GitCommitSha.parse(
    (
      await runOrThrow(
        runner,
        input,
        "git",
        ["rev-parse", "HEAD"],
        "candidate commit lookup",
      )
    ).stdout.trim(),
  );
  const evidence = input.candidateEvidence;
  async function assertRemoteBinding(): Promise<void> {
    const rows = (
      await runOrThrow(
        runner,
        input,
        "git",
        [
          "ls-remote",
          "--refs",
          input.remote,
          `refs/heads/${input.branch}`,
          `refs/heads/${input.base}`,
        ],
        "candidate remote evidence",
      )
    ).stdout
      .trim()
      .split("\n");
    const expected = new Map([
      [`refs/heads/${input.branch}`, pushedCommit],
      [`refs/heads/${input.base}`, evidence!.baseSha],
    ]);
    if (
      rows.length !== 2 ||
      rows.some((row) => {
        const fields = row.split("\t");
        if (fields.length !== 2 || expected.get(fields[1]!) !== fields[0])
          return true;
        expected.delete(fields[1]!);
        return false;
      }) ||
      expected.size !== 0
    )
      throw new Error("candidate remote head/base binding changed or missing");
  }
  if (evidence !== undefined) {
    const protection = await readEffectiveProtection(
      runner,
      input,
      repo,
      input.base,
    );
    if (!protection.protected)
      throw new Error("base branch has no effective protection");
    assertCandidateEvidenceBinding(
      evidence,
      input.evidenceContext!,
      repo,
      pushedCommit,
      protection.requiredChecks,
    );
    await assertRemoteBinding();
  }
  let pr = await resolvePullRequest(runner, input, repo, pushedCommit);
  if (evidence !== undefined && pr?.state === "MERGED")
    throw new Error("candidate evidence requires current open PR");
  if (pr?.state === "MERGED") {
    return await recoverMergedDelivery(runner, input, repo, pushedCommit, pr);
  }

  async function assertPullRequestScope(number: number): Promise<void> {
    const identity = z
      .object({
        headRefOid: GitCommitSha,
        baseRefName: z.string(),
        headRefName: z.string(),
      })
      .strict()
      .parse(
        parseJson(
          (
            await runOrThrow(
              runner,
              input,
              "gh",
              [
                "pr",
                "view",
                String(number),
                "--json",
                "headRefOid,baseRefName,headRefName",
              ],
              "candidate scope evidence",
            )
          ).stdout,
          "candidate scope evidence",
        ),
      );
    if (
      identity.headRefOid !== pushedCommit ||
      identity.baseRefName !== input.base ||
      identity.headRefName !== input.branch
    )
      throw new Error("candidate PR scope binding mismatched");
  }
  if (evidence !== undefined) {
    if (pr === undefined || pr.state !== "OPEN")
      throw new Error("candidate evidence requires current open PR");
    await assertPullRequestScope(pr.number);
  } else await pushCandidate(runner, input);
  const afterPushCommit = GitCommitSha.parse(
    (
      await runOrThrow(
        runner,
        input,
        "git",
        ["rev-parse", "HEAD"],
        "post-push commit lookup",
      )
    ).stdout.trim(),
  );
  if (afterPushCommit !== pushedCommit) {
    throw new Error("local HEAD changed after push; refusing PR delivery");
  }

  let reused = pr !== undefined;
  if (pr === undefined) {
    pr = await resolvePullRequest(runner, input, repo, pushedCommit);
    reused = pr !== undefined;
    if (pr === undefined) {
      pr = await createPullRequest(runner, input, repo, pushedCommit);
      reused = false;
    }
  }
  if (pr.state === "MERGED") {
    return await recoverMergedDelivery(runner, input, repo, pushedCommit, pr);
  }

  if (evidence === undefined) {
    const checks = await runner.run(
      "gh",
      ["pr", "checks", String(pr.number), "--watch", "--fail-fast"],
      {
        cwd: input.workspacePath,
        timeoutMs: input.ciTimeoutMs,
      },
    );
    if (checks.exitCode === 124) {
      throw new Error(`CI timeout after ${input.ciTimeoutMs} ms`);
    }
    if (checks.exitCode !== 0) throw commandFailure("CI checks", checks);
  }

  const baseProtection = await readEffectiveProtection(
    runner,
    input,
    repo,
    input.base,
  );
  if (!baseProtection.protected) {
    throw new Error("base branch has no effective protection");
  }

  const mergeCandidate = MergeCandidate.parse(
    parseJson(
      (
        await runOrThrow(
          runner,
          input,
          "gh",
          [
            "pr",
            "view",
            String(pr.number),
            "--json",
            "number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup",
          ],
          "merge candidate lookup",
        )
      ).stdout,
      "merge candidate lookup",
    ),
  );
  pullRequestUrl(mergeCandidate.url, repo, pr.number);
  if (mergeCandidate.number !== pr.number) {
    throw new Error("merge candidate metadata resolved to a different PR");
  }
  if (mergeCandidate.headRefOid !== pushedCommit) {
    throw new Error("PR head SHA changed after checks; refusing merge");
  }
  if (
    mergeCandidate.mergeable !== "MERGEABLE" ||
    mergeCandidate.mergeStateStatus !== "CLEAN"
  ) {
    throw new Error(
      `PR is not cleanly mergeable: ${mergeCandidate.mergeable}/${mergeCandidate.mergeStateStatus}`,
    );
  }
  assertRequiredChecks(
    baseProtection.requiredChecks,
    mergeCandidate.statusCheckRollup,
  );

  if (evidence !== undefined) {
    assertCandidateEvidenceBinding(
      evidence,
      input.evidenceContext!,
      repo,
      pushedCommit,
      baseProtection.requiredChecks,
    );
    assertUniqueCurrentRequiredChecks(baseProtection.requiredChecks, mergeCandidate.statusCheckRollup);
    await assertPullRequestScope(pr.number);
    await assertRemoteBinding();
  }
  await runOrThrow(
    runner,
    input,
    "gh",
    [
      "pr",
      "merge",
      String(pr.number),
      "--squash",
      "--delete-branch",
      "--match-head-commit",
      pushedCommit,
    ],
    "SHA-bound PR merge",
  );

  const merged = MergedPullRequest.parse(
    parseJson(
      (
        await runOrThrow(
          runner,
          input,
          "gh",
          [
            "pr",
            "view",
            String(pr.number),
            "--json",
            "state,mergedAt,mergeCommit,url,headRefOid",
          ],
          "merged PR proof",
        )
      ).stdout,
      "merged PR proof",
    ),
  );
  pullRequestUrl(merged.url, repo, pr.number);
  if (merged.headRefOid !== pushedCommit) {
    throw new Error("merged PR head does not match the pushed commit");
  }
  return {
    pushedCommit,
    pr: {
      number: pr.number,
      url: pr.url,
      reused,
    },
    mergeCommit: merged.mergeCommit.oid,
    mergedAt: merged.mergedAt,
  };
}
