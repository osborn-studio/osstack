import { describe, expect, it } from "vitest";
import { decideProposalGate } from "./gate.js";
import type { ImprovementProposal } from "./types.js";

function proposal(risk: "low" | "medium" | "high", gates = ["pnpm test"]): ImprovementProposal {
  return {
    proposal_id: `prop_${risk}`,
    repo_id: "osstack",
    source_asset_ids: ["asset_1"],
    target: risk === "high" ? "policy" : "eval",
    risk,
    title: "Improve system",
    rationale: "Regression evidence exists.",
    proposed_changes: [],
    required_gates: gates,
    status: "draft",
    created_at: "2026-07-07T00:00:00.000Z",
  };
}

describe("proposal gate", () => {
  it("allows low-risk proposal when gates pass", async () => {
    const decision = await decideProposalGate(proposal("low"), {
      runGate: async () => ({ pass: true, summary: "ok" }),
    });
    expect(decision.action).toBe("auto_applicable");
  });

  it("requires human for medium risk even when gates pass", async () => {
    const decision = await decideProposalGate(proposal("medium"), {
      runGate: async () => ({ pass: true, summary: "ok" }),
    });
    expect(decision.action).toBe("needs_human");
  });

  it("blocks when gate fails", async () => {
    const decision = await decideProposalGate(proposal("low"), {
      runGate: async () => ({ pass: false, summary: "failed" }),
    });
    expect(decision.action).toBe("blocked");
  });

  it("blocks when required gates exist but no runner is provided", async () => {
    const decision = await decideProposalGate(proposal("low"), {});
    expect(decision.action).toBe("blocked");
  });

  it("requires human for low risk with no gate to verify safety", async () => {
    const decision = await decideProposalGate(proposal("low", []), {
      runGate: async () => ({ pass: true, summary: "ok" }),
    });
    expect(decision.action).toBe("needs_human");
  });
});
