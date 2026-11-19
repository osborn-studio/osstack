import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopBudgetStatus, LoopBudget, checkBudget, clampTaskIterations, type BudgetUsage } from "./budget.js";
import { LoopState } from "./types.js";
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

  it.each(["max_cycles", "max_runtime_ms", "max_tokens", "max_estimated_cost_usd"] as const)(
    "explicitly resets exhausted %s once and counts only new work", async limit => {
      await enqueue("repeat");
      let now = 100;
      const scan = vi.spyOn(GitDiffScanner.prototype, "scan").mockImplementation(async () => { now++; return []; });
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const adapter = usageAdapter({ tokensIn: 2, tokensOut: 1, cost: 1 });
      const invoke = vi.spyOn(adapter, "invoke");
      const engine = (resetBudget = false) => new LoopEngine({
        workspacePath: workspace, sources: ["git_diff", "task_queue"], adapters: [adapter], agentId: adapter.id,
        skipCompletedTasks: false, budget: { [limit]: 1 }, resetBudget,
      });
      try {
        const first = await engine().runOnce();
        expect(first.budget).not.toHaveProperty("baseline");
        expect(first.events.map(e => e.type)).not.toContain("loop.budget.reset");
        const refused = await engine().runOnce();
        expect(refused.budget).toEqual(first.budget);
        expect(refused.budget?.exceeded).toBe(true);
        expect(scan).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledTimes(1);
        for (const n of [1, 2]) {
          const resetting = engine(true);
          const result = await resetting.runOnce();
          const baseline = { tokens: n * 3, estimated_cost_usd: n };
          expect(result.events.slice(0, 3).map(e => e.type)).toEqual([
            "loop.state.written", "loop.budget.reset", "loop.state.written",
          ]);
          expect(result.events.filter(e => e.type === "loop.budget.reset").map(e => e.payload))
            .toEqual([{ usage_before: first.budget!.usage, baseline }]);
          expect(result.budget).toEqual({ ...first.budget, baseline });
          expect(result.state.key_metrics?.tokens_consumed).toBe(3 * (n + 1));
          expect((await resetting.runOnce()).executedTaskCount).toBe(0);
        }
      } finally { vi.restoreAllMocks(); }
    });

  it("persists only the reset before a crash and resumes from zero", async () => {
    await enqueue("metered");
    const adapter = usageAdapter({ tokensIn: 8, tokensOut: 2, cost: 3 });
    const options = { workspacePath: workspace, sources: [], budget: { max_tokens: 1 } };
    const first = await new LoopEngine({ ...options, sources: ["task_queue"], adapters: [adapter], agentId: adapter.id }).runOnce();
    const previous = (await readLoopState(first.jsonPath))!;
    // Admission reconciles an older budget snapshot with lifetime metrics.
    previous.budget_status!.usage.tokens = 1;
    previous.budget_status!.usage.no_progress_cycles = 4;
    await stateFile.writeLoopState(first.jsonPath, previous);
    const write = stateFile.writeLoopState;
    const spy = vi.spyOn(stateFile, "writeLoopState").mockImplementationOnce(write)
      .mockRejectedValueOnce(Error("crash before debit"));
    try { await expect(new LoopEngine({ ...options, resetBudget: true }).runOnce()).rejects.toThrow("crash before debit"); }
    finally { spy.mockRestore(); }
    const status = { exceeded: false, usage: usage(), baseline: { tokens: 10, estimated_cost_usd: 3 } };
    expect(await readLoopState(first.jsonPath)).toEqual({ ...previous, budget_status: status });
    expect((await new LoopEngine(options).runOnce()).budget).toMatchObject({ ...status, usage: { cycles: 1, tokens: 0, estimated_cost_usd: 0 } });
  });

  it("records reconciled usage and persists the reset even when containment refuses work", async () => {
    await enqueue("unconfirmed");
    const adapter = usageAdapter({ tokensIn: 5, tokensOut: 3, cost: 2 });
    const options = { workspacePath: workspace, budget: { max_tokens: 4 } };
    const first = await new LoopEngine({ ...options, sources: ["task_queue"], agentId: adapter.id, adapters: [adapter] }).runOnce();
    const previous = (await readLoopState(first.jsonPath))!;
    previous.completed_tasks[0]!.implementation_unconfirmed = true;
    const prior = previous.budget_status!;
    prior.baseline = { tokens: 2, estimated_cost_usd: 0.5 };
    prior.usage.tokens = 1;
    prior.usage.estimated_cost_usd = 4;
    await stateFile.writeLoopState(first.jsonPath, previous);
    const reset = await new LoopEngine({ ...options, resetBudget: true }).runOnce();
    const baseline = { tokens: 8, estimated_cost_usd: 2 };
    expect(reset.events.map(e => e.type)).toEqual(["loop.state.written", "loop.budget.reset", "loop.stopped"]);
    expect(reset.events[1]?.payload).toEqual({ usage_before: { ...prior.usage, tokens: 6 }, baseline });
    expect(await readLoopState(first.jsonPath)).toEqual({ ...previous, budget_status: { exceeded: false, usage: usage(), baseline } });
  });

  it("resets once across multiple cycles", async () => {
    const result = await new LoopEngine({ workspacePath: workspace, sources: [], budget: {}, resetBudget: true }).runCycles({ cycles: 3 });
    expect(result.events.filter(e => e.type === "loop.budget.reset").map(e => e.payload))
      .toEqual([{ usage_before: usage(), baseline: { tokens: 0, estimated_cost_usd: 0 } }]);
    expect(result.budget?.usage.cycles).toBe(3);
  });

  it("rejects reset without a budget before state access", async () => {
    const read = vi.spyOn(stateFile, "readLoopState");
    const write = vi.spyOn(stateFile, "writeLoopState");
    try {
      await expect(new LoopEngine({ workspacePath: workspace, sources: [], resetBudget: true }).runOnce()).rejects.toThrow(/resetBudget requires.*budget/);
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
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
    expect(result.budget).toHaveProperty("unenforced", [{ adapter: "local-command", limit: "max_tokens" }]);
  });
});

