import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldLang: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-cli-report-"));
  logs = [];
  errors = [];
  oldLang = process.env["OSSTACK_LANG"];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  if (oldLang === undefined) delete process.env["OSSTACK_LANG"];
  else process.env["OSSTACK_LANG"] = oldLang;
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

  it("accepts --loop for state-file loop reports", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["report", "--loop", "cli-report-loop", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("# Osstack Loop Report - cli-report-loop");
  });

  it("rejects a --loop id that does not match state", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["report", "--loop", "other-loop", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--loop other-loop does not match state loop_id=cli-report-loop");
  });

  it("renders a Chinese report with --lang zh-CN", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["report", "--workspace", tmp, "--lang", "zh-CN"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("# Osstack 循环报告 - cli-report-loop");
    expect(output).toContain("## 摘要");
    expect(output).toContain("## 已完成任务");
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
    expect(output).toContain("cli-report-task | codex-cli | subprocess/login-reuse | coding, test-verify, reviewer, release/proof | matched code.test capability");
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

  it("reports malformed loop state without throwing", async () => {
    const statePath = join(tmp, "LOOP-STATE.json");
    await writeFile(statePath, JSON.stringify({
      loop_id: "bad-report-loop",
      completed_tasks: "not-an-array",
      pending: [],
      in_progress: [],
      decisions: [],
    }, null, 2));

    const exitCode = await main(["report", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    const output = errors.join("\n");
    expect(output).toContain("osstack: invalid loop state");
    expect(output).toContain(statePath);
    expect(output).toContain("completed_tasks");
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
