// Gate decisions — decide whether a proposal may auto-apply, needs a human,
// or is blocked. Deterministic verification is a first-class gate: a low-risk
// change may only auto-apply after its gates actually run and pass. Medium and
// high risk always require a human.

import type { ImprovementProposal } from "./types.js";

export type GateDecision =
  | { action: "auto_applicable"; reason: string }
  | { action: "needs_human"; reason: string }
  | { action: "blocked"; reason: string; failed_gate?: string };

export async function decideProposalGate(
  proposal: ImprovementProposal,
  opts: {
    runGate?: (command: string) => Promise<{ pass: boolean; summary: string }>;
  },
): Promise<GateDecision> {
  // Required gates must actually run. Missing runner with required gates blocks
  // (we cannot prove safety), and any failing gate blocks regardless of risk.
  if (proposal.required_gates.length > 0) {
    if (opts.runGate === undefined) {
      const first = proposal.required_gates[0];
      return {
        action: "blocked",
        reason: "proposal declares required gates but no gate runner was provided",
        ...(first !== undefined ? { failed_gate: first } : {}),
      };
    }
    for (const gate of proposal.required_gates) {
      const result = await opts.runGate(gate);
      if (!result.pass) {
        return { action: "blocked", reason: `gate failed: ${gate} — ${result.summary}`, failed_gate: gate };
      }
    }
  }

  // Gates passed (or there were none). Risk governs the rest.
  if (proposal.risk === "low") {
    if (proposal.required_gates.length === 0) {
      // Nothing deterministic verified this change — do not auto-apply.
      return { action: "needs_human", reason: "low risk but no deterministic gate to verify safety" };
    }
    return { action: "auto_applicable", reason: "low risk and all required gates passed" };
  }

  return { action: "needs_human", reason: `${proposal.risk} risk requires human approval` };
}
