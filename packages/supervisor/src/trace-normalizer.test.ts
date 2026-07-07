import { describe, expect, it } from "vitest";
import { traceFromCompletedTask } from "./trace-normalizer.js";

describe("trace normalizer", () => {
  it("creates a trace from a failed completed task", () => {
    const trace = traceFromCompletedTask({
      repo_id: "osstack",
      loop_id: "loop_1",
      completedTask: {
        task_id: "task_1",
        capability: "code.test",
        outcome: "failed",
        iterations: 2,
        agent_id: "codex",
        duration_ms: 1234,
        run_id: "run_1",
        started_at: "2026-07-07T00:00:00.000Z",
        completed_at: "2026-07-07T00:01:00.000Z",
        execution_summary: "Changed verifier.",
        execution_commands: [{ command: "pnpm test", exit_code: 1, duration_ms: 1000, summary: "failed" }],
        verify_summary: "Vitest failed.",
        verify_issue_count: 1,
        verify_issues: [{ severity: "error", message: "expected true received false", rule: "vitest" }],
        verify_commands: [{ command: "pnpm test", exit_code: 1, duration_ms: 1000, summary: "1 failed" }],
        changed_files: ["packages/loop/src/verifier.ts"],
      },
    });
    expect(trace.trace_id).toMatch(/^trace_osstack_task_1_/);
    expect(trace.repo_id).toBe("osstack");
    expect(trace.task_id).toBe("task_1");
    expect(trace.verification.pass).toBe(false);
    expect(trace.verification.issues).toHaveLength(1);
    expect(trace.commands.map((cmd) => cmd.command)).toEqual(["pnpm test", "pnpm test"]);
  });

  it("is deterministic and marks success runs as passing", () => {
    const input = {
      repo_id: "osstack",
      completedTask: {
        task_id: "task_ok",
        capability: "code.fix",
        outcome: "success" as const,
        iterations: 1,
        agent_id: "codex",
        duration_ms: 10,
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.01,
      },
    };
    const a = traceFromCompletedTask(input);
    const b = traceFromCompletedTask(input);
    expect(a.trace_id).toBe(b.trace_id);
    expect(a.verification.pass).toBe(true);
    expect(a.verification.score).toBe(1);
    expect(a.cost).toEqual({ tokens_in: 100, tokens_out: 50, usd: 0.01 });
  });
});
