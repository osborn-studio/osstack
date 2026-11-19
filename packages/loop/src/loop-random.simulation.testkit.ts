// The command contains its own entropy. Removing an earlier command during
// shrinking does not reroll every later adapter stream.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import { createScratchDirSync } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { vi } from "vitest";
import { z } from "zod";
import * as budgeting from "./budget.js";
import * as executor from "./executor.js";
import * as iterator from "./iterator.js";
import * as stateFile from "./state-file.js";
import { LoopEngine } from "./loop-engine.js";
import * as isolation from "./reviewer-isolation.js";
import { pick, random, Trace } from "./seeded-simulation.testkit.js";

import type { LoopEvent, Task } from "./types.js";
import * as verifier from "./verifier.js";

const ops = ["submit", "duplicate_submission", "pass", "cycles", "restart_mid_step",
  "clock", "duplicate_answer", "late_result", "raise_budget", "crash_after_debit", "reset"] as const;
export const command = z.object({
  op: z.enum(ops), key: z.number().int().min(0).max(0xffffffff),
  // Explicit boundary values also work in hand-written replays.
  allowContainment: z.boolean().optional(), tick: z.number().int().safe().optional(), cycleLimit: z.number().int().positive().optional(),
  cycleTicks: z.array(z.number().int().safe()).optional(),
  tokenLimit: z.number().int().positive().optional(), costLimit: z.number().finite().positive().optional(),
}).strict();
export type Command = z.infer<typeof command>;
export type Rule = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
export type Mutant = Rule | "reset-on-restart" | "forget-baseline";
export class Violation extends Error {
  constructor(readonly rule: Rule, readonly step: number, readonly detail: string) {
    super(`${rule} step=${step} ${detail}`);
  }
}

export function generate(seed: number, steps: number): Command[] {
  const next = random(seed);
  const commands: Command[] = [];
  // Documented R4 limit: token and cost checks follow work, so use high defaults.
  // Unconfirmed work permanently contains this workspace. Draw those faults
  // late enough to stress a growing ledger before exercising containment.
  const openUntil = Math.floor(steps * (.45 + (next() % 30) / 100));
  for (let i = 0; i < steps; i++) {
    const ordinary = ["submit", "duplicate_submission", "clock", "submit", "submit", "pass", "pass",
      "cycles", "raise_budget", "crash_after_debit", "duplicate_answer", "late_result"] as const;
    const op = pick(next, i >= openUntil ? [...ordinary, "restart_mid_step"] as const : ordinary);
    const key = next();
    const magnitude = 1 + key % 5;
    // Finish each generated history with a reset against the accumulated state.
    commands.push({ op: i === steps - 1 ? "reset" : op, key,
      ...(op === "pass" ? { tick: key % 2 ? magnitude : -magnitude } : {}),
      ...(op === "cycles" ? { cycleTicks: [-magnitude - 1, magnitude] } : {}),
      ...(i >= openUntil ? {} : { allowContainment: false }),
    });
  }
  return commands;
}

type Response = "ok" | "failed" | "missing" | "duplicate_answer" | "late_result" | "duplicate_submission"
  | "clock_backwards" | "lost_response" | "restart_mid_step";
function response(next: () => number, allowContainment: boolean): Response {
  const draw = next() % (allowContainment ? 96 : 94);
  if (draw < 32) return "ok";
  if (draw < 48) return "failed";
  if (draw < 65) return "missing";
  if (draw < 74) return "duplicate_answer";
  if (draw < 80) return "late_result";
  if (draw < 87) return "duplicate_submission";
  if (draw < 94) return "clock_backwards";
  return draw === 94 ? "restart_mid_step" : "lost_response";
}
type Repair = "ok" | "missing" | "mutation" | "unknown";
type Call = {
  task: string; iteration: number; run: string; answer: Response; terminals: HermesEvent[];
  reportOrdinal: number; elapsed: number;
  repairs: { task: string; original: string; answer: Repair }[]; pass: boolean; invalid: boolean;
};
function envelope(input: AgentTask, seq: number, now: number, status?: "completed" | "failed"): HermesEvent {
  return { event_id: input.run_id + "-" + seq, run_id: input.run_id, session_id: input.session_id,
    seq, created_at: now, type: status ? "done" : "usage.final", terminal: !!status,
    payload: status ? { status, last_seq: seq } : { tokens_in: 1, tokens_out: 1, cost_usd: .125 },
  } as HermesEvent;
}

