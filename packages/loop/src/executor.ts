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
  /** Adapter-reported token usage for this run (undefined when not reported). */
  tokens_in?: number;
  tokens_out?: number;
  /** Adapter/provider-reported spend for this run (undefined when not reported). */
  cost_usd?: number;
}

export interface LocalExecutorOptions {
  workspacePath: string;
  command?: string;
  adapters?: readonly AgentAdapter[];
  sessionId?: string;
  timeoutMs?: number;
  outputLimit?: number;
}

export async function executePlan(plan: ExecutionPlan, options: LocalExecutorOptions): Promise<AgentRun> {
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
  const availability = await adapter.isAvailable();
  if (!availability.available) {
    const completed = Date.now();
    return {
      run_id: runId,
      plan_id: plan.plan_id,
      task_id: plan.task.task_id,
      agent_id: adapter.id,
      outcome: "failed",
      started_at: new Date(started).toISOString(),
      completed_at: new Date(completed).toISOString(),
      duration_ms: completed - started,
      command_results: [{
        command: `agent:${adapter.id}`,
        exitCode: 127,
        stdout: "",
        stderr: availability.reason ?? "agent unavailable",
        durationMs: completed - started,
      }],
      adapter_event_count: 0,
      summary: availability.reason ?? "agent unavailable",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  let outcome: AgentRun["outcome"] = "completed";
  let adapterEventCount = 0;
  let summary: string | undefined;
  let usage: AgentUsage | undefined;
  try {
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

    for await (const event of adapter.invoke(agentTask, controller.signal)) {
      adapterEventCount += 1;
      if (event.type === "error" && event.terminal) {
        outcome = "failed";
        summary = errorPayload(event.payload).message;
      }
      if (event.type === "usage.updated" || event.type === "usage.final") {
        // usage events report running/final totals; the latest authoritative
        // value wins (final supersedes updated, both supersede nothing).
        usage = usagePayload(event.payload);
      }
      if (event.type === "done") {
        const payload = donePayload(event.payload);
        outcome = payload.status === "expired" ? "failed" : payload.status;
        summary = payload.result_summary;
        if (payload.usage !== undefined) usage = usagePayload(payload.usage);
      }
    }
  } catch (err) {
    outcome = "failed";
    summary = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeout);
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
    command_results: [],
    adapter_event_count: adapterEventCount,
    ...(summary !== undefined ? { summary } : {}),
    ...(usage?.tokens_in !== undefined ? { tokens_in: usage.tokens_in } : {}),
    ...(usage?.tokens_out !== undefined ? { tokens_out: usage.tokens_out } : {}),
    ...(usage?.cost_usd !== undefined ? { cost_usd: usage.cost_usd } : {}),
  };
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

function donePayload(payload: HermesEvent["payload"]): {
  status: "completed" | "failed" | "cancelled" | "expired";
  result_summary?: string;
  usage?: HermesEvent["payload"];
} {
  return payload as {
    status: "completed" | "failed" | "cancelled" | "expired";
    result_summary?: string;
    usage?: HermesEvent["payload"];
  };
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
