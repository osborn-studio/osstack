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
        async *invoke() {
          throw new Error("stream failed");
        },
      })],
    });
    expect(thrown).toMatchObject({ outcome: "failed", summary: "stream failed" });
  });
});

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
