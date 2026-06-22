import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-cli-report-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("report CLI", () => {
  it("renders an Osstack loop report from workspace state", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["report", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("# Osstack Loop Report - cli-report-loop");
    expect(output).toContain("## Completed Tasks");
    expect(output).toContain("cli-report-task | code.test | success | codex-cli | 1 | 1000 ms");
    expect(output).toContain("Use state-derived reports as the first evidence layer.");
  });

  it("can read an explicit state path", async () => {
    await mkdir(join(tmp, "state"), { recursive: true });
    const statePath = join(tmp, "state", "custom-state.json");
    await writeState(statePath);

    const exitCode = await main(["report", "--state", statePath]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("# Osstack Loop Report - cli-report-loop");
  });

  it("fails when the state file is missing", async () => {
    const exitCode = await main(["report", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("osstack: no loop state found");
  });
});

async function writeState(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    loop_id: "cli-report-loop",
    started_at: "2026-06-22T01:00:00.000Z",
    updated_at: "2026-06-22T01:05:00.000Z",
    completed_tasks: [{
      task_id: "cli-report-task",
      capability: "code.test",
      outcome: "success",
      iterations: 1,
      agent_id: "codex-cli",
      duration_ms: 1000,
    }],
    in_progress: [],
    pending: [],
    decisions: ["Use state-derived reports as the first evidence layer."],
  }, null, 2));
}
