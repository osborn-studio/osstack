import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCandidateImplementation } from "./index.js";
import type { CandidateExecutionInput } from "./candidate-execution.js";
import { LoopEngine } from "./loop-engine.js";
import { ExecutionPlan } from "./types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function fixture(): CandidateExecutionInput {
  const path = mkdtempSync(join(tmpdir(), "osstack-candidate-"));
  directories.push(path);
  return {
    plan: ExecutionPlan.parse({ plan_id: "plan-1", agent_id: "local-command", max_iterations: 3,
      task: { task_id: "task-1", capability: "code.write", prompt: "Implement once", source: "manual",
        context: { scope: { file: "output.txt" }, repo_path: "/untrusted/graph/path", authorized: true } },
      stop_condition: { type: "tests_pass" } }),
    workspace: { workspace_id: "registered-1", workspace_path: path },
    command: "node -e \"require('fs').appendFileSync('output.txt', 'once')\"",
    authorize: async () => ({ allow: true }),
  };
}
function adapter(invoke: AgentAdapter["invoke"]): AgentAdapter {
  return { id: "builder", display_name: "Builder", cost_tier: "low", capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }), invoke };
}
function done(task: AgentTask, status: "completed" | "failed" | "cancelled" | "expired" = "completed"): HermesEvent {
  return { event_id: "event-1", run_id: task.run_id, session_id: task.session_id, seq: 1,
    type: "done", created_at: 0, terminal: true,
    payload: { status, last_seq: 0, result_summary: "implementation evidence" } };
}

