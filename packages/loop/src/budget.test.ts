import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopBudget, checkBudget, clampTaskIterations, type BudgetUsage } from "./budget.js";
import { LoopEngine } from "./loop-engine.js";
import { GitDiffScanner } from "./discover.js";
import * as stateFile from "./state-file.js";
import { readLoopState } from "./state-file.js";
import {
  createLoopStateReport,
  createLoopStateScorecardFromState,
  renderLoopStateReportFromState,
} from "./report.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-budget-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("LoopBudget schema", () => {
  it("leaves no_progress_limit unset (opt-in) and all limits optional", () => {
    const budget = LoopBudget.parse({});
    expect(budget.no_progress_limit).toBeUndefined();
    expect(budget.max_cycles).toBeUndefined();
    expect(budget.max_runtime_ms).toBeUndefined();
  });

  it("rejects non-positive limits", () => {
    expect(() => LoopBudget.parse({ max_cycles: 0 })).toThrow();
    expect(() => LoopBudget.parse({ max_runtime_ms: -1 })).toThrow();
    expect(() => LoopBudget.parse({ no_progress_limit: 0 })).toThrow();
  });
});

describe("checkBudget", () => {
  it("trips each limit with a structured reason", () => {
    expect(checkBudget(LoopBudget.parse({ max_cycles: 2 }), usage({ cycles: 2 })))
      .toMatchObject({ exceeded: true, limit: "max_cycles" });
    expect(checkBudget(LoopBudget.parse({ max_runtime_ms: 100 }), usage({ runtime_ms: 150 })))
      .toMatchObject({ exceeded: true, limit: "max_runtime_ms" });
    expect(checkBudget(LoopBudget.parse({ max_tokens: 1000 }), usage({ tokens: 1200 })))
      .toMatchObject({ exceeded: true, limit: "max_tokens" });
    expect(checkBudget(LoopBudget.parse({ max_estimated_cost_usd: 1 }), usage({ estimated_cost_usd: 1.5 })))
      .toMatchObject({ exceeded: true, limit: "max_estimated_cost_usd" });
    expect(checkBudget(LoopBudget.parse({ no_progress_limit: 2 }), usage({ no_progress_cycles: 2 })))
      .toMatchObject({ exceeded: true, limit: "no_progress_limit" });
  });

  it("does not trip no-progress when the limit is unset (opt-in)", () => {
    expect(checkBudget(LoopBudget.parse({ max_runtime_ms: 100 }), usage({ no_progress_cycles: 99 })))
      .toEqual({ exceeded: false });
  });

  it("stays within budget when no limit is reached", () => {
    const budget = LoopBudget.parse({ max_cycles: 10, max_runtime_ms: 10_000, max_tokens: 1000 });
    expect(checkBudget(budget, usage({ cycles: 3, runtime_ms: 500, tokens: 100 })))
      .toEqual({ exceeded: false });
  });
});

describe("clampTaskIterations", () => {
  it("clamps only when the budget sets max_task_iterations", () => {
    expect(clampTaskIterations(3, undefined)).toBe(3);
    expect(clampTaskIterations(3, LoopBudget.parse({}))).toBe(3);
    expect(clampTaskIterations(3, LoopBudget.parse({ max_task_iterations: 1 }))).toBe(1);
  });
});

