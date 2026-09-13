import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { ITERATION_FEEDBACK_CONTEXT_KEY } from "./feedback.js";
import type { ExecutionPlan } from "./types.js";

/** Env var pointing local execute commands at the previous-attempt feedback JSON. */
export const ITERATION_FEEDBACK_FILE_ENV = "OSSTACK_ITERATION_FEEDBACK_FILE";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface AgentRun {
  run_id: string;
  plan_id: string;
  task_id: string;
  agent_id: string;
  outcome: "completed" | "failed" | "cancelled";
  started_at: string;
  completed_at: string;
  duration_ms: number;
  command_results: CommandResult[];
  adapter_event_count?: number;
  summary?: string;
  /** Stable failure classification; unconfirmed cancellation is not retry-safe. */
  failure_code?: "missing_done" | "invalid_done_payload" | "duplicate_done" | "conflicting_terminal" | "event_after_terminal" | "cancellation_unconfirmed";
  cancellation?: CancellationEvidence;
  /** Adapter-reported token usage for this run (undefined when not reported). */
  tokens_in?: number;
  tokens_out?: number;
  /** Adapter/provider-reported spend for this run (undefined when not reported). */
  cost_usd?: number;
}

export interface CancellationEvidence {
  source: "external" | "timeout";
  requested_at: string;
  invocation_started: boolean;
  stop_confirmed: boolean;
  confirmed_at?: string;
  evidence?: string;
}

export interface LocalExecutorOptions {
  workspacePath: string;
  command?: string;
  adapters?: readonly AgentAdapter[];
  sessionId?: string;
  timeoutMs?: number;
  /** Parent cancellation for adapter execution (command process control is separate). */
  signal?: AbortSignal;
  /** Maximum wait after cancellation for adapter stop evidence; default 1,000ms. */
  cancellationGraceMs?: number;
  outputLimit?: number;
}

export async function executePlan(plan: ExecutionPlan, options: LocalExecutorOptions): Promise<AgentRun> {
  if (options.signal?.aborted) {
    const now = new Date().toISOString();
    return {
      run_id: `run_${plan.plan_id}`, plan_id: plan.plan_id, task_id: plan.task.task_id,
      agent_id: plan.agent_id, outcome: "cancelled", started_at: now, completed_at: now,
      duration_ms: 0, command_results: [], adapter_event_count: 0,
      summary: "Cancelled before execution started",
      cancellation: { source: "external", requested_at: now, invocation_started: false,
        stop_confirmed: true, confirmed_at: now, evidence: "not_started" },
    };
  }
  const adapter = options.adapters?.find((candidate) => candidate.id === plan.agent_id);
  if (adapter !== undefined) {
    return await executeAdapterPlan(plan, options, adapter);
  }
  if (!isLocalAgentId(plan.agent_id)) {
    return missingAdapterRun(plan);
  }

  const started = Date.now();
  const commandResults: CommandResult[] = [];

  if (options.command !== undefined && options.command.trim() !== "") {
    const feedback = await writeIterationFeedbackFile(plan);
    try {
      commandResults.push(await runShellCommand(options.command, {
        cwd: options.workspacePath,
        timeoutMs: options.timeoutMs ?? 120_000,
        outputLimit: options.outputLimit ?? 16_000,
        ...(feedback !== undefined ? { env: { [ITERATION_FEEDBACK_FILE_ENV]: feedback.path } } : {}),
      }));
    } finally {
      if (feedback !== undefined) await feedback.cleanup();
    }
  }

  const failed = commandResults.some((result) => result.exitCode !== 0);
  const completed = Date.now();
  return {
    run_id: `run_${plan.plan_id}`,
    plan_id: plan.plan_id,
    task_id: plan.task.task_id,
    agent_id: plan.agent_id,
    outcome: failed ? "failed" : "completed",
    started_at: new Date(started).toISOString(),
    completed_at: new Date(completed).toISOString(),
    duration_ms: completed - started,
    command_results: commandResults,
  };
}

