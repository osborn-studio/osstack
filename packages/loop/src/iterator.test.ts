import { describe, expect, it } from "vitest";
import { Iterator, evaluateIteration } from "./iterator.js";
import type { Verdict } from "./types.js";

function verdict(overrides: Partial<Verdict>): Verdict {
  return {
    pass: false,
    score: 0.4,
    issues: [],
    reviewer_agent_id: "ds-review",
    summary: "Needs work",
    ...overrides,
  };
}

describe("Iterator", () => {
  it("stops when verification passes above the score threshold", () => {
    expect(evaluateIteration({
      verdict: verdict({ pass: true, score: 0.93 }),
      iteration: 1,
      maxIterations: 3,
    })).toMatchObject({ action: "stop" });
  });

  it("continues while failing verification and iterations remain", () => {
    expect(evaluateIteration({
      verdict: verdict({
        issues: [{ severity: "error", message: "Typecheck failed" }],
      }),
      iteration: 2,
      maxIterations: 3,
    })).toMatchObject({ action: "continue" });
  });

  it("escalates when the max iteration budget is exhausted", () => {
    expect(new Iterator({ escalateTo: "human" }).evaluate({
      verdict: verdict({
        issues: [{ severity: "warning", message: "Review concern" }],
      }),
      iteration: 3,
      maxIterations: 3,
    })).toEqual({
      action: "escalate",
      reason: "Maximum iterations reached (3) with 1 verifier issue remaining.",
      escalate_to: "human",
    });
  });
});
