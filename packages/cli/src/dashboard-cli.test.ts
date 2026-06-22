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

  it("localizes the cockpit summary with OSSTACK_LANG", async () => {
    process.env["OSSTACK_LANG"] = "zh-CN";
    daemon = await startDaemon({ socketPath: process.env["OSSTACK_SOCKET"]! });

    const exitCode = await main(["cockpit"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Osstack 驾驶舱");
    expect(output).toContain("任务看板:");
    expect(output).toContain("最近运行:");
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
