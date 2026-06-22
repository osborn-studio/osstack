import type { CompletedTask, LoopEvent, LoopState, Task } from "./types.js";

export interface LoopStateReportSummary {
  loop_id: string;
  started_at: string;
  updated_at: string;
  completed_count: number;
  success_count: number;
  failed_count: number;
  escalated_count: number;
  in_progress_count: number;
  pending_count: number;
  success_rate: number;
  total_cycles?: number;
  avg_duration_ms?: number;
  tokens_consumed?: number;
}

export interface LoopStateReport {
  summary: LoopStateReportSummary;
  completed_tasks: CompletedTask[];
  in_progress: Task[];
  pending: Task[];
  policy_decisions: LoopReportPolicyDecision[];
  verify_results: LoopReportVerifyResult[];
  worktree_status: LoopReportWorktreeStatus[];
  events_timeline: LoopReportTimelineEvent[];
  decisions: string[];
  risks: string[];
  next_steps: string[];
}

export interface LoopStateReportOptions {
  events?: LoopEvent[];
}

export interface LoopReportPolicyDecision {
  task_id: string;
  agent_id: string;
  reason: string;
}

export interface LoopReportVerifyResult {
  task_id: string;
  pass: boolean;
  score: number | "unknown";
  reviewer_agent_id: string;
  summary: string;
}

export interface LoopReportWorktreeStatus {
  task_id: string;
  status: "created" | "merged" | "cleaned" | "unknown";
  branch: string;
  commit: string;
  path: string;
}

export interface LoopReportTimelineEvent {
  seq: number;
  type: string;
  created_at: number;
  summary: string;
}

export type LoopStateScorecardStatus = "pass" | "fail" | "unknown";

export interface LoopStateScorecardItem {
  id: string;
  label: string;
  max: number;
  earned: number;
  status: LoopStateScorecardStatus;
  evidence: string[];
}

export interface LoopStateScorecard {
  loop_id: string;
  generated_from: "LOOP-STATE.json";
  total_score: number;
  max_score: number;
  items: LoopStateScorecardItem[];
}

export function createLoopStateReport(state: LoopState, options: LoopStateReportOptions = {}): LoopStateReport {
  const completedTasks = state.completed_tasks;
  const successCount = completedTasks.filter((task) => task.outcome === "success").length;
  const failedCount = completedTasks.filter((task) => task.outcome === "failed").length;
  const escalatedCount = completedTasks.filter((task) => task.outcome === "escalated").length;
  const inProgress = state.in_progress ?? [];
  const pending = state.pending ?? [];
  const derivedSuccessRate = completedTasks.length === 0 ? 0 : successCount / completedTasks.length;
  const summary: LoopStateReportSummary = {
    loop_id: state.loop_id,
    started_at: state.started_at,
    updated_at: state.updated_at,
    completed_count: completedTasks.length,
    success_count: successCount,
    failed_count: failedCount,
    escalated_count: escalatedCount,
    in_progress_count: inProgress.length,
    pending_count: pending.length,
    success_rate: state.key_metrics?.success_rate ?? derivedSuccessRate,
    ...(state.key_metrics !== undefined ? {
      total_cycles: state.key_metrics.total_cycles,
      avg_duration_ms: state.key_metrics.avg_duration_ms,
      tokens_consumed: state.key_metrics.tokens_consumed,
    } : {}),
  };

  return {
    summary,
    completed_tasks: completedTasks,
    in_progress: inProgress,
    pending,
    policy_decisions: derivePolicyDecisions(options.events ?? []),
    verify_results: deriveVerifyResults(options.events ?? []),
    worktree_status: deriveWorktreeStatus(options.events ?? []),
    events_timeline: deriveEventsTimeline(options.events ?? []),
    decisions: state.decisions ?? [],
    risks: deriveRisks(summary),
    next_steps: deriveNextSteps(summary),
  };
}

