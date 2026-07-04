// Feedback-carrying iteration — convert failed Verdicts into structured
// input for the next attempt, and fingerprint failures so the loop can
// detect no-progress attempts and escalate instead of burning iterations.

import { createHash } from "node:crypto";
import { failedEvaluationIds } from "./evaluation-spec.js";
import { IterationFeedback, type Verdict } from "./types.js";

/** Context key the executor and adapters read the previous-attempt feedback from. */
export const ITERATION_FEEDBACK_CONTEXT_KEY = "iteration_feedback";

export interface DeriveIterationFeedbackInput {
  /** 1-based attempt number that produced the failed verdict. */
  attempt: number;
  verdict: Verdict;
  changedFiles?: readonly string[];
  diffSummary?: string;
}

export function deriveIterationFeedback(input: DeriveIterationFeedbackInput): IterationFeedback {
  const blockingIssues = input.verdict.issues.filter((issue) => issue.severity === "error");
  const failedEvaluations = failedEvaluationIds(input.verdict.evaluations ?? []);
  const focusFiles = [...new Set(blockingIssues
    .map((issue) => issue.file)
    .filter((file): file is string => file !== undefined && file.trim() !== ""))];
  const focusEvaluations = (input.verdict.evaluations ?? [])
    .filter((evaluation) => !evaluation.pass)
    .map((evaluation) => `satisfy evaluation ${evaluation.spec_id}: ${evaluation.description}`);

  return IterationFeedback.parse({
    attempt: input.attempt,
    verdict_summary: input.verdict.summary,
    blocking_issues: blockingIssues,
    failed_evaluations: failedEvaluations,
    suggested_focus: [...focusFiles, ...focusEvaluations],
    ...(input.diffSummary !== undefined ? { previous_diff_summary: input.diffSummary } : {}),
  });
}

/**
 * Stable fingerprint of a failed attempt: blocking issues plus changed files.
 * Two consecutive attempts with the same fingerprint made no progress.
 */
export function issueFingerprint(verdict: Verdict, changedFiles: readonly string[]): string {
  const issueKeys = verdict.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.rule ?? ""}|${issue.file ?? ""}|${issue.line ?? ""}|${issue.message}`)
    .sort();
  const fileKeys = [...changedFiles].sort();
  return createHash("sha1")
    .update(JSON.stringify({ issues: issueKeys, files: fileKeys }))
    .digest("hex");
}

/** Merge feedback into a task context for the next attempt. */
export function withIterationFeedback(
  context: Record<string, unknown> | undefined,
  feedback: IterationFeedback,
): Record<string, unknown> {
  return {
    ...(context ?? {}),
    [ITERATION_FEEDBACK_CONTEXT_KEY]: feedback,
  };
}
