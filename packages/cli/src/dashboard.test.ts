import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutonomyRun,
  freezeProduction,
  openDb,
  KanbanRepository,
  upsertPitfallLesson,
} from "@osstack/core";
import { insertRun, insertTask, finalizeRun } from "./store.js";
import { createDashboardSnapshot, dashboardUrl, renderDashboardHtml, startDashboardServer } from "./dashboard.js";

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
      mkdirSync(join(tmp, "reports"));
      mkdirSync(join(tmp, "release", "osstack-proof-r1"), { recursive: true });
      writeFileSync(join(tmp, "reports", "osstack-report-r1.md"), "# report\n");
      writeFileSync(join(tmp, "release", "osstack-proof-r1", "manifest.json"), "{}\n");
      upsertPitfallLesson(db, path, {
        family: "verify_failed",
        tech_stack: ["typescript"],
        symptom: "test failed",
        resolution: "rerun verifier",
        source_run_id: "r1",
      });

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
      db.prepare(
        "INSERT INTO tasks(task_id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("t3", "Queued follow-up", "", "pending", 250, 250);

      const kanban = new KanbanRepository(db, path, () => 300);
      kanban.createCard({ card_id: "card_1", title: "Design URL flow", status: "done", assignee: "google-stitch" });
      kanban.createCard({ card_id: "card_2", title: "Ship HTTP server", status: "running", assignee: "codex-cli" });
      kanban.createCard({ card_id: "card_3", title: "Fix tunnel auth", status: "blocked", assignee: "claude-code" });

      const snapshot = createDashboardSnapshot({
        db,
        kanban,
        dbPath: path,
        workspacePath: tmp,
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
      expect(snapshot.overview.queued_tasks).toBe(1);
      expect(snapshot.overview.active_loops).toBe(2);
      expect(snapshot.overview.progress_percent).toBe(33);
      expect(snapshot.quality.grade).toBe("B");
      expect(snapshot.board.by_status.done).toBe(1);
      expect(snapshot.board.by_status.running).toBe(1);
      expect(snapshot.board.by_status.blocked).toBe(1);
      expect(snapshot.agents.map((a) => a.id)).toEqual(["codex-cli", "claude-code"]);
      expect(snapshot.evidence.reports).toBe(1);
      expect(snapshot.evidence.proof_packs).toBe(1);
      expect(snapshot.lessons.total).toBe(1);
      expect(snapshot.autonomy.reliability.weekly.run_count).toBe(0);
      expect(snapshot.agent_scorecards[0]).toMatchObject({
        agent_id: "codex-cli",
        total_runs: 1,
      });
      expect(snapshot.next_steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: "Coding",
          command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        }),
        expect.objectContaining({
          label: "测试验证",
          command: "osstack cockpit proof --workspace <path> --json",
        }),
      ]));
      expect(snapshot.recent_runs[0]?.run_id).toBe("r2");
      expect(snapshot.dashboard.url).toBe("http://127.0.0.1:8799/dashboard");
      expect(snapshot.dashboard.workspace_path).toBe(tmp);
    } finally {
      db.close();
    }
  });

  it("builds a shareable dashboard url from host and port options", () => {
    expect(dashboardUrl({ host: "127.0.0.1", urlHost: "localhost", port: 8799 }))
      .toBe("http://localhost:8799/dashboard");
  });

  it("projects active production freezes into the cockpit snapshot", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      createAutonomyRun(db, path, {
        autonomy_run_id: "run-deploy-7",
        transition_id: "run-deploy-7:queued",
        task_id: "task-deploy-7",
        repo_id: "owner/example-web",
        workspace_path: "/tmp/example-web",
        contract_sha256: "a".repeat(64),
        routing: { builder: "claude", evaluator: "kimi" },
        budget: {
          max_builder_iterations: 3,
          max_review_rounds: 3,
          max_wall_time_ms: 5_400_000,
          max_no_progress_rounds: 2,
        },
        attempt: {},
        event: { kind: "queued" },
        occurred_at: 100,
      });
      freezeProduction(db, path, {
        repo_id: "owner/example-web",
        reason: "production health check failed",
        source_run_id: "run-deploy-7",
        frozen_at: 200,
      });

      const snapshot = createDashboardSnapshot({
        db,
        kanban: new KanbanRepository(db, path, () => 300),
        dbPath: path,
        workspacePath: tmp,
        version: "0.0.0",
        phase: "test",
        dashboardUrl: "http://127.0.0.1:8799/dashboard",
        adapters: [],
        activeRuns: 0,
        now: () => 300,
      });

      expect(snapshot.autonomy.deploy_freezes).toEqual([{
        repo_id: "owner/example-web",
        target: "production",
        frozen: true,
        reason: "production health check failed",
        source_run_id: "run-deploy-7",
        frozen_at: 200,
      }]);
      expect(
        snapshot.autonomy.reliability.attention.production_frozen,
      ).toEqual([
        expect.objectContaining({
          repo_id: "owner/example-web",
          source_run_id: "run-deploy-7",
        }),
      ]);
      expect(
        snapshot.autonomy.reliability.weekly.metrics.active_freeze_count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("surfaces release readiness blockers as cockpit next steps", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      writeFileSync(join(tmp, "release-readiness.md"), [
        "# Osstack Release Readiness",
        "",
        "## Blockers",
        "",
        "- [github_actions_check] Fix GitHub Actions runner allocation before publishing or deploying.",
        "- [proof_validation] Remove external certification claims and repair compliance report references before publishing or deploying.",
        "",
        "## Next Steps",
        "",
        "- Open GitHub Actions settings/billing and confirm ubuntu-latest jobs can be assigned a runner.",
      ].join("\n"));

      const snapshot = createDashboardSnapshot({
        db,
        kanban: new KanbanRepository(db, path, () => 300),
        dbPath: path,
        workspacePath: tmp,
        version: "0.0.0",
        phase: "test",
        dashboardUrl: "http://127.0.0.1:8799/dashboard",
        adapters: [],
        activeRuns: 0,
        now: () => 300,
      });

      expect(snapshot.next_steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: "Release Readiness",
          detail: "2 blocker(s): github_actions_check, proof_validation",
          command: `osstack release doctor --target all --workspace ${tmp} --output release-readiness.md --json`,
          status: "blocked",
          blockers: [
            {
              id: "github_actions_check",
              detail: "Fix GitHub Actions runner allocation before publishing or deploying.",
            },
            {
              id: "proof_validation",
              detail: "Remove external certification claims and repair compliance report references before publishing or deploying.",
            },
          ],
        }),
      ]));
    } finally {
      db.close();
    }
  });

  it("serves workspace-scoped release readiness blockers from the dashboard API", async () => {
    const path = join(tmp, "state.db");
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "release-readiness.md"), [
      "# Osstack Release Readiness",
      "",
      "## Blockers",
      "",
      "- [github_actions_check] Fix GitHub Actions runner allocation before publishing or deploying.",
    ].join("\n"));

    const db = openDb({ path });
    const kanban = new KanbanRepository(db, path, () => 300);
    const server = await startDashboardServer((params) => createDashboardSnapshot({
      db,
      kanban,
      dbPath: path,
      ...(params?.workspacePath === undefined ? {} : { workspacePath: params.workspacePath }),
      version: "0.0.0",
      phase: "test",
      dashboardUrl: "http://127.0.0.1:8799/dashboard",
      adapters: [],
      activeRuns: 0,
      now: () => 300,
    }), { host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url.replace("/dashboard", "/api/dashboard")}?workspace=${encodeURIComponent(workspace)}`);
      const snapshot = await response.json() as {
        next_steps: Array<{ label: string; blockers?: Array<{ id: string; detail: string }> }>;
      };

      expect(snapshot.next_steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: "Release Readiness",
          blockers: [{
            id: "github_actions_check",
            detail: "Fix GitHub Actions runner allocation before publishing or deploying.",
          }],
        }),
      ]));
    } finally {
      await server.close();
      db.close();
    }
  });

  it("serves workspace-scoped dashboard URLs for integrations", async () => {
    const path = join(tmp, "state.db");
    const workspace = join(tmp, "workspace with spaces");
    mkdirSync(workspace, { recursive: true });

    const db = openDb({ path });
    const kanban = new KanbanRepository(db, path, () => 300);
    const server = await startDashboardServer(() => createDashboardSnapshot({
      db,
      kanban,
      dbPath: path,
      version: "0.0.0",
      phase: "test",
      dashboardUrl: "http://127.0.0.1:8799/dashboard",
      adapters: [],
      activeRuns: 0,
      now: () => 300,
    }), { host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`${server.url.replace("/dashboard", "/dashboard/url")}?workspace=${encodeURIComponent(workspace)}`);
      const body = await response.json() as { url: string };

      expect(new URL(body.url).searchParams.get("workspace")).toBe(workspace);
    } finally {
      await server.close();
      db.close();
    }
  });

  it("renders cockpit sections for evidence, lessons, and scorecards", () => {
    const html = renderDashboardHtml();

    expect(html).toContain('id="evidence"');
    expect(html).toContain('id="scorecards"');
    expect(html).toContain('id="lessons"');
    expect(html).toContain("<code>'+esc(n.command)+'</code>");
    expect(html).toContain("Array.isArray(n.blockers)");
    expect(html).toContain("release-blocker");
    expect(html).toContain("d.dashboard.workspace_path");
  });

  it("renders cockpit chrome in English and Chinese", () => {
    const english = renderDashboardHtml("en");
    const chinese = renderDashboardHtml("zh-CN");

    expect(english).toContain('<html lang="en">');
    expect(english).toContain("<title>osstack Cockpit</title>");
    expect(english).toContain("<h2>Evidence Assets</h2>");
    expect(english).toContain("Queued Tasks");
    expect(english).toContain("No recent runs");
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(chinese).toContain("<title>osstack 开发驾驶舱</title>");
    expect(chinese).toContain("<h2>证据资产</h2>");
    expect(chinese).toContain("<h2>Agent 评分卡</h2>");
    expect(chinese).toContain("<h2>经验教训</h2>");
    expect(chinese).toContain("队列任务");
    expect(chinese).toContain("暂无运行记录");
    expect(chinese).toContain("最新报告");
    expect(chinese).toContain("最新 Proof pack");
    expect(chinese).toContain("次运行");
    expect(chinese).toContain("成功");
    expect(chinese).toContain("已验证");
  });
});
