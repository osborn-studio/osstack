// Capability schema (Zod). Single source of truth for "what an agent can do".
// Per CEO Review decision D11/E1, used by:
//   - @osstack/agents (each adapter declares its capability set)
//   - @osstack/skill-registry (ingester normalizes external skills into this)
//   - @osstack/core/policy (policy.score reads capability list to route tasks)
//
// Exported to JSON Schema in build so the Python bridge can validate as well.

import { z } from "zod";

// Coarse categories. Add narrowly. Not a taxonomy contest.
//
// Two families:
//   - Software lifecycle (code/design/doc/plan/research/release/ops) — the
//     original osstack scope (Claude Code, Codex CLI).
//   - Professional services (intent/client/matter/risk/artifact/memory) —
//     added when PartnerOS landed as a vertical skill family
//     (see docs/external/partneros-analysis.md §五.2).
export const CapabilityKind = z.enum([
  // ── Software lifecycle ─────────────────────────────────────────────
  "code.write",
  "code.review",
  "review.code",
  "code.refactor",
  "code.test",
  "code.debug",
  "design.prd",
  "design.architecture",
  "design.review",
  "doc.write",
  "doc.summarize",
  "plan.decompose",
  "plan.estimate",
  "research.web",
  "research.code",
  "release.check",
  "release.verify",
  "ops.deploy",
  "ops.rollback",
  // ── Professional services (PartnerOS vertical) ─────────────────────
  // CEO-layer routing: turning a fuzzy human message into a structured
  // Intent, asking for clarification, deciding whether to delegate.
  "intent.draft",        // Elon: synthesize an Intent from user input
  "intent.clarify",      // Elon: ask one clarifying question
  "intent.assign",       // Qian: pick which agents run which steps
  // Client / matter relationship operations.
  "client.followup",     // Bezos: draft outreach to a client
  "client.summarize",    // any agent: read prior history, produce summary
  "matter.summarize",    // domain-specific summarization of a matter (case/fund/etc.)
  "matter.checklist",    // produce missing-document / open-item checklist
  // Risk + verification (Turing's domain).
  "risk.check",          // run industry risk rules over an artifact
  "verify.acceptance",   // check artifact against acceptance criteria
  "verify.alignment",    // check implementation against PRD/architecture/sprint intent
  // Artifact / approval lifecycle.
  "artifact.create",     // Jobs / Linus: produce a draft document
  "artifact.revise",     // produce a revised draft given user feedback
  "approval.request",    // ask the human for a go/no-go
  // Long-term memory (PartnerOS's signature feedback loop).
  "memory.write",        // persist a fact / correction / preference
  "memory.read",         // read facts about a subject (client/matter/workflow)
  // ── Autonomous ML research (karpathy/autoresearch) ─────────────────
  // A propose→train→evaluate→keep/rollback loop over a single-GPU LLM
  // training harness. The AutoResearchAdapter advertises these.
  "research.ml",         // run an autonomous ML-research experiment loop
  "research.experiment", // one propose+train+eval iteration (sub-step)
]);

export type CapabilityKind = z.infer<typeof CapabilityKind>;

export const CostTier = z.enum(["low", "mid", "high"]);
export type CostTier = z.infer<typeof CostTier>;

export const CapabilitySchema = z.object({
  id: z.string(),                                  // e.g. "claude-code.code.write"
  kind: CapabilityKind,
  agent_id: z.string(),                            // owning adapter
  description: z.string().max(280),                // one-line; LLM-readable
  cost_tier: CostTier.default("mid"),
  // Routing hints (optional). policy.score() consumes these.
  hints: z.object({
    languages: z.array(z.string()).optional(),    // ["typescript", "python"]
    frameworks: z.array(z.string()).optional(),
    avoid_when: z.array(z.string()).optional(),   // tags this capability is bad at
  }).default({}),
  version: z.string().default("0.0.0"),
});

export type Capability = z.infer<typeof CapabilitySchema>;
