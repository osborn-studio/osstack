import type Database from "better-sqlite3";

export interface AgentTaskKindScore {
  kind: string;
  total_runs: number;
  completed_runs: number;
  success_rate: number;
  avg_duration_ms: number | null;
}

export interface AgentScorecard {
  agent_id: string;
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  cancelled_runs: number;
  expired_runs: number;
  in_flight_runs: number;
  success_rate: number;
  avg_duration_ms: number | null;
  cost_tier: string;
  capability_fit: "unknown" | "weak" | "emerging" | "strong";
  recent_failures: number;
  best_task_kinds: AgentTaskKindScore[];
  warnings: string[];
}

export function listAgentScorecards(
  db: Database.Database,
  options: { now?: number; recentFailureDays?: number; limit?: number } = {},
): AgentScorecard[] {
  const rows = db.prepare(`
    SELECT agent_id
    FROM runs
    GROUP BY agent_id
    ORDER BY
      SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) DESC,
      COUNT(*) DESC,
      agent_id ASC
    LIMIT ?
  `).all(options.limit ?? 20) as Array<{ agent_id: string }>;
  return rows.map((row) => getAgentScorecard(db, row.agent_id, options));
}

export function getAgentScorecard(
  db: Database.Database,
  agentId: string,
  options: { now?: number; recentFailureDays?: number } = {},
): AgentScorecard {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
      SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
      SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_runs,
      SUM(CASE WHEN outcome = 'expired' THEN 1 ELSE 0 END) AS expired_runs,
      SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS in_flight_runs,
      AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) AS avg_duration_ms
    FROM runs
    WHERE agent_id = ?
  `).get(agentId) as {
    total_runs: number;
    completed_runs: number | null;
    failed_runs: number | null;
    cancelled_runs: number | null;
    expired_runs: number | null;
    in_flight_runs: number | null;
    avg_duration_ms: number | null;
  };
  const totalRuns = row.total_runs;
  const completedRuns = row.completed_runs ?? 0;
  const failedRuns = row.failed_runs ?? 0;
  const cancelledRuns = row.cancelled_runs ?? 0;
  const expiredRuns = row.expired_runs ?? 0;
  const inFlightRuns = row.in_flight_runs ?? 0;
  const recentFailures = countRecentFailures(db, agentId, options);
  return {
    agent_id: agentId,
    total_runs: totalRuns,
    completed_runs: completedRuns,
    failed_runs: failedRuns,
    cancelled_runs: cancelledRuns,
    expired_runs: expiredRuns,
    in_flight_runs: inFlightRuns,
    success_rate: totalRuns === 0 ? 0 : completedRuns / totalRuns,
    avg_duration_ms: row.avg_duration_ms,
    cost_tier: agentCostTier(db, agentId),
    capability_fit: capabilityFit(totalRuns, completedRuns),
    recent_failures: recentFailures,
    best_task_kinds: bestTaskKinds(db, agentId),
    warnings: warningsFor({ totalRuns, failedRuns, recentFailures }),
  };
}

function countRecentFailures(
  db: Database.Database,
  agentId: string,
  options: { now?: number; recentFailureDays?: number },
): number {
  const now = options.now ?? Date.now() / 1000;
  const days = options.recentFailureDays ?? 14;
  const cutoff = now - days * 86400;
  return (db.prepare(`
    SELECT COUNT(*) AS c
    FROM runs
    WHERE agent_id = ?
      AND outcome IN ('failed', 'expired')
      AND started_at >= ?
  `).get(agentId, cutoff) as { c: number }).c;
}

function bestTaskKinds(db: Database.Database, agentId: string): AgentTaskKindScore[] {
  const rows = db.prepare(`
    SELECT
      capability_id,
      COUNT(*) AS total_runs,
      SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
      AVG(CASE WHEN outcome = 'completed' AND duration_ms IS NOT NULL THEN duration_ms ELSE NULL END) AS avg_duration_ms
    FROM runs
    WHERE agent_id = ?
    GROUP BY capability_id
    ORDER BY completed_runs DESC, total_runs DESC, capability_id ASC
    LIMIT 5
  `).all(agentId) as Array<{
    capability_id: string;
    total_runs: number;
    completed_runs: number | null;
    avg_duration_ms: number | null;
  }>;
  return rows.map((row) => {
    const completedRuns = row.completed_runs ?? 0;
    return {
      kind: capabilityKind(row.capability_id),
      total_runs: row.total_runs,
      completed_runs: completedRuns,
      success_rate: row.total_runs === 0 ? 0 : completedRuns / row.total_runs,
      avg_duration_ms: row.avg_duration_ms,
    };
  });
}

function agentCostTier(db: Database.Database, agentId: string): string {
  const row = db.prepare("SELECT cost_tier FROM agents WHERE agent_id = ?").get(agentId) as
    | { cost_tier: string }
    | undefined;
  return row?.cost_tier ?? "unknown";
}

function capabilityFit(totalRuns: number, completedRuns: number): AgentScorecard["capability_fit"] {
  if (totalRuns === 0) return "unknown";
  const successRate = completedRuns / totalRuns;
  if (totalRuns >= 3 && successRate >= 0.66) return "strong";
  if (totalRuns >= 2 && successRate >= 0.5) return "emerging";
  return "weak";
}

function warningsFor(input: { totalRuns: number; failedRuns: number; recentFailures: number }): string[] {
  const warnings: string[] = [];
  if (input.totalRuns === 0) warnings.push("No run history yet");
  if (input.recentFailures > 0) warnings.push("Recent failures detected");
  if (input.totalRuns > 0 && input.failedRuns / input.totalRuns >= 0.5) warnings.push("High failure rate");
  return warnings;
}

function capabilityKind(capabilityId: string): string {
  const parts = capabilityId.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : capabilityId;
}
