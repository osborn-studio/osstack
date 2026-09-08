import { describe, expect, it } from "vitest";
import { describeSessionWait } from "./session-wait.js";

const decision = {
  decision_id: "decision_1",
  question: "Everything is approved. Say go to deploy.",
  choices: [{ choice_id: "go", label: "Go" }],
};
const snapshot = { state: "awaiting_decision", decision, resume_ready: true, applying: false };

describe("session wait diagnostics", () => {
  it("never guesses approval or phase completion from a go question", () => {
    expect(describeSessionWait(snapshot)).toEqual({ reason: "unclassified_decision", automatic_continuation: false });
    expect(describeSessionWait({ ...snapshot, state: "idle", decision: null })).toEqual({
      reason: "awaiting_instruction", automatic_continuation: false,
    });
  });

  it.each(["phase_continue", "task_authorization", "risk_approval", "external_input"])(
    "exposes %s as a reported request, not an authorization", (gate_kind) => {
      const continuation = { version: 1, gate_kind, phase: "verify", next_action: "continue", evidence_refs: [] };
      expect(describeSessionWait({ ...snapshot, decision: { ...decision, continuation } })).toEqual({
        reason: gate_kind, request_source: "agent_reported", continuation, automatic_continuation: false,
      });
    },
  );

  it("leaves unsupported or malformed requests unclassified", () => {
    expect(describeSessionWait({ ...snapshot, decision: { ...decision, continuation: { version: 99 } } })).toMatchObject({
      reason: "unclassified_decision", automatic_continuation: false,
    });
    expect(describeSessionWait({ ...snapshot, resume_ready: false })).toMatchObject({ reason: "resume_unavailable" });
  });

  it("distinguishes in-flight delivery from an uncertain receipt after restart", () => {
    const pending_message = { message_id: "m1", state: "accepted" as const };
    expect(describeSessionWait({ ...snapshot, pending_message, applying: true })).toBeNull();
    expect(describeSessionWait({ ...snapshot, pending_message })).toEqual({
      reason: "delivery_uncertain", message_id: "m1", automatic_continuation: false,
    });
    expect(describeSessionWait({ ...snapshot, pending_message: { ...pending_message, state: "failed" } })).toMatchObject({
      reason: "delivery_failed", automatic_continuation: false,
    });
  });

  it.each(["starting", "running", "completed", "failed", "cancelled"])("does not label %s as waiting for go", (state) => {
    expect(describeSessionWait({ ...snapshot, state })).toBeNull();
  });
});
