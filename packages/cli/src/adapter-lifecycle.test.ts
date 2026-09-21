import { afterEach, expect, it, vi } from "vitest";
import type { AgentAdapter } from "@osstack/agents";
import { boundedAdapterEvents, confirmAdapterStopped } from "./adapter-lifecycle.js";
afterEach(() => vi.useRealTimers());
it("bounds a hung iterator after abort without treating return as exit", async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const returned = vi.fn(() => new Promise<IteratorResult<number>>(() => {}));
  const source = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<number>>(() => {}), return: returned }) };
  const iterator = boundedAdapterEvents(source, controller.signal);
  const rejected = expect(iterator.next()).rejects.toThrow("grace elapsed");
  controller.abort(); await vi.advanceTimersByTimeAsync(1000); await rejected;
  expect(returned).toHaveBeenCalledTimes(1);
});
it("requires exact adapter receipt and bounds missing or hung stop confirmation", async () => {
  vi.useFakeTimers();
  const confirmStopped = vi.fn(async () => ({ stopped: true as const, evidence: "observed exit of all owned work" }));
  const adapter = { confirmStopped } as unknown as AgentAdapter;
  expect(await confirmAdapterStopped(adapter, "run-123")).toBe(true);
  expect(confirmStopped).toHaveBeenCalledWith("run-123");
  expect(await confirmAdapterStopped({} as unknown as AgentAdapter, "run-123")).toBe(false);
  expect(await confirmAdapterStopped({ confirmStopped: async () => ({ stopped: true, evidence: " " }) } as unknown as AgentAdapter, "run-123")).toBe(false);
  const pending = confirmAdapterStopped({ confirmStopped: () => new Promise(() => {}) } as unknown as AgentAdapter, "run-123");
  await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBe(false);
});
