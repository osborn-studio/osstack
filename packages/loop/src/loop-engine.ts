import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  cleanupOrphanedWorktrees,
  cleanupWorktree,
  commitWorktreeChanges,
  createWorktree,
  mergeWorktree,
  type AgentAdapter,
  type WorktreeHandle,
} from "@osstack/agents";
import {
  DEFAULT_RULES,
  PolicyEngine,
  routeCapability,
  type PolicyCandidate,
  type PolicyDecision,
  type PolicyHistory,
  type RoutableAdapter,
} from "@osstack/core";
import { checkBudget, clampTaskIterations, type BudgetUsage, type LoopBudget, type LoopBudgetStatus } from "./budget.js";
import { createScanner } from "./discover.js";
import { authorizeTask, type DiscoveryPolicy } from "./discovery-policy.js";
import { executePlan, runShellCommand, type AgentRun, type CommandResult } from "./executor.js";
import { deriveIterationFeedback, issueFingerprint, withIterationFeedback } from "./feedback.js";
import { evaluateIteration } from "./iterator.js";
import { writeLessonDraft, type LessonDraftConfig } from "./lesson-draft.js";
import { planTask } from "./planner.js";
import {
  createInitialLoopState,
  readLoopState,
  renderLoopStateMarkdown,
  writeLoopState,
} from "./state-file.js";
import { archiveCompletedTaskFile } from "./task-queue.js";
import { isSkillTask, runCommandReal, runPublish, skillIdOf, toPublishedAssetEvidence, type PublishConfig, type RunPublishDeps } from "./publisher.js";
import { verifyRun } from "./verifier.js";
import type { ArtifactVerificationOptions } from "./verifier.js";
import {
  DiscoverSource,
  LoopState,
  CompletedTask,
  type DeferredTask,
  type Issue,
  type IterationFeedback,
  type LoopEvent,
  type LoopKnowledgeTrace,
  type PublishedAssetEvidence,
  type Task,
  type Verdict,
} from "./types.js";

export interface LoopRunOptions {
  loopId?: string;
  workspacePath?: string;
  stateFilePath?: string;
  markdownPath?: string;
  sources?: string[];
  executeCommand?: string;
  verifyCommands?: string[];
  goalCommand?: string;
  maxIterations?: number;
  commandTimeoutMs?: number;
  outputLimit?: number;
  skipCompletedTasks?: boolean;
  archiveCompletedTasks?: boolean;
  useWorktree?: boolean;
  worktreeRoot?: string;
  agentId?: string;
  autoAgent?: boolean;
  verifierAgentIds?: string[];
  enforceRoleSeparation?: boolean;
  artifactVerification?: ArtifactVerificationOptions;
  /** Discovery governance policy. When absent, all discovered tasks execute (legacy behavior). */
  discoveryPolicy?: DiscoveryPolicy;
  /** Cost and stop controls. When absent, no budget is enforced (legacy behavior). */
  budget?: LoopBudget;
  /** SOP flywheel: draft lessons after successes that recovered from failed attempts. Default on. */
  lessonDrafts?: Partial<LessonDraftConfig>;
  adapters?: readonly AgentAdapter[];
  policyEngine?: PolicyEngine;
  policyHistory?: PolicyHistory;
  knowledge?: LoopKnowledgeTrace;
  /** Post-verify skill auto-publish finalizer config (opt-in, non-gating). */
  publish?: PublishConfig;
  /** Injectable publish side-effects, for tests. Defaults to the real command runner. */
  publishDeps?: RunPublishDeps;
  /**
   * Opt-in self-improvement (Level 1-4). Default off. When enabled with an
   * `assetize` callback, each completed task is handed to the callback, which
   * (in the CLI) turns a failed run into a trace + feedback assets + optional
   * proposals and returns their ids to attach. The loop stays supervisor- and
   * storage-agnostic: the callback owns assetization and persistence.
   */
  selfImprovement?: SelfImprovementConfig;
  /**
   * Kernel policy gate (R2.2). When injected, the engine consults it once at
   * run entry (before ANY discovery/execution) and once per scheduled cycle
   * tick. A deny refuses/stops the run cleanly with a `policy_denied` outcome —
   * exactly like a budget stop, never an exception. When ABSENT, behavior is
   * byte-identical to a gate-free loop (the loop stays usable standalone and
   * never couples to the policy loader/schema — how policy files are located
   * and parsed is the CLI product layer's business). Same capability-injection
   * discipline as `assetize`:
   * a gate that throws counts as deny with the error message (fail-closed) —
   * the gate is never allowed to crash the engine.
   */
  policyGate?: PolicyGate;
}

/**
 * Loop-local policy-gate decision (R2.2). Deliberately a structural type: the
 * loop never imports the policy loader/schema (that lives in the CLI product
 * layer), so it stays usable standalone; the CLI supplies an implementation
 * backed by `loadPolicyProfile`.
 */
export type PolicyGateDecision = { allow: true } | { allow: false; reason: string };

/** Injectable kernel policy gate (R2.2). See {@link LoopRunOptions.policyGate}. */
export type PolicyGate = (ctx: { workspacePath: string }) => Promise<PolicyGateDecision>;

/**
 * Policy-gate status folded onto a run result when the gate denied the run/tick.
 * Mirrors how {@link LoopBudgetStatus} surfaces a budget stop so callers (the
 * daemon, the CLI) can distinguish a policy refusal from a normal completion.
 */
export interface LoopPolicyStatus {
  denied: boolean;
  reason: string;
}

/** Ids/summary the self-improvement callback returns for a completed task. */
export interface SelfImprovementResult {
  trace_id: string;
  feedback_asset_ids: string[];
  proposal_ids: string[];
  assetization_summary: string;
  self_improvement_level: number;
}

