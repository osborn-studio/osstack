import { describe, expect, it } from "vitest";
import { SessionDecision, SessionContinuationRequest } from "./session-continuation.js";

const decision = {
  decision_id: "decision_1",
  question: "Continue to verification?",
  choices: [{ choice_id: "continue", label: "Continue" }],
};
const continuation = {
  version: 1,
  gate_kind: "phase_continue",
  phase: "implementation",
  next_action: "Run the frozen acceptance checks",
  evidence_refs: [{ evidence_id: "result_1", sha256: "a".repeat(64) }],
};

describe("session continuation requests", () => {
  it("preserves legacy decisions without inventing a gate", () => {
    expect(SessionDecision.parse(decision)).toEqual(decision);
  });

  it("round-trips a versioned request with evidence references", () => {
    expect(SessionDecision.parse({ ...decision, continuation })).toEqual({ ...decision, continuation });
  });

  it.each(["phase_continue", "task_authorization", "risk_approval", "external_input"])(
    "keeps %s separate from an authorization decision", (gate_kind) => {
      expect(SessionContinuationRequest.parse({ ...continuation, gate_kind }).gate_kind).toBe(gate_kind);
      expect(() => SessionContinuationRequest.parse({ ...continuation, gate_kind, approved: true })).toThrow();
    },
  );

  it("rejects unknown versions, unbound evidence and duplicate choices", () => {
    expect(() => SessionContinuationRequest.parse({ ...continuation, version: 2 })).toThrow();
    expect(() => SessionContinuationRequest.parse({ ...continuation, gate_kind: "auto_approve" })).toThrow();
    expect(() => SessionContinuationRequest.parse({ ...continuation, evidence_refs: [{ evidence_id: "result_1" }] })).toThrow();
    expect(() => SessionDecision.parse({ ...decision, choices: [...decision.choices, ...decision.choices] })).toThrow();
    expect(SessionDecision.parse({ ...decision, choices: [] }).choices).toEqual([]);
  });
});
