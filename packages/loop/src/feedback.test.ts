import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "./executor.js";
import {
  ITERATION_FEEDBACK_CONTEXT_KEY,
  deriveIterationFeedback,
  issueFingerprint,
  withIterationFeedback,
} from "./feedback.js";
import type { EvaluationResult } from "./evaluation-spec.js";
import { LoopEngine } from "./loop-engine.js";
import { planTask } from "./planner.js";
import { IterationFeedback, type Task, type Verdict } from "./types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-feedback-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("deriveIterationFeedback", () => {
  it("collects blocking issues, failed evaluations, focus hints, and diff summary", () => {
    const feedback = deriveIterationFeedback({
      attempt: 1,
      verdict: verdict({
        pass: false,
        summary: "2 issues found by local verifier.",
        issues: [
          { severity: "error", message: "test failed", rule: "verify.command_failed", file: "src/auth.ts" },
          { severity: "warning", message: "style nit", rule: "verify.evaluation_failed" },
        ],
        evaluations: [{
          spec_id: "auth-tests",
          mode: "command",
          description: "Auth test suite passes.",
          required: true,
          weight: 1,
          pass: false,
          summary: "command failed (exit 1)",
          implicit: false,
        }],
      }),
      changedFiles: ["src/auth.ts"],
      diffSummary: "1 file changed",
    });

    expect(feedback.attempt).toBe(1);
    expect(feedback.verdict_summary).toBe("2 issues found by local verifier.");
    expect(feedback.blocking_issues).toHaveLength(1);
    expect(feedback.blocking_issues[0]?.severity).toBe("error");
    expect(feedback.failed_evaluations).toEqual(["auth-tests"]);
    expect(feedback.suggested_focus).toEqual([
      "src/auth.ts",
      "satisfy evaluation auth-tests: Auth test suite passes.",
    ]);
    expect(feedback.previous_diff_summary).toBe("1 file changed");
    expect(() => IterationFeedback.parse(feedback)).not.toThrow();
  });
});

describe("issueFingerprint", () => {
  it("is stable across issue and evaluation ordering", () => {
    const a = issueFingerprint(verdict({
      issues: [
        { severity: "error", message: "one", rule: "r1" },
        { severity: "error", message: "two", rule: "r2" },
      ],
      evaluations: [evalResult("b", false), evalResult("a", false)],
    }));
    const b = issueFingerprint(verdict({
      issues: [
        { severity: "error", message: "two", rule: "r2" },
        { severity: "error", message: "one", rule: "r1" },
      ],
      evaluations: [evalResult("a", false), evalResult("b", false)],
    }));
    expect(a).toBe(b);
  });

  it("changes when blocking issues or failed evaluations change", () => {
    const base = issueFingerprint(verdict({
      issues: [{ severity: "error", message: "one", rule: "r1" }],
    }));
    const differentIssue = issueFingerprint(verdict({
      issues: [{ severity: "error", message: "other", rule: "r1" }],
    }));
    const differentFailedEval = issueFingerprint(verdict({
      issues: [{ severity: "error", message: "one", rule: "r1" }],
      evaluations: [evalResult("newly-failing", false)],
    }));
    expect(differentIssue).not.toBe(base);
    expect(differentFailedEval).not.toBe(base);
  });

  it("does NOT change when only the changed-file set grows (worktree is cumulative)", () => {
    // Regression guard: folding cumulative `git status` into the fingerprint
    // defeated no-progress escalation. Same verdict must fingerprint the same
    // even though the agent touched more files on the second attempt.
    const attempt1 = issueFingerprint(verdict({
      issues: [{ severity: "error", message: "still broken", rule: "verify.command_failed" }],
      evaluations: [evalResult("tests", false)],
    }));
    const attempt2 = issueFingerprint(verdict({
      issues: [{ severity: "error", message: "still broken", rule: "verify.command_failed" }],
      evaluations: [evalResult("tests", false)],
    }));
    expect(attempt2).toBe(attempt1);
  });

  it("ignores warning-severity issues and passing evaluations", () => {
    const withNoise = issueFingerprint(verdict({
      issues: [
        { severity: "error", message: "one", rule: "r1" },
        { severity: "warning", message: "nit", rule: "r3" },
      ],
      evaluations: [evalResult("tests", false), evalResult("style", true)],
    }));
    const clean = issueFingerprint(verdict({
      issues: [{ severity: "error", message: "one", rule: "r1" }],
      evaluations: [evalResult("tests", false)],
    }));
    expect(withNoise).toBe(clean);
  });
});

