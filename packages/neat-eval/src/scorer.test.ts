import { describe, expect, it } from "vitest";
import {
  scoreParityEvaluationV1,
  type ParityEvaluationInputV1,
} from "./scorer.js";

function passingInput(): ParityEvaluationInputV1 {
  const cases = Array.from({ length: 46 }, (_value, index) =>
    `hidden-${String(index + 1).padStart(3, "0")}`
  );
  const truth = cases.flatMap((caseId) =>
    Array.from({ length: 4 }, (_value, index) => `${caseId}-d${index + 1}`)
  );
  const runs = ["primary-1", "primary-2", "primary-3", "secondary-1", "secondary-2"];
  return {
    schema_version: "1",
    evaluation_kind: "hidden",
    protocol_sha256: "a".repeat(64),
    corpus_commitment_sha256: "b".repeat(64),
    custody_receipt: {
      builder_id: "builder",
      custodian_id: "independent-custodian",
      injected_at: "2026-07-18T00:00:00.000Z",
    },
    cases: cases.map((caseId) => ({
      case_id: caseId,
      truth_defect_ids: truth.filter((id) => id.startsWith(`${caseId}-`)),
    })),
    runs: [
      ...["A", "B"].flatMap((arm) =>
      cases.flatMap((caseId) => runs.map((runId) => ({
        arm: arm as "A" | "B",
        case_id: caseId,
        run_id: `${arm}-${caseId}-${runId}`,
        repetition: Number(runId.at(-1)),
        model_family: runId.startsWith("primary")
          ? "primary" as const
          : "secondary" as const,
        detected_defect_ids: truth.filter((id) => id.startsWith(`${caseId}-`)),
        false_positive_ids: [],
        finding_keys: ["narrative:AGENTS.md"],
        failure: false,
        tokens: 100,
        calls: 1,
        wall_clock_ms: 10,
      })))),
      ...cases.flatMap((caseId) => [1, 2].map((runId) => ({
        arm: "C" as const,
        case_id: caseId,
        run_id: `C-${caseId}-${runId}`,
        repetition: runId,
        model_family: "deterministic" as const,
        detected_defect_ids: [],
        false_positive_ids: [],
        finding_keys: ["mechanical:stable"],
        failure: false,
        tokens: 0,
        calls: 0,
        wall_clock_ms: 1,
      }))),
    ],
    edit_judgments: cases.flatMap((caseId) => Array.from({ length: 5 }, (_value, pairIndex) =>
      ["judge-1", "judge-2"].map((judgeId) => ({
        pair_id: `${caseId}-pair-${pairIndex + 1}`,
        case_id: caseId,
        model_family: pairIndex < 3 ? "primary" as const : "secondary" as const,
        judge_id: judgeId,
        a_score: 4,
        b_score: 4,
      }))
    ).flat()),
    human_adjudications: cases.flatMap((caseId) => Array.from({ length: 5 }, (_value, pairIndex) => ({
      pair_id: `${caseId}-pair-${pairIndex + 1}`,
      case_id: caseId,
      model_family: pairIndex < 3 ? "primary" as const : "secondary" as const,
      judge_id: "human-judge",
      a_score: 4,
      b_score: 4,
      reason: "random_agreement_review" as const,
    }))),
    thresholds: {
      recall_precision_margin: -0.05,
      edit_quality_margin: -0.25,
      alpha_minimum: 0.67,
      median_jaccard_minimum: 0.8,
      dimension_jaccard_minimum: 0.7,
      systemic_failure_maximum: 0.05,
    },
    bootstrap: { iterations: 10_000, seed: 20260718 },
    power_analysis: {
      method: "paired_case_normal_approximation",
      alpha: 0.05,
      target_power: 0.8,
      assumed_case_sd: 0.12,
      noninferiority_margin: 0.05,
      required_cases: 46,
      required_defects: 184,
    },
  };
}

describe("semantic parity scorer", () => {
  it("passes only a powered hidden evaluation with independent custody and non-inferior B", () => {
    const score = scoreParityEvaluationV1(passingInput());
    expect(score.status).toBe("passed");
    expect(score.gates.every((gate) => gate.passed)).toBe(true);
    expect(score.metrics.recall_difference.point).toBe(0);
    expect(score.metrics.precision_difference.point).toBe(0);
  });

  it("fails closed for self-custody or provider failures instead of moving thresholds", () => {
    const input = passingInput();
    input.custody_receipt.custodian_id = "builder";
    input.runs[0]!.failure = true;
    const score = scoreParityEvaluationV1(input);
    expect(score.status).toBe("failed");
    expect(score.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: "independent_custody", passed: false }),
    ]));
  });

  it("rejects changed preregistered thresholds", () => {
    const input = passingInput();
    (input.thresholds.recall_precision_margin as number) = -0.5;
    expect(() => scoreParityEvaluationV1(input)).toThrow();
  });

  it("keeps failed provider runs in the recall denominator", () => {
    const input = passingInput();
    for (const run of input.runs) {
      if (run.arm === "B" && run.model_family === "primary" && run.repetition === 1) {
        run.failure = true;
      }
    }
    const score = scoreParityEvaluationV1(input);
    expect(score.status).toBe("failed");
    expect(score.metrics.recall_difference.point).toBeLessThan(-0.3);
  });
});
