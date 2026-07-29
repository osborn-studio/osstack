import { z } from "zod";
import { DeliveryBudget, type DeliveryBudget as DeliveryBudgetType } from "./types.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const UniqueStrings = z
  .array(z.string().min(1))
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "values must not contain duplicates",
      });
    }
  });

export interface AttemptProgress {
  finding_fingerprints: string[];
  changed_files_sha256: string;
  verification_sha256: string;
  failed_commands: string[];
  acceptance_score: number;
}

export const AttemptProgressSchema: z.ZodType<AttemptProgress> = z
  .object({
    finding_fingerprints: UniqueStrings,
    changed_files_sha256: Sha256,
    verification_sha256: Sha256,
    failed_commands: UniqueStrings,
    acceptance_score: z.number().min(0).max(1).finite(),
  })
  .strict();

export interface AttemptProgressComparison {
  improved: boolean;
  reasons: string[];
}

function sortedSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function compareAttemptProgress(
  previousValue: AttemptProgress,
  currentValue: AttemptProgress,
): AttemptProgressComparison {
  const previous = AttemptProgressSchema.parse(previousValue);
  const current = AttemptProgressSchema.parse(currentValue);
  const previousFindings = new Set(previous.finding_fingerprints);
  const currentFindings = new Set(current.finding_fingerprints);
  const removedFindings = [...previousFindings]
    .filter((fingerprint) => !currentFindings.has(fingerprint))
    .sort();
  const evidenceChanged =
    previous.changed_files_sha256 !== current.changed_files_sha256 &&
    previous.verification_sha256 !== current.verification_sha256;
  const scoreIncreased =
    current.acceptance_score > previous.acceptance_score;

  const improvements = [
    ...removedFindings.map(
      (fingerprint) => `blocking_fingerprint_removed:${fingerprint}`,
    ),
    ...(evidenceChanged
      ? ["changed_files_and_verification_changed"]
      : []),
    ...(scoreIncreased ? ["acceptance_score_increased"] : []),
  ];
  if (improvements.length > 0) {
    return { improved: true, reasons: improvements };
  }

  const repeatedFailedCommands =
    current.failed_commands.length > 0 &&
    JSON.stringify(sortedSet(previous.failed_commands)) ===
      JSON.stringify(sortedSet(current.failed_commands));
  return {
    improved: false,
    reasons: [
      "blocking_findings_unchanged",
      "changed_files_or_verification_unchanged",
      ...(repeatedFailedCommands ? ["failed_commands_repeated"] : []),
      "acceptance_score_not_increased",
    ],
  };
}

export type ProgressBudgetLimit =
  | "max_builder_iterations"
  | "max_review_rounds"
  | "max_wall_time_ms"
  | "max_no_progress_rounds";

export interface ProgressBudgetInput {
  budget: DeliveryBudgetType;
  builder_iterations: number;
  review_rounds: number;
  elapsed_ms: number;
  prior_no_progress_rounds: number;
  previous?: AttemptProgress;
  current: AttemptProgress;
}

export interface ProgressBudgetEvaluation {
  exhausted: boolean;
  improved: boolean;
  no_progress_rounds: number;
  reasons: string[];
  limit?: ProgressBudgetLimit;
}

const ProgressBudgetInputSchema = z
  .object({
    budget: DeliveryBudget,
    builder_iterations: z.number().int().nonnegative(),
    review_rounds: z.number().int().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
    prior_no_progress_rounds: z.number().int().nonnegative(),
    previous: AttemptProgressSchema.optional(),
    current: AttemptProgressSchema,
  })
  .strict();

function exhaustedReason(
  limit: ProgressBudgetLimit,
  input: z.infer<typeof ProgressBudgetInputSchema>,
  noProgressRounds: number,
): string {
  const used =
    limit === "max_builder_iterations"
      ? input.builder_iterations
      : limit === "max_review_rounds"
        ? input.review_rounds
        : limit === "max_wall_time_ms"
          ? input.elapsed_ms
          : noProgressRounds;
  return `${limit} exhausted: ${used} of ${input.budget[limit]}`;
}

export function evaluateProgressBudget(
  value: ProgressBudgetInput,
): ProgressBudgetEvaluation {
  const input = ProgressBudgetInputSchema.parse(value);
  const comparison =
    input.previous === undefined
      ? { improved: true, reasons: ["baseline_attempt"] }
      : compareAttemptProgress(input.previous, input.current);
  const noProgressRounds = comparison.improved
    ? 0
    : input.prior_no_progress_rounds + 1;

  const limit: ProgressBudgetLimit | undefined =
    input.elapsed_ms >= input.budget.max_wall_time_ms
      ? "max_wall_time_ms"
      : input.builder_iterations >= input.budget.max_builder_iterations
        ? "max_builder_iterations"
        : input.review_rounds >= input.budget.max_review_rounds
          ? "max_review_rounds"
          : noProgressRounds >= input.budget.max_no_progress_rounds
            ? "max_no_progress_rounds"
            : undefined;

  if (limit === undefined) {
    return {
      exhausted: false,
      improved: comparison.improved,
      no_progress_rounds: noProgressRounds,
      reasons: comparison.reasons,
    };
  }
  return {
    exhausted: true,
    improved: comparison.improved,
    no_progress_rounds: noProgressRounds,
    reasons: [
      ...comparison.reasons,
      exhaustedReason(limit, input, noProgressRounds),
    ],
    limit,
  };
}
