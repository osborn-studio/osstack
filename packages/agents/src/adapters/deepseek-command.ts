import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability, CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { BaseAgentAdapter, type AgentAvailability, type AgentTask } from "../base.js";

export interface DeepSeekCommandOptions {
  bin?: string;
  outputPath?: string;
  strict?: boolean;
  timeoutMs?: number;
  outputLimit?: number;
}

export interface DeepSeekCommandConfig {
  id: string;
  displayName: string;
  envBin: string;
  defaultBin: string;
  defaultOutputPath: string;
  commandKind: "review" | "verify";
  capabilities: readonly Capability[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Env var pointing the DeepSeek command at the loop's evaluation specs JSON. */
export const EVALUATION_SPECS_FILE_ENV = "OSSTACK_EVALUATION_SPECS_FILE";
/** Stdout line prefix a DeepSeek command uses to report per-spec judgments. */
export const EVALUATION_JUDGMENTS_PREFIX = "OSSTACK_EVALUATIONS:";

export interface EvaluationJudgment {
  id: string;
  pass: boolean;
  summary?: string;
}

export abstract class DeepSeekCommandAdapter extends BaseAgentAdapter {
  readonly id: string;
  readonly display_name: string;
  readonly cost_tier: CostTier = "low";

  private readonly config: DeepSeekCommandConfig;
  private readonly options: DeepSeekCommandOptions;

  constructor(config: DeepSeekCommandConfig, options: DeepSeekCommandOptions = {}) {
    super();
    this.config = config;
    this.options = options;
    this.id = config.id;
    this.display_name = config.displayName;
  }

  capabilities(): readonly Capability[] {
    return this.config.capabilities;
  }

  async isAvailable(): Promise<AgentAvailability> {
    const bin = await this.resolveBin();
    if (bin === undefined) {
      return {
        available: false,
        reason: `${this.config.defaultBin} not found on PATH or legacy-python/deepseek/bin`,
        last_checked_at: nowSeconds(),
      };
    }

    const probe = await runCommand(bin, ["--help"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      outputLimit: 2_000,
    });
    if (probe.exitCode === 0) return { available: true, last_checked_at: nowSeconds() };
    return {
      available: false,
      reason: `${this.config.defaultBin} --help exited ${probe.exitCode}: ${singleLine(probe.stderr || probe.stdout)}`,
      last_checked_at: nowSeconds(),
    };
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    let seq = 0;
    yield runStarted(task, seq++);

    if (signal.aborted) {
      yield doneEvent(task, seq, "cancelled", seq - 1, "cancelled before DeepSeek command start");
      return;
    }

    const bin = await this.resolveBin();
    if (bin === undefined) {
      yield errorEvent(task, seq++, "deepseek_command_missing", `${this.config.defaultBin} not found`);
      yield doneEvent(task, seq, "failed", seq - 1, `${this.config.defaultBin} not found`);
      return;
    }

    const cwd = repoPath(task);
    const args = this.args(task);
    yield progressEvent(task, seq++, `${this.id}.start`, `${bin} ${args.join(" ")}`);

    // Loop evaluation specs travel via a temp JSON file + env var so newer
    // DeepSeek commands can judge acceptance criteria per spec while legacy
    // binaries simply ignore the variable.
    let env: Record<string, string> | undefined;
    const specsFile = await this.writeEvaluationSpecsFile(task);
    if (specsFile !== undefined) {
      env = { [EVALUATION_SPECS_FILE_ENV]: specsFile.path };
      yield progressEvent(
        task,
        seq++,
        `${this.id}.evaluation_specs`,
        `${specsFile.count} evaluation spec(s) via ${EVALUATION_SPECS_FILE_ENV}`,
      );
    }

    let input: string | undefined;
    if (this.config.commandKind === "review") {
      const diff = await runCommand("git", ["diff", "--no-ext-diff"], {
        cwd,
        timeoutMs: 30_000,
        outputLimit: this.outputLimit(),
      });
      if (diff.exitCode !== 0) {
        yield errorEvent(task, seq++, "git_diff_failed", singleLine(diff.stderr || diff.stdout));
        yield doneEvent(task, seq, "failed", seq - 1, "git diff failed before ds-review");
        return;
      }
      input = diff.stdout;
      yield progressEvent(task, seq++, "git.diff", `${input.length} byte diff`);
    }

    const commandOptions: {
      cwd: string;
      input?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs: number;
      outputLimit: number;
    } = {
      cwd,
      signal,
      timeoutMs: this.timeoutMs(),
      outputLimit: this.outputLimit(),
    };
    if (input !== undefined) commandOptions.input = input;
    if (env !== undefined) commandOptions.env = env;
    const result = await runCommand(bin, args, commandOptions);
    if (result.stdout.trim() !== "") {
      yield tokenEvent(task, seq++, `${this.id}.stdout`, result.stdout);
    }
    if (result.stderr.trim() !== "") {
      yield progressEvent(task, seq++, `${this.id}.stderr`, result.stderr);
    }
    const judgments = extractEvaluationJudgments(result.stdout);

    if (result.exitCode === 0) {
      yield doneEvent(task, seq, "completed", seq - 1, `${this.config.defaultBin} completed`, judgments);
      return;
    }

    const summary = result.timedOut
      ? `${this.config.defaultBin} timed out after ${this.timeoutMs()}ms`
      : `${this.config.defaultBin} exited ${result.exitCode}: ${singleLine(result.stderr || result.stdout)}`;
    yield errorEvent(task, seq++, "deepseek_command_failed", summary);
    yield doneEvent(task, seq, "failed", seq - 1, summary, judgments);
  }

  private async writeEvaluationSpecsFile(task: AgentTask): Promise<{ path: string; count: number } | undefined> {
    const specs = task.context?.["evaluation_specs"];
    if (!Array.isArray(specs) || specs.length === 0) return undefined;
    try {
      const dir = await mkdtemp(join(tmpdir(), "osstack-eval-specs-"));
      const path = join(dir, `${task.run_id.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`);
      await writeFile(path, `${JSON.stringify(specs, null, 2)}\n`, "utf-8");
      return { path, count: specs.length };
    } catch {
      return undefined;
    }
  }

  private args(task: AgentTask): string[] {
    const args = ["--output", outputPath(task, this.options.outputPath ?? this.config.defaultOutputPath)];
    const strict = typeof task.context?.["strict"] === "boolean"
      ? task.context["strict"]
      : this.options.strict;
    if (strict === true) args.push("--strict");
    return args;
  }

  private timeoutMs(): number {
    return this.options.timeoutMs ?? 600_000;
  }

  private outputLimit(): number {
    return this.options.outputLimit ?? 16_000;
  }

  private async resolveBin(): Promise<string | undefined> {
    const configured = this.options.bin ?? process.env[this.config.envBin];
    if (configured !== undefined && configured.trim() !== "") return configured;

    const legacy = legacyCommandPath(this.config.defaultBin);
    if (await isExecutable(legacy)) return legacy;
    return this.config.defaultBin;
  }
}

function runStarted(task: AgentTask, seq: number): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "run.started",
    payload: {
      status: "running",
      controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false },
    },
  };
}

