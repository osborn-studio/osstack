import { randomUUID } from "node:crypto";
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
  failure_code?: "process_exit_unconfirmed" | "process_control_unsupported" | "surviving_descendants";
  termination?: CommandTerminationEvidence;
  cancellation?: CancellationEvidence;
}

export interface CommandTerminationEvidence {
  /** Covers group members only; deliberately detached processes can escape. */
  scope: "posix_process_group" | "not_started" | "unsupported";
  pgid?: number;
  leader_exit_code?: number;
  trigger: "exit" | "external" | "timeout" | "leader_exit" | "process_error";
  stop_confirmed: boolean;
  signals: NodeJS.Signals[];
  evidence: string;
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
  failure_code?: "missing_done" | "invalid_event" | "invalid_done_payload" | "duplicate_done" | "conflicting_terminal" | "event_after_terminal" | "cancellation_unconfirmed" | NonNullable<CommandResult["failure_code"]>;
  cancellation?: CancellationEvidence;
  /** Adapter-reported token usage for this run (undefined when not reported). */
  tokens_in?: number;
  tokens_out?: number;
  /** Adapter/provider-reported spend for this run (undefined when not reported). */
  cost_usd?: number;
}

export interface CancellationEvidence {
  source: "external" | "timeout" | "executor_error";
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
  /** Invalid durations (nonfinite, negative, > 2^31-1) use defaults: timeout 120s, grace 1s. */
  timeoutMs?: number;
  /** Parent cancellation for adapter or command execution. */
  signal?: AbortSignal;
  /** Maximum wait after cancellation for adapter stop evidence; default 1,000ms. */
  cancellationGraceMs?: number;
  /** Command process-group TERM grace, followed by a bounded KILL wait (defaults: 1,000ms each). */
  terminationGraceMs?: number;
  killGraceMs?: number;
  outputLimit?: number;
}

export async function executePlan(plan: ExecutionPlan, options: LocalExecutorOptions): Promise<AgentRun> {
  const runId = `run_${randomUUID()}`;
  if (options.signal?.aborted || parentTerminationSignal !== undefined) {
    const now = new Date().toISOString();
    return {
      run_id: runId, plan_id: plan.plan_id, task_id: plan.task.task_id,
      agent_id: plan.agent_id, outcome: "cancelled", started_at: now, completed_at: now,
      duration_ms: 0, command_results: [], adapter_event_count: 0,
      summary: "Cancelled before execution started",
      cancellation: { source: "external", requested_at: now, invocation_started: false,
        stop_confirmed: true, confirmed_at: now, evidence: "not_started" },
    };
  }
  const adapter = options.adapters?.find((candidate) => candidate.id === plan.agent_id);
  if (adapter !== undefined) {
    return await executeAdapterPlan(plan, options, adapter, runId);
  }
  if (!isLocalAgentId(plan.agent_id)) {
    return missingAdapterRun(plan, runId);
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
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.terminationGraceMs !== undefined ? { terminationGraceMs: options.terminationGraceMs } : {}),
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
        ...(feedback !== undefined ? { env: { [ITERATION_FEEDBACK_FILE_ENV]: feedback.path } } : {}),
      }));
    } finally {
      if (feedback !== undefined) await feedback.cleanup();
    }
  }

  const failed = commandResults.some((result) => result.exitCode !== 0);
  const commandResult = commandResults[0];
  const cancellation = commandResult?.cancellation;
  const completed = Date.now();
  return {
    run_id: runId,
    plan_id: plan.plan_id,
    task_id: plan.task.task_id,
    agent_id: plan.agent_id,
    outcome: cancellation?.source === "external" && cancellation.stop_confirmed
      ? "cancelled" : failed ? "failed" : "completed",
    started_at: new Date(started).toISOString(),
    completed_at: new Date(completed).toISOString(),
    duration_ms: completed - started,
    command_results: commandResults,
    ...(commandResult?.failure_code !== undefined ? { failure_code: commandResult.failure_code } : {}),
    ...(cancellation !== undefined ? { cancellation } : {}),
    ...(commandResult?.termination !== undefined ? { summary: commandResult.termination.evidence } : {}),
  };
}

