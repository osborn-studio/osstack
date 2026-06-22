import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  tmp = mkdtempSync(join(tmpdir(), "osstack-daemon-evidence-"));
  logs = [];
  errors = [];
  oldSocket = process.env["OSSTACK_SOCKET"];
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  process.env["OSSTACK_SOCKET"] = `/tmp/osstack-daemon-evidence-${randomUUID()}.sock`;
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
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("daemon evidence CLI", () => {
  it("renders report and proof artifacts for a persisted daemon loop run_id", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "daemon-evidence-task",
      capability: "code.test",
      prompt: "Exercise daemon evidence report",
    }));
    const socketPath = process.env["OSSTACK_SOCKET"]!;
    daemon = await startDaemon({ socketPath });

    const runCode = await main([
      "loop",
      "run",
      "--daemon",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--json",
    ]);

    expect(runCode).toBe(0);
    const runSummary = JSON.parse(logs.join("\n")) as { run_id: string };
    expect(runSummary.run_id).toMatch(/^loop_run_/);

    logs = [];
    const reportCode = await main(["report", runSummary.run_id]);

    expect(reportCode).toBe(0);
    const report = logs.join("\n");
    expect(report).toContain("# Osstack Loop Report - ");
    expect(report).toContain("daemon-evidence-task");
    expect(report).toContain("## Events Timeline");
    expect(report).toContain("loop.verify.done");

    logs = [];
    const scorecardCode = await main([
      "scorecard",
      runSummary.run_id,
      "--output-dir",
      join(workspace, "release"),
    ]);

    expect(scorecardCode).toBe(0);
    await expect(readFile(join(workspace, "release", `osstack-scorecard-${runSummary.run_id}.md`), "utf-8"))
      .resolves.toContain("# Osstack Scorecard - ");

    logs = [];
    const proofCode = await main(["proof", runSummary.run_id, "--output-dir", join(workspace, "release")]);

    expect(proofCode).toBe(0);
    const proofDir = join(workspace, "release", `osstack-proof-${runSummary.run_id}`);
    await expect(readFile(join(proofDir, "events.jsonl"), "utf-8")).resolves.toContain("loop.verify.done");
    await expect(readFile(join(proofDir, "report.md"), "utf-8")).resolves.toContain("## Events Timeline");
    await expect(readFile(join(proofDir, "policy-decision.json"), "utf-8")).resolves.toContain("daemon-evidence-task");
    const verifyResults = JSON.parse(await readFile(join(proofDir, "verify-results.json"), "utf-8")) as {
      status: string;
      results: Array<{ task_id: string; pass: boolean }>;
    };
    expect(verifyResults).toMatchObject({
      status: "pass",
      results: [expect.objectContaining({
        task_id: "daemon-evidence-task",
        pass: true,
      })],
    });
  });
});
