import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePlan, runShellCommand } from "./executor.js";
import { planTask } from "./planner.js";
import type { Task } from "./types.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-executor-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("executePlan", () => {
  it("fails unknown non-local agents instead of treating them as no-op", async () => {
    const run = await executePlan(plan("missing-agent"), { workspacePath: workspace });

    expect(run.outcome).toBe("failed");
    expect(run.command_results[0]?.exitCode).toBe(127);
    expect(run.summary).toContain("agent adapter not registered");
  });

  it("runs a registered adapter with repo_path in task context", async () => {
    let captured: AgentTask | undefined;
    const adapter = mockAdapter({
      async *invoke(task) {
        captured = task;
        yield doneEvent(task.run_id, task.session_id, "completed", "done");
      },
    });

    const run = await executePlan(plan("mock-agent"), {
      workspacePath: workspace,
      adapters: [adapter],
      sessionId: "session-1",
    });

    expect(run.outcome).toBe("completed");
    expect(run.adapter_event_count).toBe(1);
    expect(run.summary).toBe("done");
    expect(captured?.capability_id).toBe("mock.code.write");
    expect(captured?.context?.["repo_path"]).toBe(workspace);
  });

  it("maps unavailable, terminal error, expired, and thrown adapter runs to failure", async () => {
    const unavailable = await executePlan(plan("unavailable"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "unavailable",
        available: false,
        reason: "missing token",
      })],
    });
    expect(unavailable).toMatchObject({
      outcome: "failed",
      summary: "missing token",
      adapter_event_count: 0,
    });

    const terminalError = await executePlan(plan("terminal-error"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "terminal-error",
        async *invoke(task) {
          yield errorEvent(task.run_id, task.session_id, "adapter exploded");
        },
      })],
    });
    expect(terminalError).toMatchObject({ outcome: "failed", summary: "adapter exploded" });

    const expired = await executePlan(plan("expired"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "expired",
        async *invoke(task) {
          yield doneEvent(task.run_id, task.session_id, "expired", "ran too long");
        },
      })],
    });
    expect(expired).toMatchObject({ outcome: "failed", summary: "ran too long" });

    const thrown = await executePlan(plan("throws"), {
      workspacePath: workspace,
      adapters: [mockAdapter({
        id: "throws",
        // biome-ignore lint/correctness/useYield: mock adapter that throws before yielding
        async *invoke() {
          throw new Error("stream failed");
        },
      })],
    });
    expect(thrown).toMatchObject({ outcome: "failed", summary: expect.stringContaining("stream failed"),
      cancellation: { source: "executor_error", stop_confirmed: false } });
  });
});

