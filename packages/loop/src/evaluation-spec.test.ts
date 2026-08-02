import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EvaluationSpec,
  evaluationScore,
  failedEvaluationIds,
  implicitArtifactSpec,
  implicitCommandSpec,
  parseEvaluationSpecs,
} from "./evaluation-spec.js";
import type { AgentRun } from "./executor.js";
import { renderLoopStateMarkdown, createInitialLoopState } from "./state-file.js";
import { parseTaskQueueFile } from "./task-queue.js";
import { CompletedTask, LoopState, type Task } from "./types.js";
import { verifyRun } from "./verifier.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-evaluation-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("EvaluationSpec schema", () => {
  it("parses a spec with defaults applied", () => {
    const spec = EvaluationSpec.parse({
      id: "auth-tests",
      mode: "command",
      description: "Auth test suite passes.",
      command: "pnpm test -- tests/auth",
    });
    expect(spec.required).toBe(true);
    expect(spec.weight).toBe(1);
    expect(spec.target_paths).toEqual([]);
    expect(spec.forbidden_paths).toEqual([]);
  });

  it("rejects unknown modes and out-of-range weights", () => {
    expect(() => parseEvaluationSpecs([{ id: "x", mode: "psychic", description: "no" }])).toThrow();
    expect(() => parseEvaluationSpecs([{ id: "x", mode: "command", description: "d", weight: 2 }])).toThrow();
  });

  it("derives implicit command and artifact specs from legacy options", () => {
    const command = implicitCommandSpec("pnpm test", 0);
    expect(command).toMatchObject({ id: "verify-command-1", mode: "command", command: "pnpm test" });

    const artifact = implicitArtifactSpec({ requireGitDiff: true, targetPaths: ["src"] });
    expect(artifact).toMatchObject({ id: "verify-artifact", mode: "artifact", target_paths: ["src"] });
  });

  it("computes weighted scores and failed ids", () => {
    const results = [
      result("a", true, 1),
      result("b", false, 1),
      result("c", false, 0.5),
    ];
    expect(evaluationScore(results, false)).toBeCloseTo(0.4);
    expect(failedEvaluationIds(results)).toEqual(["b", "c"]);
    expect(evaluationScore([], true)).toBe(1);
    expect(evaluationScore([], false)).toBe(0);
  });
});

