import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  DeployTargetPolicy as DeployTargetPolicySchema,
  type DeployTargetPolicy,
} from "@osstack/core";
import { z } from "zod";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE_ENVIRONMENT_NAMES = ["PATH", "HOME", "LANG", "TMPDIR"] as const;
const PACKAGE_MANAGER_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_AUTHORITY_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_ENVIRONMENT_VALUE_BYTES = 16 * 1_024;

export interface DeployCommandEvidence {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout_summary: string;
  stderr_summary: string;
  timed_out: boolean;
}

export const DeployCommandEvidenceSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    exit_code: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    stdout_summary: z.string(),
    stderr_summary: z.string(),
    timed_out: z.boolean(),
  })
  .strict();

export interface ProjectDeployResult {
  target: "staging" | "production";
  deploy: DeployCommandEvidence;
  verify?: DeployCommandEvidence | undefined;
  health?: DeployCommandEvidence | undefined;
  rollback?: DeployCommandEvidence | undefined;
  post_rollback_health?: DeployCommandEvidence | undefined;
  outcome:
    | "healthy"
    | "deploy_failed"
    | "verify_failed"
    | "health_failed_rolled_back"
    | "rollback_failed"
    | "cancelled";
}

export const ProjectDeployResultSchema = z
  .object({
    target: z.enum(["staging", "production"]),
    deploy: DeployCommandEvidenceSchema,
    verify: DeployCommandEvidenceSchema.optional(),
    health: DeployCommandEvidenceSchema.optional(),
    rollback: DeployCommandEvidenceSchema.optional(),
    post_rollback_health: DeployCommandEvidenceSchema.optional(),
    outcome: z.enum([
      "healthy",
      "deploy_failed",
      "verify_failed",
      "health_failed_rolled_back",
      "rollback_failed",
      "cancelled",
    ]),
  })
  .strict()
  .superRefine((result, context) => {
    const passed = (
      evidence: z.infer<typeof DeployCommandEvidenceSchema> | undefined,
    ) =>
      evidence !== undefined
      && evidence.exit_code === 0
      && !evidence.timed_out;
    if (
      result.target === "staging"
      && (
        result.rollback !== undefined
        || result.post_rollback_health !== undefined
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollback"],
        message: "staging deployment must not contain rollback evidence",
      });
    }
    if (
      result.outcome === "healthy"
      && (
        !passed(result.deploy)
        || !passed(result.verify)
        || !passed(result.health)
        || result.rollback !== undefined
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message:
          "healthy outcome requires passing deploy, verify, and health evidence without rollback",
      });
    }
    if (
      result.outcome === "verify_failed"
      && (
        result.verify === undefined
        || passed(result.verify)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "verify_failed requires failing verify evidence",
      });
    }
    const primaryFailed =
      !passed(result.deploy)
      || (
        result.verify !== undefined
        && !passed(result.verify)
      )
      || (
        result.health !== undefined
        && !passed(result.health)
      );
    if (
      (
        result.outcome === "deploy_failed"
        || result.outcome === "cancelled"
      )
      && !primaryFailed
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message:
          `${result.outcome} requires failing or timed-out command evidence`,
      });
    }
    if (
      result.outcome === "health_failed_rolled_back"
      && (
        result.target !== "production"
        || result.health === undefined
        || passed(result.health)
        || !passed(result.rollback)
        || !passed(result.post_rollback_health)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message:
          "health_failed_rolled_back requires failed production health plus passing rollback and post-rollback health",
      });
    }
    if (
      result.outcome === "rollback_failed"
      && (
        result.target !== "production"
        || (
          passed(result.rollback)
          && passed(result.post_rollback_health)
        )
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message:
          "rollback_failed requires production rollback or post-rollback health failure",
      });
    }
    if (
      result.target === "production"
      && (
        result.outcome === "deploy_failed"
        || result.outcome === "verify_failed"
        || result.outcome === "cancelled"
      )
      && (
        !passed(result.rollback)
        || !passed(result.post_rollback_health)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rollback"],
        message:
          "failed or cancelled production deployment requires passing rollback and post-rollback health evidence",
      });
    }
  });

export interface DeployScriptAuthorityFile {
  path: string;
  sha256: string;
}

