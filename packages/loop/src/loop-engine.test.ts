import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { CapabilitySchema, type Capability, type CostTier } from "@osstack/core";
import type { AgentAdapter, AgentAvailability, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { describe, expect, it, vi } from "vitest";
import { LoopEngine } from "./loop-engine.js";
import { PublishConfig, type RunPublishDeps } from "./publisher.js";

async function makeQueuedWorkspace(): Promise<string> {
  const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-engine-"));
  await mkdir(join(workspace, "tasks"));
  await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
    task_id: "task-1",
    capability: "code.test",
    prompt: "Exercise the local loop engine",
    priority: 80,
  }));
  return workspace;
}

describe("LoopEngine", () => {
  it("runs a real local command loop and writes state files", async () => {
    const workspace = await makeQueuedWorkspace();
    const result = await new LoopEngine({
      loopId: "loop-test",
      workspacePath: workspace,
      sources: ["task_queue"],
      stateFilePath: "LOOP-STATE.json",
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      verifyCommands: ["node -e \"process.exit(require('fs').existsSync('loop-output.txt') ? 0 : 1)\""],
      maxIterations: 1,
    }).runOnce();

    expect(result.state.completed_tasks).toEqual([
      expect.objectContaining({
        task_id: "task-1",
        outcome: "success",
        iterations: 1,
        agent_id: "local-command",
        verifier_agent_id: "local-verifier",
        verify_issue_count: 0,
        verify_summary: expect.stringContaining("passed"),
        execution_commands: [expect.objectContaining({ exit_code: 0 })],
        verify_commands: [expect.objectContaining({ command: expect.stringContaining("loop-output.txt"), exit_code: 0 })],
      }),
    ]);
    expect(result.events.map((event) => event.type)).toContain("loop.verify.done");
    await expect(readFile(join(workspace, "STATE.md"), "utf-8")).resolves.toContain("task-1 - success");
    await expect(readFile(join(workspace, "LOOP-STATE.json"), "utf-8")).resolves.toContain('"loop_id": "loop-test"');
  });

  it("can execute a queued task through a real AgentAdapter invocation", async () => {
    const workspace = await makeQueuedWorkspace();
    const adapter = new FakeLoopAdapter();
    const result = await new LoopEngine({
      loopId: "loop-agent",
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: adapter.id,
      adapters: [adapter],
      verifyCommands: ["node -e \"process.exit(require('fs').existsSync('agent-output.txt') ? 0 : 1)\""],
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      agent_id: "fake-loop-agent",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.execute.done",
      payload: expect.objectContaining({
        agent_id: "fake-loop-agent",
        adapter_event_count: 2,
      }),
    }));
    await expect(readFile(join(workspace, "agent-output.txt"), "utf-8"))
      .resolves.toBe("adapter wrote: Exercise the local loop engine\n");
  });

  it("automatically routes queued tasks through the policy-selected adapter", async () => {
    const workspace = await makeQueuedWorkspace();
    const highCost = new FakeLoopAdapter({ id: "high-cost-agent", costTier: "high", outputFile: "high-output.txt" });
    const lowCost = new FakeLoopAdapter({ id: "low-cost-agent", costTier: "low", outputFile: "low-output.txt" });
    const result = await new LoopEngine({
      loopId: "loop-policy-route",
      workspacePath: workspace,
      sources: ["task_queue"],
      adapters: [highCost, lowCost],
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      agent_id: "low-cost-agent",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.plan.done",
      payload: expect.objectContaining({
        agent_id: "low-cost-agent",
        routing_reason: expect.stringContaining("policy["),
        policy: expect.objectContaining({ winner_agent_id: "low-cost-agent" }),
      }),
    }));
    await expect(readFile(join(workspace, "low-output.txt"), "utf-8"))
      .resolves.toBe("adapter wrote: Exercise the local loop engine\n");
    await expect(readFile(join(workspace, "high-output.txt"), "utf-8")).rejects.toThrow();
  });

  it("runs reviewer adapters after execution and treats them as verification gates", async () => {
    const workspace = await makeQueuedWorkspace();
    const reviewer = new FakeReviewAdapter();
    const result = await new LoopEngine({
      loopId: "loop-reviewer",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('maker-output.txt', 'ok')\"",
      verifierAgentIds: [reviewer.id],
      adapters: [reviewer],
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      agent_id: "local-command",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.verify.done",
      payload: expect.objectContaining({
        pass: true,
        reviewer_agent_id: "fake-reviewer",
      }),
    }));
    await expect(readFile(join(workspace, "review-output.txt"), "utf-8"))
      .resolves.toContain("reviewed run_plan_");
  });

  it("emits a dedicated event only for a verifier's structured implementation deviation", async () => {
    const workspace = await makeQueuedWorkspace();
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "task-1",
      capability: "code.test",
      prompt: "Exercise structured deviation reporting",
      priority: 80,
      context: { emit_deviation: true },
    }));
    const reviewer = new FakeReviewAdapter();
    const result = await new LoopEngine({
      loopId: "loop-deviation",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('agent-output.txt', 'drift')\"",
      verifierAgentIds: [reviewer.id],
      adapters: [reviewer],
    }).runOnce();

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.implementation.deviation",
      payload: expect.objectContaining({
        task_id: "task-1",
        deviation_id: "architecture-drift-1",
      }),
    }));
  });

  it("records changed files, diff summary, and commit hash in task evidence", async () => {
    const workspace = await makeGitQueuedWorkspace("initial\n");
    const result = await new LoopEngine({
      loopId: "loop-evidence",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('app.txt', 'evidence change\\n')\"",
      verifyCommands: ["node -e \"process.exit(require('fs').readFileSync('app.txt','utf8').includes('evidence') ? 0 : 1)\""],
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      changed_files: expect.arrayContaining(["app.txt"]),
      diff_summary: expect.stringContaining("app.txt"),
      commit_hash: expect.any(String),
      verify_commands: [expect.objectContaining({ exit_code: 0 })],
    });
    await expect(readFile(join(workspace, "STATE.md"), "utf-8")).resolves.toContain("Changed files: app.txt");
  });

  it("fails verification when builder and evaluator are the same enforced agent", async () => {
    const workspace = await makeQueuedWorkspace();
    const adapter = new FakeLoopAdapter({ id: "same-agent" });
    const result = await new LoopEngine({
      loopId: "loop-role-separation",
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: adapter.id,
      verifierAgentIds: [adapter.id],
      enforceRoleSeparation: true,
      adapters: [adapter],
      maxIterations: 1,
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "escalated",
      agent_id: "same-agent",
      verifier_agent_id: "same-agent",
      verify_issues: [expect.objectContaining({ rule: "verify.role_separation" })],
    });
  });

  it("escalates after repeated failed verification", async () => {
    const workspace = await makeQueuedWorkspace();
    const result = await new LoopEngine({
      loopId: "loop-fail",
      workspacePath: workspace,
      sources: ["task_queue"],
      verifyCommands: ["node -e \"process.exit(1)\""],
      maxIterations: 2,
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "escalated",
      iterations: 2,
      verify_issue_count: 1,
      error_summary: expect.stringContaining("failed"),
      verify_issues: [expect.objectContaining({ rule: "verify.command_failed" })],
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.escalated",
      payload: expect.objectContaining({
        task_id: "task-1",
        iteration: 2,
        max_iterations: 2,
        escalate_to: "hermes",
      }),
    }));
    expect(result.state.decisions?.at(-1)).toContain("escalate after iteration 2");
  });

  it("keeps truncated verifier output Unicode-safe for state and proof JSON", async () => {
    const workspace = await makeQueuedWorkspace();
    const result = await new LoopEngine({
      loopId: "loop-unicode-summary",
      workspacePath: workspace,
      sources: ["task_queue"],
      verifyCommands: [
        "node -e \"process.stderr.write('x'.repeat(239) + '🚀'); process.exit(1)\"",
      ],
      maxIterations: 1,
    }).runOnce();

    const issue = result.state.completed_tasks[0]?.verify_issues?.[0]?.message ?? "";
    const stateJson = await readFile(join(workspace, "LOOP-STATE.json"), "utf-8");
    const proofJson = `${JSON.stringify(result.state, null, 2)}\n`;

    expect(hasUnpairedSurrogate(issue)).toBe(false);
    expect(stateJson).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/iu);
    expect(proofJson).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/iu);
    expect(() => JSON.parse(stateJson)).not.toThrow();
    expect(() => JSON.parse(proofJson)).not.toThrow();
  });

  it("reuses the persisted loop id when running against an existing state file", async () => {
    const workspace = await makeQueuedWorkspace();
    const first = await new LoopEngine({
      loopId: "loop-stable",
      workspacePath: workspace,
      sources: ["manual"],
    }).runOnce();
    const second = await new LoopEngine({
      workspacePath: workspace,
      sources: ["manual"],
    }).runOnce();

    expect(first.loop_id).toBe("loop-stable");
    expect(second.loop_id).toBe("loop-stable");
    expect(second.state.loop_id).toBe("loop-stable");
    expect(second.events.every((event) => event.loop_id === "loop-stable")).toBe(true);
  });

  it("skips task queue items that already completed in the persisted state", async () => {
    const workspace = await makeQueuedWorkspace();
    const command = "node -e \"const fs=require('fs'); const n=fs.existsSync('count.txt') ? Number(fs.readFileSync('count.txt','utf8')) : 0; fs.writeFileSync('count.txt', String(n + 1))\"";
    const first = await new LoopEngine({
      loopId: "loop-repeat-safe",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: command,
      maxIterations: 1,
    }).runOnce();
    const second = await new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: command,
      maxIterations: 1,
    }).runOnce();

    expect(first.executedTaskCount).toBe(1);
    expect(second.discoveredTaskCount).toBe(1);
    expect(second.executedTaskCount).toBe(0);
    expect(second.skippedTaskCount).toBe(1);
    await expect(readFile(join(workspace, "count.txt"), "utf-8")).resolves.toBe("1");
  });

  it("can run multiple cycles and pick up tasks that appear later", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-engine-watch-"));
    await mkdir(join(workspace, "tasks"));
    setTimeout(() => {
      void writeFile(join(workspace, "tasks", "late.json"), JSON.stringify({
        task_id: "late-task",
        capability: "code.test",
        prompt: "Exercise a later cycle",
      }));
    }, 5);

    const result = await new LoopEngine({
      loopId: "loop-cycles",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('late-done.txt', 'ok')\"",
    }).runCycles({ cycles: 2, intervalMs: 25 });

    expect(result.cycles).toHaveLength(2);
    expect(result.cycles[0]!.executedTaskCount).toBe(0);
    expect(result.cycles[1]!.executedTaskCount).toBe(1);
    expect(result.events
      .filter((event) => event.type === "loop.cycle.started")
      .map((event) => (event.payload as { cycle: number }).cycle)).toEqual([1, 2]);
    expect(result.events.map((event) => event.seq)).toEqual(
      result.events.map((_, index) => index + 1),
    );
    expect(result.events.at(-1)?.type).toBe("loop.stopped");
    expect(result.state.completed_tasks.at(-1)).toMatchObject({
      task_id: "late-task",
      outcome: "success",
    });
    await expect(readFile(join(workspace, "late-done.txt"), "utf-8")).resolves.toBe("ok");
  });

  it("stops multi-cycle runs early when the goal command passes", async () => {
    const workspace = await makeQueuedWorkspace();
    const result = await new LoopEngine({
      loopId: "loop-goal",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('goal-done.txt', 'ok')\"",
      goalCommand: "node -e \"process.exit(require('fs').existsSync('goal-done.txt') ? 0 : 1)\"",
    }).runCycles({ cycles: 5, intervalMs: 10 });

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]!.goal).toMatchObject({
      pass: true,
      exitCode: 0,
    });
    expect(result.events.map((event) => event.type)).toContain("loop.goal.checked");
    expect(result.events.at(-1)).toMatchObject({
      type: "loop.stopped",
      payload: expect.objectContaining({ reason: "goal command passed" }),
    });
    expect(result.state.decisions?.at(-1)).toContain("goal: passed");
  });

  it("archives successful single-task queue files when requested", async () => {
    const workspace = await makeQueuedWorkspace();
    const result = await new LoopEngine({
      loopId: "loop-archive",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('archive-done.txt', 'ok')\"",
      archiveCompletedTasks: true,
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.queue.archived",
      payload: expect.objectContaining({
        task_id: "task-1",
        archived: true,
      }),
    }));
    await expect(readFile(join(workspace, "tasks", "task.json"), "utf-8")).rejects.toThrow();
    const archiveRoot = join(workspace, "tasks", "archive");
    const days = await readdir(archiveRoot);
    expect(days).toHaveLength(1);
    await expect(readFile(join(archiveRoot, days[0]!, "task.json"), "utf-8")).resolves.toContain('"task_id":"task-1"');
  });

  it("keeps escalated task queue files visible when archiving is enabled", async () => {
    const workspace = await makeQueuedWorkspace();
    const result = await new LoopEngine({
      loopId: "loop-archive-failed",
      workspacePath: workspace,
      sources: ["task_queue"],
      verifyCommands: ["node -e \"process.exit(1)\""],
      maxIterations: 1,
      archiveCompletedTasks: true,
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "escalated",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.queue.archived",
      payload: expect.objectContaining({
        task_id: "task-1",
        archived: false,
        reason: "task did not succeed",
      }),
    }));
    await expect(readFile(join(workspace, "tasks", "task.json"), "utf-8")).resolves.toContain('"task_id":"task-1"');
  });

  it("calls runPublish once and emits loop.skill.published when a skill task verifies green", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-engine-publish-"));
    await mkdir(join(workspace, "tasks"));
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "skill-task-1",
      capability: "skill.publish",
      prompt: "Publish the skill",
      priority: 80,
      context: { publish: { skillId: "signals.group-effect-ledger" } },
    }));

    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        contract: "1.1",
        status: "published",
        id: "signals.group-effect-ledger",
        score: 100,
        gate: "team",
        apiVerified: true,
        durationMs: 1234,
      }),
      exitCode: 0,
    }));
    const publishDeps: RunPublishDeps = { runCommand, sleep: async () => {} };

    const result = await new LoopEngine({
      loopId: "loop-publish-success",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      publish: PublishConfig.parse({ enabled: true }),
      publishDeps,
    }).runOnce();

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "skill-task-1",
      outcome: "success",
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.skill.published",
      payload: expect.objectContaining({
        task_id: "skill-task-1",
        skill_id: "signals.group-effect-ledger",
        score: 100,
        gate: "team",
        apiVerified: true,
      }),
    }));
    expect(result.state.decisions?.some((line) => line.includes("published signals.group-effect-ledger to hub"))).toBe(true);
  });

  it("attaches published_asset evidence and emits loop.skill.release_recorded with the immutable release identity", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-engine-release-"));
    await mkdir(join(workspace, "tasks"));
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "skill-task-rel",
      capability: "skill.publish",
      prompt: "Publish the skill",
      priority: 80,
      context: { publish: { skillId: "signals.group-effect-ledger" } },
    }));

    const DIGEST = `sha256:${"a".repeat(64)}`;
    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        contract: "1.1",
        status: "published",
        id: "signals.group-effect-ledger",
        score: 100,
        gate: "team",
        apiVerified: true,
        durationMs: 1234,
        releaseId: "organization__osborn/signals.group-effect-ledger@0.1.0",
        digest: DIGEST,
        namespace: "organization/osborn",
        storage_key: "organization__osborn/signals.group-effect-ledger/0.1.0",
      }),
      exitCode: 0,
    }));
    const publishDeps: RunPublishDeps = { runCommand, sleep: async () => {} };

    const result = await new LoopEngine({
      loopId: "loop-release-recorded",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      publish: PublishConfig.parse({ enabled: true }),
      publishDeps,
    }).runOnce();

    // release identity persisted on the completed task
    expect(result.state.completed_tasks[0]?.published_asset).toMatchObject({
      status: "published",
      asset_id: "signals.group-effect-ledger",
      gate: "team",
      release_id: "organization__osborn/signals.group-effect-ledger@0.1.0",
      digest: DIGEST,
      namespace: "organization/osborn",
      storage_key: "organization__osborn/signals.group-effect-ledger/0.1.0",
    });
    // distinct additive event carrying the release identity
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.skill.release_recorded",
      payload: expect.objectContaining({
        release_id: "organization__osborn/signals.group-effect-ledger@0.1.0",
        digest: DIGEST,
      }),
    }));
    // both events present (existing + new), not a replacement
    expect(result.events.some((e) => e.type === "loop.skill.published")).toBe(true);
  });

  it("emits loop.skill.publish_blocked and keeps the task success when publish is blocked", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-engine-publish-blocked-"));
    await mkdir(join(workspace, "tasks"));
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "skill-task-2",
      capability: "skill.publish",
      prompt: "Publish the skill",
      priority: 80,
      context: { publish: { skillId: "signals.blocked-skill" } },
    }));

    const runCommand = vi.fn(async () => ({
      stdout: JSON.stringify({
        contract: "1.1",
        status: "blocked",
        id: "signals.blocked-skill",
        durationMs: 100,
        reasons: ["score<gate", "leak at /Volumes/AIMATE_WORK/osborn-hub-store/v1/client-secret"],
      }),
      exitCode: 2,
    }));
    const publishDeps: RunPublishDeps = { runCommand, sleep: async () => {} };

    const result = await new LoopEngine({
      loopId: "loop-publish-blocked",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      publish: PublishConfig.parse({ enabled: true }),
      publishDeps,
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "skill-task-2",
      outcome: "success",
    });
    const blockedEvent = result.events.find((e) => e.type === "loop.skill.publish_blocked");
    expect(blockedEvent?.payload).toMatchObject({ task_id: "skill-task-2", skill_id: "signals.blocked-skill", status: "blocked" });
    // the event payload reasons are REDACTED — no absolute store path leaks to events.jsonl
    expect(JSON.stringify(blockedEvent?.payload)).not.toContain("/Volumes/");
    expect((blockedEvent?.payload as { reasons: string[] }).reasons).toContain("score<gate");
    expect(result.state.decisions?.some((line) => line.includes("NEEDS-ATTENTION"))).toBe(true);
    expect(result.state.decisions?.some((line) => line.includes("/Volumes/"))).toBe(false);
  });

  it("never calls runPublish when publish.enabled is false", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-engine-publish-disabled-"));
    await mkdir(join(workspace, "tasks"));
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "skill-task-3",
      capability: "skill.publish",
      prompt: "Publish the skill",
      priority: 80,
      context: { publish: { skillId: "signals.disabled-skill" } },
    }));

    const runCommand = vi.fn(async () => ({ stdout: "{}", exitCode: 0 }));
    const publishDeps: RunPublishDeps = { runCommand, sleep: async () => {} };

    const result = await new LoopEngine({
      loopId: "loop-publish-disabled",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      publish: PublishConfig.parse({ enabled: false }),
      publishDeps,
    }).runOnce();

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.state.completed_tasks[0]).toMatchObject({ outcome: "success" });
  });

  it("never calls runPublish for a non-skill task even when publish is enabled", async () => {
    const workspace = await makeQueuedWorkspace();
    const runCommand = vi.fn(async () => ({ stdout: "{}", exitCode: 0 }));
    const publishDeps: RunPublishDeps = { runCommand, sleep: async () => {} };

    const result = await new LoopEngine({
      loopId: "loop-publish-non-skill",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      publish: PublishConfig.parse({ enabled: true }),
      publishDeps,
    }).runOnce();

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.state.completed_tasks[0]).toMatchObject({ task_id: "task-1", outcome: "success" });
  });

  it("never calls runPublish when verify fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-engine-publish-verify-fail-"));
    await mkdir(join(workspace, "tasks"));
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "skill-task-4",
      capability: "skill.publish",
      prompt: "Publish the skill",
      priority: 80,
      context: { publish: { skillId: "signals.verify-fail-skill" } },
    }));

    const runCommand = vi.fn(async () => ({ stdout: "{}", exitCode: 0 }));
    const publishDeps: RunPublishDeps = { runCommand, sleep: async () => {} };

    const result = await new LoopEngine({
      loopId: "loop-publish-verify-fail",
      workspacePath: workspace,
      sources: ["task_queue"],
      verifyCommands: ["node -e \"process.exit(1)\""],
      maxIterations: 1,
      publish: PublishConfig.parse({ enabled: true }),
      publishDeps,
    }).runOnce();

    expect(runCommand).not.toHaveBeenCalled();
    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "skill-task-4",
      outcome: "escalated",
    });
  });

  it("can execute a successful task in an isolated git worktree and merge it back", async () => {
    const workspace = await makeGitQueuedWorkspace("initial\n");
    const worktreeRoot = join(workspace, "..", "isolated-worktrees");
    const result = await new LoopEngine({
      loopId: "loop-worktree",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('app.txt', 'changed in worktree\\n')\"",
      verifyCommands: ["node -e \"process.exit(require('fs').readFileSync('app.txt','utf8').includes('changed') ? 0 : 1)\""],
      useWorktree: true,
      worktreeRoot,
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      worktree_branch: expect.stringContaining("osstack/loop/loop-worktree/"),
      worktree_commit: expect.any(String),
      worktree_branch_preserved: false,
    });
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "loop.worktree.created",
      "loop.worktree.merged",
      "loop.worktree.cleaned",
    ]));
    await expect(readFile(join(workspace, "app.txt"), "utf-8")).resolves.toBe("changed in worktree\n");
    expect(await git(workspace, ["worktree", "list", "--porcelain"])).not.toContain("osstack/loop/");
  });

  it("cleans a failed isolated worktree without merging its changes", async () => {
    const workspace = await makeGitQueuedWorkspace("stable\n");
    const result = await new LoopEngine({
      loopId: "loop-worktree-fail",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('app.txt', 'bad change\\n')\"",
      verifyCommands: ["node -e \"process.exit(1)\""],
      maxIterations: 1,
      useWorktree: true,
      worktreeRoot: join(workspace, "..", "failed-worktrees"),
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "escalated",
    });
    expect(result.events.map((event) => event.type)).toContain("loop.worktree.cleaned");
    expect(result.events.map((event) => event.type)).not.toContain("loop.worktree.merged");
    await expect(readFile(join(workspace, "app.txt"), "utf-8")).resolves.toBe("stable\n");
    expect(await git(workspace, ["worktree", "list", "--porcelain"])).not.toContain("osstack/loop/");
  });

  it("cleans loop-scoped orphaned worktrees after each cycle", async () => {
    const workspace = await makeGitQueuedWorkspace("base\n");
    const loopId = "loop-orphan-cycle";
    const worktreeRoot = join(workspace, "..", "orphan-cycle-worktrees");
    const orphanPath = join(worktreeRoot, "manual-orphan");
    const command = [
      "const fs=require('fs')",
      "const cp=require('child_process')",
      "fs.writeFileSync('app.txt','cycle change\\n')",
      `cp.execFileSync('git',['-C',${JSON.stringify(workspace)},'worktree','add','-b','osstack/loop/${loopId}/manual-orphan',${JSON.stringify(orphanPath)},'HEAD'])`,
    ].join(";");

    const result = await new LoopEngine({
      loopId,
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: `node -e ${JSON.stringify(command)}`,
      verifyCommands: ["node -e \"process.exit(require('fs').readFileSync('app.txt','utf8') === 'cycle change\\n' ? 0 : 1)\""],
      useWorktree: true,
      worktreeRoot,
    }).runOnce();

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.worktree.orphans_cleaned",
      payload: expect.objectContaining({
        phase: "after_cycle",
        removed_count: 1,
        branches: ["osstack/loop/loop-orphan-cycle/manual-orphan"],
      }),
    }));
    expect(await git(workspace, ["worktree", "list", "--porcelain"])).not.toContain(orphanPath);
    await expect(git(workspace, ["rev-parse", "--verify", "osstack/loop/loop-orphan-cycle/manual-orphan"])).rejects.toThrow();
  });

  it("leaves the completed task unchanged when self-improvement is disabled", async () => {
    const workspace = await makeQueuedWorkspace();
    const assetize = vi.fn();
    const result = await new LoopEngine({
      loopId: "loop-self-improve-off",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      selfImprovement: { repoId: "demo", enabled: false, assetize },
    }).runOnce();

    expect(assetize).not.toHaveBeenCalled();
    const task = result.state.completed_tasks[0]!;
    expect(task).toMatchObject({ task_id: "task-1", outcome: "success" });
    expect(task.trace_id).toBeUndefined();
    expect(task.feedback_asset_ids).toBeUndefined();
    expect(task.proposal_ids).toBeUndefined();
    expect(task.self_improvement_level).toBeUndefined();
    expect(result.events.map((event) => event.type)).not.toContain("loop.self_improvement.done");
  });

  it("attaches assetization ids and summary when self-improvement is enabled", async () => {
    const workspace = await makeQueuedWorkspace();
    const assetize = vi.fn(async (input: { completedTask: { task_id: string }; loopId: string; repoId: string; proposeImprovements: boolean }) => {
      expect(input.repoId).toBe("demo");
      expect(input.loopId).toBe("loop-self-improve-on");
      expect(input.proposeImprovements).toBe(true);
      expect(input.completedTask.task_id).toBe("task-1");
      return {
        trace_id: "trace_demo_task-1_abc123",
        feedback_asset_ids: ["asset_1", "asset_2"],
        proposal_ids: ["prop_1"],
        assetization_summary: "1 trace -> 2 assets -> 1 proposal",
        self_improvement_level: 3,
      };
    });

    const result = await new LoopEngine({
      loopId: "loop-self-improve-on",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      selfImprovement: { repoId: "demo", enabled: true, proposeImprovements: true, assetize },
    }).runOnce();

    expect(assetize).toHaveBeenCalledTimes(1);
    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      trace_id: "trace_demo_task-1_abc123",
      feedback_asset_ids: ["asset_1", "asset_2"],
      proposal_ids: ["prop_1"],
      assetization_summary: "1 trace -> 2 assets -> 1 proposal",
      self_improvement_level: 3,
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.self_improvement.done",
      payload: expect.objectContaining({
        task_id: "task-1",
        trace_id: "trace_demo_task-1_abc123",
        feedback_asset_count: 2,
        proposal_count: 1,
        self_improvement_level: 3,
      }),
    }));
  });

  it("never fails a task when the self-improvement callback throws", async () => {
    const workspace = await makeQueuedWorkspace();
    const assetize = vi.fn(async () => { throw new Error("assetizer exploded"); });

    const result = await new LoopEngine({
      loopId: "loop-self-improve-throws",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      selfImprovement: { repoId: "demo", enabled: true, assetize },
    }).runOnce();

    expect(assetize).toHaveBeenCalledTimes(1);
    const task = result.state.completed_tasks[0]!;
    expect(task).toMatchObject({ task_id: "task-1", outcome: "success" });
    expect(task.trace_id).toBeUndefined();
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.self_improvement.failed",
      payload: expect.objectContaining({ task_id: "task-1", error: "assetizer exploded" }),
    }));
  });

  it("preserves the isolated branch when a successful task cannot fast-forward merge", async () => {
    const workspace = await makeGitQueuedWorkspace("base\n");
    const worktreeRoot = join(workspace, "..", "merge-conflict-worktrees");
    const command = [
      "const fs=require('fs')",
      "const cp=require('child_process')",
      "fs.writeFileSync('app.txt','worktree change\\n')",
      `fs.writeFileSync(${JSON.stringify(join(workspace, "app.txt"))},'main change\\n')`,
      `cp.execFileSync('git',['-C',${JSON.stringify(workspace)},'add','app.txt'])`,
      `cp.execFileSync('git',['-C',${JSON.stringify(workspace)},'-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','advance main'])`,
    ].join(";");

    await expect(new LoopEngine({
      loopId: "loop-worktree-merge-conflict",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: `node -e ${JSON.stringify(command)}`,
      verifyCommands: ["node -e \"process.exit(require('fs').readFileSync('app.txt','utf8') === 'worktree change\\n' ? 0 : 1)\""],
      useWorktree: true,
      worktreeRoot,
    }).runOnce()).rejects.toThrow(/merge --ff-only/);

    expect(await git(workspace, ["branch", "--list", "osstack/loop/*"])).toContain("osstack/loop/");
    expect(await git(workspace, ["worktree", "list", "--porcelain"])).not.toContain(worktreeRoot);
    await expect(readFile(join(workspace, "app.txt"), "utf-8")).resolves.toBe("main change\n");
  });
});

