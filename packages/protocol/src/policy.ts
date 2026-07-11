// PolicyDecision — the router/policy engine decision, as a Zod schema.
//
// Extraction (architecture §1): core/policy/types.ts `PolicyDecision` is an
// interface today; protocol makes it executable Zod (core re-exports later in
// R1.2). Structure preserved verbatim: { winner, ranked, handoff }.
//
// Domain-neutrality: a PolicyCandidate's `capabilities` are kept OPAQUE
// (z.unknown()) in v1 — the full @osstack/core Capability schema is deliberately
// NOT pre-imported (owner constraint, same discipline as Task.evaluation).

import { z } from "zod";

/** Cost tier of a candidate agent (mirrors core CostTier). */
export const CostTier = z.enum(["low", "mid", "high"]);
export type CostTier = z.infer<typeof CostTier>;

/** A rule's partial contribution to a candidate's total score. */
export const PolicyScore = z
  .object({
    value: z.number(),
    reason: z.string(),
  })
  .strict();
export type PolicyScore = z.infer<typeof PolicyScore>;

export const PolicyCandidate = z
  .object({
    agent_id: z.string().min(1),
    cost_tier: CostTier,
    /** Opaque in v1 — core's Capability schema is not pre-imported. */
    capabilities: z.array(z.unknown()),
  })
  .strict();
export type PolicyCandidate = z.infer<typeof PolicyCandidate>;

const PolicyBreakdownEntry = z
  .object({
    rule_id: z.string(),
    value: z.number(),
    reason: z.string(),
  })
  .strict();

export const PolicyOutcome = z
  .object({
    candidate: PolicyCandidate,
    total: z.number(),
    breakdown: z.array(PolicyBreakdownEntry),
  })
  .strict();
export type PolicyOutcome = z.infer<typeof PolicyOutcome>;

/** Handoff gate: when triggered, dispatch pauses for human approval. */
export const PolicyHandoff = z
  .object({
    triggered: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();
export type PolicyHandoff = z.infer<typeof PolicyHandoff>;

export const PolicyDecision = z
  .object({
    /** Winning outcome, or null when no candidate qualified. */
    winner: PolicyOutcome.nullable(),
    /** All candidates, sorted desc by total score. */
    ranked: z.array(PolicyOutcome),
    handoff: PolicyHandoff,
  })
  .strict();
export type PolicyDecision = z.infer<typeof PolicyDecision>;