function missingAdapterRun(plan: ExecutionPlan, runId: string): AgentRun {
  const now = Date.now();
  const message = `agent adapter not registered: ${plan.agent_id}`;
  return {
    run_id: runId,
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
  runId: string,
): Promise<AgentRun> {
  const started = Date.now();
  const cancellation = new AdapterCancellation(options, adapter, runId);
  const commandResults: CommandResult[] = [];
  let iterator: AsyncIterator<HermesEvent> | undefined;
  let streamClosed = false;
  let preflightSettled = false;
  let outcome: AgentRun["outcome"] = "failed";
  let failureCode: AgentRun["failure_code"];
  let terminalState: "running" | "error" | "done" = "running";
  let adapterEventCount = 0;
  let summary: string | undefined;
  let usage: AgentUsage | undefined;
  try {
    const availability = await cancellation.wait(adapter.isAvailable());
    preflightSettled = true;
    cancellation.checkBeforeInvoke();
    if (!availability.available) {
      const message = availability.reason ?? "agent unavailable";
      commandResults.push({ command: `agent:${adapter.id}`, exitCode: 127,
        stdout: "", stderr: message, durationMs: Date.now() - started });
      throw new Error(message);
    }
    // Load the shared runtime contract only for adapter invocations.
    preflightSettled = false;
    const { DonePayload } = await cancellation.wait(import("@osstack/hermes-adapter"));
    preflightSettled = true;
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
      validateEvent(event);
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
    if (cancellation.invocationStarted) cancellation.stopAfterError(err);
  } finally {
    if (iterator !== undefined && !streamClosed) {
      // Best-effort cleanup only. Neither return() nor a pending next() may
      // hold the executor open, and late rejections must remain observed.
      const unfinished = iterator;
      void Promise.resolve().then(() => unfinished.return?.()).catch(() => undefined);
    }
    if (!cancellation.invocationStarted && preflightSettled) cancellation.confirmNotInvoked();
    await cancellation.finish();
  }

  const evidence = cancellation.evidence;
  if (evidence !== undefined) {
    // Cancellation wins over every late status, including completed/cancelled.
    // Keep protocol violations failed even when stop is independently proven.
    outcome = evidence.stop_confirmed && failureCode === undefined && evidence.source !== "executor_error" ? "cancelled" : "failed";
    if (!evidence.stop_confirmed && failureCode === undefined) failureCode = "cancellation_unconfirmed";
    const originalFailure = failureCode !== undefined || evidence.source === "executor_error" ? summary : undefined;
    summary = (evidence.stop_confirmed
      ? `Cancellation confirmed: ${evidence.evidence}`
      : "Cancellation requested; external work stop is unconfirmed (reconciliation required)")
      + (originalFailure !== undefined ? `; ${originalFailure}` : "");
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
  private expired = false;
  private active = true;
  private confirmation: Promise<void> | undefined;
  private record: CancellationEvidence | undefined;
  invocationStarted = false;

  constructor(
    private readonly options: LocalExecutorOptions,
    private readonly adapter: AgentAdapter,
    private readonly runId: string,
  ) {
    this.timeout = setTimeout(() => this.request("timeout", new Error("Adapter execution timed out")), timerDuration(options.timeoutMs, 120_000));
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.onAbort();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get evidence(): CancellationEvidence | undefined { return this.record === undefined ? undefined : { ...this.record }; }

  stopAfterError(reason: unknown): void { this.request("executor_error", reason); }

  private readonly onAbort = (): void => { this.request("external", this.options.signal?.reason); };

  private request(source: CancellationEvidence["source"], reason: unknown): void {
    if (this.record !== undefined || !this.active) return;
    const grace = timerDuration(this.options.cancellationGraceMs, 1_000);
    this.deadline = performance.now() + grace;
    this.record = { source, requested_at: new Date().toISOString(),
      invocation_started: this.invocationStarted, stop_confirmed: false };
    this.graceTimer = setTimeout(() => {
      this.expired = true;
      for (const expire of this.waiters) expire();
    }, grace);
    this.controller.abort(reason);
    if (this.invocationStarted && this.adapter.confirmStopped !== undefined) {
      this.confirmation = Promise.resolve().then(() => this.adapter.confirmStopped!(this.runId)).then((proof) => {
        if (this.active && !this.expired && performance.now() <= this.deadline && proof?.stopped === true
          && typeof proof.evidence === "string" && proof.evidence.trim() !== "") {
          this.record = { ...this.record!, stop_confirmed: true,
            confirmed_at: new Date().toISOString(), evidence: proof.evidence };
        }
      }).catch(() => undefined);
    }
  }

  confirmNotInvoked(): void {
    if (this.record === undefined) return;
    this.record = { ...this.record, stop_confirmed: true, confirmed_at: new Date().toISOString(), evidence: "invocation_not_started" };
  }

  checkBeforeInvoke(): void {
    if (parentTerminationSignal !== undefined) this.request("external", new Error("Parent termination requested"));
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
      if (this.expired || performance.now() >= this.deadline) expire();
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

function validateEvent(value: unknown): asserts value is HermesEvent {
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item);
  if (!isRecord(value) || typeof value["type"] !== "string" || value["type"].trim() === ""
    || typeof value["terminal"] !== "boolean") {
    throw new AdapterProtocolError("invalid_event", "Adapter emitted an invalid event object");
  }
  const payload = value["payload"];
  if ((value["type"] === "error" && (!isRecord(payload) || typeof payload["message"] !== "string"))
    || ((value["type"] === "usage.updated" || value["type"] === "usage.final") && !isRecord(payload))) {
    throw new AdapterProtocolError("invalid_event", `Adapter emitted an invalid ${value["type"]} payload`);
  }
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

export interface ShellCommandOptions {
  cwd: string;
  /** Invalid durations use a 120s timeout or 1s grace; zero requests immediate expiry. */
  timeoutMs: number;
  outputLimit: number;
  env?: NodeJS.ProcessEnv;
  /** False creates a clean environment for approved isolated execution. */
  inheritEnv?: boolean;
  signal?: AbortSignal;
  terminationGraceMs?: number;
  killGraceMs?: number;
}

// Installed only while commands are owned by this process. Preserve existing
// host signal handlers; re-deliver the default signal only when we are alone.
const commandShutdowns = new Set<(exiting: boolean) => void>();
let parentTerminationSignal: "SIGINT" | "SIGTERM" | undefined;
let parentTerminationTimer: ReturnType<typeof setTimeout> | undefined;
const onCommandParentExit = (): void => { for (const stop of commandShutdowns) stop(true); };
const onCommandParentInt = (): void => { stopCommandsForSignal("SIGINT", onCommandParentInt); };
const onCommandParentTerm = (): void => { stopCommandsForSignal("SIGTERM", onCommandParentTerm); };
function stopCommandsForSignal(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
  const defaultTermination = process.listenerCount(signal) === 1 && process.listeners(signal).includes(listener);
  if (defaultTermination) {
    if (parentTerminationSignal !== undefined) {
      onCommandParentExit();
      resumeDefaultTermination();
      return;
    }
    parentTerminationSignal = signal;
    parentTerminationTimer = setTimeout(() => {
      onCommandParentExit();
      resumeDefaultTermination();
    }, 2_500);
  }
  for (const stop of commandShutdowns) stop(false);
}
function resumeDefaultTermination(): void {
  if (parentTerminationSignal === undefined) return;
  clearTimeout(parentTerminationTimer);
  process.removeListener("SIGINT", onCommandParentInt);
  process.removeListener("SIGTERM", onCommandParentTerm);
  process.kill(process.pid, parentTerminationSignal);
}
function registerCommandShutdown(stop: (exiting: boolean) => void): () => void {
  if (commandShutdowns.size === 0) {
    process.on("exit", onCommandParentExit);
    process.on("SIGINT", onCommandParentInt);
    process.on("SIGTERM", onCommandParentTerm);
  }
  commandShutdowns.add(stop);
  return () => {
    commandShutdowns.delete(stop);
    if (commandShutdowns.size === 0) {
      process.removeListener("exit", onCommandParentExit);
      process.removeListener("SIGINT", onCommandParentInt);
      process.removeListener("SIGTERM", onCommandParentTerm);
      if (parentTerminationSignal !== undefined) setImmediate(resumeDefaultTermination);
    }
  };
}

export async function runShellCommand(command: string, options: ShellCommandOptions): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = timerDuration(options.timeoutMs, 120_000);
  if (options.signal?.aborted || parentTerminationSignal !== undefined) {
    const now = new Date().toISOString();
    return { command, exitCode: 130, stdout: "", stderr: "Cancelled before command started", durationMs: 0,
      cancellation: { source: "external", requested_at: now, invocation_started: false,
        stop_confirmed: true, confirmed_at: now, evidence: "not_started" } };
  }
  if (process.platform === "win32") {
    const evidence = `Command not started: POSIX process-group control unsupported on ${process.platform}`;
    return { command, exitCode: 125, stdout: "", stderr: evidence, durationMs: 0,
      failure_code: "process_control_unsupported",
      termination: { scope: "unsupported", trigger: "process_error", stop_confirmed: true, signals: [], evidence } };
  }
  return await new Promise<CommandResult>((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...((options.env !== undefined || options.inheritEnv === false)
        ? { env: { ...(options.inheritEnv === false ? {} : process.env), ...options.env } } : {}),
    });
    const pgid = child.pid;
    let stdout = "";
    let stderr = "";
    let leaderExited = false;
    let pipesClosed = false;
    let exitCode = 1;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let trigger: CommandTerminationEvidence["trigger"] | undefined;
    let cancellation: CancellationEvidence | undefined;
    let termDeadline = Infinity;
    let killDeadline = Infinity;
    let drainDeadline = Infinity;
    let descendantDeadline = Infinity;
    let lastProbe = "not inspected";
    const signals: NodeJS.Signals[] = [];
    const errors: string[] = [];

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (pgid === undefined) return;
      signals.push(signal);
      try { process.kill(-pgid, signal); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ESRCH during delivery is a race, not independent exit proof.
        if (code !== "ESRCH") errors.push(`${signal}: ${code ?? String(error)}`);
      }
    };
    const requestStop = (reason: NonNullable<typeof trigger>): void => {
      if (trigger !== undefined || settled) return;
      trigger = reason;
      clearTimeout(timeout);
      if (reason === "external" || reason === "timeout") {
        cancellation = { source: reason, requested_at: new Date().toISOString(),
          invocation_started: pgid !== undefined, stop_confirmed: false };
      }
      termDeadline = performance.now() + timerDuration(options.terminationGraceMs, 1_000);
      signalGroup("SIGTERM");
    };
    const onAbort = (): void => { requestStop("external"); };
    const finish = (confirmed: boolean, notStarted = false): void => {
      if (settled) return;
      settled = true;
      releaseShutdown();
      clearTimeout(timeout);
      clearInterval(poll);
      options.signal?.removeEventListener("abort", onAbort);
      // Do not let inherited pipes or an unconfirmed child keep this caller
      // alive forever. Late child events stay observed, but cannot revise proof.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      const evidence = notStarted ? "Command not started: spawn failed"
        : confirmed ? `Process group ${pgid} gone (kill(-pgid, 0): ESRCH); leader exit observed`
          : `Process group ${pgid} exit unconfirmed (reconciliation required): ${lastProbe}; leader exit observed=${leaderExited}`;
      const detail = evidence + (errors.length ? `; ${errors.join("; ")}` : "");
      const failureCode = !confirmed ? "process_exit_unconfirmed"
        : trigger === "leader_exit" ? "surviving_descendants" : undefined;
      const diagnostic = trigger === "timeout" ? `Command timed out after ${timeoutMs}ms`
        : trigger === "external" ? "Command cancelled"
          : trigger === "leader_exit" ? "Command leader exited with surviving descendants"
            : exitSignal ? `Command exited from signal ${exitSignal}` : "";
      resolve({ command, stdout,
        stderr: appendLimited(stderr, [diagnostic, ...(!confirmed ? [detail] : []), ...errors].filter(Boolean).join("; "), options.outputLimit),
        exitCode: !confirmed ? 125 : notStarted ? 127 : trigger === "timeout" ? 124
          : trigger === "external" ? 130 : trigger !== undefined ? 1 : exitCode,
        durationMs: Date.now() - started,
        termination: { scope: notStarted ? "not_started" : "posix_process_group",
          ...(pgid !== undefined ? { pgid } : {}),
          ...(leaderExited ? { leader_exit_code: exitCode } : {}), trigger: trigger ?? "exit",
          stop_confirmed: confirmed, signals: [...signals], evidence: detail },
        ...(failureCode !== undefined ? { failure_code: failureCode } : {}),
        ...(cancellation !== undefined ? { cancellation: { ...cancellation, stop_confirmed: confirmed,
          evidence: detail, ...(confirmed ? { confirmed_at: new Date().toISOString() } : {}) } } : {}),
      });
    };
    const inspect = (): void => {
      if (settled || pgid === undefined) return;
      let groupGone = false;
      try {
        process.kill(-pgid, 0);
        lastProbe = "group still exists";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        groupGone = code === "ESRCH";
        lastProbe = `kill(-pgid, 0): ${code ?? String(error)}`;
      }
      const now = performance.now();
      if (groupGone && leaderExited) {
        // Usually close has already drained output. Bound draining because a
        // deliberately detached process could hold a pipe outside this group.
        if (drainDeadline === Infinity) drainDeadline = now + 50;
        if (pipesClosed || now >= drainDeadline) finish(true);
        return;
      }
      if (leaderExited && trigger === undefined) {
        // A short drain window avoids killing auxiliaries already finishing.
        if (descendantDeadline === Infinity) descendantDeadline = now + Math.min(timerDuration(options.terminationGraceMs, 1_000), 100);
        if (now >= descendantDeadline) requestStop("leader_exit");
      }
      if (now >= termDeadline && killDeadline === Infinity) {
        signalGroup("SIGKILL");
        killDeadline = now + timerDuration(options.killGraceMs, 1_000);
      }
      if (now >= killDeadline) finish(false);
    };
    const timeout = setTimeout(() => requestStop("timeout"), timeoutMs);
    const poll = setInterval(inspect, 10);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk.toString("utf-8"), options.outputLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk.toString("utf-8"), options.outputLimit);
    });
    child.on("error", (error) => {
      if (settled) return;
      errors.push(error.message);
      if (pgid === undefined) finish(true, true);
      else requestStop("process_error");
    });
    child.on("exit", (code, signal) => {
      leaderExited = true;
      exitCode = code ?? 1;
      exitSignal = signal;
    });
    child.on("close", () => {
      pipesClosed = true;
      inspect();
    });
    const releaseShutdown = pgid === undefined ? () => {} : registerCommandShutdown((exiting) => {
      if (!exiting) requestStop("external");
      // SIGINT/TERM allow bounded cleanup; exit itself cannot await promises.
      else signalGroup("SIGKILL");
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function timerDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 2 ** 31 - 1 ? value : fallback;
}

function appendLimited(current: string, next: string, limit: number): string {
  const combined = current + next;
  if (combined.length <= limit) return combined;
  return combined.slice(combined.length - limit);
}
