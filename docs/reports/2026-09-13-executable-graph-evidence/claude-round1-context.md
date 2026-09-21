# Updated context — executable graph orchestration, not graph diagnostics
User corrected the target: Google ADK-style executable workflow graph with typed node I/O, parallel fan-out/AND-join, conditional routes, bounded failure/retry and termination, reusing OSStack adapters, Loop, and permissions. They want an open-source landscape and a concrete next product/technical evolution plan, comparing upgrading osstack vs a new osgraph. This turn is research/design, not a production implementation request.
Prior research mistakenly emphasized relation diagnostics. graph explain exists but is read-only and NOT an execution runtime. Do not treat that pilot or its 850 passing tests as validation of graph execution.
Current OSStack branch codex/graph-readonly-pilot at b476bcc (2026-09-13 inspection). Original uncommitted AGENTS.md belongs to user. TypeScript pnpm monorepo, Node >=20, local SQLite daemon + agent adapters + Loop + governance. Never run dev CLI against default/reserved home.
Initial external facts verified 2026-09-13 via official sources:
- DEEP-JLU/Awesome-Graph-Engineering is a resource index, no runtime.
- PO-VINCENT/graph-engineering-playbook MIT: docs task-graph patterns, runnable Python demo is knowledge extract/validate/fuse/serve, not durable executable task graph.
- InternScience/GraphGen Apache-2.0 is KG-driven SFT data synthesis, not orchestrator.
- google/adk-js Apache-2.0 @google/adk 2.0.0 is published; cloned source has Workflow, FunctionNode, JoinNode, typed data, routing, retry and session machinery. No reason to assume JS lacks graphs; prior outdated cross-language claims invalid. Source sample explicitly says Join waits for predecessor COMPLETE even if output undefined, so join != verified success.
- LangGraph.js MIT @langchain/langgraph 1.4.15 published, checkpointer/retry/interrupt support. MemorySaver is not crash durable. Checkpoints do not make external effects exactly-once.
- Mastra latest @mastra/core 1.66.0 requires Node >=22.13; outside ee/ Apache-2.0, ee directories separately licensed. Typed workflows parallel/branch/suspend/resume. Don't label whole repo simply MIT/Apache.
- Microsoft agent-framework MIT Python/.NET, Temporal TS SDK MIT durable execution with extra service/worker architecture.
Evidence status: OSStack source read, upstream source read, SDK semantic probes being run separately by parent. No integration or production benefit proven yet.
Please independently propose the best product architecture, and strongest rival case. Challenge whether a new product is warranted, whether to wrap existing engine (ADK JS or LangGraph.js) vs write scheduler, and what current reuse actually requires. Focus on authority ownership, durability vs side effects, retries inside Loop vs graph, cancellation, AND-join scopes across iterations, worktree concurrency, schema validation, crash recovery and measurable release gates. Explicitly separate verified code facts from conjecture. No tools, no implementation. Return a concrete Chinese design critique and recommended vertical slice, <=1600 Chinese words.

FILE packages/agents/src/base.ts
// AgentAdapter — every sub-agent (Claude Code, Codex CLI, DeepSeek, ...) implements
// this. The daemon's orchestrator picks one via policy.score() and feeds it tasks.
//
// Design decisions locked in plan v0.6:
//   E1: capability schema = Zod (single source of truth)
//   D11: invocation = streaming AsyncIterable<HermesEvent>
//        (events flow back to Hermes via the adapter, not buffered)
//   D5: cancellation = explicit cancel(runId) method, NOT just rejecting the iterator
//        (so the adapter can clean up sub-processes)

