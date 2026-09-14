import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LoopEngine, type PolicyGate } from "./loop-engine.js";

// R2.2 — kernel policy gate. These exercise the loop-local injection contract:
// entry consult (runOnce), per-tick consult (runCycles), no-gate byte-identity,
// and fail-closed on a throwing gate. No @osstack/core / policy.yaml here — the
// gate is a plain injected function; the CLI's makePolicyGate is tested in cli.

async function makeQueuedWorkspace(): Promise<string> {
  const workspace = mkdtempSync(join(tmpdir(), "osstack-loop-policy-"));
  await mkdir(join(workspace, "tasks"));
  await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
    task_id: "task-1",
    capability: "code.test",
    prompt: "Exercise the policy gate",
    priority: 80,
  }));
  return workspace;
}

const allowGate: PolicyGate = async () => ({ allow: true });
const denyGate: PolicyGate = async () => ({ allow: false, reason: "policy_denied: mode is observe" });

const writeSideEffect =
  "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"";

describe("LoopEngine policy gate (R2.2)", () => {
  it("consults the gate at runOnce entry and refuses before any discovery/execution", async () => {
    const workspace = await makeQueuedWorkspace();
    const gate = vi.fn(denyGate);
    const result = await new LoopEngine({
      loopId: "loop-deny",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: writeSideEffect,
      policyGate: gate,
    }).runOnce();

    // Distinguishable outcome, mirroring a budget stop.
    expect(result.policy).toEqual({ denied: true, reason: "policy_denied: mode is observe" });
    expect(result.completedTasks).toEqual([]);
    expect(result.executedTaskCount).toBe(0);
    expect(result.discoveredTaskCount).toBe(0);
    // Consulted exactly once, with the workspace path.
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith({ workspacePath: workspace });
    // A `policy_denied` loop.stopped event, and NO execution/discovery events.
    const stopped = result.events.find((event) => event.type === "loop.stopped");
    expect(stopped?.payload).toMatchObject({ reason: "policy_denied: mode is observe" });
    expect(result.events.map((event) => event.type)).not.toContain("loop.execute.done");
    expect(result.events.map((event) => event.type)).not.toContain("loop.discover.done");
    // No side effect ran and NO state file was written (refuse before side effects).
    expect(existsSync(join(workspace, "loop-output.txt"))).toBe(false);
    expect(existsSync(join(workspace, "LOOP-STATE.json"))).toBe(false);
  });

  it("allows the run when the gate allows, executing normally", async () => {
    const workspace = await makeQueuedWorkspace();
    const gate = vi.fn(allowGate);
    const result = await new LoopEngine({
      loopId: "loop-allow",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: writeSideEffect,
      policyGate: gate,
    }).runOnce();

    expect(gate).toHaveBeenCalledTimes(1);
    expect(result.policy).toBeUndefined();
    expect(result.state.completed_tasks[0]).toMatchObject({ task_id: "task-1", outcome: "success" });
    expect(existsSync(join(workspace, "loop-output.txt"))).toBe(true);
  });

  it("no gate injected => byte-identical to a gate-free run", async () => {
    // With `exactOptionalPropertyTypes`, real callers omit `policyGate` rather
    // than passing `undefined` (the daemon deletes the key; see
    // withoutRuntimeAdapters). Omission is the parity case: two gate-free runs
    // produce the same event sequence and outcomes, and never a `policy` marker.
    const wsA = await makeQueuedWorkspace();
    const wsB = await makeQueuedWorkspace();
    const base = {
      loopId: "loop-parity",
      sources: ["task_queue"],
      executeCommand: writeSideEffect,
    };
    const a = await new LoopEngine({ ...base, workspacePath: wsA }).runOnce();
    const b = await new LoopEngine({ ...base, workspacePath: wsB }).runOnce();

    expect(a.policy).toBeUndefined();
    expect(b.policy).toBeUndefined();
    // Same event sequence and same completed-task outcome (run_id/timestamps are
    // intrinsically non-deterministic, so compare the stable shape, not raw ids).
    expect(a.events.map((event) => event.type)).toEqual(b.events.map((event) => event.type));
    expect(a.state.completed_tasks.map((task) => ({ task_id: task.task_id, outcome: task.outcome, agent_id: task.agent_id }))).toEqual(
      b.state.completed_tasks.map((task) => ({ task_id: task.task_id, outcome: task.outcome, agent_id: task.agent_id })),
    );
    // Both wrote a LOOP-STATE.json (gate absence did not change persistence).
    expect(existsSync(join(wsA, "LOOP-STATE.json"))).toBe(true);
    expect(existsSync(join(wsB, "LOOP-STATE.json"))).toBe(true);
  });

  it("a throwing gate fails closed: counts as deny with the error message", async () => {
    const workspace = await makeQueuedWorkspace();
    const gate: PolicyGate = async () => {
      throw new Error("policy loader exploded");
    };
    const result = await new LoopEngine({
      loopId: "loop-throw",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: writeSideEffect,
      policyGate: gate,
    }).runOnce();

    expect(result.policy).toMatchObject({ denied: true, reason: "policy loader exploded" });
    expect(result.executedTaskCount).toBe(0);
    expect(existsSync(join(workspace, "loop-output.txt"))).toBe(false);
  });

  it("consults per scheduled cycle tick: a mid-flight flip stops runCycles cleanly", async () => {
    const workspace = await makeQueuedWorkspace();
    // A mutable fake gate: allow the entry consult (cycle 1), deny from the
    // second consult onward (the cycle-2 tick), emulating a human flipping the
    // policy file to `mode: observe` mid-flight.
    let consults = 0;
    const gate: PolicyGate = async () => {
      consults += 1;
      return consults >= 2
        ? { allow: false, reason: "policy_denied: flipped to observe" }
        : { allow: true };
    };
    const result = await new LoopEngine({
      loopId: "loop-flip",
      workspacePath: workspace,
      sources: ["task_queue"],
      skipCompletedTasks: false, // keep discovering the same task each cycle
      executeCommand: writeSideEffect,
      policyGate: gate,
    }).runCycles({ cycles: 3, intervalMs: 0 });

    // Cycle 1 ran (entry consult allowed); cycle 2's tick consult denied -> stop.
    expect(result.cycles.length).toBe(1);
    expect(consults).toBe(2);
    expect(result.policy).toMatchObject({ denied: true, reason: "policy_denied: flipped to observe" });
    const stopped = result.events.find((event) => event.type === "loop.stopped");
    expect(stopped?.payload).toMatchObject({ reason: "policy_denied: flipped to observe" });
  });

  it("runCycles entry deny refuses with no cycles run", async () => {
    const workspace = await makeQueuedWorkspace();
    const result = await new LoopEngine({
      loopId: "loop-cycles-deny",
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: writeSideEffect,
      policyGate: denyGate,
    }).runCycles({ cycles: 3, intervalMs: 0 });

    expect(result.cycles).toEqual([]);
    expect(result.policy).toMatchObject({ denied: true, reason: "policy_denied: mode is observe" });
    expect(existsSync(join(workspace, "loop-output.txt"))).toBe(false);
  });
});

