import { agentAuthMode, defaultAdapters, rolesForCapabilityKinds } from "@osstack/agents";
import type { CompletedTask, LoopEvent, LoopKnowledgeTrace, LoopState, Task } from "./types.js";

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
  conformance: LoopReportConformance;
  completed_tasks: CompletedTask[];
  in_progress: Task[];
  pending: Task[];
  policy_decisions: LoopReportPolicyDecision[];
  verify_results: LoopReportVerifyResult[];
  worktree_status: LoopReportWorktreeStatus[];
  events_timeline: LoopReportTimelineEvent[];
  knowledge: LoopKnowledgeTrace | undefined;
  decisions: string[];
  risks: string[];
  next_steps: string[];
}

export type LoopReportConformanceLevel = "L1" | "L2" | "L3" | "L4";

export interface LoopReportConformance {
  level: LoopReportConformanceLevel;
  name: "Tracked" | "Verified" | "Reviewed" | "Audited";
  evidence: string[];
}

export interface LoopStateReportOptions {
  events?: LoopEvent[];
}

export interface LoopReportPolicyDecision {
  task_id: string;
  agent_id: string;
  auth_mode: string;
  roles: string[];
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

export type LoopReportLanguage = "en" | "zh-CN";

export interface RenderLoopStateReportMarkdownOptions {
  language?: LoopReportLanguage;
}

export interface RenderLoopStateScorecardOptions {
  language?: LoopReportLanguage;
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

  const policyDecisions = derivePolicyDecisions(options.events ?? []);
  const verifyResults = deriveVerifyResults(options.events ?? []);
  const worktreeStatus = deriveWorktreeStatus(options.events ?? []);
  const eventsTimeline = deriveEventsTimeline(options.events ?? []);

