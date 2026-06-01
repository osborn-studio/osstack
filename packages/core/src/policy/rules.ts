// Default policy rule set (S3, hand-coded).
//
// Order is conventionally lowest → highest priority but the engine just sums
// scores. Tune values empirically once we have enough runs in the DB.

import type { PolicyRule } from "./types.js";

/** Prefer adapters with high historical success rate on this kind. */
export const successRateRule: PolicyRule = {
  id: "success_rate",
  description: "Adds up to +50 for agents with high completion rate on this kind",
  score(task, candidate, history) {
    const total = history.totalRuns(candidate.agent_id, task.kind);
    if (total === 0) return null; // no data → abstain
    const completed = history.completedRuns(candidate.agent_id, task.kind);
    const rate = completed / total;
    return {
      value: rate * 50,
      reason: `success_rate=${(rate * 100).toFixed(0)}% over ${total} runs`,
    };
  },
};

/** Penalize adapters that have failed recently. */
export const recentFailuresRule: PolicyRule = {
  id: "recent_failures",
  description: "Subtracts 15 per failure in the last 24h on this kind, capped at -45",
  score(_task, candidate, history) {
    const fails = history.recentFailures(candidate.agent_id, _task.kind, 1);
    if (fails === 0) return null;
    const value = -Math.min(fails * 15, 45);
    return { value, reason: `${fails} failure(s) in last 24h` };
  },
};

/** Cheaper tier wins all else equal. low=+15, mid=+5, high=0. */
export const costBiasRule: PolicyRule = {
  id: "cost_bias",
  description: "Bias toward lower-cost tier when scores would otherwise tie",
  score(_task, candidate) {
    const bias = candidate.cost_tier === "low" ? 15 : candidate.cost_tier === "mid" ? 5 : 0;
    if (bias === 0) return null;
    return { value: bias, reason: `cost_tier=${candidate.cost_tier}` };
  },
};

/** Reward adapters whose capability description matches the task kind exactly. */
export const exactCapabilityRule: PolicyRule = {
  id: "exact_capability",
  description: "+10 when adapter has a capability whose id ends in the task's kind",
  score(task, candidate) {
    const matches = candidate.capabilities.some((c) => c.id.endsWith(task.kind));
    if (!matches) return null;
    return { value: 10, reason: `has ${task.kind} capability` };
  },
};

/** Sanity floor: at least one positive score so first-time adapters can be picked. */
export const cleanSlateRule: PolicyRule = {
  id: "clean_slate",
  description: "+5 when an adapter has zero prior runs on this kind (cold-start nudge)",
  score(task, candidate, history) {
    if (history.totalRuns(candidate.agent_id, task.kind) !== 0) return null;
    return { value: 5, reason: "no prior runs (cold-start exploration)" };
  },
};

export const DEFAULT_RULES: readonly PolicyRule[] = [
  successRateRule,
  recentFailuresRule,
  costBiasRule,
  exactCapabilityRule,
  cleanSlateRule,
];