export async function simulate(seed: number, commands: Command[], mutant?: Mutant) {
  const root = createScratchDirSync("tests", "loop-random");
  const workspace = join(root, "workspace");
  const artifact = join(workspace, "output.ts");
  const tasks: Task[] = [];
  const calls: Call[] = [];
  const uncertain = new Set<string>();
  const settled = new Map<string, string>();
  const actions = new Map<string, string[]>();
  const coverage = new Set<string>();
  const trace = new Trace(seed);
  let now = 1_000_000, passes = 0, cycles = 0, usageReports = 0, serial = 0;
  let cycleLimit = 2, tokenLimit = Number.MAX_SAFE_INTEGER, costLimit = Number.MAX_SAFE_INTEGER;
  let crashDebits = 0;
  let cycleBaseline = 0, reportBaseline = 0;
  const budgetReports = () => usageReports - reportBaseline;
  let crashAfterDebit = false;
  const crash = Error("simulated process exit after cycle debit");
  let budgetStart = now, lastSample = now, expectedRuntime = 0, reportedRuntime = 0;
  let rewound = false;
  function sampleBudgetClock() {
    const delta = now - lastSample;
    if (delta < 0) rewound = true;
    if (delta > 0 && rewound) coverage.add("forward-after-rewind");
    expectedRuntime += Math.max(0, delta);
    lastSample = now;
  }
  let previousBudgetCycles = 0, previousRuntime = 0, budgetStopped = false;
  let next = random(seed), restart = false, tick = 0, allowContainment = true;
  let oldAnswer: HermesEvent | undefined;
  let delivery: "late_result" | "duplicate_answer" | undefined;
  let step = 0;
  function check(rule: Rule, ok: unknown, message: string) {
    if (!ok) throw new Violation(rule, step, message);
  }
  let boundaryViolation: Violation | undefined;
  function observeAdmission(task: string) {
    // The executor converts adapter throws into uncertain stops. Remember the
    // violation outside the stream and let the real invocation finish.
    try { admit(task); } catch (error) {
      if (!(error instanceof Violation)) throw error;
      boundaryViolation ??= error;
    }
  }
  function admit(task: string) {
    check("R2", !uncertain.has(task), "dispatch after unknown stop");
    check("R1", !settled.has(task), "dispatch after completion");
    check("R4", !budgetStopped, "dispatch after budget stop");
  }
  const adapter: AgentAdapter = {
    id: "simulation-builder", display_name: "Simulation builder", cost_tier: "low",
    capabilities: () => [], isAvailable: async () => ({ available: true, last_checked_at: now }),
    hasReportSession: () => true,
    async *invoke(input) {
      observeAdmission(input.task_id);
      const feedback = input.context?.["iteration_feedback"] as { attempt: number } | undefined;
      const iteration = (feedback?.attempt ?? 0) + 1;
      // A forced restart interrupts a dispatched task before its reply is delivered.
      if (restart) coverage.add("restart_mid_step");
      const answer = restart ? "lost_response" : response(next, allowContainment);
      restart = false;
      const call: Call = { task: input.task_id, iteration, run: input.run_id, answer, terminals: [],
        reportOrdinal: usageReports + 1, elapsed: 0, repairs: [], pass: false, invalid: false };
      calls.push(call);
      coverage.add(answer);
      trace.record([input.task_id, iteration, answer]);
      writeFileSync(artifact, "implementation " + calls.length);
      if (answer === "duplicate_submission") tasks.push(tasks.find(task => task.task_id === input.task_id)!);
      if (answer === "clock_backwards") {
        now--;
        yield { ...envelope(input, 0, now), type: "usage.updated" } as HermesEvent;
      }
      now += tick;
      call.elapsed = expectedRuntime + Math.max(0, now - lastSample);
      usageReports++;
      yield envelope(input, 1, now);
      if (answer === "lost_response" || answer === "restart_mid_step") {
        uncertain.add(call.task);
        throw Error(answer);
      }
      if (answer === "missing") { call.invalid = true; return; }
      const done = envelope(input, 2, now, answer === "failed" ? "failed" : "completed");
      call.terminals.push(done);
      yield done;
      if (oldAnswer || answer === "duplicate_answer" || answer === "late_result") {
        const extra = oldAnswer ?? { ...done, created_at: now - Number(answer === "late_result") };
        if (oldAnswer) coverage.add("delivered-" + delivery);
        call.terminals.push(extra);
        oldAnswer = undefined;
        yield extra;
        call.invalid = true;
      } else call.pass = answer !== "failed";
    },
    async *resumeReport(input, _signal, original) {
      observeAdmission(input.task_id);
      const call = calls.at(-1)!;
      const recoverable = ["ok", "ok", "ok", "missing", "missing"] as const;
      const answer = pick(next, allowContainment ? [...recoverable, "mutation", "unknown"] as const : recoverable);
      call.repairs.push({ task: input.task_id, original, answer });
      coverage.add("repair-" + answer + "-" + call.repairs.length);
      trace.record(["repair", input.task_id, answer]);
      usageReports++;
      yield envelope(input, 1, now);
      if (answer === "unknown") { uncertain.add(input.task_id); throw Error("unknown repair stop"); }
      if (answer === "mutation") writeFileSync(artifact, "mutated");
      if (answer !== "missing") {
        call.pass = answer === "ok";
        call.invalid = !call.pass;
        yield envelope(input, 2, now, "completed");
      }
    },
  };
  // Wrap the producer, so a duplicate really crosses the adapter boundary.
  if (mutant === "R1") {
    const invoke = adapter.invoke.bind(adapter);
    adapter.invoke = async function* (input, signal) { yield* invoke(input, signal); yield* invoke(input, signal); };
  }
  try {
    mkdirSync(workspace);
    writeFileSync(artifact, "");
    vi.stubEnv("OSSTACK_LOOP_CONTAINMENT_ROOT", join(root, "containment"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(isolation, "snapshotReviewerWorkspace").mockImplementation(async () => {
      const hash = createHash("sha256").update(readFileSync(artifact)).digest("hex");
      return { schema_version: 1, head: "head", status_sha256: hash, diff_sha256: hash, staged_diff_sha256: "",
        untracked_sha256: "", ignored_sha256: "", git_config_sha256: "", hooks_sha256: "",
        refs_sha256: "", git_info_sha256: "", worktree_metadata_sha256: "", combined_sha256: hash };
    });
    vi.spyOn(executor, "runShellCommand").mockImplementation(async command => {
      if (!command.startsWith("git ") || !/ (status --short|diff --no-ext-diff|rev-parse --short HEAD)/.test(command))
        throw Error("Unexpected shell command: " + command);
      return { command, exitCode: 0, stdout: command.includes(" status ") ? " M output.ts" : "", stderr: "", durationMs: 0 };
    });
    const verify = verifier.verifyRun;
    vi.spyOn(verifier, "verifyRun").mockImplementation((run, options) => {
      const hooks = options.reportRepair;
      if (hooks && !vi.isMockFunction(hooks.remainingMs)) {
        const remaining = hooks.remainingMs;
        vi.spyOn(hooks, "remainingMs").mockImplementation(() => {
          sampleBudgetClock();
          return remaining();
        });
      }
      return verify(run, options);
    });
    const checkBudget = budgeting.checkBudget;
    vi.spyOn(budgeting, "checkBudget").mockImplementation((budget, usage) => {
      sampleBudgetClock();
      if (mutant === "R7") usage.runtime_ms = now - budgetStart;
      check("R7", usage.runtime_ms >= 0 && usage.runtime_ms >= reportedRuntime && usage.runtime_ms === expectedRuntime,
        `runtime ${usage.runtime_ms}, expected ${expectedRuntime}, previous ${reportedRuntime}`);
      reportedRuntime = usage.runtime_ms;
      trace.record(["runtime", reportedRuntime]);
      return checkBudget(budget, usage);
    });
    // Advance the cycle clock after admission, including for idle cycles.
    let cycleTicks: number[] = [];
    const readState = stateFile.readLoopState;
    vi.spyOn(stateFile, "readLoopState").mockImplementation(async path => {
      const state = await readState(path);
      if (mutant === "reset-on-restart" && state?.budget_status) state.budget_status.usage.cycles = 0;
      if (mutant === "forget-baseline" && state?.budget_status) delete state.budget_status.baseline;
      return state;
    });
    const write = stateFile.writeLoopState;
    vi.spyOn(stateFile, "writeLoopState").mockImplementation(async (path, state, options) => {
      const debit = (state.budget_status?.usage.cycles ?? 0) > (state.key_metrics?.total_cycles ?? 0) + crashDebits - cycleBaseline;
      const prior = state.completed_tasks.find(row => settled.has(row.task_id));
      if (mutant === "R3" && prior && !debit) prior.outcome = prior.outcome === "success" ? "failed" : "success";
      if (mutant === "R4" && state.key_metrics) state.key_metrics.tokens_consumed++;
      const paths = await write(path, state, options);
      if (debit) {
        if (crashAfterDebit) throw crash;
        now += cycleTicks.shift() ?? 0;
      }
      return paths;
    });
    if (mutant === "R6") vi.spyOn(iterator, "evaluateIteration").mockReturnValue({ action: "stop", reason: "accept failed verification" });
    let expectedStreak = 0;
    let previousUsage: budgeting.BudgetUsage | undefined;
    for (const cmd of commands) {
      const before = calls.length;
      const hadPending = tasks.some(task => !settled.has(task.task_id));
      const path = join(workspace, "LOOP-STATE.json");
      const events: LoopEvent[] = [];
      const initialUsage = usageReports;
      next = random(cmd.key);
      allowContainment = cmd.allowContainment ?? true;
      trace.record(cmd);
      coverage.add("cmd-" + cmd.op);
      if (cmd.op === "raise_budget") {
        cycleLimit += 1 + cmd.key % 5;
        if (budgetReports() * 2 >= tokenLimit) tokenLimit = budgetReports() * 2 + 2;
        if (budgetReports() / 8 >= costLimit) costLimit = budgetReports() / 8 + .125;
      } else if (cmd.op === "clock") {
        now += (cmd.key % 2 ? -1 : 1) * (1 + cmd.key % 100);
        vi.setSystemTime(now);
      } else if (cmd.op === "submit") {
        const id = "t" + ++serial;
        tasks.push({ task_id: id, prompt: "Implement " + id, capability: "code.write", priority: 50, source: "manual" });
      } else if (cmd.op === "duplicate_submission") {
        if (tasks.length) tasks.push(pick(next, tasks));
      } else {
        if (cmd.op === "duplicate_answer" || cmd.op === "late_result") {
          const history = calls.flatMap(call => call.terminals).filter(event => event.terminal);
          if (history.length) {
            const prior = pick(next, history);
            delivery = cmd.op;
            oldAnswer = cmd.op === "late_result" ? { ...prior, created_at: Math.min(now, prior.created_at) - 1 } : prior;
          }
        }
        restart = cmd.op === "restart_mid_step";
        tick = cmd.tick ?? 0;
        cycleLimit = cmd.cycleLimit ?? cycleLimit;
        tokenLimit = cmd.tokenLimit ?? tokenLimit;
        costLimit = cmd.costLimit ?? costLimit;
        if (cmd.op === "reset") {
          cycleBaseline = cycles + crashDebits;
          reportBaseline = usageReports;
          previousRuntime = previousBudgetCycles = expectedStreak = 0;
        }
        budgetStopped = previousBudgetCycles >= cycleLimit || budgetReports() * 2 >= tokenLimit || budgetReports() / 8 >= costLimit;
        const budget = { max_task_iterations: 2, max_cycles: cycleLimit,
          max_runtime_ms: 60_000, max_tokens: tokenLimit,
          max_estimated_cost_usd: costLimit };
        const options = { loopId: "persistent", workspacePath: workspace, sources: [], inputTasks: tasks,
          adapters: [adapter], agentId: adapter.id, useWorktree: false, maxIterations: 3, budget, resetBudget: cmd.op === "reset",
          artifactVerification: { requireGitDiff: true, targetPaths: ["output.ts"] }, lessonDrafts: { enabled: false } };
        const run = async (multi: boolean) => {
          budgetStart = lastSample = now;
          expectedRuntime = reportedRuntime = previousRuntime;
          rewound = false;
          cycleTicks = multi ? [...(cmd.cycleTicks ?? [])] : [];
          const offset = calls.length;
          const wasContained = uncertain.size > 0 || calls.some(c => c.repairs.some(r => r.answer === "mutation"));
          const engine = new LoopEngine(options);
          crashAfterDebit = cmd.op === "crash_after_debit";
          const result = await (multi ? engine.runCycles({ cycles: 3 }) : engine.runOnce()).catch(error => {
            if (error !== crash) throw error;
            return undefined;
          });
          if (!result) {
            check("R4", !budgetStopped && !wasContained && calls.length === offset, "unexpected work at crash");
            crashDebits++;
            previousBudgetCycles++;
            return;
          }
          check("R4", !crashAfterDebit || budgetStopped || wasContained, "missing crash debit");
          cycleTicks = [];
          if (boundaryViolation) throw boundaryViolation;
          check("R1", new Set(calls.map(c => c.task + "/" + c.iteration)).size === calls.length, "repeated task/iteration");
          const count = "cycles" in result ? result.cycles.length : 1;
          passes += count;
          const admittedCycles = result.events.filter(e => e.type === "loop.cycle.started").length;
          check("R4", !budgetStopped || !admittedCycles, "cycle admitted after budget stop");
          const interrupted = calls.slice(offset).some(c => uncertain.has(c.task) || c.invalid)
            || budgetReports() * 2 >= budget.max_tokens || budgetReports() / 8 >= budget.max_estimated_cost_usd;
          const expectedCycles = wasContained || budgetStopped ? 0 : !multi || interrupted ? 1 : Math.min(cycleLimit - previousBudgetCycles, 3);
          check("R4", admittedCycles === expectedCycles, "cycle count differs from adapter history");
          cycles += expectedCycles;
          if (expectedCycles && hadPending && offset === before) {
            check("R4", calls.length > offset, "admitted pending work did not resume");
          }
          for (const cycle of "cycles" in result ? result.cycles : [result]) {
            const tasks = cycle.completedTasks;
            if (tasks.length && tasks.every(task => task.report_invalid === undefined)) {
              expectedStreak = tasks.some(task => task.outcome === "success") ? 0 : expectedStreak + 1;
            }
            check("R4", cycle.budget?.usage.no_progress_cycles === expectedStreak, "cycle no-progress streak differs");
          }
          const usage = result.budget!.usage;
          if (now < budgetStart) coverage.add("net-rewind-" + cmd.op);
          check("R4", usage.runtime_ms <= budget.max_runtime_ms && usage.runtime_ms >= previousRuntime,
            "runtime decreased to " + usage.runtime_ms);
          check("R4", usage.cycles === cycles + crashDebits - cycleBaseline && usage.cycles >= previousBudgetCycles && usage.cycles <= cycleLimit, "cycle accounting regressed or exceeded cap");
          check("R4", usage.tokens === budgetReports() * 2 && usage.tokens <= budget.max_tokens
            && usage.estimated_cost_usd === budgetReports() / 8 && usage.estimated_cost_usd <= budget.max_estimated_cost_usd,
            "budget usage differs from adapter or exceeds cap");
          previousBudgetCycles = usage.cycles;
          previousRuntime = usage.runtime_ms;
          budgetStopped ||= result.budget!.exceeded;
          events.push(...result.events);
          if (!hadPending) check("R3", ("cycles" in result ? result.cycles : [result]).every(r => r.executedTaskCount === 0),
            "settled pass reported execution");
          const disk = await readState(path);
          check("R3", JSON.stringify(disk) === JSON.stringify(result.state), "returned state differs from durable state");
        };
        await run(cmd.op === "cycles");
        if (cmd.op === "restart_mid_step") await run(false);
        if (mutant === "R2" && uncertain.size && before === calls.length) {
          const original = calls.find(c => uncertain.has(c.task))!;
          // Simulate a dispatcher which ignores durable containment on restart.
          await adapter.invoke({ task_id: original.task, run_id: "resend", session_id: "persistent",
            capability_id: "code.write", prompt: "resend" }, new AbortController().signal)[Symbol.asyncIterator]().next();
          if (boundaryViolation) throw boundaryViolation;
        }
      }
      check("R7", previousRuntime === expectedRuntime, "returned runtime differs from ledger");
      const state = await readState(path);
      const persisted = state?.budget_status?.usage;
      check("R4", (persisted?.cycles ?? 0) === previousBudgetCycles, "durable cycle debit differs");
      check("R4", (persisted?.no_progress_cycles ?? 0) === expectedStreak, "durable no-progress streak differs");
      if (previousUsage && cmd.op !== "reset") {
        for (const key of ["cycles", "runtime_ms", "tokens", "estimated_cost_usd"] as const) {
          check("R4", persisted && persisted[key] >= previousUsage[key], "persisted " + key + " decreased");
        }
      }
      previousUsage = persisted;
      const rows = state?.completed_tasks ?? [];
      const metrics = state?.key_metrics;

      check("R4", (metrics?.tokens_consumed ?? 0) === usageReports * 2 && (metrics?.cost_consumed ?? 0) === usageReports / 8
        && (metrics?.total_cycles ?? 0) === cycles, "durable accounting differs from ledger");
      const fresh = calls.slice(before);
      if (!hadPending) check("R3", !fresh.length && initialUsage === usageReports, "settled pass performed work");
      check("R1", new Set(rows.map(r => r.task_id)).size === rows.length && rows.length === new Set(calls.map(c => c.task)).size,
        "missing or duplicate completion");
      if (mutant === "R5") {
        const i = events.findIndex(e => e.type === "loop.report_repair.attempt");
        if (i >= 0) events.splice(i, 1);
      }
      const attempts = events.filter(e => e.type === "loop.report_repair.attempt");
      const expected = fresh.flatMap(c => c.repairs.map((r, i) => [c.task, r.original, i + 1]));
      check("R5", JSON.stringify(attempts.map(e => [e.payload?.["task_id"], e.payload?.["original_run_id"], e.payload?.["attempt"]]))
        === JSON.stringify(expected), "missing or misnumbered repair event");
      const results = events.filter(e => e.type === "loop.report_repair.result");
      check("R5", results.length === expected.length && events.filter(e => e.type === "loop.plan.done").length === fresh.length,
        "unexpected repair result or implementation plan");
      let resultIndex = 0;
      for (const c of fresh) {
        const canRepair = (attempt: number) => {
          const reports = c.reportOrdinal + attempt - 1 - reportBaseline;
          return reports * 2 < tokenLimit && reports / 8 < costLimit && c.elapsed < 60_000;
        };
        if (c.answer === "missing" || c.terminals.length === 2) {
          const last = c.repairs.at(-1);
          check("R5", !canRepair(c.repairs.length + 1) || (last && (last.answer !== "missing" || c.repairs.length === 2)), "eligible invalid report left unrepaired");
        } else check("R5", c.repairs.length === 0, "repair for valid or unknown implementation");
        for (const [i, repair] of c.repairs.entries()) {
          const payload = results[resultIndex++]?.payload;
          check("R5", canRepair(i + 1) && repair.task === c.task && payload?.["task_id"] === c.task && payload["attempt"] === i + 1
            && payload["report_valid"] === (repair.answer === "ok"), "repair acceptance differs from workspace or stop evidence");
        }
        const plan = events.filter(e => e.type === "loop.plan.done" && e.payload?.["task_id"] === c.task && e.payload["iteration"] === c.iteration);
        check("R5", plan.length === 1 && c.repairs.every(r => r.original === c.run) && c.repairs.length <= 2,
          "plan count, original session or repair limit");
        check("R5", c.repairs.slice(0, -1).every(r => r.answer === "missing"), "repair after terminal result");
        const decisions = events.filter(e => e.type === "loop.iterate.done" && e.payload?.["task_id"] === c.task && e.payload["iteration"] === c.iteration);
        const expectedAction = c.pass ? "stop" : c.answer === "failed" && !c.invalid ? (c.iteration < 2 ? "continue" : "escalate") : undefined;
        const action = decisions[0]?.payload?.["action"];
        check("R6", action === expectedAction && decisions.length === Number(expectedAction !== undefined), "decision disagrees with delivered verdict");
        if (action !== undefined) {
          const v = events.find(e => e.type === "loop.verify.done" && e.payload?.["task_id"] === c.task && e.payload["iteration"] === c.iteration);
          check("R6", action !== "stop" || (v?.payload?.["pass"] && Number(v.payload["score"]) >= .8), "stop below threshold");
          const history = actions.get(c.task) ?? [];
          history.push(action + " after iteration " + c.iteration);
          actions.set(c.task, history);
        }
      }
      const histories = new Map<string, Call[]>();
      for (const call of calls) {
        const history = histories.get(call.task) ?? [];
        history.push(call);
        histories.set(call.task, history);
      }
      const rowsById = new Map(rows.map(row => [row.task_id, row]));
      const recorded = new Map<string, string[]>();
      for (const decision of state?.decisions ?? []) {
        const match = /^(t\d+): ((?:continue|stop|escalate) after iteration \d+) - /.exec(decision);
        if (!match) continue;
        const sequence = recorded.get(match[1]!) ?? [];
        sequence.push(match[2]!);
        recorded.set(match[1]!, sequence);
      }
      for (const [id, history] of histories) {
        const row = rowsById.get(id);
        check("R1", row, "completion absent for " + id);
        if (!row) continue;
        const decisions = recorded.get(id) ?? [];
        check("R6", JSON.stringify(decisions) === JSON.stringify(actions.get(id) ?? []), "durable decision history changed");
        const signature = JSON.stringify([row.outcome, row.iterations, decisions]);
        check("R3", !settled.has(id) || settled.get(id) === signature, "settled result changed");
        settled.set(id, signature);
        check("R2", !!row.implementation_unconfirmed === uncertain.has(id), "unknown outcome was not retained");
        check("R4", row.iterations >= 1 && row.iterations <= 2, "iterations exceeded clamped limit");
        check("R5", row.iterations === history.length, "repair counted as iteration");
        const last = history.at(-1)!;
        check("R5", row.outcome === (last.pass ? "success" : "escalated"), "completion disagrees with adapter report");
      }
      trace.record([events.map(e => [e.type, e.payload?.["task_id"], e.payload?.["iteration"],
        e.payload?.["action"], e.payload?.["pass"], e.payload?.["score"], e.payload?.["report_valid"]]),
        fresh.map(c => [c.task, c.iteration, c.terminals.length, c.pass]), [...settled], cycles, usageReports]);
      step++;
    }
    return { digest: trace.digest(), passes, coverage, runtime: previousRuntime };
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}
