import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_POLICY,
  DiscoveryPolicy,
  authorizeTask,
} from "./discovery-policy.js";
import { LoopEngine } from "./loop-engine.js";
import { createLoopStateReport, renderLoopStateReportFromState } from "./report.js";
import type { Task } from "./types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-discovery-policy-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("DiscoveryPolicy schema", () => {
  it("applies conservative defaults", () => {
    const policy = DiscoveryPolicy.parse({});
    expect(policy.default_authorization).toBe("needs_approval");
    expect(policy.auto_execute_capabilities).toEqual([]);
    expect(policy.blocked_capabilities).toEqual([]);
    expect(policy.max_auto_priority).toBe(80);
  });

  it("ships a default policy that keeps task_queue auto and gates discovery sources", () => {
    expect(DEFAULT_DISCOVERY_POLICY.source_authorization["task_queue"]).toBe("auto_execute");
    expect(DEFAULT_DISCOVERY_POLICY.source_authorization["git_diff"]).toBe("suggest_only");
    expect(DEFAULT_DISCOVERY_POLICY.source_authorization["github_branch"]).toBe("needs_approval");
  });
});

describe("authorizeTask", () => {
  it("blocks tasks whose capability matches a blocked capability prefix", () => {
    const policy = DiscoveryPolicy.parse({ blocked_capabilities: ["release"] });
    const decision = authorizeTask(task({ capability: "release.verify" }), policy);
    expect(decision.authorization).toBe("blocked");
    expect(decision.reason).toContain("release");
  });

  it("blocks tasks whose context files touch a blocked path", () => {
    const policy = DiscoveryPolicy.parse({
      default_authorization: "auto_execute",
      blocked_paths: [".github/workflows"],
    });
    const decision = authorizeTask(
      task({ context: { files: [".github/workflows/release.yml"] } }),
      policy,
    );
    expect(decision.authorization).toBe("blocked");
    expect(decision.reason).toContain(".github/workflows");
  });

  it("blocks a path referenced only through an evaluation spec", () => {
    const policy = DiscoveryPolicy.parse({
      default_authorization: "auto_execute",
      blocked_paths: ["secrets"],
    });
    const decision = authorizeTask(
      task({ evaluation: [{
        id: "touch-secrets",
        mode: "artifact",
        description: "writes secrets",
        required: true,
        target_paths: ["secrets/prod.env"],
        forbidden_paths: [],
        weight: 1,
      }] }),
      policy,
    );
    expect(decision.authorization).toBe("blocked");
  });

  it("blocks regardless of leading-slash asymmetry between policy and task path", () => {
    const policy = DiscoveryPolicy.parse({
      default_authorization: "auto_execute",
      blocked_paths: ["src/secrets"],
    });
    // Absolute context path vs repo-relative blocked path must still match.
    const decision = authorizeTask(
      task({ context: { file: "/src/secrets/key.ts" } }),
      policy,
    );
    expect(decision.authorization).toBe("blocked");
  });

  it("grants auto_execute to allowlisted capabilities but caps by priority", () => {
    const policy = DiscoveryPolicy.parse({
      auto_execute_capabilities: ["code.fix"],
      max_auto_priority: 80,
    });
    expect(authorizeTask(task({ capability: "code.fix", priority: 50 }), policy).authorization)
      .toBe("auto_execute");
    expect(authorizeTask(task({ capability: "code.fix", priority: 95 }), policy).authorization)
      .toBe("needs_approval");
  });

  it("falls back to source authorization, then policy default", () => {
    const policy = DiscoveryPolicy.parse({
      default_authorization: "suggest_only",
      source_authorization: { git_diff: "needs_approval" },
    });
    expect(authorizeTask(task({ source: "git_diff" }), policy).authorization).toBe("needs_approval");
    expect(authorizeTask(task({ source: "github_branch" }), policy).authorization).toBe("suggest_only");
  });
});