function missingAdapterRun(plan: ExecutionPlan): AgentRun {
  const now = Date.now();
  const message = `agent adapter not registered: ${plan.agent_id}`;
  return {
    run_id: `run_${plan.plan_id}`,
    plan_id: plan.plan_id,
    task_id: plan.task.task_id,
    agent_id: plan.agent_id,
    outcome: "failed",
    started_at: new Date(now).toISOString(),
    completed_at: new Date(now).toISOString(),
    duration_ms: 0,
    command_results: [{
      command: `agent:${plan.agent_id}`,
      exitCode: 127,
      stdout: "",
      stderr: message,
      durationMs: 0,
    }],
    adapter_event_count: 0,
    summary: message,
  };
}

async function executeAdapterPlan(
  plan: ExecutionPlan,
  options: LocalExecutorOptions,
  adapter: AgentAdapter,
): Promise<AgentRun> {
  const started = Date.now();
  const runId = `run_${plan.plan_id}`;
  const cancellation = new AdapterCancellation(options, adapter, runId);
  const commandResults: CommandResult[] = [];
  let iterator: AsyncIterator<HermesEvent> | undefined;
  let streamClosed = false;
  let outcome: AgentRun["outcome"] = "failed";
  let failureCode: AgentRun["failure_code"];
  let terminalState: "running" | "error" | "done" = "running";
  let adapterEventCount = 0;
  let summary: string | undefined;
  let usage: AgentUsage | undefined;
  try {
    const availability = await cancellation.wait(adapter.isAvailable());
    cancellation.checkBeforeInvoke();
    if (!availability.available) {
      const message = availability.reason ?? "agent unavailable";
      commandResults.push({ command: `agent:${adapter.id}`, exitCode: 127,
        stdout: "", stderr: message, durationMs: Date.now() - started });
      throw new Error(message);
    }
    // Load the shared runtime contract only for adapter invocations.
    const { DonePayload } = await cancellation.wait(import("@osstack/hermes-adapter"));
    cancellation.checkBeforeInvoke();
    const agentTask: AgentTask = {
      run_id: runId,
      task_id: plan.task.task_id,
      session_id: options.sessionId ?? `sess_${plan.plan_id}`,
      capability_id: selectCapabilityId(adapter, plan),
      prompt: plan.task.prompt,
      context: {
        ...(plan.task.context ?? {}),
        repo_path: options.workspacePath,
      },
    };

    cancellation.checkBeforeInvoke();
    cancellation.invocationStarted = true;
    iterator = adapter.invoke(agentTask, cancellation.signal)[Symbol.asyncIterator]();
    // Manual iteration avoids for-await's unbounded implicit await return().
    while (true) {
      const next = await cancellation.wait(iterator.next());
      if (next.done) {
        streamClosed = true;
        break;
      }
      const event = next.value;
      adapterEventCount += 1;
      if (event.type === "usage.updated" || event.type === "usage.final") {
        // usage events report running/final totals; the latest authoritative
        // value wins (final supersedes updated, both supersede nothing).
        usage = usagePayload(event.payload);
        continue;
      }
      if (event.type === "done") {
        if (terminalState === "done") {
          throw new AdapterProtocolError("duplicate_done", "Adapter emitted more than one done event");
        }
        const parsed = DonePayload.safeParse(event.payload);
        if (!parsed.success) {
          throw new AdapterProtocolError("invalid_done_payload", "Adapter emitted an invalid done payload");
        }
        const payload = parsed.data;
        if (terminalState === "error" && payload.status !== "failed" && payload.status !== "expired") {
          throw new AdapterProtocolError("conflicting_terminal", `Terminal error followed by done(${payload.status})`);
        }
        terminalState = "done";
        outcome = payload.status === "expired" ? "failed" : payload.status;
        summary = payload.result_summary ?? summary;
        if (payload.usage !== undefined) usage = usagePayload(payload.usage);
        continue;
      }
      if (terminalState !== "running") {
        throw new AdapterProtocolError("event_after_terminal", `Adapter emitted ${event.type} after a terminal event`);
      }
      if (event.type === "error" && event.terminal) {
        terminalState = "error";
        outcome = "failed";
        summary = errorPayload(event.payload).message;
      }
    }
    if (terminalState === "running") {
      throw new AdapterProtocolError("missing_done", "Adapter stream ended without done or a terminal error");
    }
  } catch (err) {
    outcome = "failed";
    if (err instanceof AdapterProtocolError) failureCode = err.code;
    summary = err instanceof Error ? err.message : String(err);
  } finally {
    if (iterator !== undefined && !streamClosed) {
      // Best-effort cleanup only. Neither return() nor a pending next() may
      // hold the executor open, and late rejections must remain observed.
      const unfinished = iterator;
      void Promise.resolve().then(() => unfinished.return?.()).catch(() => undefined);
    }
    await cancellation.finish();
  }

  const evidence = cancellation.evidence;
  if (evidence !== undefined) {
    // Cancellation wins over every late status, including completed/cancelled.
    // Keep protocol violations failed even when stop is independently proven.
    outcome = evidence.stop_confirmed && failureCode === undefined ? "cancelled" : "failed";
    if (!evidence.stop_confirmed) failureCode = "cancellation_unconfirmed";
    summary = evidence.stop_confirmed
      ? `Cancellation confirmed: ${evidence.evidence}${failureCode !== undefined ? `; ${summary}` : ""}`
      : "Cancellation requested; external work stop is unconfirmed (reconciliation required)";
  }

  const completed = Date.now();
  return {
    run_id: runId,
    plan_id: plan.plan_id,
    task_id: plan.task.task_id,
    agent_id: adapter.id,
    outcome,
    started_at: new Date(started).toISOString(),
    completed_at: new Date(completed).toISOString(),
    duration_ms: completed - started,
    command_results: commandResults,
    adapter_event_count: adapterEventCount,
    ...(failureCode !== undefined ? { failure_code: failureCode } : {}),
    ...(evidence !== undefined ? { cancellation: evidence } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(usage?.tokens_in !== undefined ? { tokens_in: usage.tokens_in } : {}),
    ...(usage?.tokens_out !== undefined ? { tokens_out: usage.tokens_out } : {}),
    ...(usage?.cost_usd !== undefined ? { cost_usd: usage.cost_usd } : {}),
  };
}

/** Owns the timeout, parent listener, and a single absolute cancellation grace. */
class AdapterCancellation {
  private readonly controller = new AbortController();
  private readonly timeout: ReturnType<typeof setTimeout>;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters = new Set<() => void>();
  private deadline = Infinity;
  private active = true;
  private confirmation: Promise<void> | undefined;
  private record: CancellationEvidence | undefined;
  invocationStarted = false;

  constructor(
    private readonly options: LocalExecutorOptions,
    private readonly adapter: AgentAdapter,
    private readonly runId: string,
  ) {
    this.timeout = setTimeout(() => this.request("timeout", new Error("Adapter execution timed out")), options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.onAbort();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get evidence(): CancellationEvidence | undefined { return this.record === undefined ? undefined : { ...this.record }; }

  private readonly onAbort = (): void => { this.request("external", this.options.signal?.reason); };

  private request(source: CancellationEvidence["source"], reason: unknown): void {
    if (this.record !== undefined || !this.active) return;
    const grace = this.options.cancellationGraceMs ?? 1_000;
    const boundedGrace = Number.isFinite(grace) ? Math.max(0, grace) : 1_000;
    this.deadline = Date.now() + boundedGrace;
    this.record = { source, requested_at: new Date().toISOString(),
      invocation_started: this.invocationStarted, stop_confirmed: false };
    this.graceTimer = setTimeout(() => {
      for (const expire of this.waiters) expire();
    }, boundedGrace);
    this.controller.abort(reason);
    if (this.invocationStarted && this.adapter.confirmStopped !== undefined) {
      this.confirmation = Promise.resolve().then(() => this.adapter.confirmStopped!(this.runId)).then((proof) => {
        if (this.active && Date.now() <= this.deadline && proof?.stopped === true
          && typeof proof.evidence === "string" && proof.evidence.trim() !== "") {
          this.record = { ...this.record!, stop_confirmed: true,
            confirmed_at: new Date().toISOString(), evidence: proof.evidence };
        }
      }).catch(() => undefined);
    }
  }

  checkBeforeInvoke(): void {
    if (this.signal.aborted) throw new Error("Cancelled before adapter invocation");
  }

  wait<T>(pending: PromiseLike<T>): Promise<T> {
    // Remove each completed wait instead of retaining a Promise.race reaction
    // per streamed event on one never-settled cancellation promise.
    return new Promise<T>((resolve, reject) => {
      const expire = (): void => {
        this.waiters.delete(expire);
        reject(new Error("Cancellation grace elapsed"));
      };
      this.waiters.add(expire);
      // Observe even late rejection from an abandoned probe/next/confirmation.
      Promise.resolve(pending).then((value) => {
        this.waiters.delete(expire);
        resolve(value);
      }, (error: unknown) => {
        this.waiters.delete(expire);
        reject(error);
      });
      if (Date.now() >= this.deadline) expire();
    });
  }

  async finish(): Promise<void> {
    try {
      if (this.confirmation !== undefined) await this.wait(this.confirmation);
    } catch {
      // Grace expiration is uncertainty, never evidence that work stopped.
    } finally {
      this.active = false;
      clearTimeout(this.timeout);
      if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
      this.options.signal?.removeEventListener("abort", this.onAbort);
    }
  }
}

interface AgentUsage {
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

function usagePayload(payload: HermesEvent["payload"]): AgentUsage {
  const value = payload as { tokens_in?: unknown; tokens_out?: unknown; cost_usd?: unknown };
  return {
    ...(typeof value.tokens_in === "number" ? { tokens_in: value.tokens_in } : {}),
    ...(typeof value.tokens_out === "number" ? { tokens_out: value.tokens_out } : {}),
    ...(typeof value.cost_usd === "number" ? { cost_usd: value.cost_usd } : {}),
  };
}

function isLocalAgentId(agentId: string): boolean {
  return agentId === "local-command" || agentId === "local-noop";
}

/**
 * Local commands cannot read structured task context, so persist the previous
 * attempt's iteration feedback to a temp JSON file and point at it via env.
 * Returns a `cleanup` the caller MUST invoke once the command finishes — the
 * loop reuses a persistent worktree across many iterations, so leaking one
 * temp dir per feedback-carrying attempt would grow unbounded in a daemon run.
 */
async function writeIterationFeedbackFile(
  plan: ExecutionPlan,
): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
  const feedback = plan.task.context?.[ITERATION_FEEDBACK_CONTEXT_KEY];
  if (feedback === undefined) return undefined;
  try {
    const dir = await mkdtemp(join(tmpdir(), "osstack-feedback-"));
    const path = join(dir, `${plan.task.task_id.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`);
    await writeFile(path, `${JSON.stringify(feedback, null, 2)}\n`, "utf-8");
    return {
      path,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch {
    return undefined;
  }
}

function errorPayload(payload: HermesEvent["payload"]): { message: string } {
  return payload as { message: string };
}

class AdapterProtocolError extends Error {
  constructor(readonly code: NonNullable<AgentRun["failure_code"]>, message: string) {
    super(message);
  }
}

function selectCapabilityId(adapter: AgentAdapter, plan: ExecutionPlan): string {
  const capability = adapter.capabilities().find((candidate) =>
    candidate.id === plan.task.capability || candidate.kind === plan.task.capability
  );
  return capability?.id ?? plan.task.capability;
}

export async function runShellCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; outputLimit: number; env?: Record<string, string> },
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env !== undefined ? { env: { ...process.env, ...options.env } } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf-8"), options.outputLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf-8"), options.outputLimit);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: 127,
        stdout,
        stderr: appendLimited(stderr, error.message, options.outputLimit),
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: timedOut
          ? appendLimited(stderr, `Command timed out after ${options.timeoutMs}ms`, options.outputLimit)
          : signal
            ? appendLimited(stderr, `Command exited from signal ${signal}`, options.outputLimit)
            : stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

function appendLimited(current: string, next: string, limit: number): string {
  const combined = current + next;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}
