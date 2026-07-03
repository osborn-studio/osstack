import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
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
import { createScanner } from "./discover.js";
import { executePlan, runShellCommand, type AgentRun, type CommandResult } from "./executor.js";
import { evaluateIteration } from "./iterator.js";
import { planTask } from "./planner.js";
import {
  createInitialLoopState,
  readLoopState,
  renderLoopStateMarkdown,
  writeLoopState,
} from "./state-file.js";
import { archiveCompletedTaskFile } from "./task-queue.js";
import { isSkillTask, runCommandReal, runPublish, skillIdOf, type PublishConfig, type RunPublishDeps } from "./publisher.js";
import { verifyRun } from "./verifier.js";
import type { ArtifactVerificationOptions } from "./verifier.js";
import {
  DiscoverSource,
  LoopState,
  CompletedTask,
  type Issue,
  type LoopEvent,
  type LoopKnowledgeTrace,
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
  adapters?: readonly AgentAdapter[];
  policyEngine?: PolicyEngine;
  policyHistory?: PolicyHistory;
  knowledge?: LoopKnowledgeTrace;
  /** Post-verify skill auto-publish finalizer config (opt-in, non-gating). */
  publish?: PublishConfig;
  /** Injectable publish side-effects, for tests. Defaults to the real command runner. */
  publishDeps?: RunPublishDeps;
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
    const results: LoopRunResult[] = [];

    for (let cycle = 1; cycle <= cycles; cycle++) {
      const result = await this.runCycle(cycle, {
        emitStarted: cycle === 1,
        emitStopped: false,
      });
      results.push(result);
      if (result.goal?.pass === true) break;
      if (options.stopWhenIdle === true && result.executedTaskCount === 0) break;
      if (cycle < cycles && intervalMs > 0) await sleep(intervalMs);
    }

    const last = results.at(-1);
    if (last === undefined) {
      throw new Error("runCycles requires at least one cycle");
    }
    this.emit(last.loop_id, "loop.stopped", {
      reason: last.goal?.pass === true ? "goal command passed" : "manual run completed",
      cycles: results.length,
    });

    return {
      loop_id: last.loop_id,
      cycles: results,
      state: last.state,
      events: [...this.events],
      jsonPath: last.jsonPath,
      markdownPath: last.markdownPath,
    };
  }

  async runOnce(): Promise<LoopRunResult> {
    return await this.runCycle(1, { emitStarted: true, emitStopped: true });
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
    const tasks = this.options.skipCompletedTasks === false
      ? discoveredTasks
      : discoveredTasks.filter((task) => !completedIds.has(task.task_id));
    const skippedTaskCount = discoveredTasks.length - tasks.length;
    this.emit(loopId, "loop.discover.done", {
      task_count: tasks.length,
      discovered_task_count: discoveredTasks.length,
      skipped_task_count: skippedTaskCount,
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
      key_metrics: {
        total_cycles: (state.key_metrics?.total_cycles ?? 0) + 1,
        avg_duration_ms: completed.length === 0
          ? 0
          : Math.round(completed.reduce((sum, task) => sum + task.duration_ms, 0) / completed.length),
        success_rate: completed.length === 0 ? 1 : successCount / completed.length,
        tokens_consumed: state.key_metrics?.tokens_consumed ?? 0,
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
    const maxIterations = this.options.maxIterations ?? 1;
    const decisions: string[] = [];
    let finalRun: AgentRun | null = null;
    let finalVerdict: Verdict | null = null;
    let outcome: CompletedTask["outcome"] = "failed";
    let iterations = 0;
    let runWorkspacePath = workspacePath;
    let worktree: WorktreeHandle | undefined;
    let preserveWorktreeBranch = false;
    let worktreeCommit: string | undefined;
    let finalEvidence: TaskGitEvidence = { changedFiles: [], diffSummary: "no git evidence collected" };

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
        const agentSelection = await this.selectExecutionAgent(task, historyTasks);
        const plan = planTask(task, {
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
        this.emit(loopId, "loop.execute.done", {
          task_id: task.task_id,
          run_id: finalRun.run_id,
          outcome: finalRun.outcome,
          agent_id: finalRun.agent_id,
          ...(finalRun.adapter_event_count !== undefined ? { adapter_event_count: finalRun.adapter_event_count } : {}),
          ...(finalRun.summary !== undefined ? { summary: finalRun.summary } : {}),
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
          task,
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
        this.emit(loopId, "loop.verify.done", {
          task_id: task.task_id,
          pass: finalVerdict.pass,
          score: finalVerdict.score,
          issue_count: finalVerdict.issues.length,
          reviewer_agent_id: finalVerdict.reviewer_agent_id,
          summary: finalVerdict.summary,
          changed_files: finalEvidence.changedFiles,
          diff_summary: finalEvidence.diffSummary,
          ...(finalEvidence.commitHash !== undefined ? { commit_hash: finalEvidence.commitHash } : {}),
          ...(worktree !== undefined ? { worktree_path: worktree.worktreePath } : {}),
          iteration,
        });

        const decision = evaluateIteration({
          verdict: finalVerdict,
          iteration,
          maxIterations,
        });
        this.emit(loopId, "loop.iterate.done", {
          task_id: task.task_id,
          action: decision.action,
          reason: decision.reason,
          iteration,
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
        await this.runPublishHook(loopId, task, decisions);
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

    return {
      completedTask: CompletedTask.parse({
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
      }),
      decisions,
    };
  }

  /**
   * Post-verify publish finalizer: fires once a task's outcome is finalized as "success".
   * Non-gating — never reopens or fails the task. v1 记录不拦截: onFailure only affects the
   * decision wording (a NEEDS-ATTENTION marker), it does not reopen the task for re-iteration.
   */
  private async runPublishHook(loopId: string, task: Task, decisions: string[]): Promise<void> {
    const publishCfg = this.options.publish;
    if (publishCfg?.enabled !== true || !isSkillTask(task)) return;

    const skillId = skillIdOf(task);
    if (skillId === undefined) {
      decisions.push(`${task.task_id}: publish skipped: no skillId`);
      this.emit(loopId, "loop.skill.publish_blocked", {
        task_id: task.task_id,
        status: "error",
        reasons: ["no_skill_id"],
      });
      return;
    }

    const deps = this.options.publishDeps ?? { runCommand: runCommandReal };
    const result = await runPublish(skillId, publishCfg, deps);

    if (result.status === "published") {
      this.emit(loopId, "loop.skill.published", {
        task_id: task.task_id,
        skill_id: skillId,
        score: result.score ?? null,
        gate: result.gate ?? publishCfg.gate,
        apiVerified: result.apiVerified ?? false,
      });
      decisions.push(
        `${task.task_id}: published ${skillId} to hub (score ${result.score ?? "n/a"}, gate ${result.gate ?? publishCfg.gate}, apiVerified ${result.apiVerified ?? false})`,
      );
      return;
    }

    this.emit(loopId, "loop.skill.publish_blocked", {
      task_id: task.task_id,
      skill_id: skillId,
      status: result.status,
      reasons: result.reasons ?? [],
    });
    const marker = publishCfg.onFailure === "block" ? " [NEEDS-ATTENTION]" : "";
    decisions.push(
      `${task.task_id}: publish ${result.status} for ${skillId} (reasons: ${(result.reasons ?? []).join(", ") || "none"})${marker}`,
    );
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