function progressEvent(task: AgentTask, seq: number, phase: string, detail: string): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "progress",
    payload: { phase, detail: singleLine(detail) },
  };
}

function tokenEvent(task: AgentTask, seq: number, messageId: string, text: string): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "token.delta",
    payload: { message_id: messageId, delta: text, content_type: "text" },
  };
}

function errorEvent(task: AgentTask, seq: number, code: string, message: string): HermesEvent {
  return {
    ...envelope(task, seq, true),
    type: "error",
    payload: { code, message, terminal: true },
  };
}

function doneEvent(
  task: AgentTask,
  seq: number,
  status: "completed" | "failed" | "cancelled",
  lastSeq: number,
  summary: string,
  judgments?: EvaluationJudgment[],
): HermesEvent {
  return {
    ...envelope(task, seq, true),
    type: "done",
    payload: {
      status,
      last_seq: lastSeq,
      result_summary: summary,
      ...(judgments !== undefined && judgments.length > 0 ? { evaluation_judgments: judgments } : {}),
    },
  };
}

/**
 * Parse per-spec judgments from command stdout. Convention: the command may
 * print one line `OSSTACK_EVALUATIONS: {"evaluations":[{"id":"x","pass":true,"summary":"..."}]}`.
 * The last such line wins; malformed lines are ignored.
 */
export function extractEvaluationJudgments(stdout: string): EvaluationJudgment[] {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trimStart().startsWith(EVALUATION_JUDGMENTS_PREFIX));
  const last = lines.at(-1);
  if (last === undefined) return [];
  const raw = last.trimStart().slice(EVALUATION_JUDGMENTS_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as { evaluations?: unknown };
    const entries = Array.isArray(parsed.evaluations) ? parsed.evaluations : [];
    return entries.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate["id"] !== "string" || typeof candidate["pass"] !== "boolean") return [];
      return [{
        id: candidate["id"],
        pass: candidate["pass"],
        ...(typeof candidate["summary"] === "string" ? { summary: candidate["summary"] } : {}),
      }];
    });
  } catch {
    return [];
  }
}

function envelope(task: AgentTask, seq: number, terminal: boolean): Omit<HermesEvent, "type" | "payload"> {
  return {
    event_id: `${task.run_id}:${seq}`,
    seq,
    run_id: task.run_id,
    session_id: task.session_id,
    created_at: Date.now() / 1000,
    terminal,
  };
}

function repoPath(task: AgentTask): string {
  return typeof task.context?.["repo_path"] === "string" ? task.context["repo_path"] : process.cwd();
}

function outputPath(task: AgentTask, fallback: string): string {
  const contextKey = task.capability_id.includes("verify") ? "verify_output_path" : "review_output_path";
  return typeof task.context?.[contextKey] === "string" ? task.context[contextKey] : fallback;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 280);
}

function legacyCommandPath(command: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../..", "legacy-python", "deepseek", "bin", command);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    input?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs: number;
    outputLimit: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const onAbort = (): void => {
      timedOut = false;
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf-8"), options.outputLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf-8"), options.outputLimit);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: 127,
        stdout,
        stderr: appendLimited(stderr, error.message, options.outputLimit),
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut
          ? appendLimited(stderr, `Command timed out after ${options.timeoutMs}ms`, options.outputLimit)
          : signal
            ? appendLimited(stderr, `Command exited from signal ${signal}`, options.outputLimit)
            : stderr,
        timedOut,
      });
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function appendLimited(current: string, next: string, limit: number): string {
  const combined = current + next;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}