describe("LoopEngine feedback-carrying iteration", () => {
  it("passes first-attempt verifier feedback into the second-attempt adapter context", async () => {
    await enqueue({ task_id: "t1", prompt: "Fix the failing check", capability: "code.fix" });
    const contexts: Array<Record<string, unknown> | undefined> = [];
    const maker = mockAdapter({
      id: "maker",
      async *invoke(agentTask) {
        contexts.push(agentTask.context);
        yield doneEvent(agentTask.run_id, agentTask.session_id, "completed", "maker done");
      },
    });

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: "maker",
      adapters: [maker],
      verifyCommands: ["exit 1"],
      maxIterations: 2,
    });
    const result = await engine.runOnce();

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.[ITERATION_FEEDBACK_CONTEXT_KEY]).toBeUndefined();
    const secondAttempt = IterationFeedback.parse(contexts[1]?.[ITERATION_FEEDBACK_CONTEXT_KEY]);
    expect(secondAttempt.attempt).toBe(1);
    expect(secondAttempt.failed_evaluations).toEqual(["verify-command-1"]);
    expect(secondAttempt.blocking_issues.length).toBeGreaterThan(0);

    const iterateEvents = result.events.filter((event) => event.type === "loop.iterate.done");
    expect(iterateEvents).toHaveLength(2);
    for (const event of iterateEvents) {
      expect(event.payload).toMatchObject({
        issue_count: 1,
        failed_evaluation_ids: ["verify-command-1"],
      });
    }

    const completed = result.state.completed_tasks[0];
    expect(completed?.iteration_feedback).toHaveLength(2);
    expect(completed?.iteration_feedback?.[0]?.attempt).toBe(1);
  });

  it("escalates as no-progress when consecutive attempts repeat the same fingerprint", async () => {
    await enqueue({ task_id: "t-stuck", prompt: "Fix the stuck check", capability: "code.fix" });
    const maker = mockAdapter({ id: "maker" });

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: "maker",
      adapters: [maker],
      verifyCommands: ["exit 1"],
      maxIterations: 3,
    });
    const result = await engine.runOnce();

    const completed = result.state.completed_tasks[0];
    expect(completed?.outcome).toBe("escalated");
    expect(completed?.iterations).toBe(2);

    const escalated = result.events.find((event) => event.type === "loop.escalated");
    expect(escalated?.payload?.["reason"]).toContain("No progress");

    const markdown = engine.statusMarkdown(result.state);
    expect(markdown).toContain("Feedback (attempt 1):");
    expect(markdown).toContain("Feedback (attempt 2):");
  });

  it("records feedback in STATE.md for failed tasks", async () => {
    await enqueue({ task_id: "t-fail", prompt: "Fail once", capability: "code.fix" });

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "true",
      verifyCommands: ["echo boom >&2; exit 1"],
      maxIterations: 1,
    });
    const result = await engine.runOnce();

    const markdown = engine.statusMarkdown(result.state);
    expect(markdown).toContain("Feedback (attempt 1):");
    expect(markdown).toContain("failed evaluations: verify-command-1");
  });
});

describe("local command feedback file", () => {
  it("exposes feedback to --execute commands via OSSTACK_ITERATION_FEEDBACK_FILE", async () => {
    const feedback = deriveIterationFeedback({
      attempt: 1,
      verdict: verdict({
        pass: false,
        summary: "previous attempt failed the auth suite",
        issues: [{ severity: "error", message: "test failed", rule: "verify.command_failed" }],
      }),
      changedFiles: [],
    });
    const task: Task = {
      task_id: "t-local",
      capability: "code.fix",
      prompt: "Fix it",
      priority: 50,
      source: "task_queue",
      context: withIterationFeedback(undefined, feedback),
    };
    const plan = planTask(task, { agentId: "local-command" });

    const run = await executePlan(plan, {
      workspacePath: workspace,
      command: 'cat "$OSSTACK_ITERATION_FEEDBACK_FILE"',
    });

    expect(run.outcome).toBe("completed");
    const stdout = run.command_results[0]?.stdout ?? "";
    expect(stdout).toContain("previous attempt failed the auth suite");
    expect(() => IterationFeedback.parse(JSON.parse(stdout))).not.toThrow();
  });

  it("cleans up the temp feedback dir after the command runs (no leak)", async () => {
    const feedback = deriveIterationFeedback({
      attempt: 1,
      verdict: verdict({ summary: "boom", issues: [{ severity: "error", message: "x", rule: "r" }] }),
      changedFiles: [],
    });
    const task: Task = {
      task_id: "t-cleanup",
      capability: "code.fix",
      prompt: "Fix it",
      priority: 50,
      source: "task_queue",
      context: withIterationFeedback(undefined, feedback),
    };
    const plan = planTask(task, { agentId: "local-command" });

    const run = await executePlan(plan, {
      workspacePath: workspace,
      // Echo the exact feedback file path so we can assert *that* path is gone,
      // rather than counting entries in the shared tmpdir (which races with
      // other parallel test workers creating their own osstack-feedback-* dirs).
      command: 'printf %s "$OSSTACK_ITERATION_FEEDBACK_FILE"',
    });

    expect(run.outcome).toBe("completed");
    const feedbackPath = run.command_results[0]?.stdout?.trim() ?? "";
    expect(feedbackPath).toContain("osstack-feedback-");
    // The file existed during the run (it was readable) and is removed after.
    expect(existsSync(feedbackPath)).toBe(false);
    expect(existsSync(dirname(feedbackPath))).toBe(false);
  });
});

async function enqueue(item: { task_id: string; prompt: string; capability: string }): Promise<void> {
  await mkdir(join(workspace, "tasks"), { recursive: true });
  await writeFile(
    join(workspace, "tasks", `${item.task_id}.json`),
    `${JSON.stringify({ ...item, priority: 50 }, null, 2)}\n`,
    "utf-8",
  );
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    pass: false,
    score: 0,
    issues: [],
    reviewer_agent_id: "local-verifier",
    summary: "verification failed",
    ...overrides,
  };
}

function evalResult(specId: string, pass: boolean): EvaluationResult {
  return {
    spec_id: specId,
    mode: "command",
    description: specId,
    required: true,
    weight: 1,
    pass,
    summary: pass ? "ok" : "failed",
    implicit: false,
  };
}

function mockAdapter(options: {
  id?: string;
  invoke?: AgentAdapter["invoke"];
} = {}): AgentAdapter {
  const id = options.id ?? "maker";
  return {
    id,
    display_name: "Mock Maker",
    cost_tier: "low",
    capabilities: () => [{
      id: "mock.code.debug",
      kind: "code.debug",
      agent_id: id,
      description: "Mock fix capability",
      cost_tier: "low",
      hints: {},
      version: "0.0.0",
    }],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: options.invoke ?? (async function* (agentTask: AgentTask) {
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