export function createLoopStateScorecard(report: LoopStateReport): LoopStateScorecard {
  const completed = report.summary.completed_count;
  const failed = report.summary.failed_count;
  const escalated = report.summary.escalated_count;
  const executionCompleted = completed > 0;
  const verifyPassed = completed > 0 && failed === 0 && escalated === 0;
  const noEscalation = escalated === 0 && failed === 0;
  const items: LoopStateScorecardItem[] = [
    scorecardItem({
      id: "execution_completed",
      label: "Execution completed",
      max: 20,
      pass: executionCompleted,
      evidence: executionCompleted
        ? [`${completed} completed task${plural(completed)} recorded in LOOP-STATE.json.`]
        : ["No completed task recorded in LOOP-STATE.json."],
    }),
    scorecardItem({
      id: "verify_gates_passed",
      label: "Verify gates passed",
      max: 30,
      pass: verifyPassed,
      evidence: verifyPassed
        ? ["All completed tasks have success outcome in LOOP-STATE.json."]
        : failed > 0 || escalated > 0
          ? [`${failed} failed and ${escalated} escalated completed task${plural(failed + escalated)} recorded.`]
          : ["No completed task outcome can prove verification passed."],
    }),
    unknownScorecardItem(
      "reviewer_checker_passed",
      "Reviewer/checker passed",
      20,
      "Reviewer/checker verdicts are not present in the state-only report.",
    ),
    unknownScorecardItem(
      "worktree_clean_merged",
      "Worktree clean/merged safely",
      10,
      "Worktree branch, commit, and merge evidence are not present in the state-only report.",
    ),
    scorecardItem({
      id: "no_escalation_max_iter_failure",
      label: "No escalation/max-iteration failure",
      max: 10,
      pass: noEscalation,
      evidence: noEscalation
        ? ["No failed or escalated completed task recorded in LOOP-STATE.json."]
        : [`${failed} failed and ${escalated} escalated completed task${plural(failed + escalated)} recorded.`],
    }),
    unknownScorecardItem(
      "proof_artifacts_generated",
      "Report/proof artifacts generated",
      10,
      "Proof artifact manifest is not present in the state-only report.",
    ),
  ];

  return {
    loop_id: report.summary.loop_id,
    generated_from: "LOOP-STATE.json",
    total_score: items.reduce((sum, item) => sum + item.earned, 0),
    max_score: items.reduce((sum, item) => sum + item.max, 0),
    items,
  };
}

export function renderLoopStateReportMarkdown(report: LoopStateReport): string {
  const { summary } = report;
  const lines: string[] = [
    `# Osstack Loop Report - ${summary.loop_id}`,
    "",
    "## Summary",
    `- Started: ${summary.started_at}`,
    `- Updated: ${summary.updated_at}`,
    `- Completed: ${summary.completed_count}`,
    `- Success: ${summary.success_count}`,
    `- Failed: ${summary.failed_count}`,
    `- Escalated: ${summary.escalated_count}`,
    `- In progress: ${summary.in_progress_count}`,
    `- Pending: ${summary.pending_count}`,
    `- Success rate: ${formatPercent(summary.success_rate)}`,
  ];

  if (summary.total_cycles !== undefined) {
    lines.push(`- Total cycles: ${summary.total_cycles}`);
  }
  if (summary.avg_duration_ms !== undefined) {
    lines.push(`- Average duration: ${summary.avg_duration_ms} ms`);
  }
  if (summary.tokens_consumed !== undefined) {
    lines.push(`- Tokens consumed: ${summary.tokens_consumed}`);
  }

  lines.push(
    "",
    "## Completed Tasks",
    ...renderCompletedTasks(report.completed_tasks),
    "",
    "## In Progress",
    ...renderTasks(report.in_progress),
    "",
    "## Pending Tasks",
    ...renderTasks(report.pending),
    "",
    "## Policy Decisions",
    ...renderPolicyDecisions(report.policy_decisions),
    "",
    "## Verify Results",
    ...renderVerifyResults(report.verify_results),
    "",
    "## Worktree Status",
    ...renderWorktreeStatus(report.worktree_status),
    "",
    "## Events Timeline",
    ...renderEventsTimeline(report.events_timeline),
    "",
    "## Decisions",
    ...renderTextList(report.decisions),
    "",
    "## Risks",
    ...renderTextList(report.risks),
    "",
    "## Next Steps",
    ...renderTextList(report.next_steps),
  );

  return `${lines.join("\n")}\n`;
}

export function renderLoopStateReportFromState(state: LoopState): string {
  return renderLoopStateReportMarkdown(createLoopStateReport(state));
}

export function renderLoopStateReportFromStateAndEvents(state: LoopState, events: LoopEvent[]): string {
  return renderLoopStateReportMarkdown(createLoopStateReport(state, { events }));
}

