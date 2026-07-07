import { describe, expect, it } from "vitest";
import { proposeImprovement } from "./proposal.js";
import type { FeedbackAsset } from "./types.js";

function asset(kind: FeedbackAsset["kind"]): FeedbackAsset {
  return {
    asset_id: `asset_${kind}`,
    repo_id: "osstack",
    source_trace_id: "trace_1",
    kind,
    failure_family: kind === "governance_rule" ? "bad_policy" : "bad_reasoning",
    summary: `${kind} needed`,
    evidence: [],
    status: "proposed",
    created_at: "2026-07-07T00:00:00.000Z",
  };
}

describe("proposal generator", () => {
  it("maps eval cases to low-risk eval proposals", () => {
    const proposals = proposeImprovement({ repo_id: "osstack", assets: [asset("eval_case")], verify_commands: ["pnpm test"] });
    expect(proposals[0]?.target).toBe("eval");
    expect(proposals[0]?.risk).toBe("low");
    expect(proposals[0]?.required_gates).toEqual(["pnpm test"]);
  });

  it("maps governance rules to high-risk policy proposals", () => {
    const proposals = proposeImprovement({ repo_id: "osstack", assets: [asset("governance_rule")], verify_commands: [] });
    expect(proposals[0]?.target).toBe("policy");
    expect(proposals[0]?.risk).toBe("high");
  });

  it("carries source asset provenance and skill/prompt gaps are medium risk", () => {
    const proposals = proposeImprovement({
      repo_id: "osstack",
      assets: [asset("prompt_gap"), asset("skill_gap")],
      verify_commands: ["pnpm test"],
    });
    expect(proposals.map((p) => p.risk)).toEqual(["medium", "medium"]);
    expect(proposals[0]?.source_asset_ids).toEqual(["asset_prompt_gap"]);
  });
});
