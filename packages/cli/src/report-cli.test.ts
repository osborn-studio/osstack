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

  it("renders event-rich sections from an events JSONL file", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "events.jsonl");
    await writeFile(eventsPath, [
      JSON.stringify({
        event_id: "evt-1",
        loop_id: "cli-report-loop",
        type: "loop.plan.done",
        seq: 1,
        created_at: 1782090000000,
        payload: {
          task_id: "cli-report-task",
          agent_id: "codex-cli",
          routing_reason: "matched code.test capability",
        },
      }),
      JSON.stringify({
        event_id: "evt-2",
        loop_id: "cli-report-loop",
        type: "loop.verify.done",
        seq: 2,
        created_at: 1782090001000,
        payload: {
          task_id: "cli-report-task",
          pass: true,
          score: 1,
          reviewer_agent_id: "local-verifier",
          summary: "Verifier passed.",
        },
      }),
    ].join("\n") + "\n");

    const exitCode = await main(["report", "--workspace", tmp, "--events", eventsPath]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("## Policy Decisions");
    expect(output).toContain("cli-report-task | codex-cli | matched code.test capability");
    expect(output).toContain("## Verify Results");
    expect(output).toContain("cli-report-task | pass | 1 | local-verifier | Verifier passed.");
    expect(output).toContain("## Events Timeline");
    expect(output).toContain("loop.verify.done");
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
