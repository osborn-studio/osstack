import { describe, expect, it } from "vitest";
import { Iterator, evaluateIteration } from "./iterator.js";
import type { Verdict } from "./types.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

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

  it("escalates when guarded autonomy repeats findings through its no-progress budget", () => {
    expect(evaluateIteration({
      verdict: verdict({
        issues: [{ severity: "error", message: "Auth review failed" }],
      }),
      iteration: 3,
      maxIterations: 10,
      guardedProgress: {
        budget: {
          max_builder_iterations: 10,
          max_review_rounds: 10,
          max_wall_time_ms: 60_000,
          max_no_progress_rounds: 2,
        },
        builder_iterations: 3,
        review_rounds: 3,
        elapsed_ms: 10_000,
        prior_no_progress_rounds: 1,
        previous: {
          finding_fingerprints: ["finding-auth"],
          changed_files_sha256: SHA_A,
          verification_sha256: SHA_B,
          failed_commands: ["pnpm test"],
          acceptance_score: 0.4,
        },
        current: {
          finding_fingerprints: ["finding-auth"],
          changed_files_sha256: SHA_A,
          verification_sha256: SHA_B,
          failed_commands: ["pnpm test"],
          acceptance_score: 0.4,
        },
      },
    })).toMatchObject({
      action: "escalate",
      reason: expect.stringContaining("max_no_progress_rounds"),
    });
  });

  it("continues after acceptance-score improvement resets a stall streak", () => {
    expect(evaluateIteration({
      verdict: verdict({
        issues: [{ severity: "error", message: "One issue remains" }],
        score: 0.5,
      }),
      iteration: 2,
      maxIterations: 10,
      guardedProgress: {
        budget: {
          max_builder_iterations: 10,
          max_review_rounds: 10,
          max_wall_time_ms: 60_000,
          max_no_progress_rounds: 2,
        },
        builder_iterations: 2,
        review_rounds: 2,
        elapsed_ms: 10_000,
        prior_no_progress_rounds: 1,
        previous: {
          finding_fingerprints: ["finding-auth"],
          changed_files_sha256: SHA_A,
          verification_sha256: SHA_B,
          failed_commands: ["pnpm test"],
          acceptance_score: 0.4,
        },
        current: {
          finding_fingerprints: ["finding-auth"],
          changed_files_sha256: SHA_A,
          verification_sha256: SHA_B,
          failed_commands: ["pnpm test"],
          acceptance_score: 0.5,
        },
      },
    })).toMatchObject({ action: "continue" });
  });
});