describe("task queue evaluation field", () => {
  it("parses evaluation specs from a task queue file", () => {
    const tasks = parseTaskQueueFile({
      task_id: "fix-auth-test",
      capability: "code.fix",
      prompt: "Fix auth test failures without weakening access control.",
      priority: 90,
      evaluation: [
        {
          id: "auth-tests",
          mode: "command",
          description: "Auth test suite passes.",
          command: "pnpm test -- tests/auth",
        },
        {
          id: "no-policy-bypass",
          mode: "semantic_review",
          description: "The fix must not bypass authorization.",
          acceptance: "Reject constant allow/deny values.",
        },
      ],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.evaluation).toHaveLength(2);
    expect(tasks[0]?.evaluation?.[0]).toMatchObject({ id: "auth-tests", mode: "command", required: true });
    expect(tasks[0]?.evaluation?.[1]).toMatchObject({ id: "no-policy-bypass", mode: "semantic_review" });
  });

  it("still parses legacy task queue files without evaluation", () => {
    const tasks = parseTaskQueueFile({ task_id: "legacy", prompt: "Do the thing" });
    expect(tasks[0]?.evaluation).toBeUndefined();
  });
});

describe("verifier per-evaluation results", () => {
  it("turns legacy --verify commands into implicit command evaluation results", async () => {
    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      commands: ["exit 0", "exit 3"],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.evaluations).toHaveLength(2);
    expect(verdict.evaluations?.[0]).toMatchObject({
      spec_id: "verify-command-1",
      mode: "command",
      pass: true,
      implicit: true,
    });
    expect(verdict.evaluations?.[1]).toMatchObject({
      spec_id: "verify-command-2",
      pass: false,
      implicit: true,
    });
    // Legacy issue rule preserved for compatibility.
    expect(verdict.issues).toEqual([
      expect.objectContaining({ rule: "verify.command_failed" }),
    ]);
    expect(verdict.score).toBeCloseTo(0.5);
  });

  it("runs explicit command evaluation specs and reports per-spec results", async () => {
    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      task: task({
        evaluation: [
          spec({ id: "passes", mode: "command", command: "exit 0" }),
          spec({ id: "fails", mode: "contract", command: "echo broken >&2; exit 1" }),
        ],
      }),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({ spec_id: "passes", pass: true, implicit: false }),
      expect.objectContaining({ spec_id: "fails", mode: "contract", pass: false }),
    ]);
    expect(verdict.issues).toEqual([
      expect.objectContaining({
        rule: "verify.evaluation_failed",
        severity: "error",
        message: expect.stringContaining("fails"),
      }),
    ]);
  });

  it("does not block on failed optional evaluations", async () => {
    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      task: task({
        evaluation: [
          spec({ id: "optional-check", mode: "command", command: "exit 1", required: false }),
        ],
      }),
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.evaluations?.[0]).toMatchObject({ spec_id: "optional-check", pass: false });
    expect(verdict.issues).toEqual([
      expect.objectContaining({ severity: "warning", rule: "verify.evaluation_failed" }),
    ]);
  });

  it("evaluates explicit artifact specs against the git diff", async () => {
    await initGitWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 2;\n");

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      task: task({
        evaluation: [
          spec({ id: "touches-src", mode: "artifact", target_paths: ["src"] }),
          spec({ id: "avoids-docs", mode: "artifact", target_paths: ["docs"] }),
        ],
      }),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({ spec_id: "touches-src", pass: true }),
      expect.objectContaining({ spec_id: "avoids-docs", pass: false }),
    ]);
  });

  it("keeps implicit artifact verification results and legacy rules", async () => {
    await initGitWorkspace();

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      artifactVerification: { requireGitDiff: true },
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toEqual([
      expect.objectContaining({ rule: "verify.artifact_empty_diff" }),
    ]);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({ spec_id: "verify-artifact", mode: "artifact", pass: false, implicit: true }),
    ]);
  });

  it("passes semantic_review specs to verifier adapters in structured context", async () => {
    let captured: AgentTask | undefined;
    const adapter = mockAdapter({
      async *invoke(agentTask) {
        captured = agentTask;
        const event = doneEvent(
          agentTask.run_id,
          agentTask.session_id,
          "completed",
          "no bypass found",
        );
        yield {
          ...event,
          payload: {
            ...event.payload,
            evaluation_judgments: [{
              id: "no-policy-bypass",
              pass: true,
              summary: "no bypass found",
            }],
          },
        } as unknown as HermesEvent;
      },
    });

    const semantic = spec({
      id: "no-policy-bypass",
      mode: "semantic_review",
      description: "No authorization bypass.",
      acceptance: "Reject constant allow/deny values.",
    });
    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: task({ evaluation: [semantic] }),
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({ spec_id: "no-policy-bypass", pass: true, summary: "no bypass found" }),
    ]);
    expect(captured?.context?.["evaluation_specs"]).toEqual([semantic]);
    expect(captured?.prompt).toContain("Evaluation criteria:");
    expect(captured?.prompt).toContain("Reject constant allow/deny values.");
  });

  it("does not let a passing judgment mark a spec pass when the adapter itself failed", async () => {
    // Adapter emits an all-pass judgment but then terminates with an error.
    // The spec must NOT show pass=true (which would yield pass=false/score=1.0).
    const adapter = mockAdapter({
      async *invoke(agentTask) {
        yield {
          event_id: `${agentTask.run_id}:1`,
          seq: 1,
          run_id: agentTask.run_id,
          session_id: agentTask.session_id,
          created_at: Date.now() / 1000,
          terminal: false,
          type: "done",
          payload: {
            status: "failed",
            last_seq: 1,
            result_summary: "reviewer crashed after judging",
            evaluation_judgments: [{ id: "no-bypass", pass: true, summary: "looked fine" }],
          },
        } as unknown as HermesEvent;
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: task({ evaluation: [spec({ id: "no-bypass", mode: "semantic_review" })] }),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({ spec_id: "no-bypass", pass: false }),
    ]);
    // pass=false must not coexist with a perfect score.
    expect(verdict.score).toBeLessThan(1);
  });

  it("fails required semantic_review specs when no verifier adapter is configured", async () => {
    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      task: task({
        evaluation: [spec({ id: "needs-review", mode: "semantic_review" })],
      }),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({
        spec_id: "needs-review",
        pass: false,
        summary: expect.stringContaining("no verifier adapter"),
      }),
    ]);
  });

  it("honors per-spec adapter judgments over adapter-level pass/fail", async () => {
    const adapter = mockAdapter({
      async *invoke(agentTask) {
        yield {
          event_id: `${agentTask.run_id}:1`,
          seq: 1,
          run_id: agentTask.run_id,
          session_id: agentTask.session_id,
          created_at: Date.now() / 1000,
          terminal: true,
          type: "done",
          payload: {
            status: "completed",
            last_seq: 1,
            result_summary: "review completed",
            evaluation_judgments: [
              { id: "no-bypass", pass: false, summary: "constant allow detected in auth guard" },
              { id: "docs-updated", pass: true, summary: "docs cover the new flag" },
            ],
          },
        } as unknown as HermesEvent;
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: task({
        evaluation: [
          spec({ id: "no-bypass", mode: "semantic_review" }),
          spec({ id: "docs-updated", mode: "semantic_review" }),
        ],
      }),
    });

    // Adapter completed, but the judged-failed spec still blocks the verdict.
    expect(verdict.pass).toBe(false);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({
        spec_id: "no-bypass",
        pass: false,
        summary: "constant allow detected in auth guard",
      }),
      expect.objectContaining({
        spec_id: "docs-updated",
        pass: true,
        summary: "docs cover the new flag",
      }),
    ]);
    expect(verdict.issues).toEqual([
      expect.objectContaining({
        rule: "verify.evaluation_failed",
        message: expect.stringContaining("no-bypass"),
      }),
    ]);
    expect(verdict.score).toBeCloseTo(0.5);
  });

  it("fails semantic_review specs when the verifier adapter rejects", async () => {
    const adapter = mockAdapter({
      async *invoke(agentTask) {
        yield doneEvent(agentTask.run_id, agentTask.session_id, "failed", "bypass detected");
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: task({ evaluation: [spec({ id: "no-bypass", mode: "semantic_review" })] }),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.evaluations).toEqual([
      expect.objectContaining({ spec_id: "no-bypass", pass: false }),
    ]);
  });
});

