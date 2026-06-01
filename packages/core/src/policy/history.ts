// SQLite-backed PolicyHistory implementation.
//
// All queries are O(log n) thanks to the indexes on runs(agent_id, phase, outcome).
// We accept a Database handle rather than a path so the daemon's hot loop
// shares the single open connection.

import type Database from "better-sqlite3";
import type { PolicyHistory } from "./types.js";

/**
 * Build a PolicyHistory backed by the runs table.
 *
 * `kindCapabilityMatch` is a SQL LIKE pattern: rules ask for runs by kind
 * ("code.write"), but runs are stored by capability_id ("claude-code.code.write").
 * We match capability_id LIKE '%.code.write' to get hits for that kind on
 * any agent.
 */
export function sqliteHistory(db: Database.Database): PolicyHistory {
  // Prepared statements are reused; SQLite caches the plan.
  const totalQ = db.prepare(
    "SELECT COUNT(*) AS c FROM runs WHERE agent_id = ? AND capability_id LIKE ?",
  );
  const completedQ = db.prepare(
    "SELECT COUNT(*) AS c FROM runs WHERE agent_id = ? AND capability_id LIKE ? AND outcome = 'completed'",
  );
  const recentFailsQ = db.prepare(
    `SELECT COUNT(*) AS c FROM runs
     WHERE agent_id = ? AND capability_id LIKE ?
       AND outcome IN ('failed', 'expired')
       AND started_at >= ?`,
  );
  const avgDurQ = db.prepare(
    `SELECT AVG(duration_ms) AS d FROM runs
     WHERE agent_id = ? AND capability_id LIKE ?
       AND outcome = 'completed' AND duration_ms IS NOT NULL`,
  );

  function pattern(kind: string): string { return `%.${kind}`; }

  return {
    totalRuns(agent_id, kind) {
      return (totalQ.get(agent_id, pattern(kind)) as { c: number }).c;
    },
    completedRuns(agent_id, kind) {
      return (completedQ.get(agent_id, pattern(kind)) as { c: number }).c;
    },
    recentFailures(agent_id, kind, withinDays) {
      const cutoff = Date.now() / 1000 - withinDays * 86400;
      return (recentFailsQ.get(agent_id, pattern(kind), cutoff) as { c: number }).c;
    },
    avgDurationMs(agent_id, kind) {
      const row = avgDurQ.get(agent_id, pattern(kind)) as { d: number | null };
      return row.d;
    },
  };
}