export interface SelfImprovementConfig {
  repoId: string;
  enabled: boolean;
  proposeImprovements?: boolean;
  /**
   * Injected assetizer. Returns undefined when there is nothing to record
   * (e.g. a passing task). Errors are swallowed by the loop — self-improvement
   * is never allowed to fail a task.
   */
  assetize?: (input: {
    repoId: string;
    completedTask: CompletedTask;
    loopId: string;
    proposeImprovements: boolean;
  }) => Promise<SelfImprovementResult | undefined> | SelfImprovementResult | undefined;
}

export interface LoopGoalResult {
  command: string;
  pass: boolean;
  exitCode: number;
  durationMs: number;
  summary: string;
}

export interface LoopRunResult {
  loop_id: string;
  state: LoopState;
  completedTasks: CompletedTask[];
  events: LoopEvent[];
  jsonPath: string;
  markdownPath: string;
  discoveredTaskCount: number;
  executedTaskCount: number;
  skippedTaskCount: number;
  goal?: LoopGoalResult;
  budget?: LoopBudgetStatus;
  /** Present only when the policy gate denied this run (R2.2). */
  policy?: LoopPolicyStatus;
}

export interface LoopRunCyclesOptions {
  cycles?: number;
  intervalMs?: number;
  stopWhenIdle?: boolean;
}

export interface LoopRunCyclesResult {
  loop_id: string;
  cycles: LoopRunResult[];
  state: LoopState;
  events: LoopEvent[];
  jsonPath: string;
  markdownPath: string;
  budget?: LoopBudgetStatus;
  /** Present only when the policy gate denied the run (at entry or a tick). */
  policy?: LoopPolicyStatus;
}

export class LoopEngine {
  private seq = 0;
  private readonly events: LoopEvent[] = [];

  constructor(private readonly options: LoopRunOptions = {}) {}

  async runCycles(options: LoopRunCyclesOptions = {}): Promise<LoopRunCyclesResult> {
    const cycles = options.cycles ?? 1;
    const intervalMs = options.intervalMs ?? 0;
    if (!Number.isInteger(cycles) || cycles < 1) {
      throw new Error("runCycles.cycles must be a positive integer");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 0) {
      throw new Error("runCycles.intervalMs must be a non-negative integer");
    }
    // Entry consult (R2.2): a deny refuses before ANY discovery/execution work,
    // mirroring a budget stop — a distinguishable `policy_denied` outcome, not
    // an exception. With no gate injected this is a no-op (byte-identical).
    const entryGate = await this.consultPolicyGate();
    if (entryGate.allow === false) {
      return this.policyDeniedCyclesResult(entryGate.reason);
    }

    const results: LoopRunResult[] = [];
    const runStartedAt = Date.now();
    let noProgressCycles = 0;
    let budgetStatus: LoopBudgetStatus | undefined;
    let policyReason: string | undefined;

    for (let cycle = 1; cycle <= cycles; cycle++) {
      // Per-tick consult (R2.2): cycle 1 is covered by the entry consult above;
      // every subsequent scheduled tick re-consults so a human flipping
      // `mode: observe` mid-flight stops the loop cleanly on the next tick.
      if (cycle > 1) {
        const tickGate = await this.consultPolicyGate();
        if (tickGate.allow === false) {
          policyReason = tickGate.reason;
          break;
        }
      }
      const result = await this.runCycle(cycle, {
        emitStarted: cycle === 1,
        emitStopped: false,
      });
      results.push(result);
      noProgressCycles = nextNoProgressCycles(noProgressCycles, result);
      budgetStatus = this.checkLoopBudget(result.loop_id, {
        cycles: results.length,
        runtime_ms: Date.now() - runStartedAt,
        tokens: result.state.key_metrics?.tokens_consumed ?? 0,
        estimated_cost_usd: result.state.key_metrics?.cost_consumed ?? 0,
        no_progress_cycles: noProgressCycles,
      });
      if (budgetStatus?.exceeded === true) break;
      if (result.goal?.pass === true) break;
      if (options.stopWhenIdle === true && result.executedTaskCount === 0) break;
      if (cycle < cycles && intervalMs > 0) await sleep(intervalMs);
    }

    const last = results.at(-1);
    if (last === undefined) {
      throw new Error("runCycles requires at least one cycle");
    }
    const finalState = await this.persistBudgetStatus(last, budgetStatus);
    this.emit(last.loop_id, "loop.stopped", {
      reason: policyReason !== undefined
        ? policyStopReason(policyReason)
        : budgetStatus?.exceeded === true
          ? `budget exceeded: ${budgetStatus.reason}`
          : last.goal?.pass === true
            ? "goal command passed"
            : "manual run completed",
      cycles: results.length,
    });

    return {
      loop_id: last.loop_id,
      cycles: results,
      state: finalState,
      events: [...this.events],
      jsonPath: last.jsonPath,
      markdownPath: last.markdownPath,
      ...(budgetStatus !== undefined ? { budget: budgetStatus } : {}),
      ...(policyReason !== undefined ? { policy: { denied: true, reason: policyReason } } : {}),
    };
  }

