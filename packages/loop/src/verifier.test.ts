import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  it("passes per-run command environment without changing the host environment", async () => {
    const original = process.env["OSSTACK_HOME"];
    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      commands: [`node -e "process.exit(process.env.OSSTACK_HOME === 'candidate-only-home' && process.env.OSSTACK_AUTOAPPROVE === '0' ? 0 : 1)"`],
      commandEnv: { OSSTACK_HOME: "candidate-only-home", OSSTACK_AUTOAPPROVE: "0" },
    });
    expect(verdict.pass).toBe(true);
    expect(process.env["OSSTACK_HOME"]).toBe(original);
  });

  it.each(["failed", "cancelled"] as const)(
    "fails closed when Builder execution is %s even if verification has no other issue",
    async (outcome) => {
      const verdict = await verifyRun({
        ...run(),
        outcome,
        summary: `${outcome} after writing`,
      }, {
        workspacePath: workspace,
      });

      expect(verdict.pass).toBe(false);
      expect(verdict.score).toBe(0);
      expect(verdict.issues).toContainEqual(expect.objectContaining({
        rule: "execute.outcome_not_completed",
        message: expect.stringContaining(outcome),
      }));
    },
  );

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

  it("accepts only strict structured implementation deviations from a completed verifier", async () => {
    const adapter = mockAdapter({
      async *invoke(agentTask) {
        const event = doneEvent(agentTask.run_id, agentTask.session_id, "completed", "review found drift");
        yield {
          ...event,
          payload: {
            ...event.payload,
            implementation_deviations: [{
              deviation_id: "architecture-drift-1",
              question: "Should the implementation retain the documented adapter boundary?",
              category: "interface",
              doc_type: "tech",
              impact: 3,
              irreversibility: 2,
              uncertainty: 2,
              required: true,
              destination_hint: "technical_design",
              evidence: [{ path: "src/app.ts", line: 1 }],
            }],
          },
        } as unknown as HermesEvent;
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: task(),
    });

    expect(verdict.implementation_deviations).toEqual([
      expect.objectContaining({ deviation_id: "architecture-drift-1" }),
    ]);
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
      // biome-ignore lint/correctness/useYield: mock adapter that throws before yielding
      async *invoke() {
        throw new Error("adapter crashed");
      },
    });
    const incomplete = mockAdapter({
      id: "incomplete",
      // biome-ignore lint/correctness/useYield: mock adapter that completes without emitting events
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

  it("fails artifact verification when a task reports success but produces no diff", async () => {
    await initGitWorkspace();

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      artifactVerification: { requireGitDiff: true },
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toEqual([
      expect.objectContaining({ rule: "verify.artifact_empty_diff" }),
    ]);
  });

  it("fails artifact verification when changes miss target paths or hit forbidden paths", async () => {
    await initGitWorkspace();
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "generated.txt"), "bad\n");

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      artifactVerification: {
        requireGitDiff: true,
        targetPaths: ["src"],
      },
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "verify.artifact_target_miss" }),
      expect.objectContaining({
        rule: "verify.artifact_forbidden_path",
        file: "node_modules/generated.txt",
      }),
    ]));
  });

  it("passes artifact verification when changed files hit the required target path", async () => {
    await initGitWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 2;\n");

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      artifactVerification: {
        requireGitDiff: true,
        targetPaths: ["src"],
      },
    });

    expect(verdict.pass).toBe(true);
  });

  it("fails closed on a failing adapter judgment reported under an unknown evaluation id", async () => {
    // The adapter judges a spec id we never requested. Dropping it would let a
    // real failure pass silently, so an unknown *failing* judgment is an error.
    const adapter = mockAdapter({
      async *invoke(t) {
        yield judgmentDoneEvent(t.run_id, t.session_id, "completed", "review ran", [
          { id: "typo-review-id", pass: false, summary: "the auth flow is broken" },
        ]);
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: reviewTask("known-review"),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({
      rule: "verify.unknown_evaluation_id",
      severity: "error",
      message: expect.stringContaining("typo-review-id"),
    }));
  });

  it("fails closed on a passing adapter judgment with an unknown id", async () => {
    const adapter = mockAdapter({
      async *invoke(t) {
        yield judgmentDoneEvent(t.run_id, t.session_id, "completed", "review ran", [
          { id: "known-review", pass: true, summary: "looks good" },
          { id: "bonus-check", pass: true, summary: "extra passing judgment" },
        ]);
      },
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: reviewTask("known-review"),
    });

    expect(verdict.pass).toBe(false);
    const orphan = verdict.issues.find((issue) => issue.rule === "verify.unknown_evaluation_id");
    expect(orphan).toMatchObject({
      severity: "error",
      message: expect.stringContaining("bonus-check"),
    });
  });

  it.each(["ignored", "assume-unchanged"])("passes the supplied %s candidate patch and paths to Kimi", async (mode) => {
    await initGitWorkspace();
    const path = mode === "ignored" ? "src/ignored.ts" : "src/app.ts";
    await writeFile(join(workspace, path), "export const candidate = true;\n");
    if (mode === "ignored") {
      await writeFile(join(workspace, ".git/info/exclude"), `${path}\n`);
      execFileSync("git", ["add", "-f", "--", path], { cwd: workspace });
    }
    const diff = execFileSync("git", ["diff", "--binary", "HEAD", "--", path], {
      cwd: workspace, encoding: "utf8",
    });
    if (mode === "ignored") {
      execFileSync("git", ["reset", "HEAD", "--", path], { cwd: workspace });
    } else {
      execFileSync("git", ["update-index", "--assume-unchanged", path], { cwd: workspace });
    }
    expect(execFileSync("git", ["diff", "HEAD", "--"], { cwd: workspace, encoding: "utf8" })).toBe("");
    expect(diff).toContain("+export const candidate = true;");
    let captured: AgentTask | undefined;
    const adapter = kimiAdapter(async function* (agentTask) {
      captured = agentTask;
      yield structuredReviewDoneEvent(agentTask, "approved", [structuredJudgment("correctness", true)]);
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace, verifierAgentIds: [adapter.id], adapters: [adapter],
      task: reviewTask("correctness"), reviewCandidate: { changed_paths: [path], diff },
    });

    expect(verdict.pass).toBe(true);
    expect(captured?.context?.["kimi_review_input"]).toMatchObject({ changed_paths: [path], diff });
  });

  it("blocks a secret in a supplied ignored candidate before invoking Kimi", async () => {
    await initGitWorkspace();
    await writeFile(join(workspace, ".git/info/exclude"), "src/ignored.ts\n");
    await writeFile(join(workspace, "src/ignored.ts"), 'api_key = "ignored-candidate-secret"\n');
    let invoked = false;
    const adapter = kimiAdapter(async function* (agentTask) {
      invoked = true;
      yield structuredReviewDoneEvent(agentTask, "approved", [structuredJudgment("correctness", true)]);
    });
    const verdict = await verifyRun(run(), {
      workspacePath: workspace, verifierAgentIds: [adapter.id], adapters: [adapter],
      task: reviewTask("correctness"),
      reviewCandidate: { changed_paths: ["src/ignored.ts"], diff: "candidate patch\n" },
    });
    expect(invoked).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({ rule: "review.secret_detected" }));
  });

  it("blocks at the pre-review boundary without invoking Kimi", async () => {
    await initGitWorkspace();
    await writeFile(join(workspace, ".env"), "TOKEN=must-not-cross\n");
    let invokeCount = 0;
    const adapter = kimiAdapter(async function* (agentTask) {
      invokeCount += 1;
      yield structuredReviewDoneEvent(agentTask, "approved", []);
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: reviewTask("correctness"),
    });

    expect(invokeCount).toBe(0);
    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({
      rule: "review.forbidden_path",
    }));
  });

  it("blocks a structured changes_requested verdict and preserves the artifact", async () => {
    await initChangedGitWorkspace();
    const adapter = kimiAdapter(async function* (agentTask) {
      yield structuredReviewDoneEvent(
        agentTask,
        "changes_requested",
        [structuredJudgment("correctness", false)],
      );
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: reviewTask("correctness"),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({
      rule: "verify.review_not_approved",
    }));
    expect(verdict.review_artifacts).toEqual([
      expect.objectContaining({ verdict: "changes_requested" }),
    ]);
  });

  it("blocks missing, unknown, and duplicate structured judgments", async () => {
    for (const [label, judgments, expectedRule] of [
      ["missing", [], "verify.evaluation_failed"],
      [
        "unknown",
        [structuredJudgment("other-id", true)],
        "verify.unknown_evaluation_id",
      ],
      [
        "duplicate",
        [
          structuredJudgment("correctness", true),
          structuredJudgment("correctness", true),
        ],
        "verify.duplicate_evaluation_id",
      ],
    ] as const) {
      await rm(workspace, { recursive: true, force: true });
      workspace = mkdtempSync(join(tmpdir(), `osstack-verifier-${label}-`));
      await initChangedGitWorkspace();
      const adapter = kimiAdapter(async function* (agentTask) {
        yield structuredReviewDoneEvent(agentTask, "approved", [...judgments]);
      });

      const verdict = await verifyRun(run(), {
        workspacePath: workspace,
        verifierAgentIds: [adapter.id],
        adapters: [adapter],
        task: reviewTask("correctness"),
      });

      expect(verdict.pass, label).toBe(false);
      expect(verdict.issues, label).toContainEqual(expect.objectContaining({
        rule: expectedRule,
      }));
    }
  });

  it("blocks malformed structured review artifacts", async () => {
    await initChangedGitWorkspace();
    const adapter = kimiAdapter(async function* (agentTask) {
      const event = structuredReviewDoneEvent(
        agentTask,
        "approved",
        [structuredJudgment("correctness", true)],
      );
      yield {
        ...event,
        payload: {
          ...event.payload,
          review: { schema_version: 1, verdict: "approved" },
        },
      } as unknown as HermesEvent;
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: reviewTask("correctness"),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({
      rule: "verify.review_artifact_invalid",
    }));
  });

  it("blocks reviewer mutation after a valid approval", async () => {
    await initChangedGitWorkspace();
    const adapter = kimiAdapter(async function* (agentTask) {
      await writeFile(
        join(workspace, ".git/hooks/pre-commit"),
        "#!/bin/sh\nexit 0\n",
      );
      yield structuredReviewDoneEvent(
        agentTask,
        "approved",
        [structuredJudgment("correctness", true)],
      );
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: reviewTask("correctness"),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.issues).toContainEqual(expect.objectContaining({
      rule: "verify.reviewer_mutation",
    }));
  });

  it("passes an approved complete structured review without mutation", async () => {
    await initChangedGitWorkspace();
    let captured: AgentTask | undefined;
    const adapter = kimiAdapter(async function* (agentTask) {
      captured = agentTask;
      yield structuredReviewDoneEvent(
        agentTask,
        "approved",
        [structuredJudgment("correctness", true)],
      );
    });

    const verdict = await verifyRun(run(), {
      workspacePath: workspace,
      verifierAgentIds: [adapter.id],
      adapters: [adapter],
      task: reviewTask("correctness"),
    });

    expect(verdict.pass).toBe(true);
    expect(verdict.review_artifacts).toEqual([
      expect.objectContaining({
        reviewer_agent_id: "kimi-code",
        verdict: "approved",
      }),
    ]);
    expect(captured?.context?.["kimi_review_input"]).toMatchObject({
      schema_version: 1,
      changed_paths: ["src/app.ts"],
      evaluation_criteria: [{
        id: "correctness",
      }],
    });
  });
});

function reviewTask(specId: string): Task {
  return {
    task_id: "task-1",
    capability: "code.write",
    prompt: "Implement the change",
    priority: 50,
    source: "task_queue",
    context: { file: "src/app.ts" },
    evaluation: [{
      id: specId,
      mode: "semantic_review",
      description: "Review the change semantically",
      required: true,
      target_paths: [],
      forbidden_paths: [],
      weight: 1,
    }],
  };
}

function judgmentDoneEvent(
  runId: string,
  sessionId: string,
  status: "completed" | "failed",
  resultSummary: string,
  judgments: Array<{ id: string; pass: boolean; summary?: string }>,
): HermesEvent {
  // evaluation_judgments is carried on the done payload at runtime (read loosely
  // by the verifier) but is not part of the typed payload union, so build the
  // event untyped and cast the whole thing.
  return {
    event_id: `${runId}:1`,
    seq: 1,
    run_id: runId,
    session_id: sessionId,
    created_at: Date.now() / 1000,
    terminal: true,
    type: "done",
    payload: { status, last_seq: 1, result_summary: resultSummary, evaluation_judgments: judgments },
  } as unknown as HermesEvent;
}

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

async function initChangedGitWorkspace(): Promise<void> {
  await initGitWorkspace();
  await writeFile(join(workspace, "src", "app.ts"), "export const value = 2;\n");
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

function kimiAdapter(invoke: AgentAdapter["invoke"]): AgentAdapter {
  return mockAdapter({
    id: "kimi-code",
    capability: capability(
      "kimi-code.code.review",
      "code.review",
      "Kimi review",
    ),
    invoke,
  });
}

function structuredJudgment(
  id: string,
  pass: boolean,
): { id: string; pass: boolean; severity: "error"; summary: string } {
  return {
    id,
    pass,
    severity: "error",
    summary: pass ? "Criterion passed." : "Criterion failed.",
  };
}

function structuredReviewDoneEvent(
  taskInput: AgentTask,
  verdict: "approved" | "changes_requested",
  judgments: Array<ReturnType<typeof structuredJudgment>>,
): HermesEvent {
  return {
    event_id: `${taskInput.run_id}:1`,
    seq: 1,
    run_id: taskInput.run_id,
    session_id: taskInput.session_id,
    created_at: Date.now() / 1000,
    terminal: true,
    type: "done",
    payload: {
      status: verdict === "approved" ? "completed" : "failed",
      last_seq: 0,
      result_summary: verdict,
      review: {
        schema_version: 1,
        verdict,
        risk: "read_only",
        markdown: `# Review\n\n${verdict}`,
        judgments,
        findings: [],
        recommended_actions: verdict === "approved" ? [] : ["Fix the issue."],
        evidence_refs: [],
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
    },
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


it("bounds verifier availability without starting invocation", async () => {
  let invoked = false;
  const adapter = {...mockAdapter({async *invoke(){invoked=true;}}),
    isAvailable: () => new Promise<never>(() => {})};
  const verdict = await verifyRun(run(), {workspacePath:workspace,verifierAgentIds:[adapter.id],adapters:[adapter],timeoutMs:20});
  expect(verdict.pass).toBe(false);
  expect(invoked).toBe(false);
  expect(verdict.issues).toContainEqual(expect.objectContaining({rule:"verify.adapter_failed",message:expect.stringContaining("availability timed out")}));
});
it("bounds a verifier that ignores abort and never settles next or return", async () => {
  let signal: AbortSignal | undefined;
  let returned = false;
  const adapter = mockAdapter({invoke(_task, incoming) {
    signal = incoming;
    return {next:() => new Promise<IteratorResult<HermesEvent>>(() => {}),
      return:() => {returned=true;return new Promise<IteratorResult<HermesEvent>>(() => {});},
      [Symbol.asyncIterator]() {return this;}} as ReturnType<AgentAdapter["invoke"]>;
  }});
  const verdict = await verifyRun(run(), {workspacePath:workspace,verifierAgentIds:[adapter.id],adapters:[adapter],timeoutMs:20});
  expect(verdict.pass).toBe(false);
  expect(signal?.aborted).toBe(true);
  expect(returned).toBe(true);
  expect(verdict.issues).toContainEqual(expect.objectContaining({rule:"verify.adapter_failed",message:expect.stringContaining("stop_confirmed=unknown")}));
});
