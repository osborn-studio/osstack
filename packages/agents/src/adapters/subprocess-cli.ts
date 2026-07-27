import { spawn } from "node:child_process";
import { CapabilitySchema, type Capability, type CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { BaseAgentAdapter, type AgentAvailability, type AgentTask } from "../base.js";
import { buildAgentChildEnv } from "../child-env.js";

export interface SubprocessCliCapability {
  kind: string;
  description: string;
  hints?: Record<string, unknown>;
}

export interface SubprocessCliConfig {
  id: string;
  displayName: string;
  costTier: CostTier;
  envBin: string;
  defaultBin: string;
  envArgs: string;
  defaultArgs: readonly string[];
  probeArgs: readonly string[];
  capabilities: readonly SubprocessCliCapability[];
}

export interface SubprocessCliOptions {
  bin?: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  outputLimit?: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export abstract class SubprocessCliAdapter extends BaseAgentAdapter {
  readonly id: string;
  readonly display_name: string;
  readonly cost_tier: CostTier;

  private readonly config: SubprocessCliConfig;
  private readonly options: SubprocessCliOptions;
  private readonly adapterCapabilities: readonly Capability[];

  constructor(config: SubprocessCliConfig, options: SubprocessCliOptions = {}) {
    super();
    this.config = config;
    this.options = options;
    this.id = config.id;
    this.display_name = config.displayName;
    this.cost_tier = config.costTier;
    this.adapterCapabilities = config.capabilities.map((capability) => CapabilitySchema.parse({
      id: `${config.id}.${capability.kind}`,
      kind: capability.kind,
      agent_id: config.id,
      description: capability.description,
      cost_tier: config.costTier,
      hints: capability.hints,
    }));
  }

  capabilities(): readonly Capability[] {
    return this.adapterCapabilities;
  }

  async isAvailable(): Promise<AgentAvailability> {
    const result = await runCommand(this.bin(), this.config.probeArgs, {
      cwd: this.cwd(undefined),
      timeoutMs: 5_000,
      outputLimit: 2_000,
    });
    if (result.exitCode === 0) return { available: true, last_checked_at: nowSeconds() };
    return {
      available: false,
      reason: `${this.config.defaultBin} probe failed: ${singleLine(result.stderr || result.stdout)}`,
      last_checked_at: nowSeconds(),
    };
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    let seq = 0;
    yield runStarted(task, seq++);

    if (signal.aborted) {
      yield doneEvent(task, seq, "cancelled", seq - 1, `cancelled before ${this.config.defaultBin} spawn`);
      return;
    }

    const args = this.args(task);
    yield progressEvent(task, seq++, `${this.id}.start`, `${this.bin()} ${args.join(" ")}`);

    const commandOptions: {
      cwd: string;
      input?: string;
      signal: AbortSignal;
      timeoutMs: number;
      outputLimit: number;
    } = {
      cwd: this.cwd(task),
      signal,
      timeoutMs: this.options.timeoutMs ?? 3_600_000,
      outputLimit: this.options.outputLimit ?? 64_000,
    };
    const input = this.input(task, args);
    if (input !== undefined) commandOptions.input = input;
    const result = await runCommand(this.bin(), args, commandOptions);
    if (result.stdout.trim() !== "") {
      yield tokenEvent(task, seq++, `${this.id}.stdout`, result.stdout);
    }
    if (result.stderr.trim() !== "") {
      yield progressEvent(task, seq++, `${this.id}.stderr`, result.stderr);
    }

    if (signal.aborted) {
      yield doneEvent(task, seq, "cancelled", seq - 1, `${this.config.defaultBin} cancelled`);
      return;
    }
    if (result.exitCode === 0) {
      yield doneEvent(task, seq, "completed", seq - 1, `${this.config.defaultBin} completed`);
      return;
    }

    const summary = result.timedOut
      ? `${this.config.defaultBin} timed out after ${this.options.timeoutMs ?? 3_600_000}ms`
      : `${this.config.defaultBin} exited ${result.exitCode}: ${singleLine(result.stderr || result.stdout)}`;
    yield errorEvent(task, seq++, `${this.id.replaceAll("-", "_")}_failed`, summary);
    yield doneEvent(task, seq, "failed", seq - 1, summary);
  }

  private bin(): string {
    const configured = this.options.bin ?? process.env[this.config.envBin];
    return configured !== undefined && configured.trim() !== "" ? configured : this.config.defaultBin;
  }

  private args(task: AgentTask): string[] {
    const configured = this.options.args ?? parseEnvArgs(process.env[this.config.envArgs]);
    const template = configured.length > 0 ? configured : this.config.defaultArgs;
    return template.map((arg) => arg
      .replaceAll("{prompt}", task.prompt)
      .replaceAll("{repo}", this.cwd(task))
      .replaceAll("{capability}", task.capability_id));
  }

  private cwd(task: AgentTask | undefined): string {
    if (typeof task?.context?.["repo_path"] === "string") return task.context["repo_path"];
    return this.options.cwd ?? process.cwd();
  }

  private input(task: AgentTask, args: readonly string[]): string | undefined {
    return args.some((arg) => arg.includes(task.prompt)) ? undefined : task.prompt;
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
  return { ...envelope(task, seq, false), type: "progress", payload: { phase, detail: singleLine(detail) } };
}

function tokenEvent(task: AgentTask, seq: number, messageId: string, text: string): HermesEvent {
  return {
    ...envelope(task, seq, false),
    type: "token.delta",
    payload: { message_id: messageId, delta: text, content_type: "text" },
  };
}

function errorEvent(task: AgentTask, seq: number, code: string, message: string): HermesEvent {
  return { ...envelope(task, seq, true), type: "error", payload: { code, message, terminal: true } };
}

function doneEvent(
  task: AgentTask,
  seq: number,
  status: "completed" | "failed" | "cancelled",
  lastSeq: number,
  summary: string,
): HermesEvent {
  return {
    ...envelope(task, seq, true),
    type: "done",
    payload: { status, last_seq: lastSeq, result_summary: summary },
  };
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

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    input?: string;
    signal?: AbortSignal;
    timeoutMs: number;
    outputLimit: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildAgentChildEnv(),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const onAbort = (): void => {
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
      finish({
        exitCode: 127,
        stdout,
        stderr: appendLimited(stderr, error.message, options.outputLimit),
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      finish({
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

function parseEnvArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(/\s+/).filter(Boolean);
}

function appendLimited(current: string, next: string, limit: number): string {
  const combined = current + next;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 280);
}
