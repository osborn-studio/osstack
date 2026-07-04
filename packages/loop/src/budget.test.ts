import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopBudget, checkBudget, clampTaskIterations, type BudgetUsage } from "./budget.js";
import { LoopEngine } from "./loop-engine.js";
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
  it("defaults no_progress_limit to 2 and keeps other limits optional", () => {
    const budget = LoopBudget.parse({});
    expect(budget.no_progress_limit).toBe(2);
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
    expect(checkBudget(LoopBudget.parse({}), usage({ no_progress_cycles: 2 })))
      .toMatchObject({ exceeded: true, limit: "no_progress_limit" });
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
});

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