export interface DeployScriptAuthority {
  schema_version: 1;
  digest_sha256: string;
  files: DeployScriptAuthorityFile[];
}

export interface ComputeDeployScriptAuthorityInput {
  workspace_path: string;
  policy: DeployTargetPolicy;
}

export const DeployScriptAuthoritySchema = z
  .object({
    schema_version: z.literal(1),
    digest_sha256: z.string().regex(SHA256_PATTERN),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: z.string().regex(SHA256_PATTERN),
        })
        .strict(),
    ),
  })
  .strict();

export type ProjectDeployPhase =
  | "deploy"
  | "verify"
  | "health"
  | "rollback"
  | "post_rollback_health";

export interface ProjectDeployInput {
  target: "staging" | "production";
  workspace_path: string;
  policy: DeployTargetPolicy;
  expected_script_digest_sha256: string;
  host_environment?: Readonly<Record<string, string | undefined>>;
  max_output_bytes?: number;
  signal?: AbortSignal;
  before_phase?: (phase: ProjectDeployPhase) => Promise<void>;
}

type CommandName =
  | "command"
  | "verify_command"
  | "health_check"
  | "rollback";

interface CapturedStream {
  append(chunk: Buffer | string): void;
  summary(redactions: readonly string[]): string;
}

interface CommandRun {
  evidence: DeployCommandEvidence;
  cancelled: boolean;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isInsideWorkspace(workspace: string, candidate: string): boolean {
  const path = relative(workspace, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function looksLikeRepositoryPath(argument: string): boolean {
  return (
    !argument.startsWith("-") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(argument) &&
    (argument.startsWith(".") || argument.includes("/"))
  );
}

async function optionalFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function authorityFile(
  workspace: string,
  rawPath: string,
): Promise<DeployScriptAuthorityFile> {
  const candidate = resolve(workspace, rawPath);
  if (!isInsideWorkspace(workspace, candidate)) {
    throw new Error(`repository deploy path escapes workspace: ${rawPath}`);
  }
  await lstat(candidate);
  const canonical = await realpath(candidate);
  if (!isInsideWorkspace(workspace, canonical)) {
    throw new Error(`repository deploy path resolves outside workspace: ${rawPath}`);
  }
  const metadata = await stat(canonical);
  if (!metadata.isFile()) {
    throw new Error(`repository deploy path is not a file: ${rawPath}`);
  }
  return {
    path: relative(workspace, canonical).split(sep).join("/"),
    sha256: sha256(await readFile(canonical)),
  };
}

function commandEntries(policy: DeployTargetPolicy): Array<{
  name: CommandName;
  argv: string[];
}> {
  return [
    { name: "command", argv: [...policy.command] },
    { name: "verify_command", argv: [...policy.verify_command] },
    { name: "health_check", argv: [...policy.health_check] },
    { name: "rollback", argv: [...policy.rollback] },
  ];
}

export async function computeDeployScriptAuthority(
  input: ComputeDeployScriptAuthorityInput,
): Promise<DeployScriptAuthority> {
  const policy = DeployTargetPolicySchema.parse(input.policy);
  const workspace = await realpath(input.workspace_path);
  const files = new Map<string, DeployScriptAuthorityFile>();

  for (const entry of commandEntries(policy)) {
    for (const [index, argument] of entry.argv.entries()) {
      const repositoryPath =
        looksLikeRepositoryPath(argument) &&
        (!isAbsolute(argument) || isInsideWorkspace(workspace, argument));
      if (!repositoryPath) continue;
      if (index === 0 || (await optionalFile(resolve(workspace, argument)))) {
        const file = await authorityFile(workspace, argument);
        files.set(file.path, file);
      }
    }
    const executable = entry.argv[0]!;
    if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
      for (const path of PACKAGE_AUTHORITY_FILES) {
        if (!(await optionalFile(resolve(workspace, path)))) continue;
        const file = await authorityFile(workspace, path);
        files.set(file.path, file);
      }
    }
  }

  const sortedFiles = [...files.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const digest = sha256(
    canonicalJson({
      schema_version: 1,
      commands: commandEntries(policy),
      files: sortedFiles,
    }),
  );
  return {
    schema_version: 1,
    digest_sha256: digest,
    files: sortedFiles,
  };
}

function buildDeployEnvironment(
  policy: DeployTargetPolicy,
  host: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    ...BASE_ENVIRONMENT_NAMES,
    ...policy.allowed_environment,
  ]) {
    const value = host[name];
    if (value === undefined || value.length === 0) continue;
    if (Buffer.byteLength(value) > MAX_ENVIRONMENT_VALUE_BYTES) {
      throw new Error(`deploy environment value is too large: ${name}`);
    }
    environment[name] = value;
  }
  return environment;
}

function redactSummary(value: string, redactions: readonly string[]): string {
  let result = value;
  for (const secret of [...new Set(redactions)]
    .filter((item) => item.length >= 4)
    .sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(
      /(?:github_pat_|gh[pousr]_)[A-Za-z0-9_-]{20,}/g,
      "[REDACTED_GITHUB_TOKEN]",
    )
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi,
      "$1[REDACTED]",
    );
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = value;
  while (Buffer.byteLength(result) > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function createCapturedStream(
  maxBytes: number,
  redactionPaddingBytes: number,
): CapturedStream {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const captureLimit = maxBytes + redactionPaddingBytes;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = captureLimit - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const kept = buffer.subarray(0, remaining);
      chunks.push(kept);
      capturedBytes += kept.length;
      if (kept.length < buffer.length) truncated = true;
    },
    summary(redactions) {
      const marker = "\n[truncated]";
      const raw = Buffer.concat(chunks).toString("utf8");
      const redacted = redactSummary(raw, redactions);
      if (!truncated) return truncateUtf8(redacted, maxBytes);
      const markerBytes = Buffer.byteLength(marker);
      const prefix = truncateUtf8(
        redacted,
        Math.max(0, maxBytes - markerBytes),
      );
      return truncateUtf8(`${prefix}${marker}`, maxBytes);
    },
  };
}

function killChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 500);
  timer.unref();
}