  async runOnce(): Promise<LoopRunResult> {
    const eventStartIndex = this.events.length;
    // Entry consult (R2.2): refuse before ANY discovery/execution work. Covers
    // the daemon session scheduler too, which drives each tick via runOnce().
    const entryGate = await this.consultPolicyGate();
    if (entryGate.allow === false) {
      return this.policyDeniedRunResult(entryGate.reason, eventStartIndex);
    }
    const runStartedAt = Date.now();
    const result = await this.runCycle(1, { emitStarted: true, emitStopped: false });
    const budgetStatus = this.checkLoopBudget(result.loop_id, {
      cycles: 1,
      runtime_ms: Date.now() - runStartedAt,
      tokens: result.state.key_metrics?.tokens_consumed ?? 0,
      estimated_cost_usd: result.state.key_metrics?.cost_consumed ?? 0,
      no_progress_cycles: nextNoProgressCycles(0, result),
    });
    const finalState = await this.persistBudgetStatus(result, budgetStatus);
    this.emit(result.loop_id, "loop.stopped", {
      reason: budgetStatus?.exceeded === true
        ? `budget exceeded: ${budgetStatus.reason}`
        : result.goal?.pass === true
          ? "goal command passed"
          : "manual run completed",
    });
    return {
      ...result,
      state: finalState,
      events: this.events.slice(eventStartIndex),
      ...(budgetStatus !== undefined ? { budget: budgetStatus } : {}),
    };
  }