describe("LoopEngine budget enforcement", () => {
  it.each(["max_cycles", "max_runtime_ms", "max_tokens", "max_estimated_cost_usd", "no_progress_limit"] as const)(
    "refuses discovery at persisted %s and continues after a raise", async limit => {
      await enqueue("retry");
      let now = 100;
      const scan = vi.spyOn(GitDiffScanner.prototype, "scan").mockImplementation(async () => { now++; return []; });
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const adapter = usageAdapter({ tokensIn: 1, tokensOut: 0, cost: 1 });
      const engine = (cap: number) => new LoopEngine({ workspacePath: workspace, sources: ["git_diff", "task_queue"],
        adapters: [adapter], agentId: adapter.id, skipCompletedTasks: false, verifyCommands: ["exit 1"], budget: { [limit]: cap } });
      try {
        const first = await engine(1).runOnce();
        const unit = { cycles: 1, runtime_ms: 1, tokens: 1, estimated_cost_usd: 1, no_progress_cycles: 1 };
        expect(first.budget).toMatchObject({ exceeded: true, limit, usage: unit });
        now += 1000;
        const refused = await engine(1).runCycles({ cycles: 2 });
        expect(refused.budget).toEqual(first.budget);
        expect(refused.cycles).toEqual([]);
        expect(refused.events.map(e => e.type)).toEqual(["loop.budget.exceeded", "loop.stopped"]);
        expect(scan).toHaveBeenCalledTimes(1);
        const resumed = await engine(3).runOnce();
        expect(resumed.budget).toMatchObject({ exceeded: false, usage: {
          cycles: 2, runtime_ms: 2, tokens: 2, estimated_cost_usd: 2, no_progress_cycles: 2,
        } });
        expect((await readLoopState(resumed.jsonPath))?.budget_status).toEqual(resumed.budget);
      } finally { vi.restoreAllMocks(); }
    });

  it("resets a legacy no-progress streak after raising the limit and succeeding", async () => {
    const path = join(workspace, "LOOP-STATE.json");
    await writeFile(path, JSON.stringify({
      ...stateFile.createInitialLoopState("legacy"),
      budget_status: { exceeded: true, limit: "no_progress_limit", reason: "legacy stop",
        usage: usage({ cycles: 2, runtime_ms: 50, no_progress_cycles: 2 }) },
    }));
    await enqueue("retry");
    const run = (command: string) => new LoopEngine({ workspacePath: workspace, sources: ["task_queue"],
      executeCommand: command, skipCompletedTasks: false, budget: { no_progress_limit: 3 } }).runOnce();
    const success = await run("exit 0");
    expect(success.completedTasks[0]?.outcome).toBe("success");
    expect(success.budget).toMatchObject({ exceeded: false, usage: { cycles: 3, no_progress_cycles: 0 } });
    expect(success.budget!.usage.runtime_ms).toBeGreaterThanOrEqual(50);
    expect((await run("exit 1")).budget).toMatchObject({ exceeded: false, usage: { cycles: 4, no_progress_cycles: 1 } });
  });

  it.each([
    { command: "exit 1", streak: 2, exceeded: true },
    { command: "exit 0", streak: 0, exceeded: false },
  ])("after a failure and restart, $command leaves streak $streak", async ({ command, streak, exceeded }) => {
    await enqueue("retry");
    const run = (executeCommand: string) => new LoopEngine({
      workspacePath: workspace, sources: ["task_queue"], executeCommand,
      skipCompletedTasks: false, budget: { no_progress_limit: 2 },
    }).runOnce();
    expect((await run("exit 1")).budget).toMatchObject({ exceeded: false, usage: { no_progress_cycles: 1 } });
    const result = await run(command);
    expect(result.budget).toMatchObject({
      exceeded, ...(exceeded && { limit: "no_progress_limit" }), usage: { cycles: 2, no_progress_cycles: streak },
    });
    expect((await readLoopState(result.jsonPath))?.budget_status).toEqual(result.budget);
  });

  it("keeps the admission debit when the cycle result cannot be written", async () => {
    const engine = () => new LoopEngine({ workspacePath: workspace, sources: [], budget: { max_cycles: 2 } });
    const write = stateFile.writeLoopState;
    const spy = vi.spyOn(stateFile, "writeLoopState").mockImplementationOnce(write).mockRejectedValueOnce(Error("crash"));
    try { await expect(engine().runOnce()).rejects.toThrow("crash"); }
    finally { spy.mockRestore(); }
    expect((await readLoopState(join(workspace, "LOOP-STATE.json")))?.budget_status?.usage).toEqual(usage({ cycles: 1 }));
    expect((await engine().runOnce()).budget).toMatchObject({ exceeded: true, usage: { cycles: 2 } });
  });

  it("preserves unbudgeted two-cycle state and events before enabling a budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    try {
      const options = { workspacePath: workspace, loopId: "legacy", sources: [] };
      const result = await new LoopEngine(options).runCycles({ cycles: 2 });
      expect(JSON.parse(await readFile(result.jsonPath, "utf8"))).not.toHaveProperty("budget_status");
      expect(result.events.map(event => event.type)).toEqual([
        "loop.started",
        "loop.cycle.started", "loop.discover.done", "loop.state.written", "loop.cycle.completed",
        "loop.cycle.started", "loop.discover.done", "loop.state.written", "loop.cycle.completed",
        "loop.stopped",
      ]);
      expect((await new LoopEngine({ ...options, budget: {} }).runOnce()).budget?.usage).toEqual(usage({ cycles: 1 }));
    } finally { vi.useRealTimers(); }
  });

  it("stops after consecutive no-progress cycles and emits loop.budget.exceeded", async () => {
    await enqueue("stuck-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 1",
      skipCompletedTasks: false,
      budget: LoopBudget.parse({ no_progress_limit: 2 }),
    });
    const result = await engine.runCycles({ cycles: 5 });

    expect(result.cycles).toHaveLength(2);
    expect(result.budget).toMatchObject({
      exceeded: true,
      limit: "no_progress_limit",
      usage: expect.objectContaining({ no_progress_cycles: 2 }),
    });
    const budgetEvents = result.events.filter((event) => event.type === "loop.budget.exceeded");
    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]?.payload).toMatchObject({ limit: "no_progress_limit" });
    const stopped = result.events.filter((event) => event.type === "loop.stopped").at(-1);
    expect(stopped?.payload?.["reason"]).toContain("budget exceeded");
  });

  it("stops at max_cycles even while making progress", async () => {
    await enqueue("healthy-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 0",
      skipCompletedTasks: false,
      budget: LoopBudget.parse({ max_cycles: 2 }),
    });
    const result = await engine.runCycles({ cycles: 5 });

    expect(result.cycles).toHaveLength(2);
    expect(result.budget).toMatchObject({ exceeded: true, limit: "max_cycles" });
  });

  it("clamps per-task iterations to max_task_iterations", async () => {
    await enqueue("iterating-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 0",
      verifyCommands: ["exit 1"],
      maxIterations: 3,
      budget: LoopBudget.parse({ max_task_iterations: 1, no_progress_limit: 99 }),
    });
    const result = await engine.runOnce();

    expect(result.state.completed_tasks[0]).toMatchObject({
      outcome: "escalated",
      iterations: 1,
    });
  });

  it("reports a runtime budget stop from runOnce", async () => {
    await enqueue("slow-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"setTimeout(() => {}, 25)\"",
      budget: LoopBudget.parse({ max_runtime_ms: 1 }),
    });
    const result = await engine.runOnce();

    expect(result.budget).toMatchObject({ exceeded: true, limit: "max_runtime_ms" });
    expect(result.events.some((event) => event.type === "loop.budget.exceeded")).toBe(true);
    expect(result.state.completed_tasks[0]?.outcome).toBe("success");
  });

  it("persists budget status into state, STATE.md, report, and scorecard", async () => {
    await enqueue("surfaced-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 1",
      skipCompletedTasks: false,
      budget: LoopBudget.parse({ no_progress_limit: 1 }),
    });
    const result = await engine.runCycles({ cycles: 3 });

    // Durable state carries the budget status for `loop status`.
    expect(result.state.budget_status).toMatchObject({ exceeded: true, limit: "no_progress_limit" });
    const persisted = await readLoopState(result.jsonPath);
    expect(persisted?.budget_status).toMatchObject({ exceeded: true, limit: "no_progress_limit" });
    expect(persisted?.decisions?.some((decision) => decision.startsWith("budget:"))).toBe(true);

    const markdown = engine.statusMarkdown(result.state);
    expect(markdown).toContain("## Budget");
    expect(markdown).toContain("exceeded (no_progress_limit)");

    const report = createLoopStateReport(result.state);
    expect(report.budget).toMatchObject({ exceeded: true, limit: "no_progress_limit" });
    expect(report.risks.some((risk) => risk.includes("budget"))).toBe(true);
    const reportMarkdown = renderLoopStateReportFromState(result.state);
    expect(reportMarkdown).toContain("## Budget");
    expect(reportMarkdown).toContain("no_progress_limit");

    const scorecard = createLoopStateScorecardFromState(result.state);
    const budgetItem = scorecard.items.find((item) => item.id === "budget_within_limits");
    expect(budgetItem).toMatchObject({ status: "fail", earned: 0, max: 10 });
    expect(scorecard.max_score).toBe(110);
  });

  it("keeps the legacy 100-point scorecard when no budget is configured", async () => {
    await enqueue("legacy-scorecard-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 0",
    });
    const result = await engine.runOnce();

    const scorecard = createLoopStateScorecardFromState(result.state);
    expect(scorecard.max_score).toBe(100);
    expect(scorecard.items.some((item) => item.id === "budget_within_limits")).toBe(false);
  });

  it("does not enforce any budget when none is configured", async () => {
    await enqueue("legacy-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 0",
    });
    const result = await engine.runOnce();

    expect(result.budget).toBeUndefined();
    expect(result.events.some((event) => event.type === "loop.budget.exceeded")).toBe(false);
  });

  it("accumulates adapter-reported tokens/cost and trips max_tokens", async () => {
    await enqueue("tokened-task");
    // Adapter reports usage per run; two cycles push tokens over the cap.
    const adapter = usageAdapter({ tokensIn: 400, tokensOut: 400, cost: 0.02 });

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: "usage-agent",
      adapters: [adapter],
      skipCompletedTasks: false,
      budget: LoopBudget.parse({ max_tokens: 1000 }),
    });
    const result = await engine.runCycles({ cycles: 3 });

    // 800 tokens/cycle: cycle 1 = 800 (< 1000), cycle 2 = 1600 (>= 1000) → stop.
    expect(result.cycles).toHaveLength(2);
    expect(result.budget).toMatchObject({ exceeded: true, limit: "max_tokens" });
    expect(result.state.key_metrics?.tokens_consumed).toBeGreaterThanOrEqual(1000);
    expect(result.state.key_metrics?.cost_consumed).toBeGreaterThan(0);
    const completed = result.state.completed_tasks[0];
    expect(completed?.tokens_in).toBe(400);
    expect(completed?.cost_usd).toBeCloseTo(0.02);
  });

  it("trips max_cost_usd against adapter-reported spend", async () => {
    await enqueue("costed-task");
    const adapter = usageAdapter({ tokensIn: 10, tokensOut: 10, cost: 0.5 });

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      agentId: "usage-agent",
      adapters: [adapter],
      skipCompletedTasks: false,
      budget: LoopBudget.parse({ max_estimated_cost_usd: 0.9 }),
    });
    const result = await engine.runCycles({ cycles: 3 });

    expect(result.budget).toMatchObject({ exceeded: true, limit: "max_estimated_cost_usd" });
  });

  it("leaves usage at 0 for adapters that do not report it (cap never trips)", async () => {
    await enqueue("silent-task");

    const engine = new LoopEngine({
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "exit 0",
      skipCompletedTasks: false,
      budget: LoopBudget.parse({ max_tokens: 1 }),
    });
    const result = await engine.runCycles({ cycles: 2 });

    expect(result.budget?.exceeded).toBe(false);
    expect(result.state.key_metrics?.tokens_consumed).toBe(0);
  });
});