describe("adapter cancellation", () => {
  beforeEach(async () => {
    await import("@osstack/hermes-adapter");
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not probe or invoke a preaborted adapter", async () => {
    const controller = new AbortController();
    controller.abort("parent stopped");
    const adapter = mockAdapter();
    const probe = vi.spyOn(adapter, "isAvailable");
    const invoke = vi.spyOn(adapter, "invoke");
    const run = await executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal,
    });
    expect(run).toMatchObject({ outcome: "cancelled", adapter_event_count: 0,
      cancellation: { source: "external", stop_confirmed: true, invocation_started: false, evidence: "not_started" } });
    expect(probe).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["external", "timeout"] as const)("bounds a hanging availability probe on %s", async (source) => {
    const controller = new AbortController();
    const probe = deferred<Awaited<ReturnType<AgentAdapter["isAvailable"]>>>();
    const adapter = mockAdapter();
    adapter.isAvailable = () => probe.promise;
    const invoke = vi.spyOn(adapter, "invoke");
    const pending = executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal,
      timeoutMs: 10, cancellationGraceMs: 20,
    });
    if (source === "external") controller.abort();
    await vi.advanceTimersByTimeAsync(30);
    expect(await settledResult(pending)).toMatchObject({ outcome: "failed", failure_code: "cancellation_unconfirmed",
      cancellation: { source, stop_confirmed: false, invocation_started: false } });
    probe.resolve({ available: true, last_checked_at: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invoke when availability aborts just before returning", async () => {
    const controller = new AbortController();
    const adapter = mockAdapter();
    adapter.isAvailable = async () => {
      controller.abort();
      return { available: true, last_checked_at: 0 };
    };
    const invoke = vi.spyOn(adapter, "invoke");
    const run = await executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
    });
    expect(run.outcome).not.toBe("completed");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["external", "timeout"] as const)("passes %s abort to invoke and bounds hanging next/return", async (source) => {
    const controller = new AbortController();
    const started = deferred<AbortSignal>();
    const next = deferred<IteratorResult<HermesEvent>>();
    const close = vi.fn(() => new Promise<IteratorResult<HermesEvent>>(() => {}));
    const adapter = mockAdapter({ invoke(_task, signal) {
      started.resolve(signal);
      return { [Symbol.asyncIterator]: () => ({ next: () => next.promise, return: close }) };
    } });
    const pending = executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal,
      timeoutMs: 10, cancellationGraceMs: 20,
    });
    const actualSignal = await started.promise;
    const reason = new Error("graph cancelled");
    if (source === "external") controller.abort(reason);
    await vi.advanceTimersByTimeAsync(30);
    expect(actualSignal.aborted).toBe(true);
    if (source === "external") expect(actualSignal.reason).toBe(reason);
    const run = await settledResult(pending);
    expect(run).toMatchObject({ outcome: "failed", failure_code: "cancellation_unconfirmed",
      cancellation: { source, stop_confirmed: false, invocation_started: true } });
    expect(close).toHaveBeenCalledOnce();
    const snapshot = JSON.stringify(run);
    next.resolve({ done: false, value: streamEvent("done", { status: "completed", last_seq: 1 }, true) });
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.stringify(run)).toBe(snapshot);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["close", "throw", "completed", "cancelled", "failed"])(
    "does not infer stopped side effects from abort followed by %s", async (ending) => {
      const controller = new AbortController();
      const effects: string[] = [];
      const ownedWork = setInterval(() => effects.push("write"), 5);
      const adapter = mockAdapter({ async *invoke(task, signal) {
        controller.abort();
        expect(signal.aborted).toBe(true);
        if (ending === "throw") throw new Error("stream rejected");
        if (ending !== "close") yield doneEvent(task.run_id, task.session_id,
          ending as "completed" | "cancelled" | "failed", "late result");
      } });
      const run = await executePlan(plan(adapter.id), {
        workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
      });
      expect(run).toMatchObject({ outcome: "failed", failure_code: ending === "close" ? "missing_done" : "cancellation_unconfirmed",
        cancellation: { stop_confirmed: false, invocation_started: true } });
      await vi.advanceTimersByTimeAsync(10);
      expect(effects).toEqual(["write", "write"]);
      clearInterval(ownedWork);
    },
  );

  it("records explicit stop evidence separately from the cancellation request", async () => {
    const controller = new AbortController();
    let ownedWorkStopped = false;
    const adapter = mockAdapter({ async *invoke(task) {
      controller.abort();
      ownedWorkStopped = true;
      yield doneEvent(task.run_id, task.session_id, "cancelled", "stopped");
    } });
    adapter.confirmStopped = vi.fn(async () => {
      await Promise.resolve();
      return ownedWorkStopped ? { stopped: true as const, evidence: "owned-work:exit-observed" } : { stopped: false as const };
    });
    const run = await executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
    });
    expect(run).toMatchObject({ outcome: "cancelled", cancellation: {
      source: "external", stop_confirmed: true, evidence: "owned-work:exit-observed",
      requested_at: expect.any(String), confirmed_at: expect.any(String), invocation_started: true,
    } });
    expect(adapter.confirmStopped).toHaveBeenCalledWith(run.run_id);
    expect(run).not.toHaveProperty("failure_code");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["hang", "throw", "false", "no evidence"])("keeps stop confirmation %s uncertain", async (mode) => {
    const controller = new AbortController();
    const started = deferred<void>();
    const adapter = mockAdapter({ async *invoke(task) {
      controller.abort();
      started.resolve();
      yield doneEvent(task.run_id, task.session_id, "cancelled", "requested");
    } });
    adapter.confirmStopped = async () => {
      if (mode === "hang") return await new Promise<never>(() => {});
      if (mode === "throw") throw new Error("cannot inspect worker");
      return mode === "false" ? { stopped: false } : { stopped: true, evidence: "" };
    };
    const pending = executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(20);
    expect(await settledResult(pending)).toMatchObject({ outcome: "failed", failure_code: "cancellation_unconfirmed",
      cancellation: { stop_confirmed: false } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts independent stop evidence even if the iterator never closes", async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const adapter = mockAdapter({ invoke() {
      started.resolve();
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<HermesEvent>>(() => {}) }) };
    } });
    adapter.confirmStopped = async () => ({ stopped: true, evidence: "all-owned-work:exit-observed" });
    const pending = executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
    });
    await started.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(20);
    expect(await settledResult(pending)).toMatchObject({ outcome: "cancelled", cancellation: {
      stop_confirmed: true, evidence: "all-owned-work:exit-observed",
    } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revise returned uncertainty when stop proof arrives after grace", async () => {
    const controller = new AbortController();
    const proof = deferred<{ stopped: true; evidence: string }>();
    const started = deferred<void>();
    const adapter = mockAdapter({ async *invoke(task) {
      controller.abort();
      started.resolve();
      yield doneEvent(task.run_id, task.session_id, "completed", "late success");
    } });
    adapter.confirmStopped = () => proof.promise;
    const pending = executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(20);
    const run = await settledResult(pending);
    expect(run).toMatchObject({ outcome: "failed", failure_code: "cancellation_unconfirmed",
      cancellation: { stop_confirmed: false } });
    const snapshot = JSON.stringify(run);
    proof.resolve({ stopped: true, evidence: "too-late:exit-observed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(run)).toBe(snapshot);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["invalid", "post-terminal", "throw"])("stops owned work after abnormal %s stream exit", async (mode) => {
    let signalSeen: AbortSignal | undefined;
    let active = true;
    const close = vi.fn(() => new Promise<IteratorResult<HermesEvent>>(() => {}));
    const adapter = mockAdapter({ invoke(_task, signal) {
      signalSeen = signal;
      signal.addEventListener("abort", () => { active = false; }, { once: true });
      let step = 0;
      return { [Symbol.asyncIterator]: () => ({ return: close, next: async () => {
        if (mode === "throw") throw new Error("iterator exploded");
        return { done: false, value: mode === "invalid" ? streamEvent("done", {}, true)
          : step++ === 0 ? streamEvent("done", { status: "completed", last_seq: 1 }, true)
            : streamEvent("progress", {}) };
      } }) };
    } });
    const run = await executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], cancellationGraceMs: 20,
    });
    expect(signalSeen?.aborted).toBe(true);
    expect(active).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(run).toMatchObject({ outcome: "failed", cancellation: {
      source: "executor_error", stop_confirmed: false, invocation_started: true,
    } });
    expect(run.failure_code).toBe(mode === "invalid" ? "invalid_done_payload"
      : mode === "post-terminal" ? "event_after_terminal" : "cancellation_unconfirmed");
    expect(run.summary).toContain(mode === "throw" ? "iterator exploded" : "Adapter emitted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a protocol violation failed even with confirmed stop", async () => {
    const adapter = mockAdapter({ async *invoke() { yield streamEvent("done", {}, true); } });
    adapter.confirmStopped = async () => ({ stopped: true, evidence: "owned-work:stopped" });
    const run = await executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], cancellationGraceMs: 20,
    });
    expect(run).toMatchObject({ outcome: "failed", failure_code: "invalid_done_payload",
      cancellation: { source: "executor_error", stop_confirmed: true } });
  });

  it("does not reopen an expired grace after the wall clock rolls backward", async () => {
    const started = deferred<void>();
    const proof = deferred<{ stopped: true; evidence: string }>();
    const controller = new AbortController();
    const adapter = mockAdapter({ invoke() {
      started.resolve();
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<HermesEvent>>(() => {}) }) };
    } });
    adapter.confirmStopped = () => proof.promise;
    const pending = executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
    });
    await started.promise;
    controller.abort();
    // Model NTP rollback without moving the monotonic timer queue.
    vi.spyOn(Date, "now").mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(20);
    const result = await settledResult(pending);
    expect(result).toMatchObject({ outcome: "failed", cancellation: { stop_confirmed: false } });
    const snapshot = JSON.stringify(result);
    proof.resolve({ stopped: true, evidence: "late proof after expired timer" });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([NaN, Infinity, -1, 2 ** 31])("uses safe defaults for invalid adapter timer durations: %s", async (duration) => {
    const controller = new AbortController();
    const started = deferred<void>();
    let signalSeen: AbortSignal | undefined;
    const adapter = mockAdapter({ invoke(_task, signal) {
      signalSeen = signal;
      started.resolve();
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<HermesEvent>>(() => {}) }) };
    } });
    adapter.confirmStopped = () => new Promise(() => {});
    const pending = executePlan(plan(adapter.id), {
      workspacePath: workspace, adapters: [adapter], signal: controller.signal,
      timeoutMs: duration, cancellationGraceMs: duration,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(signalSeen?.aborted).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(999);
    expect(await settledResult(pending)).toBe("still pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await settledResult(pending)).toMatchObject({ outcome: "failed", cancellation: { stop_confirmed: false } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks done success when the final next and stop confirmation both hang with real timers", async () => {
    vi.useRealTimers();
    const adapter = mockAdapter({ invoke() {
      let step = 0;
      return { [Symbol.asyncIterator]: () => ({ next: () => step++ === 0
        ? Promise.resolve({ done: false, value: streamEvent("done", { status: "completed", last_seq: 1 }, true) })
        : new Promise<IteratorResult<HermesEvent>>(() => {}) }) };
    } });
    adapter.confirmStopped = () => new Promise(() => {});
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        executePlan(plan(adapter.id), { workspacePath: workspace, adapters: [adapter], timeoutMs: 20, cancellationGraceMs: 30 }),
        new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("watchdog expired"), 1_000); }),
      ]);
      expect(result).toMatchObject({ outcome: "failed", failure_code: "cancellation_unconfirmed",
        cancellation: { source: "timeout", stop_confirmed: false } });
    } finally { clearTimeout(watchdog); }
  });

  it.each(["completed", "unavailable", "throw", "protocol", "cancel"])(
    "cleans external listeners and timers after %s", async (ending) => {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      let signalSeen: AbortSignal | undefined;
      const adapter = mockAdapter({ available: ending !== "unavailable", async *invoke(task, signal) {
        signalSeen = signal;
        if (ending === "throw") throw new Error("failed");
        if (ending === "protocol") return;
        if (ending === "cancel") controller.abort();
        yield doneEvent(task.run_id, task.session_id, "completed", "ok");
      } });
      await executePlan(plan(adapter.id), {
        workspacePath: workspace, adapters: [adapter], signal: controller.signal, cancellationGraceMs: 20,
      });
      expect(add).toHaveBeenCalled();
      for (const [type, listener] of add.mock.calls) {
        expect(remove.mock.calls.some(([removedType, removedListener]) => removedType === type && removedListener === listener)).toBe(true);
      }
      expect(vi.getTimerCount()).toBe(0);
      if (ending !== "cancel") {
        const alreadyAborted = signalSeen?.aborted ?? false;
        controller.abort();
        expect(signalSeen?.aborted ?? false).toBe(alreadyAborted);
      }
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// A hung executor fails an assertion immediately after the test advances its
// grace clock, rather than waiting for Vitest's own multi-second timeout.
async function settledResult<T>(pending: Promise<T>): Promise<T | "still pending"> {
  return Promise.race([pending, Promise.resolve("still pending" as const)]);
}

describe("adapter terminal protocol", () => {
  const done = (status = "completed", extra: Record<string, unknown> = {}) =>
    streamEvent("done", { status, last_seq: 1, ...extra }, true);
  const error = streamEvent("error", { code: "test_error", message: "adapter failed", terminal: true }, true);
  const progress = streamEvent("progress", { phase: "working" });
  const usage = (type: string, tokens: number) => streamEvent(type, {
    tokens_in: tokens, tokens_out: tokens * 2, cost_usd: tokens / 100, duration_ms: 1,
  });

  it.each([null, undefined, [], {}, { type: 42 }, streamEvent("error", null, true),
    streamEvent("error", { message: 42 }, true), streamEvent("usage.final", null)].map((event) => [event]))(
    "classifies malformed event %j and records stop uncertainty", async (event) => {
      expect(await runEvents([event as HermesEvent])).toMatchObject({ outcome: "failed",
        failure_code: "invalid_event", cancellation: { source: "executor_error", stop_confirmed: false } });
    },
  );

  it.each([
    ["empty stream", []],
    ["work without done", [progress]],
    ["usage without done", [usage("usage.final", 10)]],
    ["nonterminal error without done", [{ ...error, terminal: false, payload: {
      code: "retryable", message: "retrying", terminal: false,
    } }]],
  ])("rejects %s as missing_done", async (_name, events) => {
    expect(await runEvents(events as HermesEvent[])).toMatchObject({
      outcome: "failed", failure_code: "missing_done",
      summary: expect.stringContaining("done"),
    });
  });

  it.each([
    null, undefined, [], "completed", {}, { status: "completed" },
    { status: "unknown", last_seq: 1 },
    { status: "completed", last_seq: -1 },
    { status: "completed", last_seq: 1.5 },
    { status: "completed", last_seq: "1" },
    { status: "completed", last_seq: 1, result_summary: 42 },
    { status: "completed", last_seq: 1, usage: null },
    { status: "completed", last_seq: 1, usage: { tokens_in: "10" } },
    { status: "completed", last_seq: 1, usage: { tokens_in: -1, tokens_out: 0, duration_ms: 1 } },
    { status: "completed", last_seq: 1, review: {} },
  ].map((payload) => [payload]))("rejects malformed done payload %j", async (payload) => {
    expect(await runEvents([streamEvent("done", payload, true)])).toMatchObject({
      outcome: "failed", failure_code: "invalid_done_payload",
    });
  });

  it.each([
    ["terminal error then success", [error, done()], "conflicting_terminal"],
    ["duplicate done", [done(), done()], "duplicate_done"],
    ["failure then success", [done("failed"), done()], "duplicate_done"],
    ["success then failure", [done(), done("failed")], "duplicate_done"],
    ["done then terminal error", [done(), error], "event_after_terminal"],
    ["done then progress then success", [done(), progress, done()], "event_after_terminal"],
    ["terminal error then work", [error, progress, done("failed")], "event_after_terminal"],
  ])("rejects %s", async (_name, events, failureCode) => {
    expect(await runEvents(events as HermesEvent[])).toMatchObject({ outcome: "failed", failure_code: failureCode });
  });

  it.each(["token.delta", "tool.started", "tool.updated", "tool.done", "run.started", "status", "approval.requested"])(
    "rejects %s after done", async (type) => {
      expect(await runEvents([done(), streamEvent(type, {})])).toMatchObject({
        outcome: "failed", failure_code: "event_after_terminal",
      });
    },
  );

  it.each(["completed", "failed", "expired", "cancelled"])("preserves a valid %s result", async (status) => {
    const run = await runEvents([progress, done(status, { result_summary: "result" })]);
    expect(run).toMatchObject({ outcome: status === "expired" ? "failed" : status, summary: "result" });
    expect(run).not.toHaveProperty("failure_code");
  });

  it("allows recovery from nonterminal errors before done", async () => {
    expect(await runEvents([{ ...error, terminal: false, payload: {
      code: "retryable", message: "retrying", terminal: false,
    } }, progress, done()])).toMatchObject({ outcome: "completed" });
  });

  it.each([false, true])("preserves terminal error with failed done: %s and surrounding usage", async (withDone) => {
    const run = await runEvents([
      usage("usage.updated", 1), error, usage("usage.final", 2),
      ...(withDone ? [done("failed")] : []), usage("usage.final", 3),
    ]);
    expect(run).toMatchObject({ outcome: "failed", summary: "adapter failed", tokens_in: 3, tokens_out: 6, cost_usd: 0.03 });
    expect(run).not.toHaveProperty("failure_code");
  });

  it("keeps the failed done summary after a terminal error", async () => {
    expect(await runEvents([error, done("failed", { result_summary: "failure summary" })]))
      .toMatchObject({ outcome: "failed", summary: "failure summary" });
  });

  it("uses the latest usage totals across updates, done payload, and final summaries", async () => {
    const events = [usage("usage.updated", 1), usage("usage.updated", 2), done("completed", {
      usage: { tokens_in: 3, tokens_out: 6, cost_usd: 0.03, duration_ms: 1 },
    })];
    expect(await runEvents(events)).toMatchObject({ outcome: "completed", tokens_in: 3, tokens_out: 6, cost_usd: 0.03 });
    expect(await runEvents([...events, usage("usage.final", 4)])).toMatchObject({
      outcome: "completed", tokens_in: 4, tokens_out: 8, cost_usd: 0.04, adapter_event_count: 4,
    });
  });
});

// Deliberately bypass static types to exercise malformed adapter output at runtime.
function streamEvent(type: string, payload: unknown, terminal = false): HermesEvent {
  return { event_id: "event-1", seq: 1, run_id: "run-1", session_id: "session-1",
    created_at: 0, terminal, type, payload } as HermesEvent;
}

async function runEvents(events: HermesEvent[]) {
  return executePlan(plan("mock-agent"), {
    workspacePath: workspace,
    adapters: [mockAdapter({ async *invoke() { yield* events; } })],
  });
}

describe("runShellCommand", () => {
  it("captures failures, truncates output, and reports timeouts", async () => {
    const failed = await runShellCommand("node -e \"console.error('bad'); process.exit(7)\"", {
      cwd: workspace,
      timeoutMs: 1_000,
      outputLimit: 100,
    });
    expect(failed.exitCode).toBe(7);
    expect(failed.stderr).toContain("bad");

    const truncated = await runShellCommand("node -e \"process.stdout.write('1234567890abcdef')\"", {
      cwd: workspace,
      timeoutMs: 1_000,
      outputLimit: 6,
    });
    expect(truncated.stdout).toBe("abcdef");

    const timedOut = await runShellCommand("node -e \"setTimeout(() => {}, 1000)\"", {
      cwd: workspace,
      timeoutMs: 20,
      outputLimit: 100,
    });
    expect(timedOut.exitCode).toBe(124);
    expect(timedOut.stderr).toContain("Command timed out after 20ms");
  });
});

describe("command process groups", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([NaN, Infinity, -1, 2 ** 31])("uses a safe shell timeout default for %s", async (timeoutMs) => {
    await withProcessFixture(`setTimeout(() => { console.log('finished'); }, 60);`, async (fixture) => {
      const result = await runShellCommand(fixture.command, { cwd: workspace, timeoutMs, outputLimit: 100 });
      expect(result).toMatchObject({ exitCode: 0, stdout: "finished\n", termination: { stop_confirmed: true } });
      fixture.assertStopped();
    });
  });

  it.each(["external", "timeout"] as const)("confirms %s termination of children and grandchildren", async (source) => {
    await withProcessFixture(`
      const { spawn } = require('node:child_process');
      const grandchild = "const fs = require('node:fs'); fs.writeFileSync('grandchild.pid', String(process.pid)); setInterval(() => {}, 1000);";
      const child = "const fs = require('node:fs'); fs.writeFileSync('child.pid', String(process.pid)); require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(grandchild) + "], {stdio: 'inherit'}); setInterval(() => {}, 1000);";
      spawn(process.execPath, ['-e', child], {stdio: 'inherit'});
      setInterval(() => {}, 1000);
    `, async (fixture) => {
      const controller = new AbortController();
      const pending = executePlan(plan("local-command"), {
        workspacePath: workspace, command: fixture.command, signal: controller.signal,
        timeoutMs: source === "timeout" ? 500 : 5_000, terminationGraceMs: 40, killGraceMs: 500,
      });
      await fixture.waitFor("grandchild.pid");
      if (source === "external") controller.abort();
      const run = await pending;
      expect(run).toMatchObject({ outcome: source === "external" ? "cancelled" : "failed",
        cancellation: { source, invocation_started: true, stop_confirmed: true } });
      expect(run.command_results[0]).toMatchObject({ exitCode: source === "external" ? 130 : 124,
        termination: { stop_confirmed: true, scope: "posix_process_group" } });
      fixture.assertStopped();
    });
  });

  it("escalates an ignored TERM to KILL within the configured bounds", async () => {
    await withProcessFixture(`
      process.on('SIGTERM', () => fs.writeFileSync('term', 'received'));
      fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);
    `, async (fixture) => {
      const controller = new AbortController();
      const pending = runShellCommand(fixture.command, {
        cwd: workspace, timeoutMs: 5_000, outputLimit: 100,
        signal: controller.signal, terminationGraceMs: 60, killGraceMs: 500,
      });
      await fixture.waitFor("ready");
      const started = Date.now();
      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ exitCode: 130, termination: {
        stop_confirmed: true, signals: ["SIGTERM", "SIGKILL"],
      } });
      expect(existsSync(join(workspace, "term"))).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      fixture.assertStopped();
    });
  });

  it.each(["inherit", "ignore"])("cleans surviving descendants after successful leader exit with %s stdio", async (stdio) => {
    await withProcessFixture(`
      const code = "const fs = require('node:fs'); fs.writeFileSync('child.pid', String(process.pid)); process.on('SIGTERM', () => {}); fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);";
      require('node:child_process').spawn(process.execPath, ['-e', code], {stdio: '${stdio}'}).unref();
      const wait = setInterval(() => { if (fs.existsSync('ready')) { clearInterval(wait); process.exit(0); } }, 5);
    `, async (fixture) => {
      const run = await executePlan(plan("local-command"), {
        workspacePath: workspace, command: fixture.command, timeoutMs: 5_000,
        terminationGraceMs: 40, killGraceMs: 500,
      });
      expect(run).toMatchObject({ outcome: "failed", failure_code: "surviving_descendants" });
      expect(run.command_results[0]?.termination?.leader_exit_code).toBe(0);
      expect(run.command_results[0]).toMatchObject({ termination: {
        trigger: "leader_exit", stop_confirmed: true, signals: ["SIGTERM", "SIGKILL"],
      } });
      fixture.assertStopped();
    });
  });

  it("does not treat closed stdio as process exit", async () => {
    await withProcessFixture(`
      fs.closeSync(1); fs.closeSync(2);
      process.on('SIGTERM', () => {});
      fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);
    `, async (fixture) => {
      const controller = new AbortController();
      const pending = runShellCommand(fixture.command, {
        cwd: workspace, timeoutMs: 5_000, outputLimit: 100, signal: controller.signal,
        terminationGraceMs: 40, killGraceMs: 500,
      });
      await fixture.waitFor("ready");
      expect(await settledResult(pending)).toBe("still pending");
      controller.abort();
      expect(await pending).toMatchObject({ exitCode: 130, termination: { stop_confirmed: true } });
      fixture.assertStopped();
    });
  });

  it("waits for late graceful exit without letting exit zero erase cancellation", async () => {
    await withProcessFixture(`
      process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync('graceful', 'yes'); process.exit(0); }, 70));
      fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);
    `, async (fixture) => {
      const controller = new AbortController();
      const pending = executePlan(plan("local-command"), {
        workspacePath: workspace, command: fixture.command, timeoutMs: 5_000,
        signal: controller.signal, terminationGraceMs: 300, killGraceMs: 500,
      });
      await fixture.waitFor("ready");
      controller.abort();
      expect(await pending).toMatchObject({ outcome: "cancelled", cancellation: { stop_confirmed: true },
        command_results: [{ exitCode: 130, termination: { signals: ["SIGTERM"] } }] });
      expect(existsSync(join(workspace, "graceful"))).toBe(true);
      fixture.assertStopped();
    });
  });

  it.each(["EPERM", "ESRCH"])("fails closed when group inspection returns %s without leader exit", async (code) => {
    await withProcessFixture(`fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);`, async (fixture) => {
      const controller = new AbortController();
      const pending = executePlan(plan("local-command"), {
        workspacePath: workspace, command: fixture.command, timeoutMs: 5_000,
        signal: controller.signal, terminationGraceMs: 20, killGraceMs: 40,
      });
      await fixture.waitFor("ready");
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0) {
          if (signal === 0) throw Object.assign(new Error(`inspection: ${code}`), { code });
          return true; // Fault injection: delivery cannot be established.
        }
        return kill(pid, signal);
      });
      controller.abort();
      const run = await pending;
      expect(run).toMatchObject({ outcome: "failed", failure_code: "process_exit_unconfirmed",
        cancellation: { stop_confirmed: false },
        command_results: [{ termination: { stop_confirmed: false, pgid: expect.any(Number) } }] });
      expect(run.summary).toContain("unconfirmed");
      const snapshot = JSON.stringify(run);
      vi.restoreAllMocks();
      fixture.cleanup();
      await waitUntil(() => !pidExists(fixture.leaderPid()));
      expect(JSON.stringify(run)).toBe(snapshot);
    });
  });

  it("refuses unsupported process-group platforms before starting work", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const run = await executePlan(plan("local-command"), {
        workspacePath: workspace, command: "echo started > should-not-exist",
      });
      expect(run).toMatchObject({ outcome: "failed", failure_code: "process_control_unsupported" });
      expect(existsSync(join(workspace, "should-not-exist"))).toBe(false);
    } finally { platform.mockRestore(); }
  });

  it("does not start a preaborted shell command", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runShellCommand("echo started > should-not-exist", {
      cwd: workspace, timeoutMs: 1_000, outputLimit: 100, signal: controller.signal,
    });
    expect(result).toMatchObject({ exitCode: 130, cancellation: {
      stop_confirmed: true, invocation_started: false, evidence: "not_started",
    } });
    expect(existsSync(join(workspace, "should-not-exist"))).toBe(false);
  });
});

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Process fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withProcessFixture(source: string, test: (fixture: {
  command: string; waitFor: (file: string) => Promise<void>; assertStopped: () => void;
  cleanup: () => void; leaderPid: () => number;
}) => Promise<void>): Promise<void> {
  writeFileSync(join(workspace, "main.cjs"), `const fs = require('node:fs');
    fs.writeFileSync('leader.pid', String(process.pid));\n${source}`);
  const pids = () => readdirSync(workspace).filter((file) => file.endsWith(".pid"))
    .map((file) => Number(readFileSync(join(workspace, file), "utf8"))).filter((pid) => pid > 1);
  const leaderPid = () => Number(readFileSync(join(workspace, "leader.pid"), "utf8"));
  const realKill = process.kill.bind(process);
  const cleanup = () => {
    // Negative ID only targets the fixture's own group when detached; the RED
    // implementation has no such group. Individual PIDs also clean up RED runs.
    for (const pid of pids()) {
      for (const target of [-pid, pid]) {
        try { realKill(target, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
  };
  const safety = setTimeout(cleanup, 3_000);
  try {
    await test({ command: `exec '${process.execPath.replaceAll("'", "'\\''")}' main.cjs`,
      waitFor: (file) => waitUntil(() => existsSync(join(workspace, file))), cleanup, leaderPid,
      assertStopped: () => {
        expect(pids().length).toBeGreaterThan(0);
        for (const pid of pids()) expect(pidExists(pid)).toBe(false);
        expect(pidExists(-leaderPid())).toBe(false);
      } });
  } finally {
    clearTimeout(safety);
    vi.restoreAllMocks();
    cleanup();
    await waitUntil(() => pids().every((pid) => !pidExists(pid)));
  }
}

function plan(agentId: string) {
  return planTask(task(), { agentId });
}

function task(): Task {
  return {
    task_id: "task-1",
    capability: "code.write",
    prompt: "Do work",
    priority: 50,
    source: "manual",
    context: { existing: true },
  };
}

function mockAdapter(options: {
  id?: string;
  available?: boolean;
  reason?: string;
  invoke?: AgentAdapter["invoke"];
} = {}): AgentAdapter {
  const id = options.id ?? "mock-agent";
  return {
    id,
    display_name: "Mock Agent",
    cost_tier: "low",
    capabilities: () => [{
      id: "mock.code.write",
      kind: "code.write",
      agent_id: id,
      description: "Mock write capability",
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

function doneEvent(
  runId: string,
  sessionId: string,
  status: "completed" | "failed" | "cancelled" | "expired",
  resultSummary: string,
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
      result_summary: resultSummary,
    },
  };
}

function errorEvent(runId: string, sessionId: string, message: string): HermesEvent {
  return {
    event_id: `${runId}:1`,
    seq: 1,
    run_id: runId,
    session_id: sessionId,
    created_at: Date.now() / 1000,
    terminal: true,
    type: "error",
    payload: {
      code: "mock_error",
      message,
      terminal: true,
    },
  };
}

describe("reviewed invocation lifecycle", () => {
  it("confirms no invocation after a settled preflight is cancelled", async () => {
    const controller = new AbortController();
    const adapter = mockAdapter();
    adapter.isAvailable = async () => { controller.abort(); return { available: true, last_checked_at: 0 }; };
    const invoke = vi.spyOn(adapter, "invoke");
    const run = await executePlan(plan(adapter.id), { workspacePath: workspace, adapters: [adapter], signal: controller.signal });
    expect(run).toMatchObject({ outcome: "cancelled", cancellation: {
      invocation_started: false, stop_confirmed: true, evidence: "invocation_not_started",
    } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not reuse stop evidence when the same plan is invoked twice", async () => {
    const executionPlan = plan("mock-agent");
    const stopped = new Set<string>();
    const controller = new AbortController();
    let calls = 0;
    const adapter = mockAdapter({ async *invoke(task) {
      if (++calls === 1) {
        stopped.add(task.run_id);
        yield doneEvent(task.run_id, task.session_id, "completed", "first stopped");
      } else {
        controller.abort();
        yield doneEvent(task.run_id, task.session_id, "cancelled", "still running");
      }
    } });
    adapter.confirmStopped = async (runId) => stopped.has(runId) ? { stopped: true, evidence: "first invocation stopped" } : { stopped: false };
    const options = { workspacePath: workspace, adapters: [adapter], signal: controller.signal };
    const first = await executePlan(executionPlan, options);
    const second = await executePlan(executionPlan, options);
    expect(first.run_id).not.toBe(second.run_id);
    expect(second.cancellation?.stop_confirmed).toBe(false);
  });

  it("knows an unsupported command was not started", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const run = await runShellCommand("exit 0", { cwd: workspace, timeoutMs: 100, outputLimit: 100 });
      expect(run).toMatchObject({ failure_code: "process_control_unsupported", termination: { stop_confirmed: true } });
    } finally { platform.mockRestore(); }
  });

  it.each(["SIGINT", "SIGTERM", "exit"] as const)("cleans owned groups on parent %s", async (ending) => {
    const { spawn } = await import("node:child_process");
    await withProcessFixture("setInterval(() => {}, 1000);", async (fixture) => {
      const program = `import { runShellCommand } from ${JSON.stringify(new URL("../dist/executor.js", import.meta.url).href)};
        process.on('message', () => process.exit(7));
        await runShellCommand(${JSON.stringify(fixture.command)}, {cwd:${JSON.stringify(workspace)},timeoutMs:10000,outputLimit:100});`;
      const host = spawn(process.execPath, ["--input-type=module", "-e", program], { cwd: workspace, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
      try {
        await fixture.waitFor("leader.pid");
        if (ending === "exit") host.send({ exit: true }); else host.kill(ending);
        await exited;
        await waitUntil(() => !pidExists(fixture.leaderPid()));
        fixture.assertStopped();
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
        await exited;
      }
    });
  });
});

describe("reviewed lifecycle compatibility", () => {
  it("knows a timeout preflight settled without invoking", async () => {
    const adapter = mockAdapter();
    adapter.isAvailable = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return { available: true, last_checked_at: 0 }; };
    const invoke = vi.spyOn(adapter, "invoke");
    const result = await executePlan(plan(adapter.id), { workspacePath: workspace, adapters: [adapter], timeoutMs: 5 });
    expect(result.cancellation).toMatchObject({ source: "timeout", stop_confirmed: true, invocation_started: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lets finishing descendants drain within a bounded window", async () => {
    await withProcessFixture(`const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10)'], {stdio: 'ignore'});
      fs.writeFileSync('child.pid', String(child.pid)); process.exit(0);`, async (fixture) => {
      const result = await runShellCommand(fixture.command, { cwd: workspace, timeoutMs: 2000, outputLimit: 1000 });
      expect(result).toMatchObject({ exitCode: 0, termination: { trigger: "exit", stop_confirmed: true, signals: [] } });
      fixture.assertStopped();
    });
  });

  it("releases process shutdown listeners after success and failure", async () => {
    const names = ["SIGINT", "SIGTERM", "exit"] as const;
    const before = names.map((name) => process.listenerCount(name));
    for (const command of ["exit 0", "exit 7"]) {
      await runShellCommand(command, { cwd: workspace, timeoutMs: 1000, outputLimit: 100 });
      expect(names.map((name) => process.listenerCount(name))).toEqual(before);
    }
  });

  it("preserves the host's own signal handler", async () => {
    const { spawn } = await import("node:child_process");
    await withProcessFixture("setInterval(() => {}, 1000);", async (fixture) => {
      const program = `import {writeFileSync} from 'node:fs';
        import {runShellCommand} from ${JSON.stringify(new URL("../dist/executor.js", import.meta.url).href)};
        process.on('message', () => process.exit(0));
        process.on('SIGINT', () => writeFileSync('host-handled', 'yes'));
        await runShellCommand(${JSON.stringify(fixture.command)}, {cwd:${JSON.stringify(workspace)},timeoutMs:10000,outputLimit:100});`;
      const host = spawn(process.execPath, ["--input-type=module", "-e", program], { cwd: workspace, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
      try {
        await fixture.waitFor("leader.pid");
        host.kill("SIGINT");
        await fixture.waitFor("host-handled");
        await waitUntil(() => !pidExists(fixture.leaderPid()));
        expect(host.exitCode).toBeNull();
        expect(host.signalCode).toBeNull();
        fixture.assertStopped();
      } finally {
        if (host.exitCode === null && host.signalCode === null) host.send({ exit: true });
        await exited;
      }
    });
  });
});