  /**
   * Consult the injected policy gate (R2.2). No gate ⇒ always allow (the loop
   * behaves exactly as before). Fail-closed: a gate that throws counts as a
   * deny carrying the error message — the gate is never allowed to crash the
   * engine, matching the `assetize` self-improvement hook's discipline.
   */
  private async consultPolicyGate(): Promise<PolicyGateDecision> {
    const gate = this.options.policyGate;
    if (gate === undefined) return { allow: true };
    const workspacePath = this.options.workspacePath ?? process.cwd();
    try {
      return await gate({ workspacePath });
    } catch (err) {
      return { allow: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Build the refusal result for a policy-denied run. Mirrors a budget stop: a
   * `loop.stopped` event with a `policy_denied` reason and a `policy` marker on
   * the result. Performs NO discovery/execution and writes NO state file — the
   * refusal happens before any side effect. Preserves the existing loop_id when
   * a state file is already present so the refusal is attributed to the loop.
   */
  private async policyDeniedRunResult(reason: string, eventStartIndex: number): Promise<LoopRunResult> {
    const workspacePath = this.options.workspacePath ?? process.cwd();
    const jsonPath = resolvePath(this.options.stateFilePath ?? "LOOP-STATE.json", workspacePath);
    const markdownPath = this.options.markdownPath !== undefined
      ? resolvePath(this.options.markdownPath, workspacePath)
      : join(dirname(jsonPath), "STATE.md");
    const existingState = await readLoopState(jsonPath);
    const loopId = existingState?.loop_id ?? this.options.loopId ?? `loop_${randomUUID()}`;
    this.emit(loopId, "loop.stopped", { reason: policyStopReason(reason) });
    return {
      loop_id: loopId,
      state: existingState ?? createInitialLoopState(loopId),
      completedTasks: [],
      events: this.events.slice(eventStartIndex),
      jsonPath,
      markdownPath,
      discoveredTaskCount: 0,
      executedTaskCount: 0,
      skippedTaskCount: 0,
      policy: { denied: true, reason },
    };
  }

  /** runCycles counterpart of {@link policyDeniedRunResult} (entry deny, no cycles ran). */
  private async policyDeniedCyclesResult(reason: string): Promise<LoopRunCyclesResult> {
    const eventStartIndex = this.events.length;
    const single = await this.policyDeniedRunResult(reason, eventStartIndex);
    return {
      loop_id: single.loop_id,
      cycles: [],
      state: single.state,
      events: this.events.slice(eventStartIndex),
      jsonPath: single.jsonPath,
      markdownPath: single.markdownPath,
      policy: { denied: true, reason },
    };
  }

  /**
   * When a budget is configured, fold its latest status back into the durable
   * state so `loop status`, reports, and scorecards can explain budget stops.
   */
  private async persistBudgetStatus(
    result: LoopRunResult,
    budgetStatus: LoopBudgetStatus | undefined,
  ): Promise<LoopState> {
    // Only re-persist when the budget actually stops the loop. A within-limits
    // check every cycle would double-write LOOP-STATE.json and double-emit
    // loop.state.written for no state change; the in-memory result.budget still
    // carries the current status for the immediate CLI print.
    if (budgetStatus === undefined || !budgetStatus.exceeded) return result.state;
    const decisions = [...(result.state.decisions ?? [])];
    if (budgetStatus.reason !== undefined) {
      decisions.push(`budget: ${budgetStatus.reason}`);
    }
    const nextState = LoopState.parse({
      ...result.state,
      updated_at: new Date().toISOString(),
      budget_status: budgetStatus,
      decisions,
    });
    const paths = await writeLoopState(result.jsonPath, nextState, { markdownPath: result.markdownPath });
    this.emit(result.loop_id, "loop.state.written", { jsonPath: paths.jsonPath, markdownPath: paths.markdownPath });
    return nextState;
  }

  private checkLoopBudget(loopId: string, usage: BudgetUsage): LoopBudgetStatus | undefined {
    const budget = this.options.budget;
    if (budget === undefined) return undefined;
    const check = checkBudget(budget, usage);
    if (check.exceeded) {
      this.emit(loopId, "loop.budget.exceeded", {
        limit: check.limit,
        reason: check.reason,
        cycles: usage.cycles,
        runtime_ms: usage.runtime_ms,
        tokens: usage.tokens,
        estimated_cost_usd: usage.estimated_cost_usd,
        no_progress_cycles: usage.no_progress_cycles,
      });
    }
    return { ...check, usage };
  }

  private async runCycle(
    cycle: number,
    lifecycle: { emitStarted: boolean; emitStopped: boolean },
  ): Promise<LoopRunResult> {
    const eventStartIndex = this.events.length;
    const workspacePath = this.options.workspacePath ?? process.cwd();
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
      key_metrics: {
        total_cycles: (state.key_metrics?.total_cycles ?? 0) + 1,
        avg_duration_ms: completed.length === 0
          ? 0
          : Math.round(completed.reduce((sum, task) => sum + task.duration_ms, 0) / completed.length),
        success_rate: completed.length === 0 ? 1 : successCount / completed.length,
        // Derived from all completed tasks so the total is idempotent across
        // cycles. Adapters that don't report usage contribute 0.
        tokens_consumed: completed.reduce(
          (sum, task) => sum + (task.tokens_in ?? 0) + (task.tokens_out ?? 0),
          0,
        ),
        cost_consumed: completed.reduce((sum, task) => sum + (task.cost_usd ?? 0), 0),
      },
      decisions,
      ...(this.options.knowledge !== undefined ? { knowledge: this.options.knowledge } : {}),
    });

    const paths = await writeLoopState(jsonPath, nextState, { ...(markdownPath !== undefined ? { markdownPath } : {}) });
    this.emit(loopId, "loop.state.written", { jsonPath: paths.jsonPath, markdownPath: paths.markdownPath });
    this.emit(loopId, "loop.cycle.completed", {
      cycle,
      task_count: tasks.length,
      discovered_task_count: discoveredTasks.length,
      skipped_task_count: skippedTaskCount,
      duration_ms: Date.now() - startedAt,
    });
    if (lifecycle.emitStopped) {
      this.emit(loopId, "loop.stopped", {
        reason: goal?.pass === true ? "goal command passed" : "manual run completed",
      });
    }

    return {
      loop_id: loopId,
      state: nextState,
      completedTasks: nextState.completed_tasks.slice(previousCompletedCount),
      events: this.events.slice(eventStartIndex),
      jsonPath: paths.jsonPath,
      markdownPath: paths.markdownPath,
      discoveredTaskCount: discoveredTasks.length,
      executedTaskCount: tasks.length,
      skippedTaskCount,
      ...(goal !== undefined ? { goal } : {}),
    };
  }

  statusMarkdown(state: LoopState): string {
    return renderLoopStateMarkdown(state);
  }

  private async selectExecutionAgent(
    task: Task,
    historyTasks: readonly CompletedTask[],
  ): Promise<AgentSelection> {
    if (this.options.agentId !== undefined) {
      return { agentId: this.options.agentId, reason: "agent_id override" };
    }
    if (this.options.executeCommand !== undefined) {
      return { agentId: "local-command", reason: "local execute command" };
    }

    const adapters = this.options.adapters ?? [];
    if (adapters.length === 0) {
      return { agentId: "local-noop", reason: "no execute command or adapters configured" };
    }

    const routerPick = await routeCapability(
      { capability_id: task.capability },
      adapters as readonly RoutableAdapter[],
    );
    if (routerPick === null) {
      return { agentId: "local-noop", reason: `no available adapter for capability ${task.capability}` };
    }

    let agentId = routerPick.adapter.id;
    let reason = routerPick.reason;
    let policyDecision: PolicyDecision | undefined;
    const kind = routerPick.capability.kind;
    if (!routerPick.reason.startsWith("exact")) {
      const eligible = await availablePolicyCandidates(adapters, kind);
      if (eligible.length >= 2) {
        policyDecision = (this.options.policyEngine ?? new PolicyEngine({ rules: DEFAULT_RULES })).decide(
          { capability_id: routerPick.capability.id, kind, phase: "code", prompt: task.prompt },
          eligible,
          this.options.policyHistory ?? completedTaskHistory(historyTasks),
        );
        if (policyDecision.winner !== null) {
          agentId = policyDecision.winner.candidate.agent_id;
          const breakdown = policyDecision.winner.breakdown
            .map((item) => `${item.rule_id}=${item.value > 0 ? "+" : ""}${item.value.toFixed(1)}`)
            .join(", ");
          reason = `policy[${breakdown || "no rule scored"}], total=${policyDecision.winner.total.toFixed(1)}`;
        }
      }
    }

    return {
      agentId,
      reason,
      ...(policyDecision !== undefined ? { policyDecision } : {}),
    };
  }

  private applyDiscoveryPolicy(
    loopId: string,
    tasks: Task[],
    decisions: string[],
  ): { executable: Task[]; deferred: DeferredTask[] } {
    const policy = this.options.discoveryPolicy;
    if (policy === undefined) return { executable: tasks, deferred: [] };

    const executable: Task[] = [];
    const deferred: DeferredTask[] = [];
    for (const task of tasks) {
      const decision = authorizeTask(task, policy);
      if (decision.authorization === "auto_execute") {
        executable.push(task);
        continue;
      }
      deferred.push({ task, authorization: decision.authorization, reason: decision.reason });
      this.emit(loopId, "loop.task.deferred", {
        task_id: task.task_id,
        capability: task.capability,
        source: task.source,
        priority: task.priority,
        authorization: decision.authorization,
        reason: decision.reason,
      });
      decisions.push(`${task.task_id}: ${decision.authorization} - ${decision.reason}`);
    }
    return { executable, deferred };
  }

  private async discover(workspacePath: string): Promise<Task[]> {
    const sources = this.options.sources ?? ["git_diff", "task_queue"];
    const tasks: Task[] = [];
    for (const source of sources) {
      const parsed = DiscoverSource.safeParse(source);
      if (!parsed.success) continue;
      tasks.push(...await createScanner(parsed.data, workspacePath).scan());
    }
    return tasks;
  }

  private async runTask(
    loopId: string,
    workspacePath: string,
    task: Task,
    historyTasks: readonly CompletedTask[],
  ): Promise<{ completedTask: CompletedTask; decisions: string[] }> {
    const started = Date.now();
    const maxIterations = clampTaskIterations(this.options.maxIterations ?? 1, this.options.budget);
    const decisions: string[] = [];
    let finalRun: AgentRun | null = null;
    let finalVerdict: Verdict | null = null;
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
            summary: "Role separation failed: builder and evaluator resolved to the same agent.",
            issues: [{
              severity: "error",
              message: `builder ${finalRun.agent_id} cannot be its own final evaluator`,
              rule: "verify.role_separation",
            }],
          };
        } else {
          finalVerdict = await verifyRun(finalRun, {
          workspacePath: runWorkspacePath,
          commands: this.options.verifyCommands ?? [],
          verifierAgentIds,
          task: effectiveTask,
          ...(this.options.artifactVerification !== undefined
            ? { artifactVerification: this.options.artifactVerification }
            : {}),
          sessionId: loopId,
          ...(this.options.commandTimeoutMs !== undefined ? { timeoutMs: this.options.commandTimeoutMs } : {}),
          ...(this.options.outputLimit !== undefined ? { outputLimit: this.options.outputLimit } : {}),
          ...(this.options.adapters !== undefined ? { adapters: this.options.adapters } : {}),
          });
        }
        finalEvidence = await collectTaskGitEvidence(runWorkspacePath);
        const failedEvaluationIds = (finalVerdict.evaluations ?? [])
          .filter((evaluation) => !evaluation.pass)
          .map((evaluation) => evaluation.spec_id);
        this.emit(loopId, "loop.verify.done", {
          task_id: task.task_id,
          pass: finalVerdict.pass,
          score: finalVerdict.score,
          issue_count: finalVerdict.issues.length,
          ...(finalVerdict.evaluations !== undefined ? {
            evaluation_count: finalVerdict.evaluations.length,
            failed_evaluation_ids: failedEvaluationIds,
          } : {}),
          reviewer_agent_id: finalVerdict.reviewer_agent_id,
          summary: finalVerdict.summary,
          changed_files: finalEvidence.changedFiles,
          diff_summary: finalEvidence.diffSummary,
          ...(finalEvidence.commitHash !== undefined ? { commit_hash: finalEvidence.commitHash } : {}),
          ...(worktree !== undefined ? { worktree_path: worktree.worktreePath } : {}),
          iteration,
        });

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

