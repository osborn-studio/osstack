import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan, runShellCommand } from "./executor.js";
import { planTask } from "./planner.js";
import type { Task } from "./types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-executor-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("executePlan", () => {
  it("fails unknown non-local agents instead of treating them as no-op", async () => {
    const run = await executePlan(plan("missing-agent"), { workspacePath: workspace });

    expect(run.outcome).toBe("failed");
    expect(run.command_results[0]?.exitCode).toBe(127);
    expect(run.summary).toContain("agent adapter not registered");
  });

  it("runs a registered adapter with repo_path in task context", async () => {
    let captured: AgentTask | undefined;
    const adapter = mockAdapter({
      async *invoke(task) {
        captured = task;
        yield doneEvent(task.run_id, task.session_id, "completed", "done");
      },
    });

    const run = await executePlan(plan("mock-agent"), {
      workspacePath: workspace,
      adapters: [adapter],
      sessionId: "session-1",
    });

    expect(run.outcome).toBe("completed");
    expect(run.adapter_event_count).toBe(1);
    expect(run.summary).toBe("done");
    expect(captured?.capability_id).toBe("mock.code.write");
    expect(captured?.context?.["repo_path"]).toBe(workspace);
  });

  it("maps unavailable, terminal error, expired, and thrown adapter runs to failure", async () => {
    const unavailable = await executePlan(plan("unavailable"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "unavailable",
        available: false,
        reason: "missing token",
      })],
    });
    expect(unavailable).toMatchObject({
      outcome: "failed",
      summary: "missing token",
      adapter_event_count: 0,
    });

    const terminalError = await executePlan(plan("terminal-error"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "terminal-error",
        async *invoke(task) {
          yield errorEvent(task.run_id, task.session_id, "adapter exploded");
        },
      })],
    });
    expect(terminalError).toMatchObject({ outcome: "failed", summary: "adapter exploded" });

    const expired = await executePlan(plan("expired"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "expired",
        async *invoke(task) {
          yield doneEvent(task.run_id, task.session_id, "expired", "ran too long");
        },
      })],
    });
    expect(expired).toMatchObject({ outcome: "failed", summary: "ran too long" });

    const thrown = await executePlan(plan("throws"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "throws",
        // biome-ignore lint/correctness/useYield: mock adapter that throws before yielding
        async *invoke() {
          throw new Error("stream failed");
        },
      })],
    });
    expect(thrown).toMatchObject({ outcome: "failed", summary: "stream failed" });
  });
});

describe("adapter terminal protocol", () => {
  const done = (status = "completed", extra: Record<string, unknown> = {}) =>
    streamEvent("done", { status, last_seq: 1, ...extra }, true);
  const error = streamEvent("error", { code: "test_error", message: "adapter failed", terminal: true }, true);
  const progress = streamEvent("progress", { phase: "working" });
  const usage = (type: string, tokens: number) => streamEvent(type, {
    tokens_in: tokens, tokens_out: tokens * 2, cost_usd: tokens / 100, duration_ms: 1,
  });

  it.each([
    ["empty stream", []],
    ["work without done", [progress]],
    ["usage without done", [usage("usage.final", 10)]],
    ["nonterminal error without done", [{ ...error, terminal: false, payload: {
      code: "retryable", message: "retrying", terminal: false,
    } }]],
  ])("rejects %s as missing_done", async (_name, events) => {
    expect(await runEvents(events as HermesEvent[])).toMatchObject({
      outcome: "failed", failure_code: "missing_done",
      summary: expect.stringContaining("done"),
    });
  });

  it.each([
    null, undefined, [], "completed", {}, { status: "completed" },
    { status: "unknown", last_seq: 1 },
    { status: "completed", last_seq: -1 },
    { status: "completed", last_seq: 1.5 },
    { status: "completed", last_seq: "1" },
    { status: "completed", last_seq: 1, result_summary: 42 },
    { status: "completed", last_seq: 1, usage: null },
    { status: "completed", last_seq: 1, usage: { tokens_in: "10" } },
    { status: "completed", last_seq: 1, usage: { tokens_in: -1, tokens_out: 0, duration_ms: 1 } },
    { status: "completed", last_seq: 1, review: {} },
  ].map((payload) => [payload]))("rejects malformed done payload %j", async (payload) => {
    expect(await runEvents([streamEvent("done", payload, true)])).toMatchObject({
      outcome: "failed", failure_code: "invalid_done_payload",
    });
  });

  it.each([
    ["terminal error then success", [error, done()], "conflicting_terminal"],
    ["duplicate done", [done(), done()], "duplicate_done"],
    ["failure then success", [done("failed"), done()], "duplicate_done"],
    ["success then failure", [done(), done("failed")], "duplicate_done"],
    ["done then terminal error", [done(), error], "event_after_terminal"],
    ["done then progress then success", [done(), progress, done()], "event_after_terminal"],
    ["terminal error then work", [error, progress, done("failed")], "event_after_terminal"],
  ])("rejects %s", async (_name, events, failureCode) => {
    expect(await runEvents(events as HermesEvent[])).toMatchObject({ outcome: "failed", failure_code: failureCode });
  });

  it.each(["token.delta", "tool.started", "tool.updated", "tool.done", "run.started", "status", "approval.requested"])(
    "rejects %s after done", async (type) => {
      expect(await runEvents([done(), streamEvent(type, {})])).toMatchObject({
        outcome: "failed", failure_code: "event_after_terminal",
      });
    },
  );

  it.each(["completed", "failed", "expired", "cancelled"])("preserves a valid %s result", async (status) => {
    const run = await runEvents([progress, done(status, { result_summary: "result" })]);
    expect(run).toMatchObject({ outcome: status === "expired" ? "failed" : status, summary: "result" });
    expect(run).not.toHaveProperty("failure_code");
  });

  it("allows recovery from nonterminal errors before done", async () => {
    expect(await runEvents([{ ...error, terminal: false, payload: {
      code: "retryable", message: "retrying", terminal: false,
    } }, progress, done()])).toMatchObject({ outcome: "completed" });
  });

  it.each([false, true])("preserves terminal error with failed done: %s and surrounding usage", async (withDone) => {
    const run = await runEvents([
      usage("usage.updated", 1), error, usage("usage.final", 2),
      ...(withDone ? [done("failed")] : []), usage("usage.final", 3),
    ]);
    expect(run).toMatchObject({ outcome: "failed", summary: "adapter failed", tokens_in: 3, tokens_out: 6, cost_usd: 0.03 });
    expect(run).not.toHaveProperty("failure_code");
  });

  it("keeps the failed done summary after a terminal error", async () => {
    expect(await runEvents([error, done("failed", { result_summary: "failure summary" })]))
      .toMatchObject({ outcome: "failed", summary: "failure summary" });
  });

  it("uses the latest usage totals across updates, done payload, and final summaries", async () => {
    const events = [usage("usage.updated", 1), usage("usage.updated", 2), done("completed", {
      usage: { tokens_in: 3, tokens_out: 6, cost_usd: 0.03, duration_ms: 1 },
    })];
    expect(await runEvents(events)).toMatchObject({ outcome: "completed", tokens_in: 3, tokens_out: 6, cost_usd: 0.03 });
    expect(await runEvents([...events, usage("usage.final", 4)])).toMatchObject({
      outcome: "completed", tokens_in: 4, tokens_out: 8, cost_usd: 0.04, adapter_event_count: 4,
    });
  });
});

