import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentAvailability, AgentTask } from "@osstack/agents";
import type { Capability } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { LoopEngine } from "@osstack/loop";

// R0.5 conformance #3b — an external consumer can drive the loop through the
// *adapter contract*: implement @osstack/agents' AgentAdapter with an
// in-memory fake (per architecture plan §3 "in-memory fake adapter") and have
// LoopEngine route a queued task through it. This is what makes the kernel
// trio claim complete — core (state), loop (engine), agents (adapter
// contract) — with zero CLI involvement, no network, no real agent binaries.
// Mirrors packages/loop/src/loop-engine.test.ts FakeLoopAdapter, replicated
// locally (the contract forbids cross-package test-helper imports).

class FakeConformanceAdapter implements AgentAdapter {
  readonly id = "fake-conformance-agent";
  readonly display_name = "Fake Conformance Agent";
  readonly cost_tier = "low" as const;

  capabilities(): readonly Capability[] {
    return [{
      id: `${this.id}.code.test`,
      kind: "code.test",
      agent_id: this.id,
      description: "In-memory fake adapter for kernel conformance",
      cost_tier: this.cost_tier,
      hints: {},
      version: "0.0.0",
    }];
  }

  async isAvailable(): Promise<AgentAvailability> {
    return { available: true, last_checked_at: Math.floor(Date.now() / 1000) };
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    yield this.event(task, 0, "run.started", {
      status: "running",
      controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false },
    }, false);

    const repoPath = typeof task.context?.["repo_path"] === "string" ? task.context["repo_path"] : undefined;
    if (signal.aborted || repoPath === undefined) {
      yield this.event(task, 1, "error", {
        code: signal.aborted ? "cancelled" : "missing_repo_path",
        message: "fake adapter could not run",
        terminal: true,
      }, true);
      return;
    }

    await writeFile(join(repoPath, "adapter-output.txt"), `adapter handled: ${task.prompt}\n`);
    yield this.event(task, 1, "done", {
      status: "completed",
      last_seq: 0,
      result_summary: "fake conformance adapter completed",
    }, true);
  }

  private event(task: AgentTask, seq: number, type: string, payload: unknown, terminal: boolean): HermesEvent {
    return {
      event_id: `${task.run_id}:${seq}`,
      seq,
      run_id: task.run_id,
      session_id: task.session_id,
      created_at: Date.now() / 1000,
      terminal,
      type,
      payload,
    } as HermesEvent;
  }
}

let workspace: string;
beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-conformance-adapter-"));
  await mkdir(join(workspace, "tasks"));
  await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
    task_id: "adapter-task-1",
    capability: "code.test",
    prompt: "Exercise the adapter contract from an external consumer",
    priority: 80,
  }));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("Agent-adapter conformance (@osstack/agents kernel consumption)", () => {
  it("LoopEngine routes a queued task through an in-memory AgentAdapter", async () => {
    const adapter = new FakeConformanceAdapter();
    const result = await new LoopEngine({
      loopId: "loop-adapter-conformance",
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: adapter.id,
      adapters: [adapter],
      verifyCommands: ["node -e \"process.exit(require('fs').existsSync('adapter-output.txt') ? 0 : 1)\""],
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "adapter-task-1",
      outcome: "success",
      agent_id: "fake-conformance-agent",
    });
    await expect(readFile(join(workspace, "adapter-output.txt"), "utf-8"))
      .resolves.toContain("adapter handled:");
  });
});
