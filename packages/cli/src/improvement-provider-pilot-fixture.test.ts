import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { observePilotAdapter, withPilotState } from "./fixtures/improvement-provider-pilot.js";

const original = { home: process.env["OSSTACK_HOME"], socket: process.env["OSSTACK_SOCKET"] };
afterEach(() => {
  for (const [key, value] of [["OSSTACK_HOME", original.home], ["OSSTACK_SOCKET", original.socket]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("pilot resource failures (offline, no provider)", () => {
  it.each([true, false])("restores existing/unset home and socket after success: %s", async (present) => {
    if (present) { process.env["OSSTACK_HOME"] = "previous-home"; process.env["OSSTACK_SOCKET"] = "previous-socket"; }
    else { delete process.env["OSSTACK_HOME"]; delete process.env["OSSTACK_SOCKET"]; }
    const close = vi.fn();
    const value = await withPilotState("isolated-home", () => {
      expect(process.env["OSSTACK_HOME"]).toBe("isolated-home");
      expect(process.env["OSSTACK_SOCKET"]).toBeUndefined();
      return { close };
    }, async () => 42, async (failures) => { expect(failures).toEqual([]); expect(close).toHaveBeenCalledOnce(); });
    expect(value).toBe(42);
    expect(process.env["OSSTACK_HOME"]).toBe(present ? "previous-home" : undefined);
    expect(process.env["OSSTACK_SOCKET"]).toBe(present ? "previous-socket" : undefined);
  });
  it.each(["open", "initial-save", "run", "close", "final-save"])("restores state and fails at %s", async (phase) => {
    const error = new Error(phase);
    const close = vi.fn(() => { if (phase === "close") throw error; });
    const run = vi.fn(async () => { if (phase === "initial-save" || phase === "run") throw error; });
    const finalize = vi.fn(async (failures: readonly unknown[]) => {
      if (phase === "final-save") throw error;
      expect(failures).toEqual([error]);
    });
    await expect(withPilotState("isolated", () => { if (phase === "open") throw error; return { close }; }, run, finalize)).rejects.toBe(error);
    expect(close).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
    expect(run).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
    expect(finalize).toHaveBeenCalledOnce();
    expect(process.env["OSSTACK_HOME"]).toBe(original.home);
    expect(process.env["OSSTACK_SOCKET"]).toBe(original.socket);
  });
  it("retains the primary failure when close and evidence persistence also fail", async () => {
    const primary = new Error("run"), closeError = new Error("close"), saveError = new Error("save");
    const promise = withPilotState("isolated", () => ({ close: () => { throw closeError; } }), async () => { throw primary; }, async (failures) => {
      expect(failures).toEqual([primary, closeError]); throw saveError;
    });
    await expect(promise).rejects.toMatchObject({ errors: [primary, closeError, saveError] });
    expect(process.env["OSSTACK_HOME"]).toBe(original.home);
  });
  it("records even a thrown undefined as a failure", async () => {
    const final = vi.fn(async (failures: readonly unknown[]) => { expect(failures).toEqual([undefined]); });
    await expect(withPilotState("isolated", () => ({ close: vi.fn() }), async () => { throw undefined; }, final)).rejects.toBeUndefined();
    expect(final).toHaveBeenCalledOnce();
  });
});

describe("transparent pilot observation", () => {
  const task: AgentTask = { run_id: "run", task_id: "task", session_id: "session", capability_id: "test", prompt: "synthetic" };
  function fixture() {
    const state = { closed: false, task: undefined as AgentTask | undefined, signal: undefined as AbortSignal | undefined };
    const event = { type: "progress", payload: { phase: "fixture" } } as HermesEvent;
    const adapter: AgentAdapter = {
      id: "fixture", display_name: "fixture", cost_tier: "low", capabilities: () => [],
      async isAvailable() { return { available: this.id === "fixture", last_checked_at: 0 }; },
      async runtimeIdentity() { return { adapter_id: this.id, adapter_version: "1", auth_mode: "test", provider_id: "test", model_id: "test", evidence_source: "configured" }; },
      async *invoke(receivedTask, receivedSignal) {
        state.task = receivedTask; state.signal = receivedSignal;
        try { expect(this.id).toBe("fixture"); yield event; } finally { state.closed = true; }
      },
    };
    return { adapter, state, event };
  }
  it("forwards identity, receiver, task, signal and the original event", async () => {
    const { adapter, state, event } = fixture();
    const onInvoke = vi.fn(async () => {}), onEvent = vi.fn(async () => {});
    const wrapped = observePilotAdapter(adapter, onInvoke, onEvent);
    expect(await wrapped.runtimeIdentity!()).toEqual(await adapter.runtimeIdentity!());
    expect(await wrapped.isAvailable()).toMatchObject({ available: true });
    const signal = new AbortController().signal;
    const events = []; for await (const e of wrapped.invoke(task, signal)) events.push(e);
    expect(events[0]).toBe(event); expect(state).toMatchObject({ closed: true, task, signal });
    expect(onInvoke).toHaveBeenCalledOnce(); expect(onEvent).toHaveBeenCalledWith(event);
  });
  it("keeps an absent runtime identity absent", () => {
    const { adapter } = fixture(); delete adapter.runtimeIdentity;
    expect("runtimeIdentity" in observePilotAdapter(adapter, async () => {}, async () => {})).toBe(false);
  });
  it("closes the provider iterator when evidence observation throws", async () => {
    const { adapter, state } = fixture();
    const failure = new Error("evidence write failed");
    const wrapped = observePilotAdapter(adapter, async () => {}, async () => { throw failure; });
    await expect(wrapped.invoke(task, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toBe(failure);
    expect(state.closed).toBe(true);
  });
});
