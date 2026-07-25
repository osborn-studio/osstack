import {
  type ProbeOutcomeCountsV1,
  deriveProbeOutcomeRates,
  type ProbeOutcomeMetricsReportV1,
  type ProbeRepoOutcomeMetricsV1,
} from "@osstack/core";
import {
  PortfolioProbeOutcomesV1,
  PortfolioReport,
  type PortfolioReport as PortfolioReportValue,
} from "./types.js";

const nonProductRoles = new Set(["reference", "archive"]);

function emptyCounts(): ProbeOutcomeCountsV1 {
  return {
    sessions_total: 0,
    sessions_replayed: 0,
    sessions_skipped: 0,
    answered_questions: 0,
    effective_questions: 0,
    resolved_items: 0,
    integrated_decisions: 0,
    high_risk_tasks: 0,
    mid_build_deviation_tasks: 0,
    deferred_items: 0,
    stale_deferred_items: 0,
    gate_relevant_items: 0,
    active_waivers: 0,
    started_sessions: 0,
    completed_sessions: 0,
  };
}

function addCounts(
  target: ProbeOutcomeCountsV1,
  source: ProbeOutcomeCountsV1,
): void {
  target.sessions_total += source.sessions_total;
  target.sessions_replayed += source.sessions_replayed;
  target.sessions_skipped += source.sessions_skipped;
  target.answered_questions += source.answered_questions;
  target.effective_questions += source.effective_questions;
  target.resolved_items += source.resolved_items;
  target.integrated_decisions += source.integrated_decisions;
  target.high_risk_tasks += source.high_risk_tasks;
  target.mid_build_deviation_tasks += source.mid_build_deviation_tasks;
  target.deferred_items += source.deferred_items;
  target.stale_deferred_items += source.stale_deferred_items;
  target.gate_relevant_items += source.gate_relevant_items;
  target.active_waivers += source.active_waivers;
  target.started_sessions += source.started_sessions;
  target.completed_sessions += source.completed_sessions;
}

export function aggregateProbeOutcomeMetrics(
  repos: readonly ProbeRepoOutcomeMetricsV1[],
  includedRepoIds: ReadonlySet<string>,
  asOfMs: number,
) {
  const included = repos.filter((repo) => includedRepoIds.has(repo.repo_id));
  if (included.length === 0) return undefined;
  const counts = emptyCounts();
  for (const repo of included) addCounts(counts, repo.counts);
  return PortfolioProbeOutcomesV1.parse({
    schema_version: "1",
    as_of_ms: asOfMs,
    baseline_status: "collecting",
    counts,
    rates: deriveProbeOutcomeRates(counts),
  });
}

/** Adds event-derived probe outcomes without parsing CLI text or setting targets. */
export function attachProbeOutcomeMetrics(
  report: PortfolioReportValue,
  source: ProbeOutcomeMetricsReportV1,
): PortfolioReportValue {
  const includedRepoIds = new Set(
    report.repos
      .filter((repo) => !nonProductRoles.has(repo.role))
      .map((repo) => repo.repo_id),
  );
  const outcomes = aggregateProbeOutcomeMetrics(
    source.repos,
    includedRepoIds,
    source.as_of_ms,
  );
  return outcomes === undefined
    ? report
    : PortfolioReport.parse({ ...report, probe_outcomes: outcomes });
}