async function executeCommand(input: {
  argv: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeout_ms: number;
  max_output_bytes: number;
  redactions: string[];
  signal?: AbortSignal;
}): Promise<CommandRun> {
  const startedAt = Date.now();
  const redactionPaddingBytes = input.redactions.reduce(
    (maximum, value) => Math.max(maximum, Buffer.byteLength(value)),
    0,
  );
  const stdout = createCapturedStream(
    input.max_output_bytes,
    redactionPaddingBytes,
  );
  const stderr = createCapturedStream(
    input.max_output_bytes,
    redactionPaddingBytes,
  );
  let timedOut = false;
  let cancelled = input.signal?.aborted ?? false;
  if (cancelled) {
    return {
      cancelled: true,
      evidence: {
        argv: [...input.argv],
        exit_code: -1,
        duration_ms: 0,
        stdout_summary: "",
        stderr_summary: "cancelled before command start",
        timed_out: false,
      },
    };
  }

  const child = spawn(input.argv[0]!, input.argv.slice(1), {
    cwd: input.cwd,
    env: input.environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

  const timeout = setTimeout(() => {
    timedOut = true;
    killChild(child);
  }, input.timeout_ms);
  timeout.unref();
  const abort = () => {
    cancelled = true;
    killChild(child);
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  const exitCode = await new Promise<number>((resolveExit) => {
    child.once("error", (error) => {
      stderr.append(error.message);
      resolveExit(-1);
    });
    child.once("close", (code) => resolveExit(code ?? -1));
  });
  clearTimeout(timeout);
  input.signal?.removeEventListener("abort", abort);

  return {
    cancelled,
    evidence: {
      argv: [...input.argv],
      exit_code: exitCode,
      duration_ms: Math.max(0, Date.now() - startedAt),
      stdout_summary: stdout.summary(input.redactions),
      stderr_summary: stderr.summary(input.redactions),
      timed_out: timedOut,
    },
  };
}

async function assertScriptAuthority(input: ProjectDeployInput): Promise<void> {
  if (!SHA256_PATTERN.test(input.expected_script_digest_sha256)) {
    throw new Error("expected deploy script authority digest is invalid");
  }
  const current = await computeDeployScriptAuthority({
    workspace_path: input.workspace_path,
    policy: input.policy,
  });
  if (current.digest_sha256 !== input.expected_script_digest_sha256) {
    throw new Error("deploy script authority digest changed");
  }
}

export async function runProjectDeploy(
  value: ProjectDeployInput,
): Promise<ProjectDeployResult> {
  const policy = DeployTargetPolicySchema.parse(value.policy);
  const maxOutputBytes = value.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 128 ||
    maxOutputBytes > 1_048_576
  ) {
    throw new Error("max_output_bytes must be between 128 and 1048576");
  }
  const workspace = await realpath(value.workspace_path);
  const hostEnvironment = value.host_environment ?? process.env;
  const environment = buildDeployEnvironment(policy, hostEnvironment);
  const redactions = [
    hostEnvironment.HOME ?? "",
    ...policy.allowed_environment.map((name) => hostEnvironment[name] ?? ""),
  ];
  const input: ProjectDeployInput = {
    ...value,
    workspace_path: workspace,
    policy,
  };

  await assertScriptAuthority(input);

  const executeBound = async (
    argv: string[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<CommandRun> => {
    await assertScriptAuthority(input);
    return executeCommand({
      argv,
      cwd: workspace,
      environment,
      timeout_ms: timeoutMs,
      max_output_bytes: maxOutputBytes,
      redactions,
      ...(signal === undefined ? {} : { signal }),
    });
  };

  const rollback = async (
    result: ProjectDeployResult,
    successfulOutcome: ProjectDeployResult["outcome"],
  ): Promise<ProjectDeployResult> => {
    let rollbackRun: CommandRun;
    try {
      await value.before_phase?.("rollback");
      rollbackRun = await executeBound(policy.rollback, policy.timeout_ms, undefined);
    } catch {
      return { ...result, outcome: "rollback_failed" };
    }
    result.rollback = rollbackRun.evidence;
    if (rollbackRun.evidence.exit_code !== 0) {
      return { ...result, outcome: "rollback_failed" };
    }
    let postHealth: CommandRun;
    try {
      await value.before_phase?.("post_rollback_health");
      postHealth = await executeBound(
        policy.health_check,
        policy.health_timeout_ms,
        undefined,
      );
    } catch {
      return { ...result, outcome: "rollback_failed" };
    }
    result.post_rollback_health = postHealth.evidence;
    if (postHealth.evidence.exit_code !== 0) {
      return { ...result, outcome: "rollback_failed" };
    }
    return { ...result, outcome: successfulOutcome };
  };

  await value.before_phase?.("deploy");
  const deploy = await executeBound(
    policy.command,
    policy.timeout_ms,
    value.signal,
  );
  let result: ProjectDeployResult = {
    target: value.target,
    deploy: deploy.evidence,
    outcome: deploy.cancelled
      ? "cancelled"
      : deploy.evidence.exit_code === 0
        ? "healthy"
        : "deploy_failed",
  };
  if (deploy.cancelled || deploy.evidence.exit_code !== 0) {
    if (value.target === "production") {
      return rollback(result, result.outcome);
    }
    return result;
  }

  await value.before_phase?.("verify");
  const verify = await executeBound(
    policy.verify_command,
    policy.timeout_ms,
    value.signal,
  );
  result = { ...result, verify: verify.evidence };
  if (verify.cancelled) {
    result.outcome = "cancelled";
    return value.target === "production"
      ? rollback(result, "cancelled")
      : result;
  }
  if (verify.evidence.exit_code !== 0) {
    result.outcome = "verify_failed";
    return value.target === "production"
      ? rollback(result, "verify_failed")
      : result;
  }

  await value.before_phase?.("health");
  const health = await executeBound(
    policy.health_check,
    policy.health_timeout_ms,
    value.signal,
  );
  result = { ...result, health: health.evidence };
  if (health.cancelled) {
    result.outcome = "cancelled";
    return value.target === "production"
      ? rollback(result, "cancelled")
      : result;
  }
  if (health.evidence.exit_code !== 0) {
    if (value.target === "production") {
      return rollback(result, "health_failed_rolled_back");
    }
    return { ...result, outcome: "deploy_failed" };
  }
  return { ...result, outcome: "healthy" };
}