      if (outcome === "success") {
        publishedAsset = await this.runPublishHook(loopId, task, decisions);
        lessonDraftPath = await this.runLessonDraftHook(loopId, workspacePath, task, decisions, {
          iterations,
          feedback: feedbackHistory,
          finalVerdict,
          changedFiles: finalEvidence.changedFiles,
          ...(finalEvidence.diffSummary !== undefined ? { diffSummary: finalEvidence.diffSummary } : {}),
          ...(finalEvidence.commitHash !== undefined ? { commitHash: finalEvidence.commitHash } : {}),
        });
      }

      if (worktree !== undefined && outcome === "success") {
        const commit = await commitWorktreeChanges(worktree, `osstack loop task ${task.task_id}`);
        if (commit.committed) {
          preserveWorktreeBranch = true;
          await mergeWorktree(worktree);
          worktreeCommit = commit.commit;
          preserveWorktreeBranch = false;
        }
        this.emit(loopId, "loop.worktree.merged", {
          task_id: task.task_id,
          worktree_path: worktree.worktreePath,
          branch: worktree.branch,
          committed: commit.committed,
          ...(commit.commit !== undefined ? { commit: commit.commit } : {}),
        });
        decisions.push(commit.committed
          ? `${task.task_id}: merged isolated worktree commit ${commit.commit}`
          : `${task.task_id}: isolated worktree had no git changes to merge`);
      }
    } finally {
      if (worktree !== undefined) {
        await cleanupWorktree(worktree, { removeBranch: !preserveWorktreeBranch });
        this.emit(loopId, "loop.worktree.cleaned", {
          task_id: task.task_id,
          worktree_path: worktree.worktreePath,
          branch: worktree.branch,
          branch_removed: !preserveWorktreeBranch,
        });
        decisions.push(`${task.task_id}: cleaned isolated worktree ${worktree.worktreePath}`);
      }
    }

    const completedTask = CompletedTask.parse({
        task_id: task.task_id,
        capability: task.capability,
        outcome,
        iterations,
        agent_id: finalRun?.agent_id ?? "local-noop",
        duration_ms: Date.now() - started,
        ...(finalRun !== null ? {
          run_id: finalRun.run_id,
          started_at: finalRun.started_at,
          completed_at: finalRun.completed_at,
          ...(finalRun.summary !== undefined ? { execution_summary: finalRun.summary } : {}),
          ...(finalRun.command_results.length > 0 ? { execution_commands: finalRun.command_results.map(commandAudit) } : {}),
        } : {}),
        ...(finalVerdict !== null ? {
          verifier_agent_id: finalVerdict.reviewer_agent_id,
          verify_summary: finalVerdict.summary,
          verify_issue_count: finalVerdict.issues.length,
          ...(finalVerdict.issues.length > 0 ? { verify_issues: finalVerdict.issues.map(issueAudit) } : {}),
          ...(finalVerdict.verify_commands !== undefined && finalVerdict.verify_commands.length > 0
            ? { verify_commands: finalVerdict.verify_commands }
            : {}),
          ...(finalVerdict.evaluations !== undefined && finalVerdict.evaluations.length > 0
            ? { evaluations: finalVerdict.evaluations }
            : {}),
        } : {}),
        ...(feedbackHistory.length > 0 ? { iteration_feedback: feedbackHistory } : {}),
        ...(lessonDraftPath !== undefined ? { lesson_draft_path: lessonDraftPath } : {}),
        ...(publishedAsset !== undefined ? { published_asset: publishedAsset } : {}),
        ...(taskUsage.reported ? {
          tokens_in: taskUsage.tokensIn,
          tokens_out: taskUsage.tokensOut,
          cost_usd: taskUsage.cost,
        } : {}),
        ...(finalEvidence.changedFiles.length > 0 ? { changed_files: finalEvidence.changedFiles } : {}),
        ...(finalEvidence.diffSummary !== undefined ? { diff_summary: finalEvidence.diffSummary } : {}),
        ...(finalEvidence.commitHash !== undefined ? { commit_hash: finalEvidence.commitHash } : {}),
        ...(outcome !== "success" ? { error_summary: completionErrorSummary(finalRun, finalVerdict) } : {}),
        ...(worktree !== undefined ? {
          worktree_path: worktree.worktreePath,
          worktree_branch: worktree.branch,
          worktree_branch_preserved: preserveWorktreeBranch,
          ...(worktreeCommit !== undefined ? { worktree_commit: worktreeCommit } : {}),
        } : {}),
      });

    return {
      completedTask: await this.applySelfImprovement(loopId, completedTask, decisions),
      decisions,
    };
  }

  /**
   * Post-verify publish finalizer: fires once a task's outcome is finalized as "success".
   * Non-gating — never reopens or fails the task. v1 记录不拦截: onFailure only affects the
   * decision wording (a NEEDS-ATTENTION marker), it does not reopen the task for re-iteration.
   */
  private async runPublishHook(loopId: string, task: Task, decisions: string[]): Promise<PublishedAssetEvidence | undefined> {
    const publishCfg = this.options.publish;
    if (publishCfg?.enabled !== true || !isSkillTask(task)) return undefined;

    const skillId = skillIdOf(task);
    if (skillId === undefined) {
      decisions.push(`${task.task_id}: publish skipped: no skillId`);
      this.emit(loopId, "loop.skill.publish_blocked", {
        task_id: task.task_id,
        status: "error",
        reasons: ["no_skill_id"],
      });
      return undefined;
    }

    const deps = this.options.publishDeps ?? { runCommand: runCommandReal };
    const result = await runPublish(skillId, publishCfg, deps);
    // Durable, auditable release evidence — release identity only on success.
    const evidence = toPublishedAssetEvidence(result, publishCfg.gate);

    if (result.status === "published") {
      this.emit(loopId, "loop.skill.published", {
        task_id: task.task_id,
        skill_id: skillId,
        score: result.score ?? null,
        gate: evidence.gate, // normalized enum — never the raw Hub-controlled gate string
        apiVerified: result.apiVerified ?? false,
      });
      // Record immutable release identity as a distinct, additive event.
      this.emit(loopId, "loop.skill.release_recorded", {
        task_id: task.task_id,
        skill_id: skillId,
        status: evidence.status,
        gate: evidence.gate,
        ...(evidence.release_id !== undefined ? { release_id: evidence.release_id } : {}),
        ...(evidence.digest !== undefined ? { digest: evidence.digest } : {}),
        ...(evidence.namespace !== undefined ? { namespace: evidence.namespace } : {}),
        ...(evidence.storage_key !== undefined ? { storage_key: evidence.storage_key } : {}),
      });
      decisions.push(
        `${task.task_id}: published ${skillId} to hub (release ${evidence.release_id ?? "unknown"}, digest ${evidence.digest ?? "unknown"}, gate ${evidence.gate})`,
      );
      return evidence;
    }

    this.emit(loopId, "loop.skill.publish_blocked", {
      task_id: task.task_id,
      skill_id: skillId,
      status: result.status,
      reasons: evidence.reasons, // REDACTED — never the raw Hub reasons (leaks to events.jsonl)
    });
    const marker = publishCfg.onFailure === "block" ? " [NEEDS-ATTENTION]" : "";
    decisions.push(
      // use the REDACTED evidence.reasons — never the raw Hub-controlled reasons.
      `${task.task_id}: publish ${result.status} for ${skillId} (reasons: ${evidence.reasons.join(", ") || "none"})${marker}`,
    );
    return evidence; // status blocked/error, no release identity
  }

  /**
   * Self-improvement hook (opt-in). When enabled, hands the finalized
   * CompletedTask to an injected `assetize` callback that turns it into a
   * RunTrace -> FeedbackAsset[] -> optional ImprovementProposal[], then folds
   * the returned ids/summary/level back onto the CompletedTask. The loop stays
   * free of any @osstack/supervisor or SQLite dependency — all of that lives in
   * the caller-provided callback. This never fails a task: any error is swallowed
   * and the original CompletedTask is returned unchanged.
   */
  private async applySelfImprovement(
    loopId: string,
    completedTask: CompletedTask,
    decisions: string[],
  ): Promise<CompletedTask> {
    const cfg = this.options.selfImprovement;
    if (cfg?.enabled !== true || cfg.assetize === undefined) return completedTask;

    try {
      const result = await cfg.assetize({
        repoId: cfg.repoId,
        completedTask,
        loopId,
        proposeImprovements: cfg.proposeImprovements ?? false,
      });
      if (result === undefined) return completedTask;

      const enriched = CompletedTask.parse({
        ...completedTask,
        trace_id: result.trace_id,
        ...(result.feedback_asset_ids.length > 0 ? { feedback_asset_ids: result.feedback_asset_ids } : {}),
        ...(result.proposal_ids.length > 0 ? { proposal_ids: result.proposal_ids } : {}),
        assetization_summary: result.assetization_summary,
        self_improvement_level: result.self_improvement_level,
      });
      this.emit(loopId, "loop.self_improvement.done", {
        task_id: completedTask.task_id,
        trace_id: result.trace_id,
        feedback_asset_count: result.feedback_asset_ids.length,
        proposal_count: result.proposal_ids.length,
        self_improvement_level: result.self_improvement_level,
      });
      decisions.push(
        `${completedTask.task_id}: self-improvement L${result.self_improvement_level} — ${result.feedback_asset_ids.length} asset(s), ${result.proposal_ids.length} proposal(s)`,
      );
      return enriched;
    } catch (err) {
      // Self-improvement is advisory: never let it fail a completed task.
      this.emit(loopId, "loop.self_improvement.failed", {
        task_id: completedTask.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return completedTask;
    }
  }

  /**
   * SOP flywheel hook: after a success that recovered from failed attempts,
   * write a reviewable lesson draft into the main workspace. Never gates the
   * task and never mutates official skill files.
   */
  private async runLessonDraftHook(
    loopId: string,
    workspacePath: string,
    task: Task,
    decisions: string[],
    input: {
      iterations: number;
      feedback: IterationFeedback[];
      finalVerdict: Verdict | null;
      changedFiles: string[];
      diffSummary?: string;
      commitHash?: string;
    },
  ): Promise<string | undefined> {
    if (input.feedback.length === 0) return undefined;
    try {
      const result = await writeLessonDraft({
        task,
        iterations: input.iterations,
        feedback: input.feedback,
        finalVerdict: input.finalVerdict,
        changedFiles: input.changedFiles,
        ...(input.diffSummary !== undefined ? { diffSummary: input.diffSummary } : {}),
        ...(input.commitHash !== undefined ? { commitHash: input.commitHash } : {}),
      }, {
        workspacePath,
        ...(this.options.lessonDrafts !== undefined ? { config: this.options.lessonDrafts } : {}),
      });
      if (!result.written || result.path === undefined) return undefined;
      this.emit(loopId, "loop.lesson.drafted", {
        task_id: task.task_id,
        path: result.path,
        failed_attempts: input.feedback.length,
      });
      decisions.push(`${task.task_id}: lesson draft written to ${result.path}`);
      return result.path;
    } catch (error) {
      decisions.push(`${task.task_id}: lesson draft failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async checkGoal(loopId: string, workspacePath: string): Promise<LoopGoalResult | undefined> {
    const command = this.options.goalCommand;
    if (command === undefined || command.trim() === "") return undefined;

    const result = await runShellCommand(command, {
      cwd: workspacePath,
      timeoutMs: this.options.commandTimeoutMs ?? 120_000,
      outputLimit: this.options.outputLimit ?? 16_000,
    });
    const goal: LoopGoalResult = {
      command,
      pass: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      summary: summarizeGoalResult(result.exitCode, result.stdout, result.stderr),
    };
    this.emit(loopId, "loop.goal.checked", {
      command,
      pass: goal.pass,
      exit_code: goal.exitCode,
      duration_ms: goal.durationMs,
      summary: goal.summary,
    });
    return goal;
  }

  private async cleanupLoopWorktrees(
    loopId: string,
    workspacePath: string,
    cycle: number,
    phase: "before_cycle" | "after_cycle",
    decisions: string[],
  ): Promise<void> {
    if (this.options.useWorktree !== true) return;
    const result = await cleanupOrphanedWorktrees(workspacePath, {
      branchPrefix: loopWorktreeBranchPrefix(loopId),
      ...(this.options.worktreeRoot !== undefined ? { rootPath: this.options.worktreeRoot } : {}),
    });
    if (result.removed.length === 0) return;
    this.emit(loopId, "loop.worktree.orphans_cleaned", {
      cycle,
      phase,
      removed_count: result.removed.length,
      branches: result.removed.map((worktree) => worktree.branch),
    });
    decisions.push(`worktree cleanup: removed ${result.removed.length} orphaned worktree(s) ${phase}`);
  }

  private emit(loopId: string, type: LoopEvent["type"], payload?: Record<string, unknown>): void {
    this.events.push({
      event_id: `evt_${randomUUID()}`,
      loop_id: loopId,
      type,
      seq: ++this.seq,
      created_at: Date.now(),
      ...(payload !== undefined ? { payload } : {}),
    });
  }
}

interface AgentSelection {
  agentId: string;
  reason: string;
  policyDecision?: PolicyDecision;
}

/**
 * A cycle counts against the no-progress budget only when it executed tasks
 * and none succeeded. Idle cycles (nothing executed) leave the streak
 * unchanged — stop-when-idle and cycle caps govern those.
 */
function nextNoProgressCycles(current: number, result: LoopRunResult): number {
  if (result.executedTaskCount === 0) return current;
  const madeProgress = result.completedTasks.some((task) => task.outcome === "success");
  return madeProgress ? 0 : current + 1;
}

interface TaskGitEvidence {
  changedFiles: string[];
  diffSummary?: string;
  commitHash?: string;
}

async function collectTaskGitEvidence(workspacePath: string): Promise<TaskGitEvidence> {
  const status = await runShellCommand("git status --short --untracked-files=all", {
    cwd: workspacePath,
    timeoutMs: 10_000,
    outputLimit: 32_000,
  });
  if (status.exitCode !== 0) {
    return { changedFiles: [], diffSummary: `git status unavailable: ${singleLine(status.stderr || status.stdout)}` };
  }

  const changedFiles = parseGitStatusFiles(status.stdout);
  const diffStat = await runShellCommand("git diff --stat -- .", {
    cwd: workspacePath,
    timeoutMs: 10_000,
    outputLimit: 4_000,
  });
  const untrackedCount = changedFiles.filter((file) => file.startsWith("?? ")).length;
  const statSummary = diffStat.exitCode === 0 && diffStat.stdout.trim() !== ""
    ? singleLine(diffStat.stdout)
    : changedFiles.length === 0
      ? "no git changes"
      : `${changedFiles.length} changed file(s), ${untrackedCount} untracked`;
  const commit = await runShellCommand("git rev-parse --short HEAD", {
    cwd: workspacePath,
    timeoutMs: 10_000,
    outputLimit: 1_000,
  });
  return {
    changedFiles,
    diffSummary: statSummary,
    ...(commit.exitCode === 0 && commit.stdout.trim() !== "" ? { commitHash: commit.stdout.trim() } : {}),
  };
}

function parseGitStatusFiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const path = line.length > 3 ? line.slice(3) : line.trim();
      return line.startsWith("?? ") ? `?? ${path}` : path;
    });
}

async function availablePolicyCandidates(
  adapters: readonly AgentAdapter[],
  kind: string,
): Promise<PolicyCandidate[]> {
  const candidates: PolicyCandidate[] = [];
  for (const adapter of adapters) {
    const capabilities = adapter.capabilities();
    if (!capabilities.some((capability) => capability.kind === kind)) continue;
    try {
      const availability = await adapter.isAvailable();
      if (!availability.available) continue;
    } catch {
      continue;
    }
    candidates.push({
      agent_id: adapter.id,
      cost_tier: adapter.cost_tier,
      capabilities,
    });
  }
  return candidates;
}

function completedTaskHistory(tasks: readonly CompletedTask[]): PolicyHistory {
  return {
    totalRuns(agentId, kind) {
      return tasks.filter((task) => task.agent_id === agentId && taskMatchesKind(task, kind)).length;
    },
    completedRuns(agentId, kind) {
      return tasks.filter((task) =>
        task.agent_id === agentId && task.outcome === "success" && taskMatchesKind(task, kind)
      ).length;
    },
    recentFailures(agentId, kind) {
      return tasks.filter((task) =>
        task.agent_id === agentId && task.outcome !== "success" && taskMatchesKind(task, kind)
      ).length;
    },
    avgDurationMs(agentId, kind) {
      const matching = tasks.filter((task) =>
        task.agent_id === agentId && task.outcome === "success" && taskMatchesKind(task, kind)
      );
      if (matching.length === 0) return null;
      return Math.round(matching.reduce((sum, task) => sum + task.duration_ms, 0) / matching.length);
    },
  };
}

function taskMatchesKind(task: CompletedTask, kind: string): boolean {
  return task.capability === kind || task.capability?.endsWith(`.${kind}`) === true;
}

function policyEventPayload(decision: PolicyDecision): Record<string, unknown> {
  return {
    winner_agent_id: decision.winner?.candidate.agent_id,
    winner_total: decision.winner?.total,
    handoff: decision.handoff,
    ranked: decision.ranked.map((item) => ({
      agent_id: item.candidate.agent_id,
      total: item.total,
      breakdown: item.breakdown,
    })),
  };
}

function resolvePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

/**
 * Normalize a policy-gate deny reason into a `loop.stopped` reason carrying
 * exactly one `policy_denied:` marker. The CLI observe-mode reason already
 * begins with the marker (kept byte-identical for the R1.3 stderr contract), so
 * it passes through unchanged; a fail-closed reason (e.g. a loader error) gets
 * the marker prefixed so every policy stop is greppable as `policy_denied`.
 */
function policyStopReason(reason: string): string {
  return reason.startsWith("policy_denied") ? reason : `policy_denied: ${reason}`;
}

function commandAudit(result: CommandResult): NonNullable<CompletedTask["execution_commands"]>[number] {
  const summary = singleLine(result.stderr.trim() || result.stdout.trim());
  return {
    command: result.command,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    ...(summary !== "" ? { summary } : {}),
  };
}

function issueAudit(issue: Issue): NonNullable<CompletedTask["verify_issues"]>[number] {
  return {
    severity: issue.severity,
    message: issue.message,
    ...(issue.file !== undefined ? { file: issue.file } : {}),
    ...(issue.line !== undefined ? { line: issue.line } : {}),
    ...(issue.rule !== undefined ? { rule: issue.rule } : {}),
  };
}

function completionErrorSummary(run: AgentRun | null, verdict: Verdict | null): string {
  const firstIssue = verdict?.issues[0];
  if (firstIssue !== undefined) return singleLine(firstIssue.message);
  if (run?.summary !== undefined) return singleLine(run.summary);
  if (run !== null && run.outcome !== "completed") return `execution ${run.outcome}`;
  return "task did not reach a passing verdict";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " " ).trim().slice(0, 240);
}

function summarizeGoalResult(exitCode: number, stdout: string, stderr: string): string {
  const output = (stderr.trim() || stdout.trim()).replace(/\s+/g, " ").slice(0, 240);
  if (exitCode === 0) return output === "" ? "goal command exited 0" : output;
  return output === "" ? `goal command exited ${exitCode}` : output;
}

function loopWorktreeBranchPrefix(loopId: string): string {
  return `osstack/loop/${sanitizeBranchPart(loopId)}`;
}

function sanitizeBranchPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized === "" ? "loop" : sanitized.slice(0, 48);
}
