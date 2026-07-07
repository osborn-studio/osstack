// Assetizer — turn a failed run into reusable feedback assets. Every asset
// preserves its source trace_id (provenance is non-negotiable). Deterministic
// and LLM-free: the failure family selects the asset kind.

import { classifyFailure, explainFailure } from "./failure-taxonomy.js";
import { FeedbackAsset, type FailureFamily, type FeedbackAssetKind, type RunTrace } from "./types.js";

const FAMILY_TO_KIND: Record<FailureFamily, FeedbackAssetKind> = {
  bad_input: "runbook_note",
  bad_context: "knowledge_memory",
  bad_retrieval: "knowledge_memory",
  bad_reasoning: "eval_case",
  bad_tool: "pitfall_lesson",
  bad_eval: "eval_case",
  bad_prompt: "prompt_gap",
  bad_skill: "skill_gap",
  bad_agent_flow: "governance_rule",
  bad_policy: "governance_rule",
  bad_verification: "test_gap",
  bad_handoff: "runbook_note",
  unknown: "runbook_note",
};

export function assetizeFailure(trace: RunTrace): FeedbackAsset[] {
  // Only failed runs produce assets; a passing run has nothing to learn from.
  if (trace.verification.pass) return [];

  const family = classifyFailure(trace);
  const kind = FAMILY_TO_KIND[family];
  const createdAt = trace.completed_at ?? trace.started_at;

  const asset = FeedbackAsset.parse({
    asset_id: `asset_${trace.trace_id}_${kind}`,
    repo_id: trace.repo_id,
    source_trace_id: trace.trace_id,
    kind,
    failure_family: family,
    summary: explainFailure(trace),
    evidence: collectEvidence(trace),
    ...(suggestedStoragePath(kind) !== undefined ? { suggested_storage_path: suggestedStoragePath(kind) } : {}),
    status: "proposed",
    created_at: createdAt,
  });
  return [asset];
}

function collectEvidence(trace: RunTrace): string[] {
  const evidence: string[] = [];
  for (const issue of trace.verification.issues) evidence.push(issue.message);
  for (const command of trace.commands) {
    if (command.exit_code !== 0 && command.summary !== undefined) {
      evidence.push(`${command.command} -> ${command.exit_code}: ${command.summary}`);
    }
  }
  return [...new Set(evidence)].slice(0, 8);
}

function suggestedStoragePath(kind: FeedbackAssetKind): string | undefined {
  switch (kind) {
    case "eval_case":
      return "eval/cases.jsonl";
    case "pitfall_lesson":
      return "loop-lessons/drafts/";
    case "knowledge_memory":
      return "knowledge/memories.jsonl";
    case "governance_rule":
      return "governance/rules.json";
    case "test_gap":
      return "tests/";
    case "prompt_gap":
      return "prompts/";
    case "skill_gap":
      return "skills/";
    case "runbook_note":
      return "docs/RUNBOOK.md";
    default:
      return undefined;
  }
}
