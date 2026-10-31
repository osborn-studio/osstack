import { loopContainmentPath } from "./loop-containment.js";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync } from "node:fs";
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
    const workspace = await makeGitQueuedWorkspace("baseline\n");
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
      .rejects.toThrow();
  });

  it("emits the frozen profile and role identities at plan and verify boundaries", async () => {
    const workspace = await makeGitQueuedWorkspace("baseline\n");
    const builder = new FakeLoopAdapter({
      id: "claude-code",
      outputFile: "profile-output.txt",
    });
    const evaluator = new FakeReviewAdapter();
    const result = await new LoopEngine({
      loopId: "loop-profile-evidence",
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: builder.id,
      verifierAgentIds: [evaluator.id],
      adapters: [builder, evaluator],
      profileRouting: profileRoutingFixture(),
    }).runOnce();

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.plan.done",
      payload: expect.objectContaining({
        profile_name: "mac-mini",
        builder_identity: expect.objectContaining({
          adapter_id: "claude-code",
          provider_id: "anthropic",
          model_id: "claude-current",
        }),
      }),
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.verify.done",
      payload: expect.objectContaining({
        profile_name: "mac-mini",
        evaluator_identity: expect.objectContaining({
          adapter_id: "fake-reviewer",
          provider_id: "review-provider",
          model_id: "review-current",
        }),
        independence_reason: "reported provider or model differs",
      }),
    }));
  });

  it("persists redacted structured Kimi review evidence in events and completed tasks", async () => {
    const workspace = await makeGitQueuedWorkspace("stable\n");
    await git(workspace, ["mv", "app.txt", "app.ts"]);
    await git(workspace, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "use TypeScript fixture",
    ]);
    const verifier = await import("./verifier.js"); const actualVerify = verifier.verifyRun;
    const seenIssues: unknown[] = [];
    const spy = vi.spyOn(verifier, "verifyRun").mockImplementation(async (...args) => { const result = await actualVerify(...args); seenIssues.push(...result.issues); return result; });
    const reviewer = new FakeKimiReviewAdapter();
    const result = await new LoopEngine({
      loopId: "loop-kimi-review",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('app.ts', 'review me\\n')\"",
      verifierAgentIds: [reviewer.id],
      adapters: [reviewer],
    }).runOnce();

    spy.mockRestore(); expect(seenIssues).toEqual([]);
    const expectedReview = expect.objectContaining({
      schema_version: 1,
      reviewer_agent_id: "kimi-code",
      verdict: "approved",
      markdown: expect.stringContaining("[REDACTED:"),
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "loop.verify.done",
      payload: expect.objectContaining({
        pass: true,
        review_artifacts: [expectedReview],
      }),
    }));
    expect(result.state.completed_tasks[0]).toMatchObject({
      outcome: "success",
      review_artifacts: [expectedReview],
    });
    expect(JSON.stringify(result.events)).not.toContain("sk-test-secret-token");
    expect(JSON.stringify(result.state.completed_tasks[0])).not.toContain("sk-test-secret-token");
  });

  it("emits a dedicated event only for a verifier's structured implementation deviation", async () => {
    const workspace = await makeGitQueuedWorkspace("baseline\n");
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

  it("refuses an explicit verifier execution role before launching the builder", async () => {
    const workspace = await makeQueuedWorkspace();
    const adapter = new FakeLoopAdapter({ id: "same-agent" });
    const invoke = vi.spyOn(adapter, "invoke");
    await expect(new LoopEngine({ workspacePath: workspace, sources: ["task_queue"],
      agentId: adapter.id, verifierAgentIds: [adapter.id], adapters: [adapter], maxIterations: 1 }).runOnce()).rejects.toThrow("VERIFIER_EXECUTION_ROLE_CONFLICT");
    expect(invoke).not.toHaveBeenCalled();
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

  it("can execute a successful task in an isolated git worktree and merge it back when local landing is opted in", async () => {
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
      localLanding: { targetBranch: "main" },
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

  it("never lands locally by default: a successful worktree run keeps its accepted commit on the task branch (D7)", async () => {
    const workspace = await makeGitQueuedWorkspace("initial\n");
    const before = await git(workspace, ["rev-parse", "HEAD"]);
    const result = await new LoopEngine({
      loopId: "loop-worktree-no-landing",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('app.txt', 'changed in worktree\\n')\"",
      verifyCommands: ["node -e \"process.exit(require('fs').readFileSync('app.txt','utf8').includes('changed') ? 0 : 1)\""],
      useWorktree: true,
      worktreeRoot: join(workspace, "..", "no-landing-worktrees"),
    }).runOnce();

    const task = result.state.completed_tasks[0]!;
    expect(task).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      worktree_commit: expect.stringMatching(/^[a-f0-9]{40}$/),
      worktree_branch_preserved: true,
    });
    const types = result.events.map((event) => event.type);
    expect(types).toContain("loop.worktree.preserved");
    expect(types).not.toContain("loop.worktree.merged");
    expect(result.events.find((event) => event.type === "loop.worktree.preserved")?.payload).toMatchObject({
      reason: "local_landing_disabled", commit: task.worktree_commit, branch: task.worktree_branch,
    });
    await expect(git(workspace, ["rev-parse", "HEAD"])).resolves.toBe(before);
    await expect(readFile(join(workspace, "app.txt"), "utf-8")).resolves.toBe("initial\n");
    await expect(git(workspace, ["rev-parse", `refs/heads/${task.worktree_branch}`])).resolves.toBe(task.worktree_commit);
    await expect(git(workspace, ["show", `${task.worktree_commit}:app.txt`])).resolves.toBe("changed in worktree");
  });

  it("refuses local landing when the main checkout is not on the pinned target branch (D7)", async () => {
    const workspace = await makeGitQueuedWorkspace("initial\n");
    await git(workspace, ["branch", "release"]);
    const before = await git(workspace, ["rev-parse", "HEAD"]);
    await expect(new LoopEngine({
      loopId: "loop-worktree-wrong-target",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('app.txt', 'changed in worktree\\n')\"",
      verifyCommands: ["node -e \"process.exit(0)\""],
      useWorktree: true,
      worktreeRoot: join(workspace, "..", "wrong-target-worktrees"),
      localLanding: { targetBranch: "release" },
    }).runOnce()).rejects.toThrow(/main checkout is on main, not the landing target release/);
    await expect(git(workspace, ["rev-parse", "refs/heads/main"])).resolves.toBe(before);
    await expect(git(workspace, ["rev-parse", "refs/heads/release"])).resolves.toBe(before);
    const branches = await git(workspace, ["branch", "--list", "osstack/loop/*"]);
    expect(branches).toContain("osstack/loop/loop-worktree-wrong-target/");
  });

  it("validates the local landing opt-in up front", () => {
    expect(() => new LoopEngine({ workspacePath: "/nonexistent", localLanding: { targetBranch: "main" } })).toThrow("LOCAL_LANDING_WORKTREE_REQUIRED");
    expect(() => new LoopEngine({ workspacePath: "/nonexistent", useWorktree: true, localLanding: { targetBranch: " " } })).toThrow("LOCAL_LANDING_TARGET_REQUIRED");
    expect(() => new LoopEngine({ workspacePath: "/nonexistent", useWorktree: true, localLanding: { targetBranch: "main" },
      guardedLocalCandidate: { mode: "artifact_only", inspect: async () => {} } })).toThrow("LOCAL_LANDING_FORBIDDEN_FOR_GUARDED_CANDIDATE");
  });

  it("preserves executor-made commits instead of deleting the branch when the tree is clean (D6)", async () => {
    const workspace = await makeGitQueuedWorkspace("initial\n");
    const before = await git(workspace, ["rev-parse", "HEAD"]);
    const command = [
      "const fs=require('fs')",
      "const cp=require('child_process')",
      "fs.writeFileSync('app.txt','committed by executor\\n')",
      "cp.execFileSync('git',['add','app.txt'])",
      "cp.execFileSync('git',['-c','user.name=exec','-c','user.email=exec@example.invalid','commit','-qm','executor commit'])",
    ].join(";");
    const result = await new LoopEngine({
      loopId: "loop-worktree-executor-commit",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: `node -e ${JSON.stringify(command)}`,
      verifyCommands: ["node -e \"process.exit(require('fs').readFileSync('app.txt','utf8').startsWith('committed') ? 0 : 1)\""],
      useWorktree: true,
      worktreeRoot: join(workspace, "..", "executor-commit-worktrees"),
    }).runOnce();

    const task = result.state.completed_tasks[0]!;
    expect(task).toMatchObject({ task_id: "task-1", outcome: "success", worktree_branch_preserved: true, worktree_commit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(result.events.find((event) => event.type === "loop.worktree.preserved")?.payload).toMatchObject({ reason: "executor_commits", commit: task.worktree_commit });
    expect(result.events.find((event) => event.type === "loop.worktree.cleaned")?.payload).toMatchObject({ branch_removed: false });
    await expect(git(workspace, ["rev-parse", `refs/heads/${task.worktree_branch}`])).resolves.toBe(task.worktree_commit);
    await expect(git(workspace, ["log", "-1", "--format=%s", task.worktree_commit!])).resolves.toBe("executor commit");
    await expect(git(workspace, ["rev-parse", "HEAD"])).resolves.toBe(before);
  });

  it("refuses to land executor-made commits even with local landing opted in (D6)", async () => {
    const workspace = await makeGitQueuedWorkspace("initial\n");
    const before = await git(workspace, ["rev-parse", "HEAD"]);
    const command = [
      "const fs=require('fs')",
      "const cp=require('child_process')",
      "fs.writeFileSync('app.txt','committed by executor\\n')",
      "cp.execFileSync('git',['add','app.txt'])",
      "cp.execFileSync('git',['-c','user.name=exec','-c','user.email=exec@example.invalid','commit','-qm','executor commit'])",
    ].join(";");
    await expect(new LoopEngine({
      loopId: "loop-worktree-executor-commit-land",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: `node -e ${JSON.stringify(command)}`,
      verifyCommands: ["node -e \"process.exit(0)\""],
      useWorktree: true,
      worktreeRoot: join(workspace, "..", "executor-commit-land-worktrees"),
      localLanding: { targetBranch: "main" },
    }).runOnce()).rejects.toThrow(/executor-made commits/);
    await expect(git(workspace, ["rev-parse", "HEAD"])).resolves.toBe(before);
    const branch = (await git(workspace, ["branch", "--list", "--format=%(refname:short)", "osstack/loop/*"])).trim();
    expect(branch).toContain("osstack/loop/loop-worktree-executor-commit-land/");
    await expect(git(workspace, ["log", "-1", "--format=%s", branch])).resolves.toBe("executor commit");
  });

  it("merges untracked-only worktree output when repository config hides untracked files", async () => {
    const workspace = await makeGitQueuedWorkspace("initial\n");
    await git(workspace, ["config", "status.showUntrackedFiles", "no"]);
    const result = await new LoopEngine({
      loopId: "loop-worktree-hidden-untracked",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('generated.txt', 'new in worktree\\n')\"",
      verifyCommands: ["node -e \"process.exit(require('fs').existsSync('generated.txt') ? 0 : 1)\""],
      useWorktree: true,
      worktreeRoot: join(workspace, "..", "hidden-untracked-worktrees"),
      localLanding: { targetBranch: "main" },
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "success",
      worktree_commit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    await expect(readFile(join(workspace, "generated.txt"), "utf-8")).resolves.toBe("new in worktree\n");
    await expect(git(workspace, ["rev-parse", "HEAD"])).resolves.toBe(result.state.completed_tasks[0]?.worktree_commit);
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

  it("does not promote cancelled Builder changes when deterministic verification passes", async () => {
    const workspace = await makeGitQueuedWorkspace("stable\n");
    const adapter = new FakeLoopAdapter({
      outputFile: "cancelled-output.txt",
      terminalStatus: "cancelled",
    });
    const result = await new LoopEngine({
      loopId: "loop-worktree-cancelled",
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: adapter.id,
      adapters: [adapter],
      verifyCommands: [
        "node -e \"process.exit(require('fs').existsSync('cancelled-output.txt') ? 0 : 1)\"",
      ],
      maxIterations: 1,
      useWorktree: true,
      worktreeRoot: join(workspace, "..", "cancelled-worktrees"),
    }).runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      task_id: "task-1",
      outcome: "escalated",
      verify_issues: [
        expect.objectContaining({
          rule: "execute.outcome_not_completed",
        }),
      ],
    });
    expect(result.events.map((event) => event.type)).toContain(
      "loop.worktree.cleaned",
    );
    expect(result.events.map((event) => event.type)).not.toContain(
      "loop.worktree.merged",
    );
    await expect(readFile(join(workspace, "cancelled-output.txt"), "utf-8"))
      .rejects.toThrow();
  });

  it("retains loop-scoped worktrees whose ownership is unproven", async () => {
    const workspace = await makeGitQueuedWorkspace("base\n");
    const loopId = "loop-orphan-cycle";
    const worktreeRoot = join(workspace, ".git", "orphan-cycle-worktrees");
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

    expect(result.completedTasks[0]?.outcome).toBe("success");
    expect(result.events.some((event) => event.type === "loop.worktree.orphans_cleaned")).toBe(false);
    expect(await git(workspace, ["worktree", "list", "--porcelain"])).toContain("osstack/loop/loop-orphan-cycle/manual-orphan");
    await expect(git(workspace, ["rev-parse", "--verify", "osstack/loop/loop-orphan-cycle/manual-orphan"])).resolves.toBeTruthy();
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

  it("keeps the isolated worktree when Git cannot commit its verified changes", async () => {
    const workspace = await makeGitQueuedWorkspace("base\n");
    const worktreeRoot = join(workspace, "..", "commit-unavailable-worktrees");
    const command = [
      "const fs=require('fs')",
      "const cp=require('child_process')",
      "fs.writeFileSync('app.txt','verified but uncommitted\\n')",
      // A stale index lock makes `git add` fail after verification passed.
      "fs.writeFileSync(cp.execFileSync('git',['rev-parse','--path-format=absolute','--git-path','index.lock'],{encoding:'utf8'}).trim(),'')",
    ].join(";");

    await expect(new LoopEngine({
      loopId: "loop-worktree-commit-unavailable",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: `node -e ${JSON.stringify(command)}`,
      verifyCommands: ["node -e \"process.exit(require('fs').readFileSync('app.txt','utf8').startsWith('verified') ? 0 : 1)\""],
      useWorktree: true,
      worktreeRoot,
    }).runOnce()).rejects.toThrow(/index\.lock|git add/);

    const listed = await git(workspace, ["worktree", "list", "--porcelain"]);
    const retained = listed.split("\n").find((line) => line.startsWith("worktree ") && line.includes("commit-unavailable-worktrees"));
    expect(retained).toBeDefined();
    await expect(readFile(join(retained!.slice("worktree ".length), "app.txt"), "utf-8")).resolves.toBe("verified but uncommitted\n");
    await expect(readFile(join(workspace, "app.txt"), "utf-8")).resolves.toBe("base\n");
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
      localLanding: { targetBranch: "main" },
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
  private readonly terminalStatus: "completed" | "cancelled";

  constructor(options: {
    id?: string;
    costTier?: CostTier;
    outputFile?: string;
    terminalStatus?: "completed" | "cancelled";
  } = {}) {
    this.id = options.id ?? "fake-loop-agent";
    this.cost_tier = options.costTier ?? "low";
    this.outputFile = options.outputFile ?? "agent-output.txt";
    this.terminalStatus = options.terminalStatus ?? "completed";
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
      status: this.terminalStatus,
      last_seq: 0,
      result_summary: `fake adapter ${this.terminalStatus}`,
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
    if (repoPath === undefined) {
      yield fakeEvent(task, 1, "error", {
        code: "missing_repo_path",
        message: "repo_path context is required",
        terminal: true,
      }, true);
      return;
    }

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

class FakeKimiReviewAdapter implements AgentAdapter {
  readonly id = "kimi-code";
  readonly display_name = "Fake Kimi Reviewer";
  readonly cost_tier: CostTier = "low";

  capabilities(): readonly Capability[] {
    return [
      CapabilitySchema.parse({
        id: "kimi-code.code.review",
        kind: "code.review",
        agent_id: this.id,
        description: "Fake structured Kimi reviewer for tests",
        cost_tier: this.cost_tier,
      }),
    ];
  }

  async isAvailable(): Promise<AgentAvailability> {
    return { available: true, last_checked_at: Math.floor(Date.now() / 1000) };
  }

  async *invoke(task: AgentTask): AsyncIterable<HermesEvent> {
    yield fakeEvent(task, 1, "done", {
      status: "completed",
      last_seq: 0,
      result_summary: "structured Kimi review approved",
      review: {
        schema_version: 1,
        verdict: "approved",
        risk: "read_only",
        markdown: "# Review\n\nApproved with token sk-test-secret-token-12345678901234567890",
        judgments: [],
        findings: [],
        recommended_actions: [],
        evidence_refs: ["app.ts"],
        runtime_identity: {
          adapter_id: "kimi-code",
          adapter_version: "0.29.1",
          auth_mode: "subprocess/login-reuse",
          provider_id: "kimi",
          model_id: "kimi-code/k3",
          agent_profile: "osstack-reviewer",
          evidence_source: "configured",
        },
      },
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

function profileRoutingFixture() {
  return {
    profile_name: "mac-mini",
    reason: "pinned profile \"mac-mini\"",
    builder_agent_id: "claude-code",
    evaluator_agent_id: "fake-reviewer",
    builder_identity: {
      adapter_id: "claude-code",
      adapter_version: "1.0.0",
      auth_mode: "login-reuse",
      provider_id: "anthropic",
      model_id: "claude-current",
      evidence_source: "reported",
    },
    evaluator_identity: {
      adapter_id: "fake-reviewer",
      adapter_version: "1.0.0",
      auth_mode: "test",
      provider_id: "review-provider",
      model_id: "review-current",
      evidence_source: "reported",
    },
    independent: true,
    independence_reason: "reported provider or model differs",
  };
}

it("retains uncertain verifier execution and never retries it after timeout or restart", async () => {
  const workspace=await makeGitQueuedWorkspace("base\n");const reviewer=new FakeReviewAdapter();let invocations=0;
  vi.spyOn(reviewer,"invoke").mockImplementation(()=>{
    invocations++;
    const iterator: AsyncIterableIterator<HermesEvent>={next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{}),[Symbol.asyncIterator](){return this;}};
    return iterator;
  });
  const options={workspacePath:workspace,sources:["task_queue" as const],executeCommand:"node -e \"require('fs').appendFileSync('execution-count.txt','x')\"",
    verifierAgentIds:[reviewer.id],adapters:[reviewer],maxIterations:3,commandTimeoutMs:1000};
  const first=await new LoopEngine(options).runOnce();
  expect(first.state.completed_tasks[0]).toMatchObject({outcome:"escalated",iterations:1,implementation_unconfirmed:true});
  expect(first.events).toContainEqual(expect.objectContaining({type:"loop.verify.done",payload:expect.objectContaining({pass:false})}));
  await new LoopEngine(options).runOnce();
  expect(invocations).toBe(1);
  expect(await readFile(join(workspace,"execution-count.txt"),"utf8")).toBe("x");
});

it("keeps prearmed containment when state persistence fails after unknown verifier stop", async () => {
  const workspace = await makeGitQueuedWorkspace("base\n");
  const stateFile = await import("./state-file.js");
  const reviewer = new FakeReviewAdapter();
  let invocations = 0;
  vi.spyOn(reviewer, "invoke").mockImplementation(() => {
    invocations++;
    return { next: () => new Promise(() => {}), return: () => new Promise(() => {}),
      [Symbol.asyncIterator]() { return this; } } as AsyncIterableIterator<HermesEvent>;
  });
  const options = { workspacePath: workspace, sources: ["task_queue" as const],
    executeCommand: "node -e \"require('fs').appendFileSync('execution-count.txt','x')\"",
    verifierAgentIds: [reviewer.id], adapters: [reviewer], commandTimeoutMs: 1000 };
  const failure = vi.spyOn(stateFile, "writeLoopState").mockRejectedValueOnce(new Error("ENOSPC after unknown stop"));
  try { await expect(new LoopEngine(options).runOnce()).rejects.toThrow("ENOSPC"); }
  finally { failure.mockRestore(); }
  await expect(readFile(join(workspace, "LOOP-STATE.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(loopContainmentPath(workspace), "utf8")).toContain("containment_pending");
  const restarted = await new LoopEngine(options).runOnce();
  expect(restarted.executedTaskCount).toBe(0);
  expect(invocations).toBe(1);
  expect(await readFile(join(workspace, "execution-count.txt"), "utf8")).toBe("x");
});

it("blocks restart with an interrupted prearmed record even without any state file", async () => {
  const workspace = await makeQueuedWorkspace();
  const { armLoopContainment } = await import("./loop-containment.js");
  armLoopContainment(loopContainmentPath(workspace));
  const result = await new LoopEngine({ workspacePath: workspace, sources: ["task_queue"],
    executeCommand: "node -e \"require('fs').writeFileSync('must-not-run','x')\"" }).runOnce();
  expect(result.executedTaskCount).toBe(0);
  await expect(readFile(join(workspace, "must-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("never retries or commits candidate mutations from a generic verifier", async () => {
  const workspace = await makeGitQueuedWorkspace("baseline\n");
  const before = await git(workspace, ["rev-parse", "HEAD"]); let invocations = 0;
  const reviewer = new FakeReviewAdapter();
  reviewer.invoke = async function* (task) {
    invocations++;
    const repo = task.context?.["repo_path"]; if (typeof repo !== "string") throw Error("missing repository");
    if (invocations === 1) await writeFile(join(repo, "review-output.txt"), "foreign verifier edit");
    yield fakeEvent(task, 1, "done", { status: "completed", last_seq: 0, result_summary: "approved" }, true);
  };
  const options = { loopId: "verifier-mutation", workspacePath: workspace, sources: ["task_queue" as const], maxIterations: 3,
    executeCommand: "node -e \"require('fs').writeFileSync('app.txt','builder')\"", verifierAgentIds: [reviewer.id], adapters: [reviewer] };
  const engine = new LoopEngine(options);
  const result = await engine.runOnce();
  expect(invocations).toBe(1); expect(result.completedTasks[0]?.outcome).toBe("escalated");
  expect(result.completedTasks[0]?.implementation_unconfirmed).not.toBe(true);
  expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(before);
  expect((await new LoopEngine(options).runOnce()).executedTaskCount).toBe(0);
  expect(invocations).toBe(1);
});

it("retains candidate containment after post-review integrity cannot be observed", async () => {
  const workspace = await makeGitQueuedWorkspace("baseline\n");
  const isolation = await import("./reviewer-isolation.js"); const actual = isolation.snapshotReviewerWorkspace;
  const spy = vi.spyOn(isolation, "snapshotReviewerWorkspace").mockImplementationOnce(actual).mockImplementationOnce(actual).mockRejectedValueOnce(Error("post-observation unavailable"));
  let invocations = 0; const reviewer = new FakeReviewAdapter(); const original = reviewer.invoke.bind(reviewer);
  reviewer.invoke = task => { invocations++; return original(task); };
  const options = { workspacePath: workspace, sources: ["task_queue" as const], maxIterations: 3,
    executeCommand: "node -e \"require('fs').writeFileSync('app.txt','builder')\"", verifierAgentIds: [reviewer.id], adapters: [reviewer] };
  try {
    const result = await new LoopEngine(options).runOnce();
    expect(result.completedTasks[0]?.outcome).toBe("escalated"); expect(invocations).toBe(1);
    expect(result.completedTasks[0]?.implementation_unconfirmed).not.toBe(true);
    expect((await new LoopEngine(options).runOnce()).executedTaskCount).toBe(0); expect(invocations).toBe(1);
  } finally { spy.mockRestore(); }
});

it("retains a live-child worktree on executor rejection and blocks a different state path", async () => {
  const workspace = await makeGitQueuedWorkspace("base\n");
  const execution = await import("./candidate-execution.js");
  const { spawn } = await import("node:child_process");
  let child: ReturnType<typeof spawn> | undefined;
  let candidatePath = "";
  const invocation = vi.spyOn(execution, "executeLegacyImplementation").mockImplementationOnce(async (_plan, options) => {
    candidatePath = options.workspacePath;
    expect(await readFile(loopContainmentPath(workspace), "utf8")).toContain("containment_pending");
    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    throw new Error("executor rejected after launch");
  });
  try {
    const options = { workspacePath: workspace, sources: ["task_queue" as const], useWorktree: true,
      worktreeRoot: join(workspace, "..", "rejected-live-child"), executeCommand: "unused" };
    await expect(new LoopEngine(options).runOnce()).rejects.toThrow("rejected after launch");
    expect(() => process.kill(child!.pid!, 0)).not.toThrow();
    expect(await readFile(join(candidatePath, "app.txt"), "utf8")).toBe("base\n");
    expect(await git(workspace, ["worktree", "list", "--porcelain"])).toContain(candidatePath);
    const restarted = await new LoopEngine({ ...options, stateFilePath: "another-state.json" }).runOnce();
    expect(restarted.executedTaskCount).toBe(0);
    expect(restarted.events).toContainEqual(expect.objectContaining({ type: "loop.stopped", payload: expect.objectContaining({ reason_code: "execution_containment_pending" }) }));
    expect(invocation).toHaveBeenCalledTimes(1);
  } finally {
    invocation.mockRestore();
    if (child !== undefined && child.exitCode === null) {
      const stopped = new Promise<void>(resolve => child!.once("close", () => resolve()));
      child.kill("SIGKILL");
      await stopped;
    }
  }
});

it("retains containment when a goal reports unknown process stop", async () => {
  const workspace = await makeQueuedWorkspace();
  const executor = await import("./executor.js");
  const command = vi.spyOn(executor, "runShellCommand").mockResolvedValueOnce({ command: "goal", exitCode: 1,
    stdout: "", stderr: "unknown", durationMs: 1, termination: { scope: "posix_process_group",
      trigger: "timeout", stop_confirmed: false, signals: ["SIGKILL"], evidence: "not attested" } });
  try {
    const options = { workspacePath: workspace, sources: [], goalCommand: "goal" };
    const first = await new LoopEngine(options).runOnce();
    expect(first.goal?.pass).toBe(false);
    expect(await readFile(loopContainmentPath(workspace), "utf8")).toContain("containment_pending");
    await new LoopEngine({ ...options, stateFilePath: "different.json" }).runOnce();
    expect(command).toHaveBeenCalledTimes(1);
  } finally { command.mockRestore(); }
});

it("keeps containment across git init and clean when unknown stop is followed by failed state write", async () => {
  const workspace = await makeQueuedWorkspace();
  const originalContainmentPath = loopContainmentPath(workspace);
  const stateFile = await import("./state-file.js");
  const verifier = await import("./verifier.js");
  const { Task } = await import("./types.js");
  const review = vi.spyOn(verifier, "verifyRun").mockResolvedValue({ pass: false, score: 0, reviewer_agent_id: "test",
    summary: "unknown", issues: [{ severity: "error", rule: "verify.adapter_stop_unconfirmed", message: "unknown" }] });
  const persist = vi.spyOn(stateFile, "writeLoopState").mockRejectedValueOnce(new Error("disk full"));
  const options = { workspacePath: workspace, sources: [], inputTasks: [Task.parse({ task_id: "clean", source: "manual", capability: "code.test", prompt: "test" })],
    executeCommand: "git init -q && git clean -fdx && node -e \"require('fs').appendFileSync('execution-count.txt','x')\"" };
  try {
    await expect(new LoopEngine(options).runOnce()).rejects.toThrow("disk full");
    persist.mockRestore();
    expect(loopContainmentPath(workspace)).not.toContain(workspace);
    expect(loopContainmentPath(workspace)).toBe(originalContainmentPath);
    expect(await readFile(loopContainmentPath(workspace), "utf8")).toContain("containment_pending");
    const restarted = await new LoopEngine({ ...options, stateFilePath: "new-state.json" }).runOnce();
    expect(restarted.executedTaskCount).toBe(0);
    expect(review).toHaveBeenCalledTimes(1);
    expect(await readFile(join(workspace, "execution-count.txt"), "utf8")).toBe("x");
  } finally { review.mockRestore(); persist.mockRestore(); }
});

it("keeps same-process integrity containment if the durable record disappears", async () => {
  const workspace = await makeGitQueuedWorkspace("baseline\n");
  const { Task } = await import("./types.js");
  const { unlink } = await import("node:fs/promises");
  const verifier = await import("./verifier.js");
  const review = vi.spyOn(verifier, "verifyRun").mockResolvedValue({ pass: false, score: 0,
    reviewer_agent_id: "test", summary: "mutation", issues: [{ severity: "error", rule: "verify.reviewer_mutation", message: "mutation" }] });
  const inputTasks = [Task.parse({ task_id: "first", source: "manual", capability: "code.test", prompt: "test" })];
  const engine = new LoopEngine({ workspacePath: workspace, sources: [], inputTasks,
    executeCommand: "node -e \"require('fs').appendFileSync('execution-count.txt','x')\"" });
  try {
    await engine.runOnce();
    await unlink(loopContainmentPath(workspace));
    inputTasks.push(Task.parse({ task_id: "second", source: "manual", capability: "code.test", prompt: "test" }));
    expect((await engine.runOnce()).executedTaskCount).toBe(0);
    expect(review).toHaveBeenCalledTimes(1);
    expect(await readFile(join(workspace, "execution-count.txt"), "utf8")).toBe("x");
  } finally { review.mockRestore(); }
});

it("rejects containment inside the actual candidate worktree before launching work", async () => {
  const main = await makeGitQueuedWorkspace("main\n");
  const candidate = await makeGitQueuedWorkspace("candidate\n");
  const agents = await import("@osstack/agents");
  const executor = await import("./candidate-execution.js");
  const created = vi.spyOn(agents, "createWorktree").mockResolvedValue({ repoPath: main, worktreePath: candidate,
    branch: "candidate", baseRef: "HEAD", rootPath: join(candidate, "..") });
  const execute = vi.spyOn(executor, "executeLegacyImplementation");
  vi.stubEnv("OSSTACK_LOOP_CONTAINMENT_ROOT", join(candidate, "host-control"));
  try {
    await expect(new LoopEngine({ workspacePath: main, sources: ["task_queue"], useWorktree: true, executeCommand: "must not execute" }).runOnce()).rejects.toThrow("outside the candidate");
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(loopContainmentPath(main), "utf8")).toContain("containment_pending");
  } finally { created.mockRestore(); execute.mockRestore(); vi.unstubAllEnvs(); }
});

it("pins post-review Git evidence and disables repository fsmonitor commands", async () => {
  const workspace = await makeGitQueuedWorkspace("main\n");
  const foreign = await makeGitQueuedWorkspace("foreign\n");
  const before = await git(workspace, ["rev-parse", "--short", "HEAD"]);
  const sentinel = join(workspace, "fsmonitor-ran");
  const monitor = join(workspace, "monitor.cjs");
  const { chmod } = await import("node:fs/promises");
  await writeFile(monitor, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad');\n`);
  await chmod(monitor, 0o700);
  await git(workspace, ["config", "core.fsmonitor", monitor]);
  await git(workspace, ["config", "core.worktree", foreign]);
  vi.stubEnv("GIT_DIR", join(foreign, ".git"));
  vi.stubEnv("GIT_WORK_TREE", foreign);
  try {
    const result = await new LoopEngine({ workspacePath: workspace, sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('app.txt','builder change')\"" }).runOnce();
    expect(result.completedTasks[0]?.outcome).toBe("success");
    expect(result.completedTasks[0]?.changed_files).toContain("app.txt");
    expect(result.completedTasks[0]?.commit_hash).toBe(before.trim());
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(foreign, "app.txt"), "utf8")).toBe("foreign\n");
  } finally { vi.unstubAllEnvs(); }
});


it.each(["code.test", "dual-reviewer.code.test"])("does not probe a verifier during execution routing for %s", async capability => {
  const workspace = await makeGitQueuedWorkspace("base\n");
  const reviewer = new FakeLoopAdapter({ id: "dual-reviewer" });
  const probe = vi.spyOn(reviewer, "isAvailable").mockImplementation(async () => {
    await writeFile(join(workspace, "app.txt"), "selection probe contamination");
    return { available: true, last_checked_at: 0 };
  });
  const invoke = vi.spyOn(reviewer, "invoke");
  await expect(new LoopEngine({ workspacePath: workspace,
    inputTasks: [{ task_id: "dual", capability, prompt: "test", priority: 1, source: "manual" }],
    adapters: [reviewer], verifierAgentIds: [reviewer.id], maxIterations: 1 }).runOnce()).rejects.toThrow("NO_EXECUTION_ADAPTER_OUTSIDE_VERIFIER_ROLE");
  expect(probe).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("base\n");
});

it.each(["prepush", "final"] as const)("retains containment after a reviewer mutates the %s candidate", async phase => {
  const { CandidatePolicy, candidateBinding } = await import("./candidate-policy.js");
  const workspace = await makeGitQueuedWorkspace("base\n");
  await git(workspace, ["config", "user.name", "test"]);
  await git(workspace, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(workspace, ".gitignore"), "LOOP-STATE.json\nSTATE.md\n");
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "-m", "fixture"]);
  const state = realpathSync(mkdtempSync(join(tmpdir(), "candidate-record-")));
  const command = "node -e 'process.exit(0)'";
  const policy = CandidatePolicy.parse({ batchId: "mutation", scopeId: "app", branch: "main",
    policyFingerprint: "a".repeat(64), environmentFingerprint: "b".repeat(64), testsFingerprint: "c".repeat(64),
    maxTasks: 1, scopePaths: ["app.txt"], stateDirectory: state,
    profiles: { local: [command], prepush: [command], final: [command] } });
  const reviewer = new FakeReviewAdapter();
  const originalInvoke = reviewer.invoke.bind(reviewer);
  let calls = 0;
  const mutateAt = phase === "prepush" ? 2 : 3;
  reviewer.invoke = async function* (task) {
    calls++;
    if (calls === mutateAt) {
      expect(task.context?.["repo_path"]).toBe(workspace);
      await writeFile(join(workspace, "app.txt"), "reviewer contamination");
    }
    yield* originalInvoke(task);
  };
  const options = { workspacePath: workspace, sources: [], inputTasks: [{ task_id: "candidate", capability: "code.test",
    prompt: "edit", priority: 1, source: "manual" as const, candidateBatch: candidateBinding(policy) }],
    executeCommand: "node -e \"require('fs').writeFileSync('app.txt','builder')\"",
    useWorktree: true, candidatePolicy: policy, maxIterations: 3,
    verifierAgentIds: [reviewer.id], adapters: [reviewer], lessonDrafts: { enabled: false } };
  const result = await new LoopEngine(options).runOnce();
  expect(calls).toBe(mutateAt);
  expect(result.completedTasks[0]?.outcome).toBe("failed");
  expect(result.completedTasks[0]?.candidate_evidence?.stage).toBe("final_preflight_failed");
  expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("reviewer contamination");
  expect(await git(workspace, ["show", "HEAD:app.txt"])).toBe("builder");
  await expect(readFile(loopContainmentPath(workspace), "utf8")).resolves.toContain("containment_pending");
  expect((await new LoopEngine(options).runOnce()).executedTaskCount).toBe(0);
  expect(calls).toBe(mutateAt);
});

it("defers dual-role availability probes until after execution selection and inside verification", async () => {
  const workspace = await makeGitQueuedWorkspace("base\n");
  const builder = new FakeLoopAdapter();
  const backup = new FakeLoopAdapter({ id: "backup", costTier: "high" });
  const reviewer = new FakeLoopAdapter({ id: "dual-reviewer" });
  const builderInvoke = vi.spyOn(builder, "invoke");
  const probe = vi.spyOn(reviewer, "isAvailable").mockImplementation(async () => {
    // A selection-time probe would run before this file exists.
    expect(await readFile(join(workspace, "agent-output.txt"), "utf8")).toBeTruthy();
    await writeFile(join(workspace, "app.txt"), "probe contamination");
    return { available: true, last_checked_at: 0 };
  });
  const invoke = vi.spyOn(reviewer, "invoke");
  const result = await new LoopEngine({ workspacePath: workspace, sources: ["task_queue"],
    adapters: [reviewer, builder, backup], verifierAgentIds: [reviewer.id], maxIterations: 3 }).runOnce();
  expect(builderInvoke).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  expect(result.completedTasks[0]?.verify_issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ rule: "verify.reviewer_mutation" }),
  ]));
  expect(result.completedTasks[0]?.outcome).not.toBe("success");
});

it.each(["--assume-unchanged", "--skip-worktree"])("preserves a legacy candidate containing %s hidden builder edits", async flag => {
  const workspace = await makeGitQueuedWorkspace("base\n");
  const reviewer = new FakeReviewAdapter();
  const options = { workspacePath: workspace, sources: ["task_queue" as const], useWorktree: true,
    executeCommand: `node -e "require('fs').writeFileSync('app.txt','hidden builder edit')" && git update-index ${flag} app.txt`,
    verifierAgentIds: [reviewer.id], adapters: [reviewer], maxIterations: 3 };
  const engine = new LoopEngine(options);
  const result = await engine.runOnce();
  expect(result.completedTasks[0]?.outcome).toBe("escalated");
  expect(result.completedTasks[0]?.verify_issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ rule: "verify.candidate_index_unconfirmed", message: "CANDIDATE_HIDDEN_INDEX_ENTRY" }),
  ]));
  const created = result.events.find(event => event.type === "loop.worktree.created");
  const candidate = created?.payload?.["worktree_path"];
  expect(typeof candidate).toBe("string");
  expect(await readFile(join(candidate as string, "app.txt"), "utf8")).toBe("hidden builder edit");
  expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("base\n");
  expect(result.events.some(event => event.type === "loop.worktree.cleaned" || event.type === "loop.worktree.merged")).toBe(false);
  await expect(readFile(loopContainmentPath(workspace), "utf8")).resolves.toContain("containment_pending");
  expect((await engine.runOnce()).executedTaskCount).toBe(0);
  expect((await new LoopEngine(options).runOnce()).executedTaskCount).toBe(0);
});

it.each(["explicit", "only-verifiers"])("releases the lease for a static %s role refusal before containment or effects", async mode => {
  const workspace = await makeQueuedWorkspace();
  const reviewer = new FakeLoopAdapter({ id: "dual-role" });
  const probe = vi.spyOn(reviewer, "isAvailable");
  const invoke = vi.spyOn(reviewer, "invoke");
  const release = vi.fn(async () => {}), retain = vi.fn();
  await expect(new LoopEngine({ workspacePath: workspace, sources: ["task_queue"],
    ...(mode === "explicit" ? { agentId: reviewer.id } : {}), adapters: [reviewer],
    verifierAgentIds: [reviewer.id], lifecycleLease: async () => ({ release, retain }) }).runOnce()).rejects.toThrow(
      mode === "explicit" ? "VERIFIER_EXECUTION_ROLE_CONFLICT" : "NO_EXECUTION_ADAPTER_OUTSIDE_VERIFIER_ROLE",
    );
  expect(release).toHaveBeenCalledTimes(1);
  expect(retain).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  await expect(readFile(loopContainmentPath(workspace), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains protection for a routing miss after an effectful non-verifier availability probe", async () => {
  const workspace = await makeQueuedWorkspace();
  const builder = new FakeLoopAdapter();
  const reviewer = new FakeReviewAdapter();
  const probe = vi.spyOn(builder, "isAvailable").mockImplementation(async () => {
    await writeFile(join(workspace, "probe-effect.txt"), "external probe started");
    return { available: false, last_checked_at: 0 };
  });
  const release = vi.fn(async () => {}), retain = vi.fn();
  await expect(new LoopEngine({ workspacePath: workspace, sources: ["task_queue"], adapters: [builder, reviewer],
    verifierAgentIds: [reviewer.id], lifecycleLease: async () => ({ release, retain }) }).runOnce()).rejects.toThrow(
      "NO_AVAILABLE_EXECUTION_ADAPTER_AFTER_ROUTING_PROBES",
    );
  expect(probe).toHaveBeenCalled();
  expect(await readFile(join(workspace, "probe-effect.txt"), "utf8")).toBe("external probe started");
  expect(release).not.toHaveBeenCalled();
  expect(retain).toHaveBeenCalledWith("execution, probe or verification did not settle safely; preflight refusal is possible; this does not prove a process is alive; reconciliation required");
  await expect(readFile(loopContainmentPath(workspace), "utf8")).resolves.toContain("containment_pending");
});


it("retains the real worktree and branch after a writing selection probe refuses execution", async () => {
  const workspace = await makeGitQueuedWorkspace("base\n");
  const builder = new FakeLoopAdapter();
  const reviewer = new FakeReviewAdapter();
  let candidatePath = "";
  const probe = vi.spyOn(builder, "isAvailable").mockImplementation(async () => {
    expect(candidatePath).not.toBe("");
    await writeFile(join(candidatePath, "app.txt"), "selection probe evidence");
    return { available: false, last_checked_at: 0 };
  });
  const invoke = vi.spyOn(builder, "invoke");
  const release = vi.fn(async () => {}), retain = vi.fn();
  const options = { workspacePath: workspace, sources: ["task_queue" as const], useWorktree: true,
    adapters: [builder, reviewer], verifierAgentIds: [reviewer.id],
    prepareVerification: async (path: string) => { candidatePath = path; },
    lifecycleLease: async () => ({ release, retain }) };
  const engine = new LoopEngine(options);
  await expect(engine.runOnce()).rejects.toThrow("NO_AVAILABLE_EXECUTION_ADAPTER_AFTER_ROUTING_PROBES");
  expect(probe).toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(await readFile(join(candidatePath, "app.txt"), "utf8")).toBe("selection probe evidence");
  const listings = await git(workspace, ["worktree", "list", "--porcelain"]);
  expect(listings).toContain(candidatePath);
  const branch = (await git(candidatePath, ["symbolic-ref", "--short", "HEAD"])).trim();
  expect(await git(workspace, ["branch", "--list", branch])).toContain(branch);
  expect(release).not.toHaveBeenCalled();
  expect(retain).toHaveBeenCalledWith(expect.stringContaining("preflight refusal is possible"));
  await expect(readFile(loopContainmentPath(workspace), "utf8")).resolves.toContain("containment_pending");
  expect((await engine.runOnce()).executedTaskCount).toBe(0);
  expect((await new LoopEngine({ ...options, stateFilePath: "new-state.json" }).runOnce()).executedTaskCount).toBe(0);
  expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("base\n");
});