import type { Capability, CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";

/** Globally unique adapter identifier (e.g. "claude-code", "codex-cli"). */
export type AgentId = string;

export interface AgentAvailability {
  available: boolean;
  /** Stable preflight classification for control-plane decisions. */
  status?: "available" | "not_authenticated" | "installed_but_broken" | "not_installed";
  /** Human-readable reason when unavailable (missing key, bin not on PATH, ...). */
  reason?: string;
  /** Last successful probe time (unix seconds). */
  last_checked_at: number;
}

export interface AgentTask {
  /** Globally unique run id (allocated by the orchestrator, not the adapter). */
  run_id: string;
  /** Owning task this run belongs to. */
  task_id: string;
  /** Hermes session that originated the request (for event envelope). */
  session_id: string;
  /** Capability the orchestrator selected for this run. */
  capability_id: string;
  /** Free-form user prompt + any structured context the adapter understands. */
  prompt: string;
  context?: Record<string, unknown>;
}

export interface AgentRuntimeIdentity {
  adapter_id: string;
  adapter_version: string;
  auth_mode: string;
  provider_id: string;
  model_id: string;
  model_context_window?: number;
  reasoning_effort?: string;
  agent_profile?: string;
  binary_path_sha256?: string;
  evidence_source: "reported" | "configured" | "inferred";
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly display_name: string;
  readonly cost_tier: CostTier;

  /** Capabilities this adapter advertises. Read by policy.score(). */
  capabilities(): readonly Capability[];

  /**
   * Cheap reachability probe. Should NOT call the underlying LLM; just check
   * that we have credentials + the CLI/SDK is present. < 2s expected.
   */
  isAvailable(): Promise<AgentAvailability>;

  /** Runtime/provider evidence used by review and proof artifacts. */
  runtimeIdentity?(): Promise<AgentRuntimeIdentity>;

  /**
   * Execute the task and stream Hermes-shaped events until terminal. The
   * adapter is responsible for emitting `run.started` first and one of
   * `done` / `error` last; the daemon will refuse non-conforming streams.
   *
   * Implementations MUST honor an AbortSignal: when fired, stop the
   * underlying work, emit a final `done` with status "cancelled", and
   * close the iterator.
   */
  invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent>;
}

// Resumable conversation support is deliberately a separate structural
// capability. See session.ts and isSessionCapableAdapter(): existing one-shot
// adapters continue to satisfy AgentAdapter without implementing fake resume.

/**
 * Helper base class: keeps the common fields and forces subclasses to
 * implement the streaming method. Adapters don't HAVE to subclass this —
 * the interface above is sufficient — but most will because boilerplate.
 */
export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly id: AgentId;
  abstract readonly display_name: string;
  abstract readonly cost_tier: CostTier;

  abstract capabilities(): readonly Capability[];
  abstract isAvailable(): Promise<AgentAvailability>;
  abstract invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent>;
}

FILE packages/loop/src/executor.ts
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

FILE packages/protocol/src/session-continuation.ts
import { z } from "zod";

const Id = z.string().trim().min(1).max(256);

export const SessionGateKind = z.enum([
  "phase_continue",
  "task_authorization",
  "risk_approval",
  "external_input",
]);
export type SessionGateKind = z.infer<typeof SessionGateKind>;

/** An agent-reported request, never a grant or proof that a gate passed. */
export const SessionContinuationRequest = z.object({
  version: z.literal(1),
  gate_kind: SessionGateKind,
  phase: Id,
  next_action: z.string().trim().min(1).max(1_000),
  evidence_refs: z.array(z.object({
    evidence_id: Id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(32),
}).strict();
export type SessionContinuationRequest = z.infer<typeof SessionContinuationRequest>;

export const SessionDecision = z.object({
  decision_id: Id,
  question: z.string().trim().min(1).max(1_000),
  // Empty choices remain valid for legacy adapters requesting free-form input.
  choices: z.array(z.object({
    choice_id: Id,
    label: z.string().trim().min(1).max(160),
  }).strict()).max(8).refine(
    (choices) => new Set(choices.map((choice) => choice.choice_id)).size === choices.length,
    "choice IDs must be unique",
  ),
  continuation: SessionContinuationRequest.optional(),
}).strict();
export type SessionDecision = z.infer<typeof SessionDecision>;

FILE packages/protocol/src/session-continuation-grant.ts
import { z } from "zod";

const Id = z.string().trim().min(1).max(256);
const Timestamp = z.string().datetime({ offset: true });
const Instruction = z.string().min(1).max(16_000).refine(
  (value) => value.trim().length > 0,
  "instruction must contain non-whitespace text",
);
const AbsolutePath = z.string().max(4_096).regex(
  /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/,
  "repo_path must be an absolute path",
).refine((value) => !value.includes("\0"), "repo_path must not contain NUL characters");

/**
 * Equality against persisted assistant_text only. These checks attest to the
 * declared output contract, never open-ended task quality or an R3 approval.
 * A JSON path is a sequence of literal keys; [] selects the root primitive.
 * Consumers must use own-property traversal, not eval or prototype lookup.
 */
export const OutputCheck = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text_equals"),
    expected: z.string().max(4_000),
  }).strict(),
  z.object({
    kind: z.literal("json_value_equals"),
    path: z.array(z.string().max(256)).max(8),
    expected: z.union([z.null(), z.string().max(4_000), z.number().finite(), z.boolean()]),
  }).strict(),
]);
export type OutputCheck = z.infer<typeof OutputCheck>;

