import type { KnowledgeHygieneRuleV1 } from "./rule-types.js";
import { createRuleFinding } from "./rule-types.js";

export const REQUIRED_SURFACE_RULE_V1: KnowledgeHygieneRuleV1 = {
  id: "surface.required_missing",
  version: "1",
  default_severity: "warning",
  evaluate(input) {
    if (!input.config) return [];
    return input.config.required_surfaces.flatMap((required) => {
      const surface = input.inventory.surfaces.find(
        (candidate) => candidate.path === required.path,
      );
      if (surface?.exists && surface.kind === required.kind) return [];
      return [createRuleFinding(this, input, {
        path: required.path,
        anchor: `required:${required.id}`,
        surface: "documentation",
        severity: required.severity,
        confidence: "high",
        observed: {
          exists: surface?.exists ?? false,
          kind: surface?.kind ?? null,
        },
        expected: { exists: true, kind: required.kind, id: required.id },
        rationale: "A configured knowledge surface is missing or has the wrong kind.",
        remediation: { mode: "agent_edit" },
      })];
    });
  },
};