describe("LoopEngine discovery governance", () => {
  it("executes task_queue tasks but defers git_diff discoveries under the default policy", async () => {
    await initGitWorkspaceWithDiff();
    await enqueue({ task_id: "queued-fix", prompt: "Run the queued fix", capability: "code.fix" });

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["git_diff", "task_queue"],
      executeCommand: "true",
      discoveryPolicy: DEFAULT_DISCOVERY_POLICY,
    });
    const result = await engine.runOnce();

    expect(result.executedTaskCount).toBe(1);
    expect(result.state.completed_tasks.map((completed) => completed.task_id)).toEqual(["queued-fix"]);
    expect(result.state.deferred_tasks).toHaveLength(1);
    expect(result.state.deferred_tasks?.[0]).toMatchObject({
      authorization: "suggest_only",
      task: expect.objectContaining({ source: "git_diff" }),
    });

    const deferredEvents = result.events.filter((event) => event.type === "loop.task.deferred");
    expect(deferredEvents).toHaveLength(1);
    expect(deferredEvents[0]?.payload).toMatchObject({ authorization: "suggest_only", source: "git_diff" });

    const markdown = engine.statusMarkdown(result.state);
    expect(markdown).toContain("## Suggested");
    expect(markdown).toContain("## Needs Approval");
    expect(markdown).toContain("## Blocked");
  });

  it("records blocked tasks in state without executing them", async () => {
    await enqueue({ task_id: "risky", prompt: "Touch the release pipeline", capability: "release.publish" });

    const policy = DiscoveryPolicy.parse({
      default_authorization: "auto_execute",
      blocked_capabilities: ["release.publish"],
    });
    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "true",
      discoveryPolicy: policy,
    });
    const result = await engine.runOnce();

    expect(result.executedTaskCount).toBe(0);
    expect(result.state.completed_tasks).toHaveLength(0);
    expect(result.state.deferred_tasks?.[0]).toMatchObject({
      authorization: "blocked",
      task: expect.objectContaining({ task_id: "risky" }),
    });
    const markdown = engine.statusMarkdown(result.state);
    expect(markdown).toContain("## Blocked");
    expect(markdown).toContain("risky");
  });

  it("surfaces deferred tasks in the loop report and risks", async () => {
    await enqueue({ task_id: "risky-report", prompt: "Touch the release pipeline", capability: "release.publish" });

    const policy = DiscoveryPolicy.parse({
      default_authorization: "auto_execute",
      blocked_capabilities: ["release.publish"],
    });
    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "true",
      discoveryPolicy: policy,
    });
    const result = await engine.runOnce();

    const report = createLoopStateReport(result.state);
    expect(report.summary.deferred_count).toBe(1);
    expect(report.deferred_tasks[0]).toMatchObject({ authorization: "blocked" });
    expect(report.risks.some((risk) => risk.includes("blocked by discovery policy"))).toBe(true);

    const markdown = renderLoopStateReportFromState(result.state);
    expect(markdown).toContain("## Deferred Tasks (Governance)");
    expect(markdown).toContain("risky-report");
  });

  it("keeps legacy behavior when no policy is configured", async () => {
    await initGitWorkspaceWithDiff();

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["git_diff"],
      executeCommand: "true",
    });
    const result = await engine.runOnce();

    expect(result.executedTaskCount).toBeGreaterThan(0);
    expect(result.state.deferred_tasks ?? []).toHaveLength(0);
    const markdown = engine.statusMarkdown(result.state);
    expect(markdown).not.toContain("## Blocked");
  });
});

async function initGitWorkspaceWithDiff(): Promise<void> {
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "app.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ], { cwd: workspace, stdio: "ignore" });
  await writeFile(join(workspace, "src", "app.ts"), "export const value = 2;\n");
}

async function enqueue(item: { task_id: string; prompt: string; capability: string }): Promise<void> {
  await mkdir(join(workspace, "tasks"), { recursive: true });
  await writeFile(
    join(workspace, "tasks", `${item.task_id}.json`),
    `${JSON.stringify({ ...item, priority: 50 }, null, 2)}\n`,
    "utf-8",
  );
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "task-1",
    capability: "code.fix",
    prompt: "Fix the thing",
    priority: 50,
    source: "task_queue",
    ...overrides,
  };
}