// Deliberately bypass static types to exercise malformed adapter output at runtime.
function streamEvent(type: string, payload: unknown, terminal = false): HermesEvent {
  return { event_id: "event-1", seq: 1, run_id: "run-1", session_id: "session-1",
    created_at: 0, terminal, type, payload } as HermesEvent;
}

async function runEvents(events: HermesEvent[]) {
  return executePlan(plan("mock-agent"), {
    workspacePath: workspace,
    adapters: [mockAdapter({ async *invoke() { yield* events; } })],
  });
}

describe("runShellCommand", () => {
  it("captures failures, truncates output, and reports timeouts", async () => {
    const failed = await runShellCommand("node -e \"console.error('bad'); process.exit(7)\"", {
      cwd: workspace,
      timeoutMs: 1_000,
      outputLimit: 100,
    });
    expect(failed.exitCode).toBe(7);
    expect(failed.stderr).toContain("bad");

    const truncated = await runShellCommand("node -e \"process.stdout.write('1234567890abcdef')\"", {
      cwd: workspace,
      timeoutMs: 1_000,
      outputLimit: 6,
    });
    expect(truncated.stdout).toBe("abcdef");

    const timedOut = await runShellCommand("node -e \"setTimeout(() => {}, 1000)\"", {
      cwd: workspace,
      timeoutMs: 20,
      outputLimit: 100,
    });
    expect(timedOut.exitCode).toBe(124);
    expect(timedOut.stderr).toContain("Command timed out after 20ms");
  });
});

function plan(agentId: string) {
  return planTask(task(), { agentId });
}

function task(): Task {
  return {
    task_id: "task-1",
    capability: "code.write",
    prompt: "Do work",
    priority: 50,
    source: "manual",
    context: { existing: true },
  };
}

function mockAdapter(options: {
  id?: string;
  available?: boolean;
  reason?: string;
  invoke?: AgentAdapter["invoke"];
} = {}): AgentAdapter {
  const id = options.id ?? "mock-agent";
  return {
    id,
    display_name: "Mock Agent",
    cost_tier: "low",
    capabilities: () => [{
      id: "mock.code.write",
      kind: "code.write",
      agent_id: id,
      description: "Mock write capability",
      cost_tier: "low",
      hints: {},
      version: "0.0.0",
    }],
    isAvailable: async () => ({
      available: options.available ?? true,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      last_checked_at: 0,
    }),
    invoke: options.invoke ?? (async function* (task) {
      yield doneEvent(task.run_id, task.session_id, "completed", "ok");
    }),
  };
}

function doneEvent(
  runId: string,
  sessionId: string,
  status: "completed" | "failed" | "cancelled" | "expired",
  resultSummary: string,
): HermesEvent {
  return {
    event_id: `${runId}:1`,
    seq: 1,
    run_id: runId,
    session_id: sessionId,
    created_at: Date.now() / 1000,
    terminal: true,
    type: "done",
    payload: {
      status,
      last_seq: 1,
      result_summary: resultSummary,
    },
  };
}

function errorEvent(runId: string, sessionId: string, message: string): HermesEvent {
  return {
    event_id: `${runId}:1`,
    seq: 1,
    run_id: runId,
    session_id: sessionId,
    created_at: Date.now() / 1000,
    terminal: true,
    type: "error",
    payload: {
      code: "mock_error",
      message,
      terminal: true,
    },
  };
}
