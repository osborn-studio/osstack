import * as protocol from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import { protocol as loopProtocol } from "./index.js";
import { completedTaskToRunSummary, toProtocolTask } from "./protocol-mappers.js";
import { CompletedTask, Task } from "./types.js";

function task(overrides: Record<string, unknown> = {}): Task {
  return Task.parse({
    task_id: "task_1",
    capability: "code.fix",
    prompt: "fix the failing test",
    source: "git_diff",
    ...overrides,
  });
}

function completedTask(overrides: Record<string, unknown> = {}): CompletedTask {
  return CompletedTask.parse({
    task_id: "task_1",
    capability: "code.fix",
    outcome: "success",
    iterations: 2,
    agent_id: "claude-code",
    duration_ms: 4200,
    run_id: "run_task_1",
    started_at: "2023-11-14T22:13:20.000Z",
    completed_at: "2023-11-14T22:13:24.200Z",
    execution_summary: "applied the fix",
    ...overrides,
  });
}

describe("namespaced protocol re-export", () => {
  it("exposes PROTOCOL_VERSION via `import { protocol } from @osstack/loop`", () => {
    expect(loopProtocol.PROTOCOL_VERSION).toBe("1.0");
  });
});

describe("toProtocolTask", () => {
  it("maps a minimal task and passes the strict protocol.Task schema", () => {
    const p = toProtocolTask(task());
    expect(() => protocol.Task.parse(p)).not.toThrow();
    expect(p).toEqual({
      task_id: "task_1",
      capability: "code.fix",
      prompt: "fix the failing test",
      source: "git_diff",
      priority: 50, // loop default applied by Task.parse
    });
  });

  it("passes context through and passes strict parse", () => {
    const p = toProtocolTask(task({ context: { file: "a.ts", line: 3 }, priority: 90 }));
    expect(p.context).toEqual({ file: "a.ts", line: 3 });
    expect(p.priority).toBe(90);
    expect(() => protocol.Task.parse(p)).not.toThrow();
  });

  it("passes evaluation through as an opaque array accepted by strict parse", () => {
    const p = toProtocolTask(
      task({
        evaluation: [
          { id: "tests", mode: "command", description: "unit tests", command: "pnpm test" },
        ],
      }),
    );
    expect(p.evaluation).toHaveLength(1);
    expect(() => protocol.Task.parse(p)).not.toThrow();
  });

  it("omits optional fields when absent (strict-valid under exactOptionalPropertyTypes)", () => {
    const p = toProtocolTask(task());
    expect(p).not.toHaveProperty("context");
    expect(p).not.toHaveProperty("evaluation");
  });
});

describe("completedTaskToRunSummary", () => {
  it("maps a run-backed task and passes the strict RunSummary schema", () => {
    const summary = completedTaskToRunSummary(completedTask());
    expect(() => protocol.RunSummary.parse(summary)).not.toThrow();
    expect(summary).toEqual({
      run_id: "run_task_1",
      task_id: "task_1",
      agent_id: "claude-code",
      outcome: "completed",
      started_at: "2023-11-14T22:13:20.000Z",
      completed_at: "2023-11-14T22:13:24.200Z",
      duration_ms: 4200,
      summary: "applied the fix",
    });
  });

  it("maps success -> completed, failed -> failed, escalated -> cancelled", () => {
    expect(completedTaskToRunSummary(completedTask({ outcome: "success" })).outcome).toBe(
      "completed",
    );
    expect(completedTaskToRunSummary(completedTask({ outcome: "failed" })).outcome).toBe("failed");
    expect(completedTaskToRunSummary(completedTask({ outcome: "escalated" })).outcome).toBe(
      "cancelled",
    );
  });

  it("omits completed_at and summary when absent (still strict-valid)", () => {
    const summary = completedTaskToRunSummary(
      completedTask({ completed_at: undefined, execution_summary: undefined }),
    );
    expect(summary).not.toHaveProperty("completed_at");
    expect(summary).not.toHaveProperty("summary");
    expect(() => protocol.RunSummary.parse(summary)).not.toThrow();
  });

  it("clamps a negative duration to 0", () => {
    expect(completedTaskToRunSummary(completedTask({ duration_ms: -1 })).duration_ms).toBe(0);
  });

  it("ESCALATES (throws) when the task has no executed run (missing run_id)", () => {
    expect(() => completedTaskToRunSummary(completedTask({ run_id: undefined }))).toThrow(
      /actual run/,
    );
  });

  it("ESCALATES (throws) when started_at is missing", () => {
    expect(() => completedTaskToRunSummary(completedTask({ started_at: undefined }))).toThrow(
      /actual run/,
    );
  });
});
