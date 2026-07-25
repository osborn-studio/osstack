import type { ProbeItemV1, ProbeSeverityV1 } from "./types.js";

export interface ProbePriorityContextV1 {
  pack_priority_by_id?: Readonly<Record<string, number>>;
  pack_order_by_question_id?: Readonly<Record<string, number>>;
}

const originBoost: Readonly<Record<ProbeItemV1["origin"], number>> = {
  calibration: 1,
  static_pack: 2,
  blindspot: 4,
  interview_followup: 3,
  prototype_reaction: 0,
  restatement_diff: 0,
  mid_build: 0,
  manual: 0,
};

const quadrantBoost: Readonly<
  Record<ProbeItemV1["current_quadrant"], number>
> = {
  kk: 0,
  ku: 1,
  uk: 3,
  uu: 2,
};

export function deriveProbeSeverity(item: Pick<
  ProbeItemV1,
  "impact" | "irreversibility"
>): ProbeSeverityV1 {
  const risk = item.impact * item.irreversibility;
  if (risk >= 7) return "high";
  if (risk >= 4) return "medium";
  return "low";
}

export function computeProbePriority(item: ProbeItemV1): number {
  return (
    item.impact * item.irreversibility * 100 +
    item.uncertainty * 10 +
    (item.required ? 5 : 0) +
    originBoost[item.origin] +
    quadrantBoost[item.current_quadrant]
  );
}

export function compareProbeItems(
  left: ProbeItemV1,
  right: ProbeItemV1,
  context: ProbePriorityContextV1 = {},
): number {
  if (left.origin === "calibration" && right.origin !== "calibration") return -1;
  if (right.origin === "calibration" && left.origin !== "calibration") return 1;
  const priorityDifference =
    computeProbePriority(right) - computeProbePriority(left);
  if (priorityDifference !== 0) return priorityDifference;

  const leftPack = left.source_pack?.pack_id;
  const rightPack = right.source_pack?.pack_id;
  const leftPackPriority =
    leftPack === undefined
      ? 0
      : (context.pack_priority_by_id?.[leftPack] ?? 0);
  const rightPackPriority =
    rightPack === undefined
      ? 0
      : (context.pack_priority_by_id?.[rightPack] ?? 0);
  if (leftPackPriority !== rightPackPriority) {
    return rightPackPriority - leftPackPriority;
  }

  const leftPackOrder =
    context.pack_order_by_question_id?.[left.question_id] ??
    Number.MAX_SAFE_INTEGER;
  const rightPackOrder =
    context.pack_order_by_question_id?.[right.question_id] ??
    Number.MAX_SAFE_INTEGER;
  if (leftPackOrder !== rightPackOrder) return leftPackOrder - rightPackOrder;

  return left.item_id.localeCompare(right.item_id);
}

export function sortProbeItems(
  items: readonly ProbeItemV1[],
  context: ProbePriorityContextV1 = {},
): ProbeItemV1[] {
  return [...items].sort((left, right) =>
    compareProbeItems(left, right, context),
  );
}
