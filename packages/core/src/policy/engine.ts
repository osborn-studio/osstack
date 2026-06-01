// Policy engine — collects scores from all registered rules and ranks
// candidate adapters for a given task.
//
// Per E2: rules are TS functions; engine sums their scores and picks the
// highest. Ties broken by lowest cost_tier, then by candidate.agent_id.
//
// Handoff gate (plan v0.6 §F4-precursor): if the recent failure rate for
// the chosen winner is above HANDOFF_FAILURE_RATE_THRESHOLD over the
// HANDOFF_LOOKBACK_DAYS window, the engine flips handoff.triggered=true.
// The daemon then asks for human approval before dispatch.

import type {
  PolicyCandidate, PolicyDecision, PolicyHistory, PolicyOutcome,
  PolicyRule, PolicyScore, PolicyTask,
} from "./types.js";

const TIER_ORDER: Record<PolicyCandidate["cost_tier"], number> = { low: 0, mid: 1, high: 2 };

/** Default handoff thresholds. Override per-engine if your workload differs. */
export const HANDOFF_LOOKBACK_DAYS = 7;
export const HANDOFF_FAILURE_RATE_THRESHOLD = 0.5;
/** Minimum runs in the window before the handoff gate can trigger (avoids cold-start false-positives). */
export const HANDOFF_MIN_RUNS = 3;

export interface PolicyEngineOptions {
  rules?: ReadonlyArray<PolicyRule>;
  handoff?: {
    lookback_days?: number;
    failure_rate_threshold?: number;
    min_runs?: number;
  };
}

export class PolicyEngine {
  readonly rules: ReadonlyArray<PolicyRule>;
  readonly handoffLookbackDays: number;
  readonly handoffFailureRateThreshold: number;
  readonly handoffMinRuns: number;

  constructor(opts: PolicyEngineOptions = {}) {
    this.rules = opts.rules ?? [];
    this.handoffLookbackDays = opts.handoff?.lookback_days ?? HANDOFF_LOOKBACK_DAYS;
    this.handoffFailureRateThreshold = opts.handoff?.failure_rate_threshold ?? HANDOFF_FAILURE_RATE_THRESHOLD;
    this.handoffMinRuns = opts.handoff?.min_runs ?? HANDOFF_MIN_RUNS;
  }

  decide(
    task: PolicyTask,
    candidates: ReadonlyArray<PolicyCandidate>,
    history: PolicyHistory,
  ): PolicyDecision {
    const outcomes: PolicyOutcome[] = candidates.map((c) => {
      const breakdown: Array<{ rule_id: string; value: number; reason: string }> = [];
      let total = 0;
      for (const rule of this.rules) {
        let score: PolicyScore | null;
        try {
          score = rule.score(task, c, history);
        } catch (err) {
          // A throwing rule must not break the engine. Record a 0-score
          // breakdown entry so operators can see which rule misfired.
          breakdown.push({
            rule_id: rule.id,
            value: 0,
            reason: `rule_error: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        if (score === null) continue;
        breakdown.push({ rule_id: rule.id, value: score.value, reason: score.reason });
        total += score.value;
      }
      return { candidate: c, total, breakdown };
    });

    outcomes.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      const tierA = TIER_ORDER[a.candidate.cost_tier];
      const tierB = TIER_ORDER[b.candidate.cost_tier];
      if (tierA !== tierB) return tierA - tierB;
      return a.candidate.agent_id.localeCompare(b.candidate.agent_id);
    });

    const winner = outcomes[0] ?? null;
    const handoff = winner !== null
      ? this.evaluateHandoff(task, winner.candidate, history)
      : { triggered: false };

    return { winner, ranked: outcomes, handoff };
  }

  private evaluateHandoff(
    task: PolicyTask,
    candidate: PolicyCandidate,
    history: PolicyHistory,
  ): PolicyDecision["handoff"] {
    const total = history.totalRuns(candidate.agent_id, task.kind);
    if (total < this.handoffMinRuns) return { triggered: false };
    const completed = history.completedRuns(candidate.agent_id, task.kind);
    const recentFails = history.recentFailures(
      candidate.agent_id, task.kind, this.handoffLookbackDays,
    );
    const failureRate = (total - completed) / total;
    if (failureRate >= this.handoffFailureRateThreshold) {
      return {
        triggered: true,
        reason: `${candidate.agent_id} failure rate ${(failureRate * 100).toFixed(0)}% on kind=${task.kind} (${total - completed}/${total} runs, ${recentFails} fails in last ${this.handoffLookbackDays}d). Asking for human approval before dispatch.`,
      };
    }
    return { triggered: false };
  }
}
