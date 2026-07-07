// Evaluator epochs — the Red Queen control. Evaluators are artifacts too, so
// a challenger may only replace an incumbent at an epoch boundary, and only if
// it demonstrably beats the incumbent on anchor cases with enough coverage.
// When an evaluator is displaced, scores that depended on it are quarantined.

const DEFAULT_MIN_DELTA = 0.05;
const DEFAULT_MIN_ANCHOR_CASES = 10;

export interface EvaluatorPromotionInput {
  incumbent_evaluator_id: string;
  challenger_evaluator_id: string;
  incumbent_correct: number;
  incumbent_total: number;
  challenger_correct: number;
  challenger_total: number;
  min_delta?: number;
  min_anchor_cases?: number;
}

export interface EvaluatorPromotionDecision {
  promoted: boolean;
  anchor_accuracy_delta: number;
  reason: string;
}

export function decideEvaluatorPromotion(input: EvaluatorPromotionInput): EvaluatorPromotionDecision {
  const minDelta = input.min_delta ?? DEFAULT_MIN_DELTA;
  const minAnchorCases = input.min_anchor_cases ?? DEFAULT_MIN_ANCHOR_CASES;

  const incumbentAccuracy = accuracy(input.incumbent_correct, input.incumbent_total);
  const challengerAccuracy = accuracy(input.challenger_correct, input.challenger_total);
  const delta = round4(challengerAccuracy - incumbentAccuracy);

  // A challenger tested on fewer cases than the incumbent has not earned trust.
  if (input.challenger_total < input.incumbent_total) {
    return {
      promoted: false,
      anchor_accuracy_delta: delta,
      reason: `challenger coverage (${input.challenger_total}) below incumbent coverage (${input.incumbent_total}); not promoted`,
    };
  }

  // Too few anchor cases to trust any promotion automatically.
  if (input.challenger_total < minAnchorCases) {
    return {
      promoted: false,
      anchor_accuracy_delta: delta,
      reason: `insufficient anchor cases (${input.challenger_total} < ${minAnchorCases}); promotion requires human approval`,
    };
  }

  if (delta >= minDelta) {
    return {
      promoted: true,
      anchor_accuracy_delta: delta,
      reason: `challenger accuracy ${challengerAccuracy.toFixed(2)} beats incumbent ${incumbentAccuracy.toFixed(2)} by ${delta.toFixed(2)} (>= ${minDelta})`,
    };
  }

  return {
    promoted: false,
    anchor_accuracy_delta: delta,
    reason: `accuracy delta ${delta.toFixed(2)} below promotion threshold ${minDelta}; challenger rejected`,
  };
}

export interface ScoreRecord {
  score_id: string;
  evaluator_id: string;
  status: "active" | "quarantined";
}

/**
 * Quarantine only the scores produced by a displaced evaluator. Scores from
 * other evaluators are returned unchanged so unrelated history stays trusted.
 */
export function markScoresForQuarantine(input: {
  displaced_evaluator_id: string;
  score_records: ScoreRecord[];
}): ScoreRecord[] {
  return input.score_records.map((record) =>
    record.evaluator_id === input.displaced_evaluator_id
      ? { ...record, status: "quarantined" }
      : { ...record }
  );
}

function accuracy(correct: number, total: number): number {
  if (total <= 0) return 0;
  return correct / total;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