it('holds an injected lifecycle lease until final state persistence', async () => {
  const workspace = await makeQueuedWorkspace();
  let acquired = false; let released = false;
  const result = await new LoopEngine({ workspacePath: workspace, sources: ['task_queue'], executeCommand: writeSideEffect,
    lifecycleLease: async () => {
      acquired = true;
      return { release: async () => { expect(existsSync(join(workspace, 'LOOP-STATE.json'))).toBe(true); released = true; }, retain: () => {} };
    },
  }).runOnce();
  expect(result.executedTaskCount).toBe(1); expect(acquired).toBe(true); expect(released).toBe(true);
});

it('retains the host lease when persisted implementation stop is unconfirmed', async () => {
  const workspace = await makeQueuedWorkspace();
  const first = await new LoopEngine({ workspacePath: workspace, sources: ['task_queue'], executeCommand: writeSideEffect }).runOnce();
  first.state.completed_tasks[0]!.implementation_unconfirmed = true;
  await writeFile(first.jsonPath, JSON.stringify(first.state));
  let retained = false; let released = false;
  await new LoopEngine({ workspacePath: workspace, sources: ['task_queue'],
    lifecycleLease: async () => ({ retain: () => { retained = true; }, release: async () => { released = true; } }),
  }).runOnce();
  expect(retained).toBe(true); expect(released).toBe(false);
});

it("releases an admission on invalid cycle options before any execution", async () => {
  const workspace = await makeQueuedWorkspace();
  const release = vi.fn(async () => {}); const retain = vi.fn();
  const engine = new LoopEngine({ workspacePath: workspace, sources: [], lifecycleLease: async () => ({ release, retain }) });
  await expect(engine.runCycles({ intervalMs: -1 })).rejects.toThrow("intervalMs");
  expect(release).toHaveBeenCalledTimes(1); expect(retain).not.toHaveBeenCalled();
  expect(existsSync(join(workspace, "LOOP-STATE.json"))).toBe(false);
});

it("does not carry confirmed effects into a later invalid invocation", async () => {
  const workspace = await makeQueuedWorkspace();
  const release = vi.fn(async () => {}); const retain = vi.fn();
  const engine = new LoopEngine({ workspacePath: workspace, sources: ["task_queue"], executeCommand: writeSideEffect,
    lifecycleLease: async () => ({ release, retain }) });
  await engine.runOnce();
  await expect(engine.runCycles({ intervalMs: -1 })).rejects.toThrow("intervalMs");
  expect(release).toHaveBeenCalledTimes(2); expect(retain).not.toHaveBeenCalled();
});