describe("adapter budget visibility", () => {
  const token = { max_tokens: 100 };
  const cost = { max_estimated_cost_usd: 1 };
  const both = { ...token, ...cost };
  const tokenPair = { adapter: "usage-agent", limit: "max_tokens" };
  const costPair = { adapter: "usage-agent", limit: "max_estimated_cost_usd" };
  const engine = (adapter: AgentAdapter, budget?: LoopBudget) => new LoopEngine({
    workspacePath: workspace, loopId: "visibility", sources: ["task_queue"],
    agentId: adapter.id, adapters: [adapter], skipCompletedTasks: false, ...(budget && { budget }),
  });
  const warnings = (events: { type: string; payload?: Record<string, unknown> | undefined }[]) =>
    events.filter(event => event.type === "loop.budget.unenforceable").map(event => event.payload);

  it("persists the first silent task and keeps the normal completion and score", async () => {
    await enqueue("one");
    await enqueue("two");
    const result = await engine(usageAdapter({}), token).runCycles({ cycles: 2 });
    expect(result.cycles.map(cycle => cycle.executedTaskCount)).toEqual([2, 2]);
    expect(result.state.completed_tasks.every(task => task.outcome === "success")).toBe(true);
    expect(result.events.at(-1)?.payload).toMatchObject({ reason_code: "completed" });
    expect(warnings(result.events)).toEqual([{ ...tokenPair, task_id: result.state.completed_tasks[0]!.task_id, reason: expect.any(String) }]);
    const state = (await readLoopState(result.jsonPath))!;
    for (const status of [result.budget, ...result.cycles.map(cycle => cycle.budget), state.budget_status, createLoopStateReport(state).budget]) {
      expect(status).toMatchObject({ exceeded: false, unenforced: [tokenPair] });
    }
    for (const text of [renderLoopStateReportFromState(state), await readFile(result.markdownPath, "utf8"), createLoopStateReport(state).risks.join(" ")]) {
      expect(text).toContain(tokenPair.adapter);
      expect(text).toContain(tokenPair.limit);
    }
    const oldShape = LoopBudgetStatus.pick({ exceeded: true, limit: true, reason: true, usage: true });
    const oldStatus = LoopState.extend({ budget_status: oldShape.optional() }).parse(state).budget_status!;
    expect(oldStatus).not.toHaveProperty("unenforced");
    const legacyState = { ...state, budget_status: oldStatus };
    expect(createLoopStateScorecardFromState(state)).toEqual(createLoopStateScorecardFromState(legacyState));
    await writeFile(result.jsonPath, JSON.stringify(legacyState));
    expect((await readLoopState(result.jsonPath))?.budget_status).toEqual(oldStatus);
  });

  it.each([
    [token, { tokensOut: 0 }, []],
    [cost, { tokensIn: 1 }, [costPair]],
    [both, { tokensIn: 1 }, [costPair]],
    [both, { cost: 0 }, [tokenPair]],
    [both, {}, [tokenPair, costPair]],
  ] as const)("checks only configured caps %j against reported fields %j", async (budget, reported, pairs) => {
    await enqueue("task");
    const result = await engine(usageAdapter(reported), budget).runOnce();
    expect(warnings(result.events)).toEqual(pairs.map(pair => ({ ...pair, task_id: "task", reason: expect.any(String) })));
    if (pairs.length) expect(result.budget).toHaveProperty("unenforced", pairs);
    else expect(result.state.budget_status).not.toHaveProperty("unenforced");
  });

  it("remembers cost from an earlier snapshot when done.usage supplies only tokens", async () => {
    await enqueue("partial");
    const adapter = usageAdapter({ cost: 0 });
    const invoke = adapter.invoke.bind(adapter);
    adapter.invoke = async function* (task, signal) {
      for await (const event of invoke(task, signal)) {
        if (event.type === "done") {
          yield { ...event, payload: { status: "completed", last_seq: event.seq, usage: { tokens_in: 1, tokens_out: 0, duration_ms: 1 } } };
        } else yield event;
      }
    };
    const result = await engine(adapter, both).runOnce();
    expect(result.budget?.usage.tokens).toBe(1);
    expect(warnings(result.events)).toEqual([]);
    expect(result.budget).not.toHaveProperty("unenforced");
  });

  it("remembers a pair across restarts, later usage, and cap removal", async () => {
    await enqueue("repeat");
    const silent = usageAdapter({});
    const first = await engine(silent, token).runCycles({ cycles: 3 });
    expect(warnings(first.events)).toHaveLength(1);
    for (const next of [engine(silent, token), engine(usageAdapter({ tokensIn: 1 }), token), engine(silent, { max_cycles: 20 }), engine(silent, token)]) {
      const result = await next.runOnce();
      expect(result.executedTaskCount).toBe(1);
      expect(warnings(result.events)).toEqual([]);
      expect(result.budget).toHaveProperty("unenforced", [tokenPair]);
    }
  });

  it("carries warning history through a real stop and an admission refusal", async () => {
    await enqueue("repeat");
    const run = () => engine(usageAdapter({}), { ...both, max_cycles: 1 }).runOnce();
    const first = await run();
    const refused = await run();
    expect(first.budget).toMatchObject({ exceeded: true, limit: "max_cycles", unenforced: [tokenPair, costPair] });
    expect(refused.budget).toEqual(first.budget);
    expect(refused.executedTaskCount).toBe(0);
    expect(warnings(refused.events)).toEqual([]);
  });

  it("attributes missing tokens to the silent adapter in a mixed cycle", async () => {
    const adapters = [usageAdapter({}, "silent"), usageAdapter({ tokensIn: 1 }, "metered")];
    const result = await new LoopEngine({ workspacePath: workspace, sources: [], adapters, budget: token,
      inputTasks: adapters.map(adapter => ({ task_id: adapter.id, capability: adapter.id + ".code.test", prompt: "test", source: "task_queue", priority: 1 })),
    }).runOnce();
    expect(result.completedTasks.map(task => task.agent_id)).toEqual(["silent", "metered"]);
    expect(warnings(result.events)).toEqual([{ adapter: "silent", limit: "max_tokens", task_id: "silent", reason: expect.any(String) }]);
  });

  it.each([
    [undefined, "1eddbc6cc21be837972b65ebdfe150f972985edb9f69daf3873a9cf0cae5ee41"],
    [{ max_cycles: 5 }, "5e1ce66816e8f96d316c4f7fa465855e046b9a3c419ddee745ea161fde847765"],
    [{ max_runtime_ms: 100 }, "5e1ce66816e8f96d316c4f7fa465855e046b9a3c419ddee745ea161fde847765"],
  ] as const)("preserves legacy state bytes without usage caps %j", async (budget, digest) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    try {
      await enqueue("legacy");
      const result = await engine(usageAdapter({ tokensIn: 1 }), budget).runOnce();
      expect(warnings(result.events)).toEqual([]);
      expect(result.state.budget_status ?? {}).not.toHaveProperty("unenforced");
      const bytes = (await readFile(result.jsonPath, "utf8")).replaceAll(result.completedTasks[0]!.run_id!, "fixed-run");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    } finally { vi.useRealTimers(); }
  });
});

function usageAdapter(u: { tokensIn?: number; tokensOut?: number; cost?: number }, id = "usage-agent"): AgentAdapter {
  return {
    id,
    display_name: "Usage Agent",
    cost_tier: "low",
    capabilities: () => [{
      id: id + ".code.test",
      kind: "code.test",
      agent_id: id,
      description: "reports usage",
      cost_tier: "low",
      hints: {},
      version: "0.0.0",
    }],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    async *invoke(task) {
      if (Object.keys(u).length > 0) yield {
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
