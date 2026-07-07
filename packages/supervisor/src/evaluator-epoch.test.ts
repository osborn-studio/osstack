import { describe, expect, it } from "vitest";
import { decideEvaluatorPromotion, markScoresForQuarantine } from "./evaluator-epoch.js";

describe("decideEvaluatorPromotion", () => {
  it("promotes a challenger that beats the incumbent by >= min_delta with enough anchors", () => {
    const decision = decideEvaluatorPromotion({
      incumbent_evaluator_id: "eval_v1",
      challenger_evaluator_id: "eval_v2",
      incumbent_correct: 8,
      incumbent_total: 10,
      challenger_correct: 9,
      challenger_total: 10,
    });
    expect(decision.promoted).toBe(true);
    expect(decision.anchor_accuracy_delta).toBe(0.1);
    expect(decision.reason).toMatch(/beats incumbent/);
  });

  it("rejects when the accuracy delta is below the threshold", () => {
    const decision = decideEvaluatorPromotion({
      incumbent_evaluator_id: "eval_v1",
      challenger_evaluator_id: "eval_v2",
      incumbent_correct: 8,
      incumbent_total: 10,
      challenger_correct: 8,
      challenger_total: 10,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.anchor_accuracy_delta).toBe(0);
    expect(decision.reason).toMatch(/below promotion threshold/);
  });

  it("does not promote when challenger coverage is below incumbent coverage", () => {
    const decision = decideEvaluatorPromotion({
      incumbent_evaluator_id: "eval_v1",
      challenger_evaluator_id: "eval_v2",
      incumbent_correct: 12,
      incumbent_total: 15,
      challenger_correct: 6,
      challenger_total: 6,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.reason).toMatch(/coverage/);
  });

  it("blocks auto-promotion and mentions human approval when anchors are below the minimum", () => {
    const decision = decideEvaluatorPromotion({
      incumbent_evaluator_id: "eval_v1",
      challenger_evaluator_id: "eval_v2",
      incumbent_correct: 3,
      incumbent_total: 5,
      challenger_correct: 5,
      challenger_total: 5,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.reason).toMatch(/insufficient anchor cases|human approval/i);
  });

  it("respects a custom min_delta", () => {
    const decision = decideEvaluatorPromotion({
      incumbent_evaluator_id: "eval_v1",
      challenger_evaluator_id: "eval_v2",
      incumbent_correct: 80,
      incumbent_total: 100,
      challenger_correct: 82,
      challenger_total: 100,
      min_delta: 0.05,
    });
    // +0.02 delta < 0.05 threshold → rejected.
    expect(decision.promoted).toBe(false);
  });
});

describe("markScoresForQuarantine", () => {
  it("quarantines only scores from the displaced evaluator", () => {
    const result = markScoresForQuarantine({
      displaced_evaluator_id: "eval_v1",
      score_records: [
        { score_id: "s1", evaluator_id: "eval_v1", status: "active" },
        { score_id: "s2", evaluator_id: "eval_v2", status: "active" },
        { score_id: "s3", evaluator_id: "eval_v1", status: "active" },
      ],
    });
    expect(result.find((r) => r.score_id === "s1")?.status).toBe("quarantined");
    expect(result.find((r) => r.score_id === "s2")?.status).toBe("active");
    expect(result.find((r) => r.score_id === "s3")?.status).toBe("quarantined");
  });
});