describe("executeCandidateImplementation", () => {
  it("executes once in the registered workspace without commit, cleanup, discovery, verification or state writes", async () => {
    const input = fixture();
    const path = input.workspace.workspace_path;
    execFileSync("git", ["init", "-q", path]);
    writeFileSync(join(path, "LOOP-STATE.json"), "existing audit");
    writeFileSync(join(path, "queued-task.json"), "unrelated task");
    const before = readdirSync(path);
    const gitBefore = readFileSync(join(path, ".git", "HEAD"), "utf8");
    const result = await executeCandidateImplementation(input);
    expect(result).toMatchObject({ status: "implementation_complete", workspace: input.workspace,
      execution: { outcome: "completed", command_results: [expect.objectContaining({ exitCode: 0 })] } });
    expect(readFileSync(join(path, "output.txt"), "utf8")).toBe("once");
    expect(readdirSync(path).sort()).toEqual([...before, "output.txt"].sort());
    expect(readFileSync(join(path, "LOOP-STATE.json"), "utf8")).toBe("existing audit");
    expect(readFileSync(join(path, ".git", "HEAD"), "utf8")).toBe(gitBefore);
    expect(existsSync(join(path, ".git", "index"))).toBe(false);
    expect(existsSync(join(path, ".git", "logs", "HEAD"))).toBe(false);
  });

  it.each(["deny", "throw", "missing"])("fails closed for %s authorization before adapter probes or command effects", async (mode) => {
    const input = fixture();
    const invoke = vi.fn(async function* (task: AgentTask) { yield done(task); });
    const builder = adapter(invoke);
    builder.isAvailable = vi.fn(builder.isAvailable);
    input.plan.agent_id = builder.id;
    input.adapters = [builder];
    input.authorize = mode === "deny" ? async () => ({ allow: false, reason: "scope denied" })
      : mode === "throw" ? async () => { throw new Error("authority unavailable"); }
      : undefined as unknown as CandidateExecutionInput["authorize"];
    const result = await executeCandidateImplementation(input);
    expect(result.status).toBe("authorization_denied");
    expect(result.execution).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(builder.isAvailable).not.toHaveBeenCalled();
    expect(readdirSync(input.workspace.workspace_path)).toEqual([]);
  });

  it("preabort prevents authorization and all effects", async () => {
    const input = fixture();
    const controller = new AbortController();
    controller.abort();
    input.signal = controller.signal;
    input.authorize = vi.fn(input.authorize);
    expect((await executeCandidateImplementation(input)).status).toBe("cancelled");
    expect(input.authorize).not.toHaveBeenCalled();
    expect(readdirSync(input.workspace.workspace_path)).toEqual([]);
  });

  it.each(["allow", "reject"])("cancels promptly during pending auth and ignores its late %s", async (late) => {
    const input = fixture();
    const controller = new AbortController();
    input.signal = controller.signal;
    let settle!: (value: { allow: true }) => void;
    let reject!: (reason: Error) => void;
    input.authorize = () => new Promise((resolve, fail) => { settle = resolve; reject = fail; });
    const pending = executeCandidateImplementation(input);
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    if (late === "allow") settle({ allow: true }); else reject(new Error("late auth error"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readdirSync(input.workspace.workspace_path)).toEqual([]);
  });

  it("keeps the original cancellation signal when the caller replaces it during authorization", async () => {
    const input = fixture();
    const original = new AbortController();
    input.signal = original.signal;
    input.authorize = () => new Promise(() => {});
    const pending = executeCandidateImplementation(input);
    input.signal = new AbortController().signal;
    original.abort();
    expect((await pending).status).toBe("cancelled");
    expect(readdirSync(input.workspace.workspace_path)).toEqual([]);
  });

  it("binds plan, command, workspace and signal across an authorization await", async () => {
    const input = fixture();
    const originalWorkspace = { ...input.workspace };
    let release!: () => void;
    input.authorize = async (scope) => {
      expect(scope.plan.task.context?.["scope"]).toEqual({ file: "output.txt" });
      expect(Reflect.set(scope.plan.task, "prompt", "authorizer changed prompt")).toBe(false);
      expect(Reflect.set(scope.plan.task.context!["scope"] as object, "file", "bad.txt")).toBe(false);
      expect(Reflect.set(scope.workspace, "workspace_path", "/wrong")).toBe(false);
      expect(Reflect.set(scope, "command", "exit 99")).toBe(false);
      await new Promise<void>((resolve) => { release = resolve; });
      return { allow: true };
    };
    const pending = executeCandidateImplementation(input);
    input.plan.task.prompt = "caller changed prompt";
    input.plan.task.context!["scope"] = { file: "bad.txt" };
    input.plan.agent_id = "missing-agent";
    input.workspace.workspace_path = "/wrong";
    input.workspace.workspace_id = "wrong";
    input.command = "exit 99";
    release();
    const result = await pending;
    expect(result).toMatchObject({ status: "implementation_complete", workspace: originalWorkspace,
      execution: { agent_id: "local-command" } });
    expect(readFileSync(join(originalWorkspace.workspace_path, "output.txt"), "utf8")).toBe("once");
  });

  it("uses the authorized plan snapshot and registered identity for the preselected adapter", async () => {
    const input = fixture();
    const seen: AgentTask[] = [];
    const builder = adapter(async function* (task) { seen.push(task); yield done(task); });
    input.plan.agent_id = builder.id;
    input.adapters = [builder];
    input.authorize = async () => { input.plan.task.prompt = "mutated"; input.adapters = []; return { allow: true }; };
    const result = await executeCandidateImplementation(input);
    expect(result.status).toBe("implementation_complete");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ prompt: "Implement once", context: { repo_path: input.workspace.workspace_path } });
    expect(result.execution?.summary).toBe("implementation evidence");
    expect(readdirSync(input.workspace.workspace_path)).toEqual([]);
  });

  it.each(["worktree", "identity", "relative"])("rejects invalid %s workspace scope before authorization", async (kind) => {
    const input = fixture();
    if (kind === "worktree") input.plan.worktree_path = "/another-worktree";
    if (kind === "identity") input.workspace.workspace_id = "";
    if (kind === "relative") input.workspace.workspace_path = "relative-path";
    input.authorize = vi.fn(input.authorize);
    expect((await executeCandidateImplementation(input)).status).toBe("invalid_input");
    expect(input.authorize).not.toHaveBeenCalled();
  });

  it.each(["local-noop", "local-command"])("does not claim implementation for commandless %s", async (id) => {
    const input = fixture();
    input.plan.agent_id = id;
    delete input.command;
    expect((await executeCandidateImplementation(input)).status).toBe("failed");
  });

  it.each(["failed", "cancelled", "expired"] as const)("preserves adapter %s evidence without promoting it", async (status) => {
    const input = fixture();
    input.plan.agent_id = "builder";
    input.adapters = [adapter(async function* (task) { yield done(task, status); })];
    const result = await executeCandidateImplementation(input);
    expect(result.status).toBe(status === "cancelled" ? "cancelled" : "failed");
    expect(result.execution?.summary).toBe("implementation evidence");
  });

  it("retains protocol failure and uncertainty evidence for a stream without done", async () => {
    const input = fixture();
    input.plan.agent_id = "builder";
    input.adapters = [adapter(async function* () {})];
    expect(await executeCandidateImplementation(input)).toMatchObject({ status: "execution_unconfirmed",
      execution: { outcome: "failed", failure_code: "missing_done",
        cancellation: { source: "executor_error", stop_confirmed: false } } });
  });

  it("propagates live caller cancellation and independently confirmed stop evidence", async () => {
    const input = fixture();
    const controller = new AbortController();
    input.signal = controller.signal;
    input.plan.agent_id = "builder";
    const builder = adapter(async function* (task, signal) {
      controller.abort();
      expect(signal.aborted).toBe(true);
      yield done(task);
    });
    builder.confirmStopped = async () => ({ stopped: true, evidence: "worker exited" });
    input.adapters = [builder];
    expect(await executeCandidateImplementation(input)).toMatchObject({ status: "cancelled",
      execution: { cancellation: { source: "external", invocation_started: true,
        stop_confirmed: true, evidence: "worker exited" } } });
  });

  it("maps failed commands and missing adapters to failed with execution evidence", async () => {
    const input = fixture();
    input.command = "exit 7";
    expect(await executeCandidateImplementation(input)).toMatchObject({ status: "failed",
      execution: { command_results: [expect.objectContaining({ exitCode: 7 })] } });
    input.plan.agent_id = "missing-agent";
    expect(await executeCandidateImplementation(input)).toMatchObject({ status: "failed",
      execution: { summary: "agent adapter not registered: missing-agent" } });
  });

  it("preserves unconfirmed cancellation instead of claiming completion", async () => {
    const input = fixture();
    input.plan.agent_id = "builder";
    input.timeoutMs = 10;
    input.cancellationGraceMs = 1;
    input.adapters = [adapter(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }))];
    expect(await executeCandidateImplementation(input)).toMatchObject({ status: "execution_unconfirmed",
      execution: { failure_code: "cancellation_unconfirmed", cancellation: { invocation_started: true, stop_confirmed: false } } });
  });
});

