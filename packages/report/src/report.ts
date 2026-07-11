// Run report — normalizes a loop/run's durable state into a structured,
// human-readable report. Pure: builders take data in, renderers return
// strings out. File I/O lives in the CLI, never here.
//
// Today the only input is a LoopState (LOOP-STATE.json). The RunReport model
// is deliberately decoupled from it so a daemon-events builder can be added
// later without changing renderers or downstream proof/scorecard code.

import type { CompletedTask, LoopState } from "@osstack/loop";

/** Conformance level a run reached (see docs/specs/OSSTACK_RUN_SPEC_V1.md). */
export type ConformanceLevel = "L1" | "L2" | "L3" | "L4";

export interface ReportCommand {
  command: string;
  exit_code: number;
  duration_ms: number;
  summary?: string;
}

export interface ReportIssue {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
  rule?: string;
}

export interface ReportWorktree {
  path?: string;
  branch?: string;
  commit?: string;
  branch_preserved?: boolean;
}

export interface ReportTask {
  task_id: string;
  capability?: string;
  outcome: "success" | "failed" | "escalated";
  iterations: number;
  agent_id: string;
  duration_ms: number;
  run_id?: string;
  execution_summary?: string;
  commands: ReportCommand[];
  verifier_agent_id?: string;
  verify_summary?: string;
  verify_issue_count?: number;
  verify_issues: ReportIssue[];
  error_summary?: string;
  worktree?: ReportWorktree;
}

export interface ReportTotals {
  tasks: number;
  success: number;
  failed: number;
  escalated: number;
  cycles: number;
  tokens: number;
  success_rate: number;
}

export interface RunReport {
  schema: "osstack.run-report/v1";
  generated_at: string;
  loop_id: string;
  started_at: string;
  updated_at: string;
  workspace?: string;
  conformance_level: ConformanceLevel;
  totals: ReportTotals;
  agents_used: string[];
  decisions: string[];
  tasks: ReportTask[];
  risks: string[];
  next_steps: string[];
}

export interface BuildReportOptions {
  /** Absolute path of the workspace this run operated on. */
  workspace?: string;
  /** Stamp the generated_at field (injected for deterministic tests). */
  now?: Date;
}

function mapTask(t: CompletedTask): ReportTask {
  const task: ReportTask = {
    task_id: t.task_id,
    outcome: t.outcome,
    iterations: t.iterations,
    agent_id: t.agent_id,
    duration_ms: t.duration_ms,
    commands: (t.execution_commands ?? []).map((c) => ({
      command: c.command,
      exit_code: c.exit_code,
      duration_ms: c.duration_ms,
      ...(c.summary !== undefined ? { summary: c.summary } : {}),
    })),
    verify_issues: (t.verify_issues ?? []).map((i) => ({
      severity: i.severity,
      message: i.message,
      ...(i.file !== undefined ? { file: i.file } : {}),
      ...(i.line !== undefined ? { line: i.line } : {}),
      ...(i.rule !== undefined ? { rule: i.rule } : {}),
    })),
  };
  if (t.capability !== undefined) task.capability = t.capability;
  if (t.run_id !== undefined) task.run_id = t.run_id;
  if (t.execution_summary !== undefined) task.execution_summary = t.execution_summary;
  if (t.verifier_agent_id !== undefined) task.verifier_agent_id = t.verifier_agent_id;
  if (t.verify_summary !== undefined) task.verify_summary = t.verify_summary;
  if (t.verify_issue_count !== undefined) task.verify_issue_count = t.verify_issue_count;
  if (t.error_summary !== undefined) task.error_summary = t.error_summary;
  const wt: ReportWorktree = {};
  if (t.worktree_path !== undefined) wt.path = t.worktree_path;
  if (t.worktree_branch !== undefined) wt.branch = t.worktree_branch;
  if (t.worktree_commit !== undefined) wt.commit = t.worktree_commit;
  if (t.worktree_branch_preserved !== undefined) wt.branch_preserved = t.worktree_branch_preserved;
  if (Object.keys(wt).length > 0) task.worktree = wt;
  return task;
}