  return {
    summary,
    conformance: deriveConformance(summary, policyDecisions, verifyResults, worktreeStatus, eventsTimeline),
    completed_tasks: completedTasks,
    in_progress: inProgress,
    pending,
    policy_decisions: policyDecisions,
    verify_results: verifyResults,
    worktree_status: worktreeStatus,
    events_timeline: eventsTimeline,
    knowledge: state.knowledge,
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

export function renderLoopStateReportMarkdown(
  report: LoopStateReport,
  options: RenderLoopStateReportMarkdownOptions = {},
): string {
  const { summary } = report;
  const text = reportText(options.language ?? "en");
  const lines: string[] = [
    `# ${text.title} - ${summary.loop_id}`,
    "",
    `## ${text.summary}`,
    `- ${text.started}: ${summary.started_at}`,
    `- ${text.updated}: ${summary.updated_at}`,
    `- ${text.completed}: ${summary.completed_count}`,
    `- ${text.success}: ${summary.success_count}`,
    `- ${text.failed}: ${summary.failed_count}`,
    `- ${text.escalated}: ${summary.escalated_count}`,
    `- ${text.inProgress}: ${summary.in_progress_count}`,
    `- ${text.pending}: ${summary.pending_count}`,
    `- ${text.successRate}: ${formatPercent(summary.success_rate)}`,
    `- ${text.conformance}: ${report.conformance.level} ${report.conformance.name}`,
  ];

  if (summary.total_cycles !== undefined) {
    lines.push(`- ${text.totalCycles}: ${summary.total_cycles}`);
  }
  if (summary.avg_duration_ms !== undefined) {
    lines.push(`- ${text.averageDuration}: ${summary.avg_duration_ms} ms`);
  }
  if (summary.tokens_consumed !== undefined) {
    lines.push(`- ${text.tokensConsumed}: ${summary.tokens_consumed}`);
  }

  lines.push(
    "",
    `## ${text.completedTasks}`,
    ...renderCompletedTasks(report.completed_tasks),
    "",
    `## ${text.inProgressSection}`,
    ...renderTasks(report.in_progress),
    "",
    `## ${text.pendingTasks}`,
    ...renderTasks(report.pending),
    "",
    `## ${text.policyDecisions}`,
    ...renderPolicyDecisions(report.policy_decisions),
    "",
    `## ${text.verifyResults}`,
    ...renderVerifyResults(report.verify_results),
    "",
    `## ${text.worktreeStatus}`,
    ...renderWorktreeStatus(report.worktree_status),
    "",
    `## ${text.eventsTimeline}`,
    ...renderEventsTimeline(report.events_timeline),
    "",
    `## ${text.knowledgeTrace}`,
    ...renderKnowledgeTrace(report.knowledge),
    "",
    `## ${text.decisions}`,
    ...renderTextList(report.decisions),
    "",
    `## ${text.risks}`,
    ...renderTextList(report.risks),
    "",
    `## ${text.nextSteps}`,
    ...renderTextList(report.next_steps),
  );

  return `${lines.join("\n")}\n`;
}

export function renderLoopStateReportFromState(
  state: LoopState,
  options: RenderLoopStateReportMarkdownOptions = {},
): string {
  return renderLoopStateReportMarkdown(createLoopStateReport(state), options);
}

export function renderLoopStateReportFromStateAndEvents(
  state: LoopState,
  events: LoopEvent[],
  options: RenderLoopStateReportMarkdownOptions = {},
): string {
  return renderLoopStateReportMarkdown(createLoopStateReport(state, { events }), options);
}

export function renderLoopStateScorecardMarkdown(
  scorecard: LoopStateScorecard,
  options: RenderLoopStateScorecardOptions = {},
): string {
  const text = scorecardText(options.language ?? "en");
  const lines = [
    `# ${text.title} - ${scorecard.loop_id}`,
    "",
    `## ${text.summary}`,
    `- ${text.score}: ${scorecard.total_score} / ${scorecard.max_score}`,
    `- ${text.generatedFrom}: ${scorecard.generated_from}`,
    "",
    `## ${text.items}`,
    `| ${text.item} | ${text.status} | ${text.score} | ${text.evidence} |`,
    "| --- | --- | ---: | --- |",
    ...scorecard.items.map((item) => (
      `| ${item.id} | ${item.status} | ${item.earned} / ${item.max} | ${item.evidence.join("<br>")} |`
    )),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderLoopStateScorecardHtml(
  scorecard: LoopStateScorecard,
  options: RenderLoopStateScorecardOptions = {},
): string {
  const language = options.language ?? "en";
  const text = scorecardText(language);
  const rows = scorecard.items.map((item) => `
      <tr class="${escapeHtml(item.status)}">
        <td>${escapeHtml(item.label)}</td>
        <td>${escapeHtml(item.status)}</td>
        <td>${item.earned} / ${item.max}</td>
        <td>${item.evidence.map(escapeHtml).join("<br>")}</td>
      </tr>`).join("");

  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(text.title)} - ${escapeHtml(scorecard.loop_id)}</title>
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
  <h1>${escapeHtml(text.title)} - ${escapeHtml(scorecard.loop_id)}</h1>
  <div class="score">${escapeHtml(text.score)}: ${scorecard.total_score} / ${scorecard.max_score}</div>
  <table>
    <thead>
      <tr><th>${escapeHtml(text.item)}</th><th>${escapeHtml(text.status)}</th><th>${escapeHtml(text.score)}</th><th>${escapeHtml(text.evidence)}</th></tr>
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

function deriveConformance(
  summary: LoopStateReportSummary,
  policyDecisions: LoopReportPolicyDecision[],
  verifyResults: LoopReportVerifyResult[],
  worktreeStatus: LoopReportWorktreeStatus[],
  eventsTimeline: LoopReportTimelineEvent[],
): LoopReportConformance {
  const evidence = ["loop state recorded"];
  let level: LoopReportConformanceLevel = "L1";
  let name: LoopReportConformance["name"] = "Tracked";

  const hasReplayableEvents = eventsTimeline.length > 0;
  if (hasReplayableEvents) evidence.push("events timeline recorded");

  const hasPassingVerify = verifyResults.some((result) => result.pass);
  const hasExplicitVerifyFailure = verifyResults.some((result) => !result.pass && result.summary !== "unknown");
  if (hasPassingVerify || hasExplicitVerifyFailure) {
    level = "L2";
    name = "Verified";
    evidence.push(hasPassingVerify ? "verify gate passed" : "verify failure recorded");
  }

  const hasReviewer = verifyResults.some((result) => result.reviewer_agent_id !== "unknown");
  if (level !== "L1" && hasReviewer) {
    level = "L3";
    name = "Reviewed";
    evidence.push("reviewer/checker result recorded");
  }

  const hasAgentDecision = policyDecisions.length > 0;
  const hasWorktreeEvidence = worktreeStatus.length > 0;
  const hasRiskEvidence = summary.failed_count > 0 || summary.escalated_count > 0 || summary.success_count > 0;
  if (
    level === "L3"
    && hasAgentDecision
    && hasReplayableEvents
    && hasWorktreeEvidence
    && hasRiskEvidence
  ) {
    level = "L4";
    name = "Audited";
    evidence.push("agent decision recorded", "worktree evidence recorded", "risk evidence recorded");
  }

  return { level, name, evidence };
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
    "| Task | Agent | Auth mode | Roles | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...items.map((item) => `| ${item.task_id} | ${item.agent_id} | ${item.auth_mode} | ${item.roles.join(", ") || "unknown"} | ${item.reason} |`),
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

function renderKnowledgeTrace(knowledge: LoopKnowledgeTrace | undefined): string[] {
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
      auth_mode: agentAuthMode(stringPayload(event, "agent_id")),
      roles: rolesForAgent(stringPayload(event, "agent_id")),
      reason: stringPayload(event, "routing_reason"),
    }));
}

function rolesForAgent(agentId: string): string[] {
  const adapter = defaultAdapters().find((candidate) => candidate.id === agentId);
  return rolesForCapabilityKinds(adapter?.capabilities().map((capability) => capability.kind) ?? []);
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

function reportText(language: LoopReportLanguage): {
  title: string;
  summary: string;
  started: string;
  updated: string;
  completed: string;
  success: string;
  failed: string;
  escalated: string;
  inProgress: string;
  pending: string;
  successRate: string;
  conformance: string;
  totalCycles: string;
  averageDuration: string;
  tokensConsumed: string;
  completedTasks: string;
  inProgressSection: string;
  pendingTasks: string;
  policyDecisions: string;
  verifyResults: string;
  worktreeStatus: string;
  eventsTimeline: string;
  knowledgeTrace: string;
  decisions: string;
  risks: string;
  nextSteps: string;
} {
  if (language === "zh-CN") {
    return {
      title: "Osstack 循环报告",
      summary: "摘要",
      started: "开始时间",
      updated: "更新时间",
      completed: "已完成",
      success: "成功",
      failed: "失败",
      escalated: "升级",
      inProgress: "进行中",
      pending: "待处理",
      successRate: "成功率",
      conformance: "符合级别",
      totalCycles: "总循环数",
      averageDuration: "平均耗时",
      tokensConsumed: "Token 消耗",
      completedTasks: "已完成任务",
      inProgressSection: "进行中",
      pendingTasks: "待处理任务",
      policyDecisions: "策略决策",
      verifyResults: "验证结果",
      worktreeStatus: "Worktree 状态",
      eventsTimeline: "事件时间线",
      knowledgeTrace: "知识注入记录",
      decisions: "决策记录",
      risks: "风险",
      nextSteps: "下一步",
    };
  }
  return {
    title: "Osstack Loop Report",
    summary: "Summary",
    started: "Started",
    updated: "Updated",
    completed: "Completed",
    success: "Success",
    failed: "Failed",
    escalated: "Escalated",
    inProgress: "In progress",
    pending: "Pending",
    successRate: "Success rate",
    conformance: "Conformance",
    totalCycles: "Total cycles",
    averageDuration: "Average duration",
    tokensConsumed: "Tokens consumed",
    completedTasks: "Completed Tasks",
    inProgressSection: "In Progress",
    pendingTasks: "Pending Tasks",
    policyDecisions: "Policy Decisions",
    verifyResults: "Verify Results",
    worktreeStatus: "Worktree Status",
    eventsTimeline: "Events Timeline",
    knowledgeTrace: "Knowledge Trace",
    decisions: "Decisions",
    risks: "Risks",
    nextSteps: "Next Steps",
  };
}

function scorecardText(language: LoopReportLanguage): {
  title: string;
  summary: string;
  score: string;
  generatedFrom: string;
  items: string;
  item: string;
  status: string;
  evidence: string;
} {
  if (language === "zh-CN") {
    return {
      title: "Osstack 评分卡",
      summary: "摘要",
      score: "分数",
      generatedFrom: "生成来源",
      items: "评分项",
      item: "项目",
      status: "状态",
      evidence: "证据",
    };
  }
  return {
    title: "Osstack Scorecard",
    summary: "Summary",
    score: "Score",
    generatedFrom: "Generated from",
    items: "Items",
    item: "Item",
    status: "Status",
    evidence: "Evidence",
  };
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
