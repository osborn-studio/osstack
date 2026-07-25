import { createHash } from "node:crypto";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const ParityEvaluationRunV1Schema = z.object({
  arm: z.enum(["A", "B", "C"]),
  case_id: z.string().min(1),
  run_id: z.string().min(1),
  repetition: z.number().int().positive(),
  model_family: z.enum(["primary", "secondary", "deterministic"]),
  detected_defect_ids: z.array(z.string().min(1)),
  false_positive_ids: z.array(z.string().min(1)),
  finding_keys: z.array(z.string().min(1)),
  failure: z.boolean(),
  failure_reason: z.string().max(512).optional(),
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  wall_clock_ms: z.number().int().nonnegative(),
}).strict().superRefine((run, context) => {
  if ((run.arm === "C") !== (run.model_family === "deterministic")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "only C runs may be deterministic" });
  }
  if (!run.failure && run.failure_reason !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "successful run cannot have failure_reason" });
  }
});
export type ParityEvaluationRunV1 = z.infer<typeof ParityEvaluationRunV1Schema>;

export const ParityEvaluationInputV1Schema = z.object({
  schema_version: z.literal("1"),
  evaluation_kind: z.enum(["development", "hidden"]),
  protocol_sha256: sha256,
  corpus_commitment_sha256: sha256,
  custody_receipt: z.object({
    builder_id: z.string().min(1),
    custodian_id: z.string().min(1),
    injected_at: z.string().datetime(),
  }).strict(),
  cases: z.array(z.object({
    case_id: z.string().min(1),
    truth_defect_ids: z.array(z.string().min(1)).min(1),
  }).strict()).min(30),
  runs: z.array(ParityEvaluationRunV1Schema),
  edit_judgments: z.array(z.object({
    pair_id: z.string().min(1),
    case_id: z.string().min(1),
    model_family: z.enum(["primary", "secondary"]),
    judge_id: z.string().min(1),
    a_score: z.number().int().min(1).max(5),
    b_score: z.number().int().min(1).max(5),
  }).strict()),
  human_adjudications: z.array(z.object({
    pair_id: z.string().min(1),
    case_id: z.string().min(1),
    model_family: z.enum(["primary", "secondary"]),
    judge_id: z.string().min(1),
    a_score: z.number().int().min(1).max(5),
    b_score: z.number().int().min(1).max(5),
    reason: z.enum(["model_disagreement", "random_agreement_review"]),
  }).strict()),
  thresholds: z.object({
    recall_precision_margin: z.literal(-0.05),
    edit_quality_margin: z.literal(-0.25),
    alpha_minimum: z.literal(0.67),
    median_jaccard_minimum: z.literal(0.8),
    dimension_jaccard_minimum: z.literal(0.7),
    systemic_failure_maximum: z.literal(0.05),
  }).strict(),
  bootstrap: z.object({
    iterations: z.literal(10_000),
    seed: z.literal(20260718),
  }).strict(),
  power_analysis: z.object({
    method: z.literal("paired_case_normal_approximation"),
    alpha: z.literal(0.05),
    target_power: z.literal(0.8),
    assumed_case_sd: z.literal(0.12),
    noninferiority_margin: z.literal(0.05),
    required_cases: z.literal(46),
    required_defects: z.literal(184),
  }).strict(),
}).strict().superRefine((input, context) => {
  const caseIds = input.cases.map((entry) => entry.case_id);
  if (new Set(caseIds).size !== caseIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "evaluation case ids must be unique" });
  }
  const defectIds = input.cases.flatMap((entry) => entry.truth_defect_ids);
  if (new Set(defectIds).size !== defectIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "truth defect ids must be globally unique" });
  }
  if (new Set(input.runs.map((entry) => entry.run_id)).size !== input.runs.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "evaluation run ids must be unique" });
  }
  const knownCases = new Set(caseIds);
  if (input.runs.some((entry) => !knownCases.has(entry.case_id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "run references unknown case" });
  }
  if (input.edit_judgments.some((entry) => !knownCases.has(entry.case_id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "judgment references unknown case" });
  }
  const agreementPairs: string[] = [];
  for (const caseId of caseIds) {
    const judgments = input.edit_judgments.filter((entry) => entry.case_id === caseId);
    const pairIds = [...new Set(judgments.map((entry) => entry.pair_id))];
    if (pairIds.length !== 5) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `case ${caseId} requires exactly five blinded diff pairs`,
      });
    }
    const pairFamilies = pairIds.map((pairId) =>
      judgments.find((entry) => entry.pair_id === pairId)?.model_family
    );
    if (
      pairFamilies.filter((family) => family === "primary").length !== 3
      || pairFamilies.filter((family) => family === "secondary").length !== 2
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `case ${caseId} requires three primary and two secondary diff pairs`,
      });
    }
    for (const pairId of pairIds) {
      const pairJudgments = judgments.filter((entry) => entry.pair_id === pairId);
      if (
        pairJudgments.length !== 2
        || new Set(pairJudgments.map((entry) => entry.judge_id)).size !== 2
        || new Set(pairJudgments.map((entry) => entry.model_family)).size !== 1
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pair ${pairId} requires exactly two distinct model judges`,
        });
      }
      if (pairJudgments.some((entry) => entry.judge_id === input.custody_receipt.builder_id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `pair ${pairId} uses builder as judge` });
      }
      const adjudications = input.human_adjudications.filter((entry) => entry.pair_id === pairId);
      const disagreement = new Set(pairJudgments.map((entry) => `${entry.a_score}/${entry.b_score}`)).size > 1;
      if (disagreement) {
        if (adjudications.length !== 1 || adjudications[0]?.reason !== "model_disagreement") {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `pair ${pairId} disagreement requires human adjudication` });
        }
      } else {
        agreementPairs.push(pairId);
        if (adjudications.some((entry) => entry.reason !== "random_agreement_review")) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `pair ${pairId} has invalid agreement review reason` });
        }
      }
    }
  }
  const reviewedAgreements = new Set(input.human_adjudications
    .filter((entry) => entry.reason === "random_agreement_review")
    .map((entry) => entry.pair_id));
  const requiredAgreementReviews = [...agreementPairs]
    .sort((left, right) => createHash("sha256")
      .update(`${input.bootstrap.seed}|human-review|${left}`)
      .digest("hex")
      .localeCompare(createHash("sha256")
        .update(`${input.bootstrap.seed}|human-review|${right}`)
        .digest("hex")))
    .slice(0, Math.ceil(agreementPairs.length * 0.2));
  if (requiredAgreementReviews.some((pairId) => !reviewedAgreements.has(pairId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic 20% agreement review sample is incomplete" });
  }
  const pairCases = new Map(input.edit_judgments.map((entry) => [entry.pair_id, entry.case_id]));
  if (input.human_adjudications.some((entry) => {
    const modelJudges = input.edit_judgments
      .filter((judgment) => judgment.pair_id === entry.pair_id)
      .map((judgment) => judgment.judge_id);
    return !knownCases.has(entry.case_id)
      || pairCases.get(entry.pair_id) !== entry.case_id
      || input.edit_judgments.some((judgment) =>
        judgment.pair_id === entry.pair_id && judgment.model_family !== entry.model_family
      )
      || entry.judge_id === input.custody_receipt.builder_id
      || modelJudges.includes(entry.judge_id);
  })) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid human adjudicator or case" });
  }
  if (new Set(input.human_adjudications.map((entry) => entry.pair_id)).size !== input.human_adjudications.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "at most one human adjudication is allowed per pair" });
  }
});
export type ParityEvaluationInputV1 = z.infer<typeof ParityEvaluationInputV1Schema>;

interface Estimate {
  point: number;
  lower_95: number;
  upper_95: number;
}

export interface ParityEvaluationScoreV1 {
  schema_version: "1";
  status: "passed" | "failed";
  metrics: {
    recall_difference: Estimate;
    precision_difference: Estimate;
    edit_quality_difference: Estimate;
    krippendorff_alpha: number;
    median_semantic_jaccard: number;
    minimum_dimension_jaccard: number;
    systemic_failure_rate: number;
  };
  gates: Array<{ gate: string; passed: boolean; observed: number | string; required: string }>;
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index]!;
}

function clusterBootstrapDifference(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
  iterations: number,
  seed: number,
): Estimate {
  const caseIds = [...a.keys()].filter((caseId) => b.has(caseId)).sort();
  const point = mean(caseIds.map((caseId) => b.get(caseId)! - a.get(caseId)!));
  if (caseIds.length === 0) return { point, lower_95: -1, upper_95: 1 };
  const random = mulberry32(seed);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const differences: number[] = [];
    for (let index = 0; index < caseIds.length; index += 1) {
      const selected = caseIds[Math.floor(random() * caseIds.length)]!;
      differences.push(b.get(selected)! - a.get(selected)!);
    }
    samples.push(mean(differences));
  }
  return {
    point,
    lower_95: percentile(samples, 0.025),
    upper_95: percentile(samples, 0.975),
  };
}

function metricByCase(
  input: ParityEvaluationInputV1,
  arm: "A" | "B",
  metric: "recall" | "precision",
  family?: "primary" | "secondary",
): Map<string, number> {
  const result = new Map<string, number>();
  for (const caseEntry of input.cases) {
    const truth = new Set(caseEntry.truth_defect_ids);
    const runs = input.runs.filter((run) =>
      run.arm === arm
      && run.case_id === caseEntry.case_id
      && (family === undefined || run.model_family === family)
    );
    const values = runs.map((run) => {
      if (run.failure) return 0;
      const detected = new Set(run.detected_defect_ids);
      const truePositive = [...detected].filter((id) => truth.has(id)).length;
      if (metric === "recall") {
        return truth.size === 0 ? 1 : truePositive / truth.size;
      }
      const denominator = detected.size + new Set(run.false_positive_ids).size;
      return denominator === 0 ? 1 : truePositive / denominator;
    });
    result.set(caseEntry.case_id, values.length === 0 ? 0 : mean(values));
  }
  return result;
}

function qualityByCase(
  input: ParityEvaluationInputV1,
  side: "a_score" | "b_score",
  family: "primary" | "secondary",
): Map<string, number> {
  return new Map(input.cases.map((caseEntry) => {
    const judgments = input.edit_judgments.filter((entry) =>
      entry.case_id === caseEntry.case_id && entry.model_family === family
    );
    const pairIds = [...new Set(judgments.map((entry) => entry.pair_id))];
    const values = pairIds.map((pairId) => {
      const human = input.human_adjudications.find((entry) => entry.pair_id === pairId);
      if (human !== undefined) return human[side];
      return mean(judgments.filter((entry) => entry.pair_id === pairId).map((entry) => entry[side]));
    });
    return [caseEntry.case_id, mean(values)];
  }));
}

function krippendorffAlpha(input: ParityEvaluationInputV1): number {
  const groups = new Map<string, number[]>();
  for (const judgment of input.edit_judgments) {
    const values = groups.get(judgment.pair_id) ?? [];
    values.push(judgment.b_score - judgment.a_score);
    groups.set(judgment.pair_id, values);
  }
  const observedDistances = [...groups.values()].flatMap((values) => {
    const pairs: number[] = [];
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        pairs.push(((values[left]! - values[right]!) / 8) ** 2);
      }
    }
    return pairs;
  });
  const all = [...groups.values()].flat();
  const expectedDistances: number[] = [];
  for (let left = 0; left < all.length; left += 1) {
    for (let right = left + 1; right < all.length; right += 1) {
      expectedDistances.push(((all[left]! - all[right]!) / 8) ** 2);
    }
  }
  const expected = mean(expectedDistances);
  if (expected === 0) return mean(observedDistances) === 0 ? 1 : 0;
  return 1 - mean(observedDistances) / expected;
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  return [...a].filter((value) => b.has(value)).length / union.size;
}

function stability(input: ParityEvaluationInputV1): {
  median: number;
  minimumDimension: number;
} {
  const runs = input.runs.filter((run) => run.arm === "B");
  const allScores: number[] = [];
  const byDimension = new Map<string, number[]>();
  for (const caseEntry of input.cases) {
    const caseRuns = runs.filter((run) => run.case_id === caseEntry.case_id);
    for (let left = 0; left < caseRuns.length; left += 1) {
      for (let right = left + 1; right < caseRuns.length; right += 1) {
        const leftRun = caseRuns[left]!;
        const rightRun = caseRuns[right]!;
        if (leftRun.model_family !== rightRun.model_family) continue;
        const score = jaccard(leftRun.finding_keys, rightRun.finding_keys);
        allScores.push(score);
        const dimensions = new Set(
          [...leftRun.finding_keys, ...rightRun.finding_keys]
            .map((value) => value.split(":", 1)[0] ?? "unknown"),
        );
        for (const dimension of dimensions) {
          const values = byDimension.get(dimension) ?? [];
          values.push(jaccard(
            leftRun.finding_keys.filter((value) => value.startsWith(`${dimension}:`)),
            rightRun.finding_keys.filter((value) => value.startsWith(`${dimension}:`)),
          ));
          byDimension.set(dimension, values);
        }
      }
    }
  }
  return {
    median: percentile(allScores, 0.5),
    minimumDimension: Math.min(1, ...[...byDimension.values()].map((values) => percentile(values, 0.5))),
  };
}

function completeRuns(input: ParityEvaluationInputV1): boolean {
  return input.cases.every((caseEntry) => {
    const runs = input.runs.filter((run) => run.case_id === caseEntry.case_id);
    return runs.filter((run) => run.arm === "A" && run.model_family === "primary").length === 3
      && runs.filter((run) => run.arm === "A" && run.model_family === "secondary").length === 2
      && runs.filter((run) => run.arm === "B" && run.model_family === "primary").length === 3
      && runs.filter((run) => run.arm === "B" && run.model_family === "secondary").length === 2
      && runs.filter((run) => run.arm === "C").length === 2;
  });
}

function deterministicC(input: ParityEvaluationInputV1): boolean {
  return input.cases.every((caseEntry) => {
    const runs = input.runs.filter((run) =>
      run.arm === "C" && run.case_id === caseEntry.case_id && !run.failure
    );
    return runs.length === 2
      && JSON.stringify(runs[0]!.finding_keys) === JSON.stringify(runs[1]!.finding_keys)
      && JSON.stringify(runs[0]!.detected_defect_ids)
        === JSON.stringify(runs[1]!.detected_defect_ids);
  });
}

export function scoreParityEvaluationV1(
  rawInput: ParityEvaluationInputV1,
): ParityEvaluationScoreV1 {
  const input = ParityEvaluationInputV1Schema.parse(rawInput);
  const recall = clusterBootstrapDifference(
    metricByCase(input, "A", "recall", "primary"),
    metricByCase(input, "B", "recall", "primary"),
    input.bootstrap.iterations,
    input.bootstrap.seed,
  );
  const precision = clusterBootstrapDifference(
    metricByCase(input, "A", "precision", "primary"),
    metricByCase(input, "B", "precision", "primary"),
    input.bootstrap.iterations,
    input.bootstrap.seed + 1,
  );
  const quality = clusterBootstrapDifference(
    qualityByCase(input, "a_score", "primary"),
    qualityByCase(input, "b_score", "primary"),
    input.bootstrap.iterations,
    input.bootstrap.seed + 2,
  );
  const alpha = krippendorffAlpha(input);
  const stable = stability(input);
  const relevantRuns = input.runs.filter((run) => run.arm === "A" || run.arm === "B");
  const failureRate = relevantRuns.length === 0
    ? 1
    : relevantRuns.filter((run) => run.failure).length / relevantRuns.length;
  const hiddenDefects = new Set(input.cases.flatMap((entry) => entry.truth_defect_ids)).size;
  const secondaryRecall = clusterBootstrapDifference(
    metricByCase(input, "A", "recall", "secondary"),
    metricByCase(input, "B", "recall", "secondary"),
    input.bootstrap.iterations,
    input.bootstrap.seed + 4,
  );
  const secondaryPrecision = clusterBootstrapDifference(
    metricByCase(input, "A", "precision", "secondary"),
    metricByCase(input, "B", "precision", "secondary"),
    input.bootstrap.iterations,
    input.bootstrap.seed + 5,
  );
  const secondaryQuality = clusterBootstrapDifference(
    qualityByCase(input, "a_score", "secondary"),
    qualityByCase(input, "b_score", "secondary"),
    input.bootstrap.iterations,
    input.bootstrap.seed + 6,
  );
  const gates: ParityEvaluationScoreV1["gates"] = [
    {
      gate: "hidden_protocol",
      passed: input.evaluation_kind === "hidden",
      observed: input.evaluation_kind,
      required: "hidden",
    },
    {
      gate: "independent_custody",
      passed: input.custody_receipt.builder_id !== input.custody_receipt.custodian_id,
      observed: `${input.custody_receipt.builder_id}/${input.custody_receipt.custodian_id}`,
      required: "builder_id != custodian_id",
    },
    {
      gate: "powered_hidden_corpus",
      passed: input.cases.length >= input.power_analysis.required_cases
        && hiddenDefects >= input.power_analysis.required_defects,
      observed: `${input.cases.length} cases/${hiddenDefects} defects`,
      required: `>=${input.power_analysis.required_cases} cases and >=${input.power_analysis.required_defects} defects`,
    },
    {
      gate: "complete_three_arm_runs",
      passed: completeRuns(input),
      observed: input.runs.length,
      required: "A/B 3 primary + 2 secondary and C x2 per case",
    },
    {
      gate: "recall_noninferiority",
      passed: recall.lower_95 >= input.thresholds.recall_precision_margin,
      observed: recall.lower_95,
      required: `lower95 >= ${input.thresholds.recall_precision_margin}`,
    },
    {
      gate: "precision_noninferiority",
      passed: precision.lower_95 >= input.thresholds.recall_precision_margin,
      observed: precision.lower_95,
      required: `lower95 >= ${input.thresholds.recall_precision_margin}`,
    },
    {
      gate: "edit_quality_noninferiority",
      passed: quality.lower_95 >= input.thresholds.edit_quality_margin,
      observed: quality.lower_95,
      required: `lower95 >= ${input.thresholds.edit_quality_margin}`,
    },
    {
      gate: "judge_agreement",
      passed: alpha >= input.thresholds.alpha_minimum,
      observed: alpha,
      required: `alpha >= ${input.thresholds.alpha_minimum}`,
    },
    {
      gate: "semantic_stability",
      passed: stable.median >= input.thresholds.median_jaccard_minimum
        && stable.minimumDimension >= input.thresholds.dimension_jaccard_minimum,
      observed: `${stable.median}/${stable.minimumDimension}`,
      required: `median >= ${input.thresholds.median_jaccard_minimum}; each dimension >= ${input.thresholds.dimension_jaccard_minimum}`,
    },
    {
      gate: "model_family_direction",
      passed: secondaryRecall.point >= input.thresholds.recall_precision_margin
        && secondaryPrecision.point >= input.thresholds.recall_precision_margin
        && secondaryQuality.point >= input.thresholds.edit_quality_margin,
      observed: `${secondaryRecall.point}/${secondaryPrecision.point}/${secondaryQuality.point}`,
      required: "secondary-family recall/precision/edit direction matches the primary conclusion",
    },
    {
      gate: "systemic_failures",
      passed: failureRate <= input.thresholds.systemic_failure_maximum,
      observed: failureRate,
      required: `<= ${input.thresholds.systemic_failure_maximum}`,
    },
    {
      gate: "mechanical_reproducibility",
      passed: deterministicC(input),
      observed: deterministicC(input) ? "bit-for-bit" : "mismatch",
      required: "two C-arm runs identical per case",
    },
  ];
  return {
    schema_version: "1",
    status: gates.every((gate) => gate.passed) ? "passed" : "failed",
    metrics: {
      recall_difference: recall,
      precision_difference: precision,
      edit_quality_difference: quality,
      krippendorff_alpha: alpha,
      median_semantic_jaccard: stable.median,
      minimum_dimension_jaccard: stable.minimumDimension,
      systemic_failure_rate: failureRate,
    },
    gates,
  };
}