describe("state rendering for evaluations", () => {
  it("renders failed evaluation ids and summaries in STATE.md", () => {
    const state = LoopState.parse({
      ...createInitialLoopState("loop-eval"),
      completed_tasks: [CompletedTask.parse({
        task_id: "fix-auth-test",
        outcome: "failed",
        iterations: 1,
        agent_id: "local-command",
        duration_ms: 12,
        evaluations: [
          {
            spec_id: "auth-tests",
            mode: "command",
            description: "Auth test suite passes.",
            required: true,
            weight: 1,
            pass: false,
            summary: "command failed (exit 1)",
            implicit: false,
          },
          {
            spec_id: "style",
            mode: "command",
            description: "Style check.",
            required: true,
            weight: 1,
            pass: true,
            summary: "command passed (5 ms)",
            implicit: false,
          },
        ],
      })],
    });

    const markdown = renderLoopStateMarkdown(state);
    expect(markdown).toContain("Failed evaluations: auth-tests (command failed (exit 1))");
    expect(markdown).not.toContain("style (command passed");
  });
});

async function initGitWorkspace(): Promise<void> {
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
}

function result(id: string, pass: boolean, weight: number): {
  spec_id: string;
  mode: "command";
  description: string;
  required: boolean;
  weight: number;
  pass: boolean;
  summary: string;
  implicit: boolean;
} {
  return {
    spec_id: id,
    mode: "command",
    description: id,
    required: true,
    weight,
    pass,
    summary: pass ? "ok" : "failed",
    implicit: false,
  };
}

function spec(overrides: Partial<EvaluationSpec> & { id: string; mode: EvaluationSpec["mode"] }): EvaluationSpec {
  return EvaluationSpec.parse({
    description: `${overrides.id} evaluation`,
    ...overrides,
  });
}

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

function task(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "task-1",
    capability: "code.fix",
    prompt: "Fix the failing test",
    priority: 50,
    source: "task_queue",
    ...overrides,
  };
}

function mockAdapter(options: {
  id?: string;
  available?: boolean;
  invoke?: AgentAdapter["invoke"];
} = {}): AgentAdapter {
  const id = options.id ?? "reviewer";
  return {
    id,
    display_name: "Mock Reviewer",
    cost_tier: "low",
    capabilities: () => [{
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
      last_checked_at: 0,
    }),
    invoke: options.invoke ?? (async function* (agentTask) {
      yield doneEvent(agentTask.run_id, agentTask.session_id, "completed", "ok");
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
