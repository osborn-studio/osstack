import { mkdir, rm, writeFile } from "node:fs/promises";
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
let daemon: DaemonHandles | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-dashboard-cli-"));
  logs = [];
  errors = [];
  oldSocket = process.env["OSSTACK_SOCKET"];
  oldHome = process.env["OSSTACK_HOME"];
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
      cockpit: { dashboard: { title: string }; board: { columns: unknown[] } };
    };
    expect(summary.daemon.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(summary.daemon.active_loops).toBe(0);
    expect(summary.cockpit.dashboard.title).toContain("osstack");
    expect(Array.isArray(summary.cockpit.board.columns)).toBe(true);
  });
});