/**
 * Highest conformance level the data supports:
 *   L1 always (we have a run record)
 *   L2 if any task ran a verifier/verify gate
 *   L3 if any task ran a reviewer/checker agent
 *   L4 only when a proof pack is assembled (opts.proofed), set by the proof layer
 */
export function conformanceLevel(tasks: ReportTask[], opts: { proofed?: boolean } = {}): ConformanceLevel {
  if (opts.proofed) return "L4";
  const reviewed = tasks.some((t) => t.verifier_agent_id !== undefined);
  if (reviewed) return "L3";
  const verified = tasks.some(
    (t) => t.verify_summary !== undefined || t.verify_issue_count !== undefined || t.verify_issues.length > 0,
  );
  if (verified) return "L2";
  return "L1";
}

function deriveRisks(tasks: ReportTask[]): string[] {
  const risks: string[] = [];
  for (const t of tasks) {
    if (t.outcome === "failed") {
      risks.push(`Task \`${t.task_id}\` failed${t.error_summary ? `: ${t.error_summary}` : ""}.`);
    } else if (t.outcome === "escalated") {
      risks.push(`Task \`${t.task_id}\` was escalated and needs human attention.`);
    }
    if (t.worktree?.branch_preserved && t.worktree.branch) {
      risks.push(`Unmerged worktree branch \`${t.worktree.branch}\` was preserved for review.`);
    }
    const errs = t.verify_issues.filter((i) => i.severity === "error").length;
    if (errs > 0) risks.push(`Task \`${t.task_id}\` has ${errs} unresolved error-level verify issue(s).`);
  }
  return risks;
}

