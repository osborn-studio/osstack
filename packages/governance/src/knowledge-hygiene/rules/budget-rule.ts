import type { KnowledgeSurfaceInventoryEntryV1 } from "../types.js";
import type { KnowledgeHygieneRuleV1 } from "./rule-types.js";
import { createRuleFinding, findingEvidence } from "./rule-types.js";

interface BudgetThreshold {
  lines?: number | undefined;
  bytes?: number | undefined;
}

function exceeds(
  surface: KnowledgeSurfaceInventoryEntryV1,
  threshold: BudgetThreshold | undefined,
): boolean {
  if (!threshold) return false;
  return (
    (threshold.lines !== undefined &&
      surface.lines !== undefined &&
      surface.lines > threshold.lines) ||
    (threshold.bytes !== undefined &&
      surface.bytes !== undefined &&
      surface.bytes > threshold.bytes)
  );
}

const warningRule: KnowledgeHygieneRuleV1 = {
  id: "budget.warn_exceeded",
  version: "1",
  default_severity: "warning",
  evaluate(input) {
    if (!input.config) return [];
    return input.config.budgets.flatMap((budget) => {
      const surface = input.inventory.surfaces.find(
        (candidate) => candidate.path === budget.path,
      );
      if (!surface?.exists || surface.kind !== "file") return [];
      if (!exceeds(surface, budget.warn) || exceeds(surface, budget.error)) return [];
      return [createRuleFinding(this, input, {
        path: budget.path,
        anchor: `budget:${budget.id}:warn`,
        surface: surface.surface,
        severity: "warning",
        confidence: "high",
        observed: { lines: surface.lines ?? null, bytes: surface.bytes ?? null },
        expected: { maximum: budget.warn ?? {} },
        rationale: "The knowledge surface exceeds its configured warning budget.",
        evidence_refs: findingEvidence(surface),
        remediation: { mode: "agent_edit" },
      })];
    });
  },
};

const errorRule: KnowledgeHygieneRuleV1 = {
  id: "budget.error_exceeded",
  version: "1",
  default_severity: "error",
  evaluate(input) {
    if (!input.config) return [];
    return input.config.budgets.flatMap((budget) => {
      const surface = input.inventory.surfaces.find(
        (candidate) => candidate.path === budget.path,
      );
      if (!surface?.exists || surface.kind !== "file") return [];
      if (!exceeds(surface, budget.error)) return [];
      return [createRuleFinding(this, input, {
        path: budget.path,
        anchor: `budget:${budget.id}:error`,
        surface: surface.surface,
        severity: "error",
        confidence: "high",
        observed: { lines: surface.lines ?? null, bytes: surface.bytes ?? null },
        expected: { maximum: budget.error ?? {} },
        rationale: "The knowledge surface exceeds its configured error budget.",
        evidence_refs: findingEvidence(surface),
        remediation: { mode: "agent_edit" },
      })];
    });
  },
};

export const BUDGET_RULES_V1 = Object.freeze([
  warningRule,
  errorRule,
] satisfies readonly KnowledgeHygieneRuleV1[]);