/** The checks must pass before the frozen instruction for this step is sent. */
export const ContinuationGrantStep = z.object({
  phase: Id,
  instruction: Instruction,
  checks: z.array(OutputCheck).min(1).max(16),
  retry_instruction: Instruction.optional(),
  max_retries: z.number().int().min(0).max(3).default(0),
}).strict();
export type ContinuationGrantStep = z.infer<typeof ContinuationGrantStep>;

/**
 * A finite delegation bound to one session, runtime policy, repository and
 * initial turn/version. "Completed" means all delegated instructions were sent
 * and completed; it does not mean the user's overall objective was achieved.
 * Signature verification, time validity and durable consumption are runtime
 * responsibilities. This schema does not grant GitHub or R3 approval powers.
 */
export const ContinuationGrantBody = z.object({
  version: z.literal(1),
  grant_id: Id,
  session_id: Id,
  runtime_id: Id,
  runtime_policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  repo_path: AbsolutePath,
  initial_turn_id: Id,
  initial_version: z.number().int().min(1),
  issued_at: Timestamp,
  expires_at: Timestamp,
  max_resumes: z.number().int().min(1).max(32),
  max_checks: z.number().int().min(1).max(64),
  turn_timeout_ms: z.number().int().min(100).max(300_000),
  steps: z.array(ContinuationGrantStep).min(1).max(16),
}).strict();
export type ContinuationGrantBody = z.infer<typeof ContinuationGrantBody>;

export const SignedContinuationGrant = z.object({
  body: ContinuationGrantBody,
  key_id: Id,
  signature: z.string().regex(
    /^[A-Za-z0-9+/]{85}[AQgw]==$/,
    "signature must be canonical base64 for a 64-byte Ed25519 signature",
  ),
}).strict();
export type SignedContinuationGrant = z.infer<typeof SignedContinuationGrant>;

