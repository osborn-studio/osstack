import { spawn } from "node:child_process";

export const HARDENED_GIT_CONFIG_ARGS = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
]);

export const HARDENED_GIT_ERROR_CODES = [
  "HARDENED_GIT_INVALID_ARGS",
  "HARDENED_GIT_SPAWN_FAILED",
  "HARDENED_GIT_FAILED",
  "HARDENED_GIT_TIMEOUT",
  "HARDENED_GIT_ABORTED",
  "HARDENED_GIT_OUTPUT_LIMIT",
] as const;
export type HardenedGitErrorCode = (typeof HARDENED_GIT_ERROR_CODES)[number];

export class HardenedGitError extends Error {
  constructor(
    readonly code: HardenedGitErrorCode,
    readonly args: readonly string[],
    readonly exitCode: number | null = null,
    readonly stderr = "",
  ) {
    super(`${code}: git ${args.slice(0, 3).join(" ")}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`);
    this.name = "HardenedGitError";
  }
}

/** GIT_* variables a caller may set explicitly; every other GIT_* is stripped. */
export type HardenedGitEnvKey =
  | "GIT_AUTHOR_NAME"
  | "GIT_AUTHOR_EMAIL"
  | "GIT_AUTHOR_DATE"
  | "GIT_COMMITTER_NAME"
  | "GIT_COMMITTER_EMAIL"
  | "GIT_COMMITTER_DATE"
  | "GIT_INDEX_FILE";

export interface HardenedGitContext {
  /** Source environment the allowlist is drawn from (default `process.env`). */
  env?: Readonly<NodeJS.ProcessEnv>;
  /** HOME for git; defaults to the source environment's HOME. */
  home?: string;
  gitBinary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface HardenedGitOptions extends HardenedGitContext {
  cwd: string;
  /** Extra `-c key=value` pairs appended after the fixed hardening prefix. */
  config?: readonly (readonly [string, string])[];
  gitEnv?: Readonly<Partial<Record<HardenedGitEnvKey, string>>>;
  input?: Uint8Array | string;
  /** Exit codes treated as success (default `[0]`). */
  okExitCodes?: readonly number[];
}

export interface HardenedGitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Minimal environment for host-side git: PATH, HOME, LANG/LC_* plus the fixed GIT_* hardening. */
export function hardenedGitEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
  home: string | undefined = source.HOME,
  gitEnv: Readonly<Partial<Record<HardenedGitEnvKey, string>>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === "PATH" || key === "LANG" || key.startsWith("LC_")) environment[key] = value;
  }
  if (home !== undefined) environment.HOME = home;
  for (const [key, value] of Object.entries(gitEnv)) if (value !== undefined) environment[key] = value;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

/** Run git with an argv array (never a shell), a fixed config prefix, a minimal environment, bounded output and a timeout. */
export function runHardenedGit(args: readonly string[], options: HardenedGitOptions): Promise<HardenedGitResult> {
  const pairs = options.config ?? [];
  if (
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    pairs.some(([key, value]) => !/^[A-Za-z0-9][A-Za-z0-9-]*\.[^=\n\0]+$/.test(key) || /[\n\0]/.test(value))
  ) {
    return Promise.reject(new HardenedGitError("HARDENED_GIT_INVALID_ARGS", args));
  }
  const config = pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  for (const key of Object.keys(options.gitEnv ?? {})) {
    if (!/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$|^GIT_INDEX_FILE$/.test(key)) {
      return Promise.reject(new HardenedGitError("HARDENED_GIT_INVALID_ARGS", args));
    }
  }
  const argv = [...HARDENED_GIT_CONFIG_ARGS, ...config, ...args];
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const okExitCodes = options.okExitCodes ?? [0];
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(new HardenedGitError("HARDENED_GIT_ABORTED", args));
  return new Promise((resolve, reject) => {
    // Own process group, so a timeout or abort also kills helpers git spawned.
    const child = spawn(options.gitBinary ?? "git", argv, {
      cwd: options.cwd,
      env: hardenedGitEnvironment(options.env, options.home ?? options.env?.HOME ?? process.env.HOME, options.gitEnv),
      shell: false,
      detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const settle = (error: HardenedGitError | undefined, result?: HardenedGitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result as HardenedGitResult);
    };
    const fail = (code: HardenedGitErrorCode) => {
      if (settled) return;
      killGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(new HardenedGitError(code, args, null, stderr));
    };
    const timer = setTimeout(() => fail("HARDENED_GIT_TIMEOUT"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = () => fail("HARDENED_GIT_ABORTED");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limit) return fail("HARDENED_GIT_OUTPUT_LIMIT");
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_STDERR_BYTES - stderr.length);
    });
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
    child.on("error", () => settle(new HardenedGitError("HARDENED_GIT_SPAWN_FAILED", args)));
    child.on("close", (exitCode) => {
      killGroup();
      if (exitCode === null || !okExitCodes.includes(exitCode)) {
        return settle(new HardenedGitError("HARDENED_GIT_FAILED", args, exitCode, stderr));
      }
      settle(undefined, { stdout: Buffer.concat(stdout), stderr, exitCode });
    });
  });
}
