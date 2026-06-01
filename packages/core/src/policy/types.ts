// Policy engine types.
//
// Decision recorded in plan v0.6 / E2:
//   "Policy DSL = TS 函数 + 优先级打分"
//   each rule = (task, history) => Score (or null). highest wins.
//
// S3 ships these types + the engine. Rules live in policy/rules/*. The
// router (S2) finds candidate adapters; the policy engine refines the
// choice using history from the runs table.

import type { Capability, CostTier } from "../capability.js";
import type { LifecyclePhase } from "../state/schema.js";

export interface PolicyTask {
  /** Capability the router picked / the user requested. */
  capability_id: string;
  /** Capability kind extracted from the id (e.g. "code.write"). */
  kind: string;
  /** Lifecycle phase this run is in (S3+: most tasks land in "code"). */
  phase: LifecyclePhase;
  /** Free-form prompt; rules may inspect length / keywords. */
  prompt: string;
}

export interface PolicyCandidate {
  agent_id: string;
  cost_tier: CostTier;
  capabilities: readonly Capability[];
}

/**
 * Read-only window over the recent run history a policy rule may use.
 * Implementations are responsible for keeping queries cheap; the engine
 * does NOT cache across rules.
 */
export interface PolicyHistory {
  /** Total runs by this agent for this capability kind. */
  totalRuns(agent_id: string, kind: string): number;
  /** Runs that ended in "completed" for (agent, kind). */
  completedRuns(agent_id: string, kind: string): number;
  /** Number of failures within the last `withinDays` days for (agent, kind). */
  recentFailures(agent_id: string, kind: string, withinDays: number): number;
  /** Average duration (ms) for completed runs of (agent, kind). null when no data. */
  avgDurationMs(agent_id: string, kind: string): number | null;
}

export interface PolicyScore {
  /** Numeric score; higher is better. */
  value: number;
  /** Short human-readable rationale shown in routing_reason. */
  reason: string;
}

/**
 * A rule returns a partial score, or null to abstain. The engine sums all
 * rule scores per candidate and picks the highest total.
 */
export interface PolicyRule {
  readonly id: string;
  readonly description: string;
  score(
    task: PolicyTask,
    candidate: PolicyCandidate,
    history: PolicyHistory,
  ): PolicyScore | null;
}

export interface PolicyOutcome {
  candidate: PolicyCandidate;
  total: number;
  breakdown: ReadonlyArray<{ rule_id: string; value: number; reason: string }>;
}

export interface PolicyDecision {
  winner: PolicyOutcome | null;
  /** All candidates, sorted desc by total score. */
  ranked: ReadonlyArray<PolicyOutcome>;
  /**
   * Handoff gate: when true, the daemon should pause and request human
   * approval before dispatching. The reason explains why.
   */
  handoff: { triggered: boolean; reason?: string };
}