async function makeGitQueuedWorkspace(appContents: string): Promise<string> {
  const workspace = await makeQueuedWorkspace();
  await git(workspace, ["init", "-b", "main"]);
  await writeFile(join(workspace, "app.txt"), appContents);
  await git(workspace, ["add", "app.txt"]);
  await git(workspace, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  return workspace;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

class FakeLoopAdapter implements AgentAdapter {
  readonly id: string;
  readonly display_name = "Fake Loop Agent";
  readonly cost_tier: CostTier;
  private readonly outputFile: string;

  constructor(options: { id?: string; costTier?: CostTier; outputFile?: string } = {}) {
    this.id = options.id ?? "fake-loop-agent";
    this.cost_tier = options.costTier ?? "low";
    this.outputFile = options.outputFile ?? "agent-output.txt";
  }

  capabilities(): readonly Capability[] {
    return [
      CapabilitySchema.parse({
        id: `${this.id}.code.test`,
        kind: "code.test",
        agent_id: this.id,
        description: "Fake loop adapter for tests",
        cost_tier: this.cost_tier,
      }),
    ];
  }

  async isAvailable(): Promise<AgentAvailability> {
    return { available: true, last_checked_at: Math.floor(Date.now() / 1000) };
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    yield fakeEvent(task, 0, "run.started", {
      status: "running",
      controls: {
        cancel: true,
        approval_pending: false,
        clarify_pending: false,
        queue: false,
        goal: false,
      },
    });

    if (signal.aborted) {
      yield fakeEvent(task, 1, "done", {
        status: "cancelled",
        last_seq: 0,
        result_summary: "cancelled before writing",
      }, true);
      return;
    }

    const repoPath = typeof task.context?.["repo_path"] === "string" ? task.context["repo_path"] : undefined;
    if (repoPath === undefined) {
      yield fakeEvent(task, 1, "error", {
        code: "missing_repo_path",
        message: "repo_path context is required",
        terminal: true,
      }, true);
      return;
    }

    await writeFile(join(repoPath, this.outputFile), `adapter wrote: ${task.prompt}\n`);
    yield fakeEvent(task, 1, "done", {
      status: "completed",
      last_seq: 0,
      result_summary: "fake adapter completed",
    }, true);
  }
}

class FakeReviewAdapter implements AgentAdapter {
  readonly id = "fake-reviewer";
  readonly display_name = "Fake Reviewer";
  readonly cost_tier: CostTier = "low";

  capabilities(): readonly Capability[] {
    return [
      CapabilitySchema.parse({
        id: "fake-reviewer.review.code",
        kind: "review.code",
        agent_id: this.id,
        description: "Fake reviewer adapter for tests",
        cost_tier: this.cost_tier,
      }),
    ];
  }

  async isAvailable(): Promise<AgentAvailability> {
    return { available: true, last_checked_at: Math.floor(Date.now() / 1000) };
  }

  async *invoke(task: AgentTask): AsyncIterable<HermesEvent> {
    const repoPath = typeof task.context?.["repo_path"] === "string" ? task.context["repo_path"] : undefined;
    const subjectRunId = typeof task.context?.["subject_run_id"] === "string" ? task.context["subject_run_id"] : "missing";
    if (repoPath === undefined) {
      yield fakeEvent(task, 1, "error", {
        code: "missing_repo_path",
        message: "repo_path context is required",
        terminal: true,
      }, true);
      return;
    }

    await writeFile(join(repoPath, "review-output.txt"), `reviewed ${subjectRunId}\n`);
    yield fakeEvent(task, 1, "done", {
      status: "completed",
      last_seq: 0,
      result_summary: "fake review passed",
      implementation_deviations: task.context?.["emit_deviation"] === true
        ? [{
            deviation_id: "architecture-drift-1",
            question: "Should the implementation retain the documented adapter boundary?",
            category: "interface",
            doc_type: "tech",
            impact: 3,
            irreversibility: 2,
            uncertainty: 2,
            required: true,
            destination_hint: "technical_design",
            evidence: [{ path: "agent-output.txt", line: 1 }],
          }]
        : undefined,
    }, true);
  }
}

function fakeEvent(
  task: AgentTask,
  seq: number,
  type: "run.started" | "done" | "error",
  payload: unknown,
  terminal = false,
): HermesEvent {
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
