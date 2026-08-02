import { describe, expect, it } from "vitest";
import {
  compareAttemptProgress,
  evaluateProgressBudget,
  type AttemptProgress,
} from "./progress-budget.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function progress(
  overrides: Partial<AttemptProgress> = {},
): AttemptProgress {
  return {
    finding_fingerprints: ["finding-auth", "finding-test"],
    changed_files_sha256: SHA_A,
    verification_sha256: SHA_B,
    failed_commands: ["pnpm test"],
    acceptance_score: 0.4,
    ...overrides,
  };
}

const BUDGET = {
  max_builder_iterations: 3,
  max_review_rounds: 3,
  max_wall_time_ms: 60_000,
  max_no_progress_rounds: 2,
};

describe("attempt progress comparison", () => {
  it("reports no improvement for identical findings, evidence, commands, and score", () => {
    expect(compareAttemptProgress(progress(), progress())).toEqual({
      improved: false,
      reasons: [
        "blocking_findings_unchanged",
        "changed_files_or_verification_unchanged",
        "failed_commands_repeated",
        "acceptance_score_not_increased",
      ],
    });
  });

  it("requires both changed-file and verification digests to change", () => {
    expect(
      compareAttemptProgress(
        progress(),
        progress({ changed_files_sha256: SHA_C }),
      ).improved,
    ).toBe(false);
    expect(
      compareAttemptProgress(
        progress(),
        progress({ verification_sha256: SHA_C }),
      ).improved,
    ).toBe(false);
    expect(
      compareAttemptProgress(
        progress(),
        progress({
          changed_files_sha256: SHA_C,
          verification_sha256: SHA_C,
        }),
      ),
    ).toEqual({
      improved: true,
      reasons: ["changed_files_and_verification_changed"],
    });
  });

  it("treats a disappeared blocking fingerprint or higher score as progress", () => {
    expect(
      compareAttemptProgress(
        progress(),
        progress({ finding_fingerprints: ["finding-test"] }),
      ),
    ).toEqual({
      improved: true,
      reasons: ["blocking_fingerprint_removed:finding-auth"],
    });
    expect(
      compareAttemptProgress(
        progress(),
        progress({ acceptance_score: 0.41 }),
      ),
    ).toEqual({
      improved: true,
      reasons: ["acceptance_score_increased"],
    });
  });
});

describe("guarded progress budgets", () => {
  it("increments consecutive stalls and resets the count after improvement", () => {
    const stalled = evaluateProgressBudget({
      budget: BUDGET,
      builder_iterations: 2,
      review_rounds: 2,
      elapsed_ms: 10_000,
      prior_no_progress_rounds: 0,
      previous: progress(),
      current: progress(),
    });
    expect(stalled).toMatchObject({
      exhausted: false,
      improved: false,
      no_progress_rounds: 1,
    });

    const improved = evaluateProgressBudget({
      budget: BUDGET,
      builder_iterations: 2,
      review_rounds: 2,
      elapsed_ms: 10_000,
      prior_no_progress_rounds: 1,
      previous: progress(),
      current: progress({ acceptance_score: 0.5 }),
    });
    expect(improved).toMatchObject({
      exhausted: false,
      improved: true,
      no_progress_rounds: 0,
    });
  });

  it.each([
    [
      "max_builder_iterations",
      {
        builder_iterations: 3,
        review_rounds: 1,
        elapsed_ms: 10_000,
        prior_no_progress_rounds: 0,
      },
    ],
    [
      "max_review_rounds",
      {
        builder_iterations: 1,
        review_rounds: 3,
        elapsed_ms: 10_000,
        prior_no_progress_rounds: 0,
      },
    ],
    [
      "max_wall_time_ms",
      {
        builder_iterations: 1,
        review_rounds: 1,
        elapsed_ms: 60_000,
        prior_no_progress_rounds: 0,
      },
    ],
    [
      "max_no_progress_rounds",
      {
        builder_iterations: 2,
        review_rounds: 2,
        elapsed_ms: 10_000,
        prior_no_progress_rounds: 1,
      },
    ],
  ] as const)(
    "exhausts %s deterministically",
    (limit, usage) => {
      expect(
        evaluateProgressBudget({
          budget: BUDGET,
          ...usage,
          previous: progress(),
          current: progress(),
        }),
      ).toMatchObject({
        exhausted: true,
        limit,
      });
    },
  );
});
