import { matchesKnowledgeHygienePathPatternV1 } from "../path-pattern.js";
import type { KnowledgeHygieneRuleV1 } from "./rule-types.js";
import { createRuleFinding } from "./rule-types.js";

export const CHANGE_CONTRACT_RULE_V1: KnowledgeHygieneRuleV1 = {
  id: "contract.review_required",
  version: "1",
  default_severity: "warning",
  evaluate(input) {
    if (!input.config || !input.change_set) return [];
    return input.config.contracts.flatMap((contract) => {
      const triggeringPaths = input.change_set?.changed_paths.filter((path) =>
        contract.when.any_path.some((pattern) =>
          matchesKnowledgeHygienePathPatternV1(pattern, path))) ?? [];
      if (triggeringPaths.length === 0) return [];
      const reviewed = input.change_set?.changed_paths.some((path) =>
        contract.review.any_path.some((pattern) =>
          matchesKnowledgeHygienePathPatternV1(pattern, path))) ?? false;
      if (reviewed) return [];

      const severity = contract.enforcement === "required" ? "error" : "warning";
      return [createRuleFinding(this, input, {
        path: triggeringPaths[0] ?? ".",
        anchor: `contract:${contract.id}`,
        surface: "documentation",
        severity,
        confidence: "medium",
        observed: {
          contract_id: contract.id,
          triggering_paths: triggeringPaths,
          diff_id: input.change_set?.diff_id,
        },
        expected: {
          review_any_path: contract.review.any_path,
          enforcement: contract.enforcement,
        },
        rationale: "A configured change-review obligation is unresolved.",
        evidence_refs: [
          ...triggeringPaths.map((path) => ({ kind: "proof" as const, ref: path })),
          ...contract.review.any_path.map((path) => ({
            kind: "external" as const,
            ref: path,
          })),
        ],
        remediation: contract.enforcement === "required"
          ? { mode: "agent_edit" }
          : { mode: "human_decision" },
      })];
    });
  },
};