function deriveNextSteps(tasks: ReportTask[]): string[] {
  const steps: string[] = [];
  const failed = tasks.filter((t) => t.outcome === "failed");
  const escalated = tasks.filter((t) => t.outcome === "escalated");
  if (failed.length > 0) {
    steps.push(`Re-run or inspect ${failed.length} failed task(s): ${failed.map((t) => `\`${t.task_id}\``).join(", ")}.`);
  }
  if (escalated.length > 0) {
    steps.push(`Review ${escalated.length} escalated task(s) manually.`);
  }
  const preserved = tasks.filter((t) => t.worktree?.branch_preserved && t.worktree.branch);
  if (preserved.length > 0) {
    steps.push(`Inspect preserved branches: ${preserved.map((t) => `\`${t.worktree!.branch}\``).join(", ")}.`);
  }
  if (steps.length === 0 && tasks.length > 0) steps.push("All tasks completed successfully — ready to ship.");
  return steps;
}

/** Build a normalized RunReport from a LoopState. Never throws on partial data. */
export function buildRunReport(state: LoopState, opts: BuildReportOptions = {}): RunReport {
  const now = opts.now ?? new Date();
  const tasks = state.completed_tasks.map(mapTask);
  const success = tasks.filter((t) => t.outcome === "success").length;
  const failed = tasks.filter((t) => t.outcome === "failed").length;
  const escalated = tasks.filter((t) => t.outcome === "escalated").length;
  const agents = Array.from(new Set(tasks.map((t) => t.agent_id))).sort();
  const totals: ReportTotals = {
    tasks: tasks.length,
    success,
    failed,
    escalated,
    cycles: state.key_metrics?.total_cycles ?? 0,
    tokens: state.key_metrics?.tokens_consumed ?? 0,
    success_rate: tasks.length > 0 ? success / tasks.length : 0,
  };
  const report: RunReport = {
    schema: "osstack.run-report/v1",
    generated_at: now.toISOString(),
    loop_id: state.loop_id,
    started_at: state.started_at,
    updated_at: state.updated_at,
    conformance_level: conformanceLevel(tasks),
    totals,
    agents_used: agents,
    decisions: state.decisions ?? [],
    tasks,
    risks: deriveRisks(tasks),
    next_steps: deriveNextSteps(tasks),
  };
  if (opts.workspace !== undefined) report.workspace = opts.workspace;
  return report;
}

const OUTCOME_BADGE: Record<ReportTask["outcome"], string> = {
  success: "✓ success",
  failed: "✗ failed",
  escalated: "⚠ escalated",
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Render a RunReport as a self-explanatory Markdown document. */
export function renderReportMarkdown(report: RunReport): string {
  const L: string[] = [];
  L.push(`# osstack run report — \`${report.loop_id}\``);
  L.push("");
  L.push(`> Generated ${report.generated_at} · conformance **${report.conformance_level}**`);
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(`- **Tasks:** ${report.totals.tasks} (✓ ${report.totals.success} · ✗ ${report.totals.failed} · ⚠ ${report.totals.escalated})`);
  L.push(`- **Success rate:** ${(report.totals.success_rate * 100).toFixed(0)}%`);
  L.push(`- **Cycles:** ${report.totals.cycles} · **Tokens:** ${report.totals.tokens}`);
  L.push(`- **Agents used:** ${report.agents_used.length > 0 ? report.agents_used.map((a) => `\`${a}\``).join(", ") : "—"}`);
  if (report.workspace) L.push(`- **Workspace:** \`${report.workspace}\``);
  L.push(`- **Window:** ${report.started_at} → ${report.updated_at}`);
  L.push("");

  L.push("## Tasks");
  L.push("");
  if (report.tasks.length === 0) {
    L.push("_No completed tasks recorded._");
  } else {
    L.push("| Task | Outcome | Agent | Iters | Duration | Verify |");
    L.push("|---|---|---|---|---|---|");
    for (const t of report.tasks) {
      const verify = t.verify_summary
        ? t.verify_summary.slice(0, 40)
        : t.verify_issue_count !== undefined
          ? `${t.verify_issue_count} issue(s)`
          : "—";
      L.push(`| \`${t.task_id}\` | ${OUTCOME_BADGE[t.outcome]} | \`${t.agent_id}\` | ${t.iterations} | ${fmtMs(t.duration_ms)} | ${verify} |`);
    }
  }
  L.push("");

  // Per-task detail for anything non-trivial.
  for (const t of report.tasks) {
    const hasDetail =
      t.commands.length > 0 ||
      t.verify_issues.length > 0 ||
      t.execution_summary ||
      t.error_summary ||
      t.worktree;
    if (!hasDetail) continue;
    L.push(`### \`${t.task_id}\` — ${OUTCOME_BADGE[t.outcome]}`);
    L.push("");
    if (t.capability) L.push(`- capability: \`${t.capability}\``);
    if (t.run_id) L.push(`- run_id: \`${t.run_id}\``);
    if (t.execution_summary) L.push(`- execution: ${t.execution_summary}`);
    if (t.verifier_agent_id) L.push(`- reviewer/checker: \`${t.verifier_agent_id}\``);
    if (t.error_summary) L.push(`- error: ${t.error_summary}`);
    if (t.worktree) {
      const w = t.worktree;
      const merged = w.branch_preserved ? "preserved (unmerged)" : "merged";
      L.push(`- worktree: \`${w.branch ?? "?"}\`${w.commit ? ` @ \`${w.commit.slice(0, 9)}\`` : ""} (${merged})`);
    }
    if (t.commands.length > 0) {
      L.push("");
      L.push("Commands:");
      for (const c of t.commands) {
        L.push(`- \`${c.command}\` → exit ${c.exit_code} (${fmtMs(c.duration_ms)})`);
      }
    }
    if (t.verify_issues.length > 0) {
      L.push("");
      L.push("Verify issues:");
      for (const i of t.verify_issues.slice(0, 20)) {
        const loc = i.file ? ` (${i.file}${i.line ? `:${i.line}` : ""})` : "";
        L.push(`- **${i.severity}**${i.rule ? ` [${i.rule}]` : ""}: ${i.message}${loc}`);
      }
    }
    L.push("");
  }

  if (report.decisions.length > 0) {
    L.push("## Decisions");
    L.push("");
    for (const d of report.decisions) L.push(`- ${d}`);
    L.push("");
  }

  if (report.risks.length > 0) {
    L.push("## Risks");
    L.push("");
    for (const r of report.risks) L.push(`- ${r}`);
    L.push("");
  }

  if (report.next_steps.length > 0) {
    L.push("## Next steps");
    L.push("");
    for (const s of report.next_steps) L.push(`- ${s}`);
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("_Generated by `osstack report` · [OSSTACK_RUN_SPEC_V1](../docs/specs/OSSTACK_RUN_SPEC_V1.md)_");
  L.push("");
  return L.join("\n");
}
