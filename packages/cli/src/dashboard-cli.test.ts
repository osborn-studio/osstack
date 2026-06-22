import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";
import { startDaemon, type DaemonHandles } from "./daemon.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldSocket: string | undefined;
let oldHome: string | undefined;
let oldLang: string | undefined;
let daemon: DaemonHandles | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-dashboard-cli-"));
  logs = [];
  errors = [];
  oldSocket = process.env["OSSTACK_SOCKET"];
  oldHome = process.env["OSSTACK_HOME"];
  oldLang = process.env["OSSTACK_LANG"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  process.env["OSSTACK_SOCKET"] = `/tmp/osstack-dashboard-cli-${randomUUID()}.sock`;
  process.env["OSSTACK_UPDATE_CHECK"] = "0";
  daemon = null;
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  if (daemon) await daemon.close();
  if (oldSocket === undefined) delete process.env["OSSTACK_SOCKET"];
  else process.env["OSSTACK_SOCKET"] = oldSocket;
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  if (oldLang === undefined) delete process.env["OSSTACK_LANG"];
  else process.env["OSSTACK_LANG"] = oldLang;
  delete process.env["OSSTACK_UPDATE_CHECK"];
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("dashboard/cockpit CLI", () => {
  it("shows a product cockpit summary from daemon status and dashboard snapshot", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    await mkdir(join(tmp, "workspace", "reports"), { recursive: true });
    await mkdir(join(tmp, "workspace", "release", "osstack-proof-smoke"), { recursive: true });
    await writeFile(join(tmp, "workspace", "reports", "osstack-report-smoke.md"), "# report\n");
    await writeFile(join(tmp, "workspace", "release", "osstack-proof-smoke", "manifest.json"), "{}\n");

    expect(await main(["kanban", "create", "Ship cockpit", "--assignee", "codex-cli"])).toBe(0);

    logs = [];
    const exitCode = await main(["cockpit"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Osstack Cockpit");
    expect(output).toContain("daemon=");
    expect(output).toContain("runs total=");
    expect(output).toContain("queued=");
    expect(output).toContain("evidence reports=");
    expect(output).toContain("kanban:");
    expect(output).toContain("triage: 1");
    expect(output).toContain("recent runs:");
    expect(output).toContain("next steps:");
    expect(output).toContain("[ready] 产品设计 - google-stitch 2.0 primary, claude-design fallback");
  });

  it("prints daemon status and dashboard snapshot JSON with cockpit --json", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      daemon: { version: string; active_loops: number };
      cockpit: { dashboard: { title: string }; overview: { queued_tasks: number }; board: { columns: unknown[] } };
    };
    expect(summary.daemon.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(summary.daemon.active_loops).toBe(0);
    expect(summary.cockpit.dashboard.title).toContain("osstack");
    expect(summary.cockpit.overview.queued_tasks).toBe(0);
    expect(Array.isArray(summary.cockpit.board.columns)).toBe(true);
  });

  it("prints actionable cockpit next steps as a standalone command", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("next steps:");
    expect(output).toContain("[ready] 产品设计 - google-stitch 2.0 primary, claude-design fallback");
    expect(output).toContain("command: osstack guide --write");
    expect(output).toContain("[ready] Coding - codex-cli primary, claude-code fallback");
    expect(output).toContain("command: osstack deliver \"<task>\" --auto-agent --worktree --checkpoint");
  });

  it("prints cockpit next steps as JSON", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next", "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      next_steps: Array<{ label: string; detail: string; status: string; command?: string }>;
    };
    expect(summary.next_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "产品设计",
        detail: "google-stitch 2.0 primary, claude-design fallback",
        command: "osstack guide --write",
        status: "ready",
      }),
      expect.objectContaining({
        label: "Coding",
        detail: "codex-cli primary, claude-code fallback",
        command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        status: "ready",
      }),
    ]));
  });

  it("filters cockpit next steps by status in JSON", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next", "--status", "ready", "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      next_steps: Array<{ label: string; status: string; command?: string }>;
    };
    expect(summary.next_steps.length).toBeGreaterThan(0);
    expect(summary.next_steps.every((step) => step.status === "ready")).toBe(true);
    expect(summary.next_steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Coding",
        command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        status: "ready",
      }),
    ]));
  });

  it("filters cockpit next steps by status in text output", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit", "next", "--status", "ready"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("next steps:");
    expect(output).toContain("[ready] Coding - codex-cli primary, claude-code fallback");
    expect(output).not.toContain("[running]");
    expect(output).not.toContain("[blocked]");
  });

  it("rejects unsupported cockpit next status filters before contacting the daemon", async () => {
    const exitCode = await main(["cockpit", "next", "--status", "done"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("requires --status ready|running|blocked");
  });

  it("localizes the cockpit summary with OSSTACK_LANG", async () => {
    process.env["OSSTACK_LANG"] = "zh-CN";
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Osstack 驾驶舱");
    expect(output).toContain("任务看板:");
    expect(output).toContain("最近运行:");
    expect(output).toContain("下一步:");
  });

  it("generates a cockpit report from workspace loop evidence", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-report-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "cockpit-report-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
      in_progress: [],
      pending: [],
      decisions: ["Generate reports from the cockpit surface."],
    }, null, 2));

    const exitCode = await main(["cockpit", "report", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      report: string;
      opened: boolean;
    };
    expect(summary).toMatchObject({
      loop_id: "cockpit-report-loop",
      report: join(workspace, "reports", "osstack-report-cockpit-report-loop.md"),
      opened: false,
    });
    await expect(readFile(summary.report, "utf-8")).resolves.toContain("# Osstack Loop Report - cockpit-report-loop");
    await expect(readFile(summary.report, "utf-8")).resolves.toContain("Generate reports from the cockpit surface.");
  });

  it("runs queued work from the cockpit with evidence defaults", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "cockpit-run-task",
      capability: "code.test",
      prompt: "Run queued work from cockpit",
    }, null, 2));

    const exitCode = await main([
      "cockpit",
      "run",
      "--workspace",
      workspace,
      "--execute",
      "node -e \"require('fs').writeFileSync('cockpit-run.txt','ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').existsSync('cockpit-run.txt') ? 0 : 1)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      completed_tasks: Array<{ task_id: string; outcome: string }>;
      artifacts: {
        report: string;
        scorecard_markdown: string;
        scorecard_html: string;
        proof_dir: string;
        proof_manifest: string;
      };
    };
    expect(summary.completed_tasks).toEqual([
      expect.objectContaining({ task_id: "cockpit-run-task", outcome: "success" }),
    ]);
    expect(summary.artifacts.report).toBe(join(workspace, "reports", `osstack-report-${summary.loop_id}.md`));
    expect(summary.artifacts.scorecard_markdown).toBe(join(workspace, "release", `osstack-scorecard-${summary.loop_id}.md`));
    expect(summary.artifacts.scorecard_html).toBe(join(workspace, "release", `osstack-scorecard-${summary.loop_id}.html`));
    expect(summary.artifacts.proof_dir).toBe(join(workspace, "release", `osstack-proof-${summary.loop_id}`));
    await expect(readFile(summary.artifacts.report, "utf-8")).resolves.toContain(`# Osstack Loop Report - ${summary.loop_id}`);
    await expect(readFile(summary.artifacts.proof_manifest, "utf-8")).resolves.toContain("\"kind\": \"osstack.proof_pack\"");
  });

  it("requeues a failed task from cockpit retry", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-retry-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "failed-task",
        capability: "code.test",
        outcome: "failed",
        iterations: 2,
        agent_id: "codex-cli",
        duration_ms: 1200,
        verify_summary: "Tests failed.",
        verify_issues: [{ severity: "error", message: "Expected ok" }],
      }],
      in_progress: [],
      pending: [],
      decisions: [],
    }, null, 2));

    const exitCode = await main(["cockpit", "retry", "failed-task", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      retry_of_task_id: string;
      retry_task: { task_id: string; prompt: string; capability: string; priority: number; context: Record<string, unknown> };
      path: string;
    };
    expect(summary).toMatchObject({
      loop_id: "cockpit-retry-loop",
      retry_of_task_id: "failed-task",
      retry_task: {
        task_id: "failed-task-retry",
        capability: "code.test",
        priority: 70,
        context: expect.objectContaining({
          retry_of_task_id: "failed-task",
          retry_from_loop_id: "cockpit-retry-loop",
          previous_outcome: "failed",
          previous_agent_id: "codex-cli",
          previous_verify_summary: "Tests failed.",
        }),
      },
    });
    expect(summary.retry_task.prompt).toContain("Retry failed osstack loop task failed-task.");
    await expect(readFile(summary.path, "utf-8")).resolves.toContain("\"task_id\": \"failed-task-retry\"");
  });

  it("refuses to retry a successful cockpit task", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-success-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "successful-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
      in_progress: [],
      pending: [],
      decisions: [],
    }, null, 2));

    const exitCode = await main(["cockpit", "retry", "successful-task", "--workspace", workspace]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("retry only accepts failed or escalated tasks");
  });

  it("approves a kanban card from the cockpit", async () => {
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });
    expect(await main(["kanban", "create", "Approve cockpit card", "--assignee", "codex-cli"])).toBe(0);
    const created = logs.join("\n").match(/created (card_[a-f0-9]+):/)?.[1];
    expect(created).toBeDefined();

    logs = [];
    const exitCode = await main([
      "cockpit",
      "approve",
      created!,
      "--comment",
      "Reviewed from cockpit.",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      card_id: string;
      status: string;
      approved: boolean;
      commented: boolean;
    };
    expect(summary).toMatchObject({
      card_id: created,
      status: "done",
      approved: true,
      commented: true,
    });

    logs = [];
    expect(await main(["kanban", "board"])).toBe(0);
    expect(logs.join("\n")).toContain("DONE (1)");

    logs = [];
    expect(await main(["kanban", "events", "--since", "0"])).toBe(0);
    const events = JSON.parse(logs.join("\n")) as { events: Array<{ kind: string; card_id: string; payload: string | null }> };
    expect(events.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ card_id: created, kind: "completed" }),
      expect.objectContaining({ card_id: created, kind: "commented" }),
    ]));
  });

  it("generates a cockpit proof pack from workspace loop evidence", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "LOOP-STATE.json"), JSON.stringify({
      loop_id: "cockpit-proof-loop",
      started_at: "2026-06-22T01:00:00.000Z",
      updated_at: "2026-06-22T01:05:00.000Z",
      completed_tasks: [{
        task_id: "cockpit-proof-task",
        capability: "code.test",
        outcome: "success",
        iterations: 1,
        agent_id: "codex-cli",
        duration_ms: 1000,
      }],
      in_progress: [],
      pending: [],
      decisions: ["Generate proof packs from the cockpit surface."],
    }, null, 2));

    const exitCode = await main(["cockpit", "proof", "--workspace", workspace, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      loop_id: string;
      proof_dir: string;
      proof_zip: string;
      manifest: string;
      artifact_count: number;
      opened: boolean;
    };
    expect(summary).toMatchObject({
      loop_id: "cockpit-proof-loop",
      proof_dir: join(workspace, "release", "osstack-proof-cockpit-proof-loop"),
      proof_zip: join(workspace, "release", "osstack-proof-cockpit-proof-loop.zip"),
      manifest: join(workspace, "release", "osstack-proof-cockpit-proof-loop", "manifest.json"),
      opened: false,
    });
    expect(summary.artifact_count).toBeGreaterThan(0);
    await expect(readFile(summary.manifest, "utf-8")).resolves.toContain("\"run_id\": \"cockpit-proof-loop\"");
    await expect(readFile(join(summary.proof_dir, "report.md"), "utf-8")).resolves.toContain("# Osstack Loop Report - cockpit-proof-loop");
  });
});