describe("legacy single implementation seam", () => {
  it("retains an unconfirmed worktree and stops later tasks/cycles, including an explicit retry after restart", async () => {
    const input = fixture();
    const workspacePath = input.workspace.workspace_path;
    execFileSync("git", ["init", "-q", workspacePath]);
    execFileSync("git", ["-C", workspacePath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture"]);
    const invoke = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<HermesEvent>>(() => {}) }) }));
    const options = { workspacePath, inputTasks: [input.plan.task, { ...input.plan.task, task_id: "later-task" }],
      agentId: "builder", adapters: [adapter(invoke)], commandTimeoutMs: 10, maxIterations: 3,
      useWorktree: true, worktreeRoot: join(workspacePath, "worktrees"), skipCompletedTasks: false };
    const result = await new LoopEngine(options).runCycles({ cycles: 3 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]?.executedTaskCount).toBe(1);
    const completed = result.state.completed_tasks[0]!;
    expect(completed).toMatchObject({ outcome: "escalated", iterations: 1, worktree_branch_preserved: true });
    expect(existsSync(completed.worktree_path!)).toBe(true);
    expect(result.events.map((event) => event.type)).not.toContain("loop.worktree.cleaned");
    expect(result.state.pending?.map((task) => task.task_id)).toEqual(["later-task"]);
    const resumed = await new LoopEngine(options).runOnce();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(resumed.executedTaskCount).toBe(0);
    expect(resumed.state.pending?.map((task) => task.task_id)).toEqual(["later-task"]);
    expect(existsSync(completed.worktree_path!)).toBe(true);
  });

  it("escalates unknown execution after one invocation with maxIterations > 1 and saves audit evidence", async () => {
    const input = fixture();
    const invoke = vi.fn(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<HermesEvent>>(() => {}) }) }));
    const result = await new LoopEngine({ workspacePath: input.workspace.workspace_path,
      inputTasks: [input.plan.task], agentId: "builder", adapters: [adapter(invoke)],
      commandTimeoutMs: 10, maxIterations: 3,
      verifyCommands: ["node -e \"require('fs').writeFileSync('verified', 'bad')\""],
    }).runOnce();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.completedTasks[0]).toMatchObject({ outcome: "escalated", iterations: 1,
      execution_summary: expect.stringContaining("cancellation_unconfirmed") });
    const audit = readFileSync(result.jsonPath, "utf8");
    expect(audit).toContain('stop_confirmed');
    expect(audit).toContain('invocation_started');
    expect(existsSync(join(input.workspace.workspace_path, "verified"))).toBe(false);
    expect(result.events.map((event) => event.type)).not.toContain("loop.verify.done");
  });
});

describe("reviewed candidate boundaries", () => {
  it("does not trust model text as a persistent stop instruction", async () => {
    const input = fixture();
    const builder = adapter(async function* (task) {
      const event = done(task); event.payload = { status: "completed", last_seq: 1, result_summary: "execution_unconfirmed: {}" }; yield event;
    });
    const options = { workspacePath: input.workspace.workspace_path, agentId: builder.id, adapters: [builder] };
    await new LoopEngine({ ...options, inputTasks: [input.plan.task] }).runOnce();
    const resumed = await new LoopEngine({ ...options, inputTasks: [{ ...input.plan.task, task_id: "next-task" }] }).runOnce();
    expect(resumed.executedTaskCount).toBe(1);
  });

  it("authorizes the repo_path that will actually be used", async () => {
    const input = fixture();
    input.authorize = (scope) => scope.plan.task.context?.["repo_path"] === scope.workspace.workspace_path
      ? { allow: true } : { allow: false, reason: "Wrong effective path" };
    expect((await executeCandidateImplementation(input)).status).toBe("implementation_complete");
  });

  it.each(["workspace", "command"])("rejects NUL in %s before authority or effects", async (target) => {
    const input = fixture();
    if (target === "workspace") input.workspace.workspace_path += "\0"; else input.command += "\0";
    input.authorize = vi.fn(input.authorize);
    expect((await executeCandidateImplementation(input)).status).toBe("invalid_input");
    expect(input.authorize).not.toHaveBeenCalled();
  });

  it("returns uncertainty rather than throwing on an unexpected execution failure", async () => {
    const input = fixture();
    input.plan.agent_id = "broken-registry";
    input.adapters = [{ get id(): string { throw new Error("registry failed"); } } as AgentAdapter];
    expect(await executeCandidateImplementation(input)).toMatchObject({ status: "execution_unconfirmed", reason: expect.stringContaining("registry failed") });
  });
});