export function renderLoopStateScorecardMarkdown(scorecard: LoopStateScorecard): string {
  const lines = [
    `# Osstack Scorecard - ${scorecard.loop_id}`,
    "",
    "## Summary",
    `- Score: ${scorecard.total_score} / ${scorecard.max_score}`,
    `- Generated from: ${scorecard.generated_from}`,
    "",
    "## Items",
    "| Item | Status | Score | Evidence |",
    "| --- | --- | ---: | --- |",
    ...scorecard.items.map((item) => (
      `| ${item.id} | ${item.status} | ${item.earned} / ${item.max} | ${item.evidence.join("<br>")} |`
    )),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderLoopStateScorecardHtml(scorecard: LoopStateScorecard): string {
  const rows = scorecard.items.map((item) => `
      <tr class="${escapeHtml(item.status)}">
        <td>${escapeHtml(item.label)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${item.earned} / ${item.max}</td>
        <td>${item.evidence.map(escapeHtml).join("<br>")}</td>
      </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Osstack Scorecard - ${escapeHtml(scorecard.loop_id)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #17202a; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    .score { font-size: 20px; margin-bottom: 24px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d6dbe1; padding: 10px 12px; text-align: left; vertical-align: top; }
    th { background: #f4f6f8; }
    tr.pass td:first-child { border-left: 4px solid #247a3d; }
    tr.fail td:first-child { border-left: 4px solid #b42318; }
    tr.unknown td:first-child { border-left: 4px solid #8a6d3b; }
  </style>
</head>
<body>
  <h1>Osstack Scorecard - ${escapeHtml(scorecard.loop_id)}</h1>
  <div class="score">Score: ${scorecard.total_score} / ${scorecard.max_score}</div>
  <table>
    <thead>
      <tr><th>Item</th><th>Status</th><th>Score</th><th>Evidence</th></tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

export function createLoopStateScorecardFromState(state: LoopState): LoopStateScorecard {
  return createLoopStateScorecard(createLoopStateReport(state));
}

function deriveRisks(summary: LoopStateReportSummary): string[] {
  const risks: string[] = [];
  if (summary.failed_count > 0) {
    risks.push(`${summary.failed_count} completed task${plural(summary.failed_count)} failed.`);
  }
  if (summary.escalated_count > 0) {
    risks.push(`${summary.escalated_count} completed task${plural(summary.escalated_count)} escalated.`);
  }
  if (summary.pending_count > 10) {
    risks.push(`${summary.pending_count} pending tasks may need prioritization.`);
  }
  return risks;
}

function deriveNextSteps(summary: LoopStateReportSummary): string[] {
  const nextSteps: string[] = [];
  if (summary.in_progress_count > 0) {
    nextSteps.push(`Finish or unblock ${summary.in_progress_count} in-progress task${plural(summary.in_progress_count)}.`);
  }
  if (summary.pending_count > 0) {
    nextSteps.push(`Triage ${summary.pending_count} pending task${plural(summary.pending_count)}.`);
  }
  if (summary.failed_count > 0 || summary.escalated_count > 0) {
    nextSteps.push("Review failed or escalated tasks before starting new loop cycles.");
  }
  if (nextSteps.length === 0) {
    nextSteps.push("Queue the next validated task or close the loop session.");
  }
  return nextSteps;
}

function renderCompletedTasks(tasks: CompletedTask[]): string[] {
  if (tasks.length === 0) return ["- None"];

  return [
    "| Task | Capability | Outcome | Agent | Iterations | Duration |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...tasks.map((task) => `| ${task.task_id} | ${task.capability ?? "unknown"} | ${task.outcome} | ${task.agent_id} | ${task.iterations} | ${task.duration_ms} ms |`),
  ];
}

function renderTasks(tasks: Task[]): string[] {
  if (tasks.length === 0) return ["- None"];

  return [
    "| Task | Capability | Source | Priority | Prompt |",
    "| --- | --- | --- | ---: | --- |",
    ...tasks.map((task) => `| ${task.task_id} | ${task.capability} | ${task.source} | ${task.priority} | ${task.prompt} |`),
  ];
}

function renderPolicyDecisions(items: LoopReportPolicyDecision[]): string[] {
  if (items.length === 0) return ["- None"];
  return [
    "| Task | Agent | Reason |",
    "| --- | --- | --- |",
    ...items.map((item) => `| ${item.task_id} | ${item.agent_id} | ${item.reason} |`),
  ];
}

function renderVerifyResults(items: LoopReportVerifyResult[]): string[] {
  if (items.length === 0) return ["- None"];
  return [
    "| Task | Result | Score | Reviewer | Summary |",
    "| --- | --- | ---: | --- | --- |",
    ...items.map((item) => `| ${item.task_id} | ${item.pass ? "pass" : "fail"} | ${item.score} | ${item.reviewer_agent_id} | ${item.summary} |`),
  ];
}

function renderWorktreeStatus(items: LoopReportWorktreeStatus[]): string[] {
  if (items.length === 0) return ["- None"];
  return [
    "| Task | Status | Branch | Commit | Path |",
    "| --- | --- | --- | --- | --- |",
    ...items.map((item) => `| ${item.task_id} | ${item.status} | ${item.branch} | ${item.commit} | ${item.path} |`),
  ];
}

function renderEventsTimeline(items: LoopReportTimelineEvent[]): string[] {
  if (items.length === 0) return ["- None"];
  return [
    "| Seq | Type | Summary |",
    "| ---: | --- | --- |",
    ...items.map((item) => `| ${item.seq} | ${item.type} | ${item.summary} |`),
  ];
}

function renderTextList(items: string[]): string[] {
  if (items.length === 0) return ["- None"];
  return items.map((item) => `- ${item}`);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function derivePolicyDecisions(events: LoopEvent[]): LoopReportPolicyDecision[] {
  return events
    .filter((event) => event.type === "loop.plan.done")
    .map((event) => ({
      task_id: stringPayload(event, "task_id"),
      agent_id: stringPayload(event, "agent_id"),
      reason: stringPayload(event, "routing_reason"),
    }));
}

function deriveVerifyResults(events: LoopEvent[]): LoopReportVerifyResult[] {
  return events
    .filter((event) => event.type === "loop.verify.done")
    .map((event) => ({
      task_id: stringPayload(event, "task_id"),
      pass: booleanPayload(event, "pass"),
      score: numberPayload(event, "score") ?? "unknown",
      reviewer_agent_id: stringPayload(event, "reviewer_agent_id"),
      summary: stringPayload(event, "summary"),
    }));
}

function deriveWorktreeStatus(events: LoopEvent[]): LoopReportWorktreeStatus[] {
  return events
    .filter((event) => (
      event.type === "loop.worktree.created"
      || event.type === "loop.worktree.merged"
      || event.type === "loop.worktree.cleaned"
    ))
    .map((event) => ({
      task_id: stringPayload(event, "task_id"),
      status: event.type === "loop.worktree.created"
        ? "created"
        : event.type === "loop.worktree.merged"
          ? "merged"
          : event.type === "loop.worktree.cleaned"
            ? "cleaned"
            : "unknown",
      branch: stringPayload(event, "branch"),
      commit: stringPayload(event, "commit"),
      path: stringPayload(event, "path"),
    }));
}

function deriveEventsTimeline(events: LoopEvent[]): LoopReportTimelineEvent[] {
  return events.map((event) => ({
    seq: event.seq,
    type: event.type,
    created_at: event.created_at,
    summary: summarizeEvent(event),
  }));
}

function summarizeEvent(event: LoopEvent): string {
  if (event.type === "loop.plan.done") {
    return `${stringPayload(event, "task_id")} routed to ${stringPayload(event, "agent_id")}: ${stringPayload(event, "routing_reason")}`;
  }
  if (event.type === "loop.verify.done") {
    return `${stringPayload(event, "task_id")} verify ${booleanPayload(event, "pass") ? "passed" : "failed"}: ${stringPayload(event, "summary")}`;
  }
  if (event.type === "loop.execute.done") {
    return `${stringPayload(event, "task_id")} executed by ${stringPayload(event, "agent_id")} with outcome ${stringPayload(event, "outcome")}`;
  }
  if (event.type === "loop.worktree.created" || event.type === "loop.worktree.merged" || event.type === "loop.worktree.cleaned") {
    return `${stringPayload(event, "task_id")} ${event.type.replace("loop.worktree.", "worktree ")}`;
  }
  const taskId = stringPayload(event, "task_id");
  return taskId === "unknown" ? event.type : `${taskId}: ${event.type}`;
}

function payloadValue(event: LoopEvent, key: string): unknown {
  return event.payload?.[key];
}

function stringPayload(event: LoopEvent, key: string): string {
  const value = payloadValue(event, key);
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function numberPayload(event: LoopEvent, key: string): number | undefined {
  const value = payloadValue(event, key);
  return typeof value === "number" ? value : undefined;
}

function booleanPayload(event: LoopEvent, key: string): boolean {
  const value = payloadValue(event, key);
  return typeof value === "boolean" ? value : false;
}

function scorecardItem(args: {
  id: string;
  label: string;
  max: number;
  pass: boolean;
  evidence: string[];
}): LoopStateScorecardItem {
  return {
    id: args.id,
    label: args.label,
    max: args.max,
    earned: args.pass ? args.max : 0,
    status: args.pass ? "pass" : "fail",
    evidence: args.evidence,
  };
}

function unknownScorecardItem(
  id: string,
  label: string,
  max: number,
  evidence: string,
): LoopStateScorecardItem {
  return {
    id,
    label,
    max,
    earned: 0,
    status: "unknown",
    evidence: [evidence],
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
