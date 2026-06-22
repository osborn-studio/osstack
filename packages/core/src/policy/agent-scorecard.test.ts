import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../state/db.js";
import { getAgentScorecard, listAgentScorecards } from "./agent-scorecard.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-agent-scorecard-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("agent scorecards", () => {
  it("summarizes real run history for one agent", () => {
    const db = openDb({ path: join(tmp, "state.db") });
    try {
      seedRun(db, { run_id: "r1", task_id: "t1", agent_id: "codex-cli", capability_id: "codex-cli.code.test", outcome: "completed", duration_ms: 1000, started_at: 100 });
      seedRun(db, { run_id: "r2", task_id: "t2", agent_id: "codex-cli", capability_id: "codex-cli.code.test", outcome: "failed", duration_ms: 2000, started_at: 200 });
      seedRun(db, { run_id: "r3", task_id: "t3", agent_id: "codex-cli", capability_id: "codex-cli.code.write", outcome: "completed", duration_ms: 3000, started_at: 300 });
      seedRun(db, { run_id: "r4", task_id: "t4", agent_id: "claude-cli", capability_id: "claude-cli.code.write", outcome: "completed", duration_ms: 4000, started_at: 400 });

      const scorecard = getAgentScorecard(db, "codex-cli", { now: 1000, recentFailureDays: 30 });

      expect(scorecard).toMatchObject({
        agent_id: "codex-cli",
        total_runs: 3,
        completed_runs: 2,
        failed_runs: 1,
        success_rate: 2 / 3,
        avg_duration_ms: 2000,
        cost_tier: "unknown",
        capability_fit: "strong",
        recent_failures: 1,
      });
      expect(scorecard.best_task_kinds[0]).toMatchObject({
        kind: "code.test",
        total_runs: 2,
        success_rate: 0.5,
      });
      expect(scorecard.warnings).toEqual(["Recent failures detected"]);
    } finally {
      db.close();
    }
  });

  it("lists scorecards sorted by completed runs and total runs", () => {
    const db = openDb({ path: join(tmp, "state.db") });
    try {
      seedRun(db, { run_id: "r1", task_id: "t1", agent_id: "codex-cli", capability_id: "codex-cli.code.test", outcome: "completed", duration_ms: 1000, started_at: 100 });
      seedRun(db, { run_id: "r2", task_id: "t2", agent_id: "claude-cli", capability_id: "claude-cli.code.write", outcome: "completed", duration_ms: 1000, started_at: 100 });
      seedRun(db, { run_id: "r3", task_id: "t3", agent_id: "claude-cli", capability_id: "claude-cli.code.review", outcome: "completed", duration_ms: 1000, started_at: 100 });

      const scorecards = listAgentScorecards(db, { now: 1000 });

      expect(scorecards.map((scorecard) => scorecard.agent_id)).toEqual(["claude-cli", "codex-cli"]);
    } finally {
      db.close();
    }
  });
});

function seedRun(db: ReturnType<typeof openDb>, row: {
  run_id: string;
  task_id: string;
  agent_id: string;
  capability_id: string;
  outcome: "completed" | "failed" | "cancelled" | "expired";
  duration_ms: number;
  started_at: number;
}): void {
  db.prepare(
    "INSERT INTO tasks(task_id, title, description, status, created_at, updated_at) VALUES (?, ?, '', 'done', ?, ?)",
  ).run(row.task_id, row.task_id, row.started_at, row.started_at);
  db.prepare(`
    INSERT INTO runs(run_id, task_id, session_id, agent_id, capability_id, phase, outcome, started_at, completed_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, 'code', ?, ?, ?, ?)
  `).run(
    row.run_id,
    row.task_id,
    `session-${row.run_id}`,
    row.agent_id,
    row.capability_id,
    row.outcome,
    row.started_at,
    row.started_at + row.duration_ms / 1000,
    row.duration_ms,
  );
}
