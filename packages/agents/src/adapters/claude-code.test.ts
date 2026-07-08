// Adapter-side token-accounting contract for the claude-code adapter. The loop
// executor reads tokens_in/tokens_out/cost_usd off the usage.final payload to
// drive budget enforcement, so a change that stops emitting those (or mis-maps
// the SDK result) must fail here rather than silently zero out budgets in
// production. The Anthropic Agent SDK is fully mocked — no real API call.

import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "../base.js";

// Hoisted so the vi.mock factory (which is hoisted above imports) can capture a
// stable reference; each test assigns the fake SDK message stream it wants.
const sdk = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      for (const message of sdk.messages) yield message;
    })(),
}));

import { ClaudeCodeAdapter } from "./claude-code.js";

afterEach(() => {
  sdk.messages = [];
  vi.clearAllMocks();
});

describe("ClaudeCodeAdapter usage.final emission (loop budget contract)", () => {
  it("emits usage.final with tokens_in/tokens_out/cost_usd from an SDK success result", async () => {
    sdk.messages = [
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "done" }] } },
      {
        type: "result",
        subtype: "success",
        duration_ms: 1234,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 50 },
        result: "task complete",
      },
    ];

    const adapter = new ClaudeCodeAdapter();
    const events = await drain(adapter.invoke(task("claude-code.code.write"), new AbortController().signal));

    const usage = events.find((event) => event.type === "usage.final");
    expect(usage).toBeDefined();
    // Exactly the three fields the loop executor's usagePayload() consumes.
    expect(usage?.payload).toMatchObject({
      tokens_in: 100,
      tokens_out: 50,
      cost_usd: 0.0123,
    });
    // usage.final must land before the terminal done, and the run must complete.
    expect(usage?.terminal).toBe(false);
    expect(doneStatus(events)).toBe("completed");
  });

  it("emits usage.final with zeroed tokens and no cost when the SDK omits usage", async () => {
    // The executor treats a missing cost_usd as 'no cost reported' (contributes
    // 0 to budgets); the adapter must not fabricate one. Tokens default to 0.
    sdk.messages = [
      { type: "result", subtype: "success", duration_ms: 5, result: "ok" },
    ];

    const adapter = new ClaudeCodeAdapter();
    const events = await drain(adapter.invoke(task("claude-code.code.write"), new AbortController().signal));

    const usage = events.find((event) => event.type === "usage.final");
    expect(usage?.payload).toMatchObject({ tokens_in: 0, tokens_out: 0 });
    expect((usage?.payload as Record<string, unknown>)["cost_usd"]).toBeUndefined();
    expect(doneStatus(events)).toBe("completed");
  });

  it("still emits usage.final on a non-success result before failing", async () => {
    // Even a failed turn reports usage; budgets must account for spend on
    // failures, so usage.final precedes the error/done(failed) pair.
    sdk.messages = [
      {
        type: "result",
        subtype: "error_max_turns",
        duration_ms: 42,
        total_cost_usd: 0.005,
        usage: { input_tokens: 30, output_tokens: 10 },
        errors: ["hit max turns"],
      },
    ];

    const adapter = new ClaudeCodeAdapter();
    const events = await drain(adapter.invoke(task("claude-code.code.write"), new AbortController().signal));

    const usage = events.find((event) => event.type === "usage.final");
    expect(usage?.payload).toMatchObject({ tokens_in: 30, tokens_out: 10, cost_usd: 0.005 });
    expect(doneStatus(events)).toBe("failed");
  });
});

async function drain(it: AsyncIterable<HermesEvent>): Promise<HermesEvent[]> {
  const events: HermesEvent[] = [];
  for await (const event of it) events.push(event);
  return events;
}

function doneStatus(events: HermesEvent[]): string | undefined {
  const done = [...events].reverse().find((event) => event.type === "done");
  return done === undefined ? undefined : String((done.payload as { status?: unknown }).status);
}

function task(capabilityId: string): AgentTask {
  return {
    run_id: `run_${capabilityId.replaceAll(".", "_")}`,
    task_id: "task-1",
    session_id: "session-1",
    capability_id: capabilityId,
    prompt: "hello from task",
    context: {},
  };
}