function usageAdapter(u: { tokensIn: number; tokensOut: number; cost: number }): AgentAdapter {
  return {
    id: "usage-agent",
    display_name: "Usage Agent",
    cost_tier: "low",
    capabilities: () => [{
      id: "usage.code.test",
      kind: "code.test",
      agent_id: "usage-agent",
      description: "reports usage",
      cost_tier: "low",
      hints: {},
      version: "0.0.0",
    }],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    async *invoke(task) {
      yield {
        event_id: `${task.run_id}:u`,
        seq: 1,
        run_id: task.run_id,
        session_id: task.session_id,
        created_at: Date.now() / 1000,
        terminal: false,
        type: "usage.final",
        payload: { tokens_in: u.tokensIn, tokens_out: u.tokensOut, cost_usd: u.cost, duration_ms: 1 },
      } as unknown as HermesEvent;
      yield {
        event_id: `${task.run_id}:d`,
        seq: 2,
        run_id: task.run_id,
        session_id: task.session_id,
        created_at: Date.now() / 1000,
        terminal: true,
        type: "done",
        payload: { status: "completed", last_seq: 2, result_summary: "ok" },
      } as unknown as HermesEvent;
    },
  };
}

async function enqueue(taskId: string): Promise<void> {
  await mkdir(join(workspace, "tasks"), { recursive: true });
  await writeFile(
    join(workspace, "tasks", `${taskId}.json`),
    `${JSON.stringify({ task_id: taskId, capability: "code.test", prompt: `Run ${taskId}`, priority: 50 }, null, 2)}\n`,
    "utf-8",
  );
}

function usage(overrides: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    cycles: 0,
    runtime_ms: 0,
    tokens: 0,
    estimated_cost_usd: 0,
    no_progress_cycles: 0,
    ...overrides,
  };
}
