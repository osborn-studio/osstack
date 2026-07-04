import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LoopState, type CompletedTask, type DeferredTask, type Task } from "./types.js";

export interface LoopStateFilePaths {
  jsonPath: string;
  markdownPath: string;
}

export interface WriteLoopStateOptions {
  /** Defaults to STATE.md beside the JSON file. */
  markdownPath?: string;
}

export function createInitialLoopState(loopId: string, now = new Date()): LoopState {
  const timestamp = now.toISOString();
  return LoopState.parse({
    loop_id: loopId,
    started_at: timestamp,
    updated_at: timestamp,
    completed_tasks: [],
    pending: [],
    in_progress: [],
    decisions: [],
  });
}

export async function readLoopState(jsonPath: string): Promise<LoopState | null> {
  try {
    const raw = await readFile(jsonPath, "utf-8");
    return LoopState.parse(JSON.parse(raw));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeLoopState(
  jsonPath: string,
  state: LoopState,
  options: WriteLoopStateOptions = {},
): Promise<LoopStateFilePaths> {
  const parsed = LoopState.parse({
    ...state,
    updated_at: state.updated_at,
  });
  const markdownPath = options.markdownPath ?? join(dirname(jsonPath), "STATE.md");

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });

  await writeFileAtomic(jsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await writeFileAtomic(markdownPath, renderLoopStateMarkdown(parsed));

  return { jsonPath, markdownPath };
}

export function renderLoopStateMarkdown(state: LoopState): string {
  const lines: string[] = [
    `# Loop State - ${state.updated_at}`,
    "",
    "## In Progress",
    ...renderTasks(state.in_progress ?? [], false),
    "",
    "## Completed",
    ...renderCompletedTasks(state.completed_tasks),
    "",
    "## Pending",
    ...renderTasks(state.pending ?? [], true),
  ];

  if (state.budget_status !== undefined) {
    const status = state.budget_status;
    lines.push(
      "",
      "## Budget",
      `- Status: ${status.exceeded ? `exceeded (${status.limit ?? "unknown limit"})` : "within limits"}`,
      ...(status.reason !== undefined ? [`- Reason: ${status.reason}`] : []),
      `- Usage: ${status.usage.cycles} cycle(s), ${status.usage.runtime_ms} ms, ${status.usage.tokens} tokens, $${status.usage.estimated_cost_usd.toFixed(4)}, ${status.usage.no_progress_cycles} no-progress cycle(s)`,
    );
  }

  const deferred = state.deferred_tasks ?? [];
  if (deferred.length > 0) {
    lines.push(
      "",
      "## Needs Approval",
      ...renderDeferredTasks(deferred.filter((entry) => entry.authorization === "needs_approval")),
      "",
      "## Suggested",
      ...renderDeferredTasks(deferred.filter((entry) => entry.authorization === "suggest_only")),
      "",
      "## Blocked",
      ...renderDeferredTasks(deferred.filter((entry) => entry.authorization === "blocked")),
    );
  }

  if (state.key_metrics) {
    lines.push(
      "",
      "## Key Metrics",
      `- Total cycles: ${state.key_metrics.total_cycles}`,
      `- Average duration: ${state.key_metrics.avg_duration_ms} ms`,
      `- Success rate: ${Math.round(state.key_metrics.success_rate * 100)}%`,
      `- Tokens consumed: ${state.key_metrics.tokens_consumed}`,
    );
  }

  if (state.knowledge !== undefined) {
    lines.push("", "## Knowledge Trace", ...renderKnowledgeTrace(state.knowledge));
  }

  if (state.decisions && state.decisions.length > 0) {
    lines.push("", "## Decisions", ...state.decisions.map((decision) => `- ${decision}`));
  }

  return `${lines.join("\n")}\n`;
}

function renderDeferredTasks(entries: DeferredTask[]): string[] {
  if (entries.length === 0) return ["- None"];
  return entries.map((entry) => (
    `- [ ] ${entry.task.task_id}: ${entry.task.prompt} (${entry.task.capability}, ${entry.task.source}, priority ${entry.task.priority}) - ${entry.reason}`
  ));
}

function renderTasks(tasks: Task[], includePriority: boolean): string[] {
  if (tasks.length === 0) return ["- None"];

  return tasks.map((task) => {
    const priority = includePriority ? `, priority ${task.priority}` : "";
    return `- [ ] ${task.prompt} (${task.capability}${priority})`;
  });
}

function renderCompletedTasks(tasks: CompletedTask[]): string[] {
  if (tasks.length === 0) return ["- None"];

  return tasks.flatMap((task) => {
    const capability = task.capability === undefined ? "" : `, ${task.capability}`;
    const lines = [
      `- [x] ${task.task_id} - ${task.outcome} via ${task.agent_id} (${task.iterations} iteration${task.iterations === 1 ? "" : "s"}, ${task.duration_ms} ms${capability})`,
    ];
    if (task.run_id !== undefined) lines.push(`  - Run: ${task.run_id}`);
    if (task.verify_summary !== undefined) {
      lines.push(`  - Verification: ${task.verify_summary} (${task.verify_issue_count ?? 0} issue${task.verify_issue_count === 1 ? "" : "s"})`);
    }
    const failedEvaluations = (task.evaluations ?? []).filter((evaluation) => !evaluation.pass);
    if (failedEvaluations.length > 0) {
      lines.push(`  - Failed evaluations: ${failedEvaluations.map((evaluation) => `${evaluation.spec_id} (${evaluation.summary})`).join("; ")}`);
    }
    for (const feedback of task.iteration_feedback ?? []) {
      const failed = feedback.failed_evaluations.length > 0
        ? `, failed evaluations: ${feedback.failed_evaluations.join(", ")}`
        : "";
      lines.push(`  - Feedback (attempt ${feedback.attempt}): ${feedback.verdict_summary} (${feedback.blocking_issues.length} blocking issue${feedback.blocking_issues.length === 1 ? "" : "s"}${failed})`);
    }
    if (task.execution_commands !== undefined && task.execution_commands.length > 0) {
      lines.push(`  - Commands: ${task.execution_commands.map((command) => `${command.command} -> ${command.exit_code}`).join(", ")}`);
    }
    if (task.verify_commands !== undefined && task.verify_commands.length > 0) {
      lines.push(`  - Verify commands: ${task.verify_commands.map((command) => `${command.command} -> ${command.exit_code}`).join(", ")}`);
    }
    if (task.changed_files !== undefined && task.changed_files.length > 0) {
      lines.push(`  - Changed files: ${task.changed_files.join(", ")}`);
    }
    if (task.diff_summary !== undefined) lines.push(`  - Diff: ${task.diff_summary}`);
    if (task.commit_hash !== undefined) lines.push(`  - Commit: ${task.commit_hash}`);
    if (task.error_summary !== undefined) lines.push(`  - Error: ${task.error_summary}`);
    if (task.worktree_branch !== undefined) {
      const commit = task.worktree_commit === undefined ? "" : `, commit ${task.worktree_commit}`;
      lines.push(`  - Worktree: ${task.worktree_branch}${commit}`);
    }
    if (task.lesson_draft_path !== undefined) {
      lines.push(`  - Lesson draft: ${task.lesson_draft_path}`);
    }
    return lines;
  });
}

function renderKnowledgeTrace(knowledge: LoopState["knowledge"]): string[] {
  if (knowledge === undefined) return ["- Mode: off"];
  const lines = [
    `- Mode: ${knowledge.mode}`,
    `- Status: ${knowledge.status}`,
  ];
  if (knowledge.query !== undefined) lines.push(`- Query: ${knowledge.query}`);
  if (knowledge.reason !== undefined) lines.push(`- Reason: ${knowledge.reason}`);
  if (knowledge.packs.length > 0) {
    lines.push(...knowledge.packs.map((pack) => (
      `- Pack: ${pack.id}@${pack.version} (${pack.source_kind}, quality ${pack.quality_score})`
    )));
  }
  if (knowledge.results.length > 0) {
    lines.push(...knowledge.results.map((result) => (
      `- Chunk: ${result.chunk_id} (${result.pack_id}@${result.pack_version}, score ${result.score}${result.matched_terms.length === 0 ? "" : `, matched_terms=${result.matched_terms.join(",")}`}) - ${result.title}`
    )));
  }
  return lines;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, targetPath);
}
