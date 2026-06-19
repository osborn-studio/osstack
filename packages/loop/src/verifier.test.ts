import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { Capability } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRun } from "./executor.js";
import type { Task } from "./types.js";
import { verifyRun } from "./verifier.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-verifier-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("verifyRun", () => {
  it("runs verifier adapters with repo and subject context", async () => {
    let captured: AgentTask | undefined;
    const adapter = mockAdapter({
      async *invoke(task) {
        captured = task;
        yield doneEvent(task.run_id, task.session_id, "completed", "review ok");
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: task(),
      sessionId: "loop-1",
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.reviewer_agent_id).toBe("reviewer");
    expect(verdict.summary).toContain("verifier adapter");
    expect(captured).toMatchObject({
      session_id: "loop-1",
      capability_id: "mock.review.code",
      context: expect.objectContaining({
        repo_path: workspace,
        subject_run_id: "run-plan-1",
        subject_agent_id: "maker",
      }),
    });
    expect(captured?.prompt).toContain("Review or verify the completed loop task.");
  });

  it("fails when a verifier adapter is missing, unavailable, or reports failure", async () => {
    const unavailable = mockAdapter({ id: "unavailable", available: false, reason: "missing binary" });
    const failing = mockAdapter({
      id: "failing",
      async *invoke(task) {
        yield doneEvent(task.run_id, task.session_id, "failed", "review rejected");
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: ["missing", "unavailable", "failing"],
      adapters: [unavailable, failing],
      task: task(),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toEqual([
      expect.objectContaining({ rule: "verify.adapter_missing" }),
      expect.objectContaining({ rule: "verify.adapter_unavailable" }),
      expect.objectContaining({ rule: "verify.adapter_failed" }),
    ]);
  });

  it("turns verifier error events, thrown errors, and incomplete streams into issues", async () => {
    const terminalError = mockAdapter({
      id: "terminal-error",
      async *invoke(task) {
        yield errorEvent(task.run_id, task.session_id, "review process exited");
      },
    });
    const throwing = mockAdapter({
      id: "throwing",
      async *invoke() {
        throw new Error("adapter crashed");
      },
    });
    const incomplete = mockAdapter({
      id: "incomplete",
      async *invoke() {
        return;
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: ["terminal-error", "throwing", "incomplete"],
      adapters: [terminalError, throwing, incomplete],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toEqual([
      expect.objectContaining({ message: expect.stringContaining("review process exited") }),
      expect.objectContaining({ message: expect.stringContaining("adapter crashed") }),
      expect.objectContaining({ message: expect.stringContaining("verifier did not complete") }),
    ]);
  });

  it("selects verifier capability kinds in preference order with fallback", async () => {
    const captured: string[] = [];
    const adapters = [
      mockAdapter({ id: "alignment", capability: capability("alignment.verify", "verify.alignment", "alignment") }),
      mockAdapter({ id: "acceptance", capability: capability("acceptance.verify", "verify.acceptance", "acceptance") }),
      mockAdapter({ id: "release", capability: capability("release.verify", "release.verify", "release") }),
      mockAdapter({ id: "legacy-review", capability: capability("legacy.review", "code.review", "legacy-review") }),
      mockAdapter({ id: "fallback", capabilities: [] }),
    ].map((adapter) => ({
      ...adapter,
      invoke: async function* (task: AgentTask) {
        captured.push(task.capability_id);
        yield doneEvent(task.run_id, task.session_id, "completed");
      },
    }));

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: ["alignment", "acceptance", "release", "legacy-review", "fallback"],
      adapters,
    });

    expect(verdict.pass).toBe(true);
    expect(captured).toEqual([
      "alignment.verify",
      "acceptance.verify",
      "release.verify",
      "legacy.review",
      "verify.fallback",
    ]);
  });
});

function run(): AgentRun {
  return {
    run_id: "run-plan-1",
    plan_id: "plan-1",
    task_id: "task-1",
    agent_id: "maker",
    outcome: "completed",
    started_at: new Date(0).toISOString(),
    completed_at: new Date(1).toISOString(),
    duration_ms: 1,
    command_results: [],
    summary: "maker completed",
  };
}

function task(): Task {
  return {
    task_id: "task-1",
    capability: "code.write",
    prompt: "Implement the change",
    priority: 50,
    source: "task_queue",
    context: { file: "src/app.ts" },
  };
}

function mockAdapter(options: {
  id?: string;
  available?: boolean;
  reason?: string;
  capability?: Capability;
  capabilities?: readonly Capability[];
  invoke?: AgentAdapter["invoke"];
} = {}): AgentAdapter {
  const id = options.id ?? "reviewer";
  return {
    id,
    display_name: "Mock Reviewer",
    cost_tier: "low",
    capabilities: () => options.capabilities ?? [options.capability ?? {
      id: "mock.review.code",
      kind: "review.code",
      agent_id: id,
      description: "Mock review capability",
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
  resultSummary?: string,
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
      ...(resultSummary !== undefined ? { result_summary: resultSummary } : {}),
    },
  };
}

function errorEvent(runId: string, sessionId: string, message: string): HermesEvent {
  return {
    event_id: `${runId}:error`,
    seq: 1,
    run_id: runId,
    session_id: sessionId,
    created_at: Date.now() / 1000,
    terminal: true,
    type: "error",
    payload: { code: "verify_failed", message, terminal: true },
  };
}

function capability(id: string, kind: Capability["kind"], agentId: string): Capability {
  return {
    id,
    kind,
    agent_id: agentId,
    description: `${kind} capability`,
    cost_tier: "low",
    hints: {},
    version: "0.0.0",
  };
}
