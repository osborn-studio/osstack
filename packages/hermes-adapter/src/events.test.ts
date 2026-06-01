import { describe, expect, it } from "vitest";
import { HermesEventSchema, HermesControlSchema } from "./events.js";

describe("HermesEventSchema", () => {
  it("parses a run.started event", () => {
    const ev = HermesEventSchema.parse({
      event_id: "run_1:0",
      seq: 0,
      run_id: "run_1",
      session_id: "sess_1",
      created_at: 1778750000,
      terminal: false,
      type: "run.started",
      payload: {
        status: "running",
        controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: true, goal: false },
      },
    });
    expect(ev.type).toBe("run.started");
  });

  it("parses a tool.done terminal-flagged event", () => {
    const ev = HermesEventSchema.parse({
      event_id: "run_1:7",
      seq: 7,
      run_id: "run_1",
      session_id: "sess_1",
      created_at: 1778750100,
      terminal: false,
      type: "tool.done",
      payload: {
        tool_call_id: "tc_1",
        result: { stdout: "ok" },
        duration_ms: 42,
        error: false,
      },
    });
    expect(ev.type).toBe("tool.done");
  });

  it("rejects an event with an unknown type", () => {
    expect(() => HermesEventSchema.parse({
      event_id: "x", seq: 0, run_id: "r", session_id: "s",
      created_at: 1, terminal: false, type: "tool.bogus", payload: {},
    })).toThrow();
  });

  it("rejects a token.delta missing required fields", () => {
    expect(() => HermesEventSchema.parse({
      event_id: "x", seq: 0, run_id: "r", session_id: "s",
      created_at: 1, terminal: false, type: "token.delta", payload: {},
    })).toThrow();
  });
});

describe("HermesControlSchema", () => {
  it("parses an observe control with after_seq", () => {
    const c = HermesControlSchema.parse({ type: "observe", run_id: "r1", after_seq: 5 });
    expect(c.type).toBe("observe");
  });

  it("parses a cancel control", () => {
    const c = HermesControlSchema.parse({ type: "cancel", run_id: "r1", reason: "user_clicked_stop" });
    expect(c.type).toBe("cancel");
  });

  it("rejects unknown control types", () => {
    expect(() => HermesControlSchema.parse({ type: "nope", run_id: "r1" })).toThrow();
  });
});
