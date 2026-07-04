// LoopBudget — first-class cost and stop controls.
//
// Budgets are opt-in: without one, the loop behaves exactly as before. With
// one, the engine (and daemon sessions) check usage after every cycle and
// stop with a structured `loop.budget.exceeded` event instead of running on.
// Budget stops are task/loop failures (exit code 2), not CLI crashes.

import { z } from "zod";

export const LoopBudget = z.object({
  max_cycles: z.number().int().positive().optional(),
  max_task_iterations: z.number().int().positive().optional(),
  max_runtime_ms: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_estimated_cost_usd: z.number().positive().optional(),
  /** Consecutive cycles without a successful task before the loop stops. */
  no_progress_limit: z.number().int().positive().default(2),
});
export type LoopBudget = z.infer<typeof LoopBudget>;

export const BudgetUsage = z.object({
  cycles: z.number(),
  runtime_ms: z.number(),
  /** Adapter token usage when adapters expose it; stays 0 otherwise. */
  tokens: z.number(),
  /** Estimated spend when cost data is available; stays 0 otherwise. */
  estimated_cost_usd: z.number(),
  /** Consecutive cycles that completed no successful task. */
  no_progress_cycles: z.number(),
});
export type BudgetUsage = z.infer<typeof BudgetUsage>;

export interface BudgetCheck {
  exceeded: boolean;
  /** Which budget field tripped, e.g. "max_runtime_ms". */
  limit?: string;
  reason?: string;
}

/** Budget status persisted into LoopState and surfaced in results/reports. */
export const LoopBudgetStatus = z.object({
  exceeded: z.boolean(),
  limit: z.string().optional(),
  reason: z.string().optional(),
  usage: BudgetUsage,
});
export type LoopBudgetStatus = z.infer<typeof LoopBudgetStatus>;

export function checkBudget(budget: LoopBudget, usage: BudgetUsage): BudgetCheck {
  if (budget.max_cycles !== undefined && usage.cycles >= budget.max_cycles) {
    return {
      exceeded: true,
      limit: "max_cycles",
      reason: `cycle budget reached: ${usage.cycles} of ${budget.max_cycles} cycles used`,
    };
  }
  if (budget.max_runtime_ms !== undefined && usage.runtime_ms >= budget.max_runtime_ms) {
    return {
      exceeded: true,
      limit: "max_runtime_ms",
      reason: `runtime budget exceeded: ${usage.runtime_ms} ms of ${budget.max_runtime_ms} ms used`,
    };
  }
  if (budget.max_tokens !== undefined && usage.tokens >= budget.max_tokens) {
    return {
      exceeded: true,
      limit: "max_tokens",
      reason: `token budget exceeded: ${usage.tokens} of ${budget.max_tokens} tokens used`,
    };
  }
  if (
    budget.max_estimated_cost_usd !== undefined
    && usage.estimated_cost_usd >= budget.max_estimated_cost_usd
  ) {
    return {
      exceeded: true,
      limit: "max_estimated_cost_usd",
      reason: `cost budget exceeded: $${usage.estimated_cost_usd.toFixed(4)} of $${budget.max_estimated_cost_usd.toFixed(4)} used`,
    };
  }
  if (usage.no_progress_cycles >= budget.no_progress_limit) {
    return {
      exceeded: true,
      limit: "no_progress_limit",
      reason: `no progress for ${usage.no_progress_cycles} consecutive cycle(s) (limit ${budget.no_progress_limit})`,
    };
  }
  return { exceeded: false };
}

/** Clamp per-task iterations to the budget's max_task_iterations, when set. */
export function clampTaskIterations(maxIterations: number, budget: LoopBudget | undefined): number {
  if (budget?.max_task_iterations === undefined) return maxIterations;
  return Math.min(maxIterations, budget.max_task_iterations);
}
