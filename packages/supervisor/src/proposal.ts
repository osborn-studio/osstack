// Improvement proposals — turn feedback assets into risk-rated change
// proposals. Deterministic mapping from asset kind to change target and risk.
// A proposal is never applied here; it only describes an intended change and
// the gates that must pass first.

import { createHash } from "node:crypto";
import { ImprovementProposal, type FeedbackAsset, type FeedbackAssetKind, type ImprovementRisk, type ImprovementTarget } from "./types.js";

interface Mapping {
  target: ImprovementTarget;
  risk: ImprovementRisk;
}

const KIND_TO_MAPPING: Record<FeedbackAssetKind, Mapping> = {
  eval_case: { target: "eval", risk: "low" },
  test_gap: { target: "test", risk: "low" },
  pitfall_lesson: { target: "docs", risk: "low" },
  knowledge_memory: { target: "docs", risk: "low" },
  runbook_note: { target: "docs", risk: "low" },
  prompt_gap: { target: "prompt", risk: "medium" },
  skill_gap: { target: "skill", risk: "medium" },
  governance_rule: { target: "policy", risk: "high" },
};

export function proposeImprovement(input: {
  repo_id: string;
  assets: FeedbackAsset[];
  verify_commands: string[];
}): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];

  for (const asset of input.assets) {
    const mapping = KIND_TO_MAPPING[asset.kind];
    const definition = {
      repo_id: input.repo_id,
      source_asset_ids: [asset.asset_id],
      target: mapping.target,
      risk: mapping.risk,
      title: `${titleForTarget(mapping.target)} from ${asset.failure_family}`,
      rationale: `Derived from ${asset.kind} asset ${asset.asset_id} (trace ${asset.source_trace_id}): ${asset.summary}`,
      proposed_changes: asset.suggested_storage_path !== undefined
        ? [{ path: asset.suggested_storage_path, action: "modify", summary: `Record ${asset.kind} from failure.` }]
        : [],
      required_gates: [...input.verify_commands],
    };
    // Stable across batches and retries; changed provenance, evidence, or
    // proposal content creates a new identity instead of replacing history.
    const digest = createHash("sha256").update(JSON.stringify({
      version: 2,
      definition,
      source_repo_id: asset.repo_id,
      source_trace_id: asset.source_trace_id,
      evidence: asset.evidence,
    })).digest("hex");

    proposals.push(ImprovementProposal.parse({
      ...definition,
      proposal_id: `prop_v2_${digest}`,
      status: "draft",
      created_at: asset.created_at,
    }));
  }

  return proposals;
}

function titleForTarget(target: ImprovementTarget): string {
  switch (target) {
    case "eval":
      return "Add evaluation case";
    case "test":
      return "Close test gap";
    case "prompt":
      return "Improve prompt";
    case "skill":
      return "Improve skill";
    case "policy":
      return "Adjust governance policy";
    case "docs":
      return "Add runbook/knowledge note";
    case "tool":
      return "Fix tool integration";
    case "agent_flow":
      return "Adjust agent flow";
    case "routing":
      return "Adjust routing";
    default:
      return "Improvement";
  }
}