LOOP EXCERPTS
    const jsonPath = resolvePath(this.options.stateFilePath ?? "LOOP-STATE.json", workspacePath);
    const markdownPath = this.options.markdownPath !== undefined
      ? resolvePath(this.options.markdownPath, workspacePath)
      : undefined;
    const startedAt = Date.now();

    const existingState = await readLoopState(jsonPath);
    const loopId = existingState?.loop_id ?? this.options.loopId ?? `loop_${randomUUID()}`;
    const state = existingState ?? createInitialLoopState(loopId);
    const decisions = [...(state.decisions ?? [])];

    if (lifecycle.emitStarted) this.emit(loopId, "loop.started", { workspace_path: workspacePath });
    if (this.options.knowledge !== undefined) {
      this.emit(loopId, "loop.knowledge.used", {
        mode: this.options.knowledge.mode,
        status: this.options.knowledge.status,
        pack_count: this.options.knowledge.packs.length,
        chunk_count: this.options.knowledge.results.length,
        ...(this.options.knowledge.query !== undefined ? { query: this.options.knowledge.query } : {}),
        ...(this.options.knowledge.reason !== undefined ? { reason: this.options.knowledge.reason } : {}),
        ...(this.options.knowledge.fallback_mode !== undefined ? { fallback_mode: this.options.knowledge.fallback_mode } : {}),
      });
      decisions.push(`knowledge: ${this.options.knowledge.mode}/${this.options.knowledge.status} with ${this.options.knowledge.results.length} chunk(s)`);
    }
    this.emit(loopId, "loop.cycle.started", { cycle });
    await this.cleanupLoopWorktrees(loopId, workspacePath, cycle, "before_cycle", decisions);
    const discoveredTasks = await this.discover(workspacePath);
    const completedIds = new Set(state.completed_tasks.map((task) => task.task_id));
    const candidateTasks = this.options.skipCompletedTasks === false
      ? discoveredTasks
      : discoveredTasks.filter((task) => !completedIds.has(task.task_id));
    const skippedTaskCount = discoveredTasks.length - candidateTasks.length;
    const governance = this.applyDiscoveryPolicy(loopId, candidateTasks, decisions);
    const tasks = governance.executable;
    this.emit(loopId, "loop.discover.done", {
      task_count: tasks.length,
      discovered_task_count: discoveredTasks.length,
      skipped_task_count: skippedTaskCount,
      ...(this.options.discoveryPolicy !== undefined
        ? { deferred_task_count: governance.deferred.length }
        : {}),
    });

    const previousCompletedCount = state.completed_tasks.length;
    const completed: CompletedTask[] = [...state.completed_tasks];
    const pending = [...tasks];

    for (const task of tasks) {
      pending.shift();
      const taskResult = await this.runTask(loopId, workspacePath, task, completed);
      completed.push(taskResult.completedTask);
      decisions.push(...taskResult.decisions);
      if (this.options.archiveCompletedTasks === true) {
        const archive = await archiveCompletedTaskFile(task, taskResult.completedTask, workspacePath);
        this.emit(loopId, "loop.queue.archived", {
          task_id: task.task_id,
          archived: archive.archived,
          ...(archive.reason !== undefined ? { reason: archive.reason } : {}),
          ...(archive.fromPath !== undefined ? { from_path: archive.fromPath } : {}),
          ...(archive.toPath !== undefined ? { to_path: archive.toPath } : {}),
        });
        if (archive.archived) {
          decisions.push(`${task.task_id}: archived task queue file to ${archive.toPath}`);
        }
      }
    }
    await this.cleanupLoopWorktrees(loopId, workspacePath, cycle, "after_cycle", decisions);

    const goal = await this.checkGoal(loopId, workspacePath);
    if (goal !== undefined) {
      decisions.push(`goal: ${goal.pass ? "passed" : "not met"} - ${goal.summary}`);
    }

    const successCount = completed.filter((task) => task.outcome === "success").length;
    const nextState = LoopState.parse({
      ...state,
      loop_id: state.loop_id || loopId,
      updated_at: new Date().toISOString(),
      completed_tasks: completed,
      in_progress: [],
      pending,
      deferred_tasks: governance.deferred,
      // Recompute each cycle, including after restart or a policy change. Never
      // carry a prior waiting verdict into newly executable or truly idle work.
      wait_reason: tasks.length === 0 ? discoveryWaitReason(governance.deferred) : undefined,
      key_metrics: {
        total_cycles: (state.key_metrics?.total_cycles ?? 0) + 1,
        avg_duration_ms: completed.length === 0
          ? 0
          : Math.round(completed.reduce((sum, task) => sum + task.duration_ms, 0) / completed.length),
  ): Promise<{ completedTask: CompletedTask; decisions: string[] }> {
    const started = Date.now();
    const maxIterations = clampTaskIterations(this.options.maxIterations ?? 1, this.options.budget);
    const decisions: string[] = [];
    let finalRun: AgentRun | null = null;
    let finalVerdict: Verdict | null = null;
    let finalReviewArtifacts: ReviewArtifact[] | undefined;
    let outcome: CompletedTask["outcome"] = "failed";
    let iterations = 0;
    // Usage accrues across every iteration of this task, not just the last run.
    const taskUsage = { tokensIn: 0, tokensOut: 0, cost: 0, reported: false };
    let runWorkspacePath = workspacePath;
    let worktree: WorktreeHandle | undefined;
    let preserveWorktreeBranch = false;
    let worktreeCommit: string | undefined;
    let finalEvidence: TaskGitEvidence = { changedFiles: [], diffSummary: "no git evidence collected" };
    let latestFeedback: IterationFeedback | undefined;
    const feedbackHistory: IterationFeedback[] = [];
    let previousFingerprint: string | undefined;
    let lessonDraftPath: string | undefined;
    let publishedAsset: PublishedAssetEvidence | undefined;

    if (this.options.useWorktree === true) {
      worktree = await createWorktree({
        repoPath: workspacePath,
        runId: task.task_id,
        branchPrefix: loopWorktreeBranchPrefix(loopId),
        ...(this.options.worktreeRoot !== undefined ? { rootPath: this.options.worktreeRoot } : {}),
      });
      runWorkspacePath = worktree.worktreePath;
      this.emit(loopId, "loop.worktree.created", {
        task_id: task.task_id,
        worktree_path: worktree.worktreePath,
        branch: worktree.branch,
      });
      decisions.push(`${task.task_id}: created isolated worktree ${worktree.worktreePath}`);
    }

    try {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        iterations = iteration;
        const effectiveTask: Task = latestFeedback === undefined
          ? task
          : { ...task, context: withIterationFeedback(task.context, latestFeedback) };
        const agentSelection = await this.selectExecutionAgent(effectiveTask, historyTasks);
        const plan = planTask(effectiveTask, {
          maxIterations,
          agentId: agentSelection.agentId,
          ...(worktree !== undefined ? { worktreePath: worktree.worktreePath } : {}),
        });
        this.emit(loopId, "loop.plan.done", {
          task_id: task.task_id,
          plan_id: plan.plan_id,
          agent_id: plan.agent_id,
          routing_reason: agentSelection.reason,
          ...(agentSelection.policyDecision !== undefined ? { policy: policyEventPayload(agentSelection.policyDecision) } : {}),
          ...(plan.worktree_path !== undefined ? { worktree_path: plan.worktree_path } : {}),
          ...(this.options.profileRouting !== undefined
            ? {
                profile_name: this.options.profileRouting.profile_name,
                profile_reason: this.options.profileRouting.reason,
                builder_identity: redactProfileIdentity(
                  this.options.profileRouting.builder_identity,
                ),
                independent: this.options.profileRouting.independent,
                independence_reason:
                  this.options.profileRouting.independence_reason,
              }
            : {}),
          iteration,
        });
        decisions.push(`${task.task_id}: selected ${plan.agent_id} - ${agentSelection.reason}`);

        finalRun = await executePlan(plan, {
          workspacePath: runWorkspacePath,
          sessionId: loopId,
          ...(this.options.adapters !== undefined ? { adapters: this.options.adapters } : {}),
          ...(this.options.executeCommand !== undefined ? { command: this.options.executeCommand } : {}),
          ...(this.options.commandTimeoutMs !== undefined ? { timeoutMs: this.options.commandTimeoutMs } : {}),
          ...(this.options.outputLimit !== undefined ? { outputLimit: this.options.outputLimit } : {}),
        });
        if (finalRun.tokens_in !== undefined || finalRun.tokens_out !== undefined || finalRun.cost_usd !== undefined) {
          taskUsage.reported = true;
          taskUsage.tokensIn += finalRun.tokens_in ?? 0;
          taskUsage.tokensOut += finalRun.tokens_out ?? 0;
          taskUsage.cost += finalRun.cost_usd ?? 0;
        }
        this.emit(loopId, "loop.execute.done", {
          task_id: task.task_id,
          run_id: finalRun.run_id,
          outcome: finalRun.outcome,
          agent_id: finalRun.agent_id,
          ...(finalRun.adapter_event_count !== undefined ? { adapter_event_count: finalRun.adapter_event_count } : {}),
          ...(finalRun.summary !== undefined ? { summary: finalRun.summary } : {}),
          ...(finalRun.tokens_in !== undefined ? { tokens_in: finalRun.tokens_in } : {}),
          ...(finalRun.tokens_out !== undefined ? { tokens_out: finalRun.tokens_out } : {}),
          ...(finalRun.cost_usd !== undefined ? { cost_usd: finalRun.cost_usd } : {}),
          ...(worktree !== undefined ? { worktree_path: worktree.worktreePath } : {}),
          iteration,
        });

        const verifierAgentIds = this.options.verifierAgentIds ?? [];
        if (
          this.options.enforceRoleSeparation === true
          && verifierAgentIds.includes(finalRun.agent_id)
        ) {
          finalVerdict = {
            pass: false,
            score: 0,
            reviewer_agent_id: verifierAgentIds.join(","),
            : {}),
          iteration,
        });
        for (const deviation of finalVerdict.implementation_deviations ?? []) {
          this.emit(loopId, "loop.implementation.deviation", {
            task_id: task.task_id,
            iteration,
            reviewer_agent_id: finalVerdict.reviewer_agent_id,
            ...deviation,
          });
        }

        let decision = evaluateIteration({
          verdict: finalVerdict,
          iteration,
          maxIterations,
        });
        if (!finalVerdict.pass) {
          const fingerprint = issueFingerprint(finalVerdict);
          if (decision.action === "continue" && fingerprint === previousFingerprint) {
            decision = {
              action: "escalate",
              reason: `No progress: attempt ${iteration} produced the same blocking issues and failed evaluations as attempt ${iteration - 1}.`,
              escalate_to: "hermes",
            };
          }
          previousFingerprint = fingerprint;
          latestFeedback = deriveIterationFeedback({
            attempt: iteration,
            verdict: finalVerdict,
            changedFiles: finalEvidence.changedFiles,
            ...(finalEvidence.diffSummary !== undefined ? { diffSummary: finalEvidence.diffSummary } : {}),
          });
          feedbackHistory.push(latestFeedback);
        }
        this.emit(loopId, "loop.iterate.done", {
          task_id: task.task_id,
          action: decision.action,
          reason: decision.reason,
          iteration,
          issue_count: finalVerdict.issues.length,
          failed_evaluation_ids: failedEvaluationIds,
        });
        decisions.push(`${task.task_id}: ${decision.action} after iteration ${iteration} - ${decision.reason}`);

        if (decision.action === "stop") {
          outcome = "success";
          break;
        }
        if (decision.action === "escalate") {
          outcome = "escalated";
          this.emit(loopId, "loop.escalated", {
            task_id: task.task_id,
            reason: decision.reason,
            iteration,
            max_iterations: maxIterations,
            escalate_to: decision.escalate_to,
            agent_id: finalRun.agent_id,
          });
          break;
        }
      }

      if (finalRun?.outcome === "failed" && finalVerdict?.pass !== true && outcome !== "escalated") {
        outcome = "failed";
      }

DAEMON LEASE EXCERPT
    : "write";
}

function repoWriteSemaphore(
  ctx: DaemonContext,
  repoId: string,
): FifoSemaphore {
  const existing = ctx.repoWriteSemaphores.get(repoId);
  if (existing !== undefined) return existing;
  const created = new FifoSemaphore(1);
  ctx.repoWriteSemaphores.set(repoId, created);
  return created;
}

async function acquireDaemonRunSlot(
  ctx: DaemonContext,
  input: {
    kind: "read" | "write";
    run_id: string;
    repo_id?: string;
    signal?: AbortSignal;
  },
): Promise<DaemonRunSlot> {
  if (input.kind === "read") {
    const lease = await ctx.readSemaphore.acquire(input.signal);
    return {
      release: async () => {
        lease.release();
      },
    };
  }
  if (
    ctx.guardedAutonomy !== undefined
    && ctx.lastAutonomyHealth === undefined
  ) {
    throw new Error(
      "autonomy writes are blocked until the initial health check completes",
    );
  }
  if (ctx.lastAutonomyHealth?.can_run_local === false) {
    throw new Error(
      `autonomy writes are blocked by ${
        ctx.lastAutonomyHealth.write_blockers.join(",")
      }`,
    );
  }

  let repoSemaphore: FifoSemaphore | undefined;
  let repoLease: SemaphoreLease | undefined;
  let writeLease: SemaphoreLease | undefined;
  let fileLock: RepoWriteLock | undefined;
  try {
    if (input.repo_id !== undefined) {
      repoSemaphore = repoWriteSemaphore(ctx, input.repo_id);
      repoLease = await repoSemaphore.acquire(input.signal);
    }
    writeLease = await ctx.writeSemaphore.acquire(input.signal);
    if (input.repo_id !== undefined) {
      fileLock = await acquireRepoWriteLock({
        root_dir: join(osstackHome(), "locks", "repos"),
        repo_id: input.repo_id,
        autonomy_run_id: input.run_id,
        on_audit: (event) => {
          process.stderr.write(
            `osstack: ${JSON.stringify(event)}\n`,
          );
        },
      });
    }
  } catch (error) {
    writeLease?.release();
    repoLease?.release();
    if (
      input.repo_id !== undefined
      && repoSemaphore?.in_use === 0
      && repoSemaphore.pending === 0
    ) {
      ctx.repoWriteSemaphores.delete(input.repo_id);
    }
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await fileLock?.release();
      } finally {
        writeLease?.release();
        repoLease?.release();
        if (
          input.repo_id !== undefined
          && repoSemaphore?.in_use === 0