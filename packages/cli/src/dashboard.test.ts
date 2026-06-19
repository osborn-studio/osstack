import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, KanbanRepository } from "@osstack/core";
import { insertRun, insertTask, finalizeRun } from "./store.js";
import { createDashboardSnapshot, dashboardUrl } from "./dashboard.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-dashboard-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("dashboard", () => {
  it("summarizes osstack runs, board cards, agents, and quality", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertTask(db, path, { task_id: "t1", title: "Build dashboard", created_at: 100 });
      insertRun(db, path, {
        run_id: "r1",
        task_id: "t1",
        session_id: "s1",
        agent_id: "codex-cli",
        capability_id: "codex-cli.code.write",
        phase: "code",
        started_at: 100,
      });
      finalizeRun(db, path, "r1", "completed", 103);
      db.prepare("UPDATE runs SET tokens_in = 10, tokens_out = 20 WHERE run_id = ?").run("r1");

      insertTask(db, path, { task_id: "t2", title: "Verify release", created_at: 200 });
      insertRun(db, path, {
        run_id: "r2",
        task_id: "t2",
        session_id: "s2",
        agent_id: "claude-code",
        capability_id: "claude-code.code.test",
        phase: "test",
        started_at: 200,
      });

      const kanban = new KanbanRepository(db, path, () => 300);
      kanban.createCard({ card_id: "card_1", title: "Design URL flow", status: "done", assignee: "google-stitch" });
      kanban.createCard({ card_id: "card_2", title: "Ship HTTP server", status: "running", assignee: "codex-cli" });
      kanban.createCard({ card_id: "card_3", title: "Fix tunnel auth", status: "blocked", assignee: "claude-code" });

      const snapshot = createDashboardSnapshot({
        db,
        kanban,
        dbPath: path,
        version: "0.0.0",
        phase: "test",
        dashboardUrl: "http://127.0.0.1:8799/dashboard",
        adapters: [
          { id: "codex-cli", display_name: "Codex", cost_tier: "mid" },
          { id: "claude-code", display_name: "Claude Code", cost_tier: "high" },
        ],
        activeRuns: 1,
        activeLoops: 2,
        now: () => 300,
      });

      expect(snapshot.overview.total_runs).toBe(2);
      expect(snapshot.overview.completed_runs).toBe(1);
      expect(snapshot.overview.active_runs).toBe(1);
      expect(snapshot.overview.active_loops).toBe(2);
      expect(snapshot.overview.progress_percent).toBe(33);
      expect(snapshot.quality.grade).toBe("B");
      expect(snapshot.board.by_status.done).toBe(1);
      expect(snapshot.board.by_status.running).toBe(1);
      expect(snapshot.board.by_status.blocked).toBe(1);
      expect(snapshot.agents.map((a) => a.id)).toEqual(["codex-cli", "claude-code"]);
      expect(snapshot.recent_runs[0]?.run_id).toBe("r2");
      expect(snapshot.dashboard.url).toBe("http://127.0.0.1:8799/dashboard");
    } finally {
      db.close();
    }
  });

  it("builds a shareable dashboard url from host and port options", () => {
    expect(dashboardUrl({ host: "127.0.0.1", urlHost: "localhost", port: 8799 }))
      .toBe("http://localhost:8799/dashboard");
  });
});
