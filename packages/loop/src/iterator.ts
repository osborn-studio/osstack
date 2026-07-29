import {
  evaluateProgressBudget,
  type ProgressBudgetInput,
} from "@osstack/autonomy";
import type { IterationOutcome, Verdict } from "./types.js";

export interface IterationDecisionInput {
  verdict: Verdict;
  /** 1-based attempt number for the current task. */
  iteration: number;
  maxIterations: number;
  /** Minimum score required when verdict.pass is true. */
  minPassingScore?: number;
  escalateTo?: "human" | "hermes";
  /**
   * Opt-in guarded-autonomy progress evidence. Legacy loop callers omit it
   * and preserve the existing iteration semantics.
   */
  guardedProgress?: ProgressBudgetInput;
}

export class Iterator {
  constructor(
    private readonly defaults: {
      minPassingScore?: number;
      escalateTo?: "human" | "hermes";
    } = {},
  ) {}

  evaluate(input: IterationDecisionInput): IterationOutcome {
    return evaluateIteration({
      ...input,
      minPassingScore: input.minPassingScore ?? this.defaults.minPassingScore ?? 0.8,
      escalateTo: input.escalateTo ?? this.defaults.escalateTo ?? "hermes",
    });
  }
}

export function evaluateIteration(input: IterationDecisionInput): IterationOutcome {
  const minPassingScore = input.minPassingScore ?? 0.8;
  const escalateTo = input.escalateTo ?? "hermes";

  if (input.verdict.pass && input.verdict.score >= minPassingScore) {
    return {
      action: "stop",
      reason: `Verifier passed with score ${formatScore(input.verdict.score)}.`,
    };
  }

  if (input.guardedProgress !== undefined) {
    const progressBudget = evaluateProgressBudget(input.guardedProgress);
    if (progressBudget.exhausted) {
      return {
        action: "escalate",
        reason:
          `Guarded autonomy budget ${progressBudget.limit} exhausted: ` +
          progressBudget.reasons.join("; "),
        escalate_to: escalateTo,
      };
    }
  }

  if (input.iteration >= input.maxIterations) {
    return {
      action: "escalate",
      reason: buildMaxIterationReason(input),
      escalate_to: escalateTo,
    };
  }

  if (input.verdict.pass) {
    return {
      action: "continue",
      reason: `Verifier passed but score ${formatScore(input.verdict.score)} is below threshold ${formatScore(minPassingScore)}.`,
    };
  }

  const blockingIssues = input.verdict.issues.filter((issue) => issue.severity === "error").length;
  const issueSummary = blockingIssues > 0
    ? `${blockingIssues} blocking issue${blockingIssues === 1 ? "" : "s"} remain`
    : "verification has not passed";

  return {
    action: "continue",
    reason: `${issueSummary}; iteration ${input.iteration} of ${input.maxIterations}.`,
  };
}

function buildMaxIterationReason(input: IterationDecisionInput): string {
  const issueCount = input.verdict.issues.length;
  if (issueCount === 0) {
    return `Maximum iterations reached (${input.maxIterations}) without an approved verdict.`;
  }
  return `Maximum iterations reached (${input.maxIterations}) with ${issueCount} verifier issue${issueCount === 1 ? "" : "s"} remaining.`;
}

function formatScore(score: number): string {
  return score.toFixed(2);
}
