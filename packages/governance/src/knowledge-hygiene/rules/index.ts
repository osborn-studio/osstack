import { matchesKnowledgeHygienePathPatternV1 } from "../path-pattern.js";
import {
  KnowledgeHygieneRuleIdV1,
  type KnowledgeHygieneFindingV1,
} from "../types.js";
import { BUDGET_RULES_V1 } from "./budget-rule.js";
import { CHANGE_CONTRACT_RULE_V1 } from "./change-contract-rule.js";
import { CLAUDE_CODE_MEMORY_LIMIT_RULE_V1 } from "../adapters/claude-code-memory.js";
import { INSTRUCTION_RULES_V1 } from "./instruction-rule.js";
import { REQUIRED_SURFACE_RULE_V1 } from "./required-surface-rule.js";
import { REFERENCE_RULES_V1 } from "./reference-rule.js";
import {
  createRuleFinding,
  type KnowledgeHygieneRuleInputV1,
  type KnowledgeHygieneRuleV1,
} from "./rule-types.js";

export type {
  KnowledgeHygieneReferenceObservationV1,
  KnowledgeHygieneRuleInputV1,
  KnowledgeHygieneRuleV1,
} from "./rule-types.js";
export {
  inspectKnowledgeReferences,
  type InspectKnowledgeReferencesInputV1,
  REFERENCE_RULES_V1,
} from "./reference-rule.js";

const scanIncompleteRule: KnowledgeHygieneRuleV1 = {
  id: "scan.incomplete",
  version: "1",
  default_severity: "error",
  evaluate(input) {
    if (input.inventory.completeness.complete) return [];
    return [createRuleFinding(this, input, {
      path: ".",
      anchor: "inventory",
      surface: "documentation",
      severity: "error",
      confidence: "high",
      observed: {
        skipped_files: input.inventory.completeness.skipped_files,
        reasons: input.inventory.completeness.reasons,
      },
      expected: { complete: true, skipped_files: 0 },
      rationale: "The repository knowledge inventory did not complete.",
      remediation: { mode: "human_decision" },
    })];
  },
};

function externalAdapterRule(
  id: Extract<KnowledgeHygieneRuleIdV1, `probe.${string}`>,
  defaultSeverity: KnowledgeHygieneRuleV1["default_severity"],
): KnowledgeHygieneRuleV1 {
  return {
    id,
    version: "1",
    default_severity: defaultSeverity,
    evaluate: () => [],
  };
}

export function createKnowledgeHygieneRuleRegistry(
  rules: readonly KnowledgeHygieneRuleV1[],
): readonly KnowledgeHygieneRuleV1[] {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`);
    seen.add(rule.id);
  }
  return Object.freeze([...rules]);
}

const unorderedRules: readonly KnowledgeHygieneRuleV1[] = [
  ...INSTRUCTION_RULES_V1,
  REQUIRED_SURFACE_RULE_V1,
  ...BUDGET_RULES_V1,
  ...REFERENCE_RULES_V1,
  CHANGE_CONTRACT_RULE_V1,
  CLAUDE_CODE_MEMORY_LIMIT_RULE_V1,
  externalAdapterRule("probe.artifact_integrity", "error"),
  externalAdapterRule("probe.destination_missing", "warning"),
  externalAdapterRule("probe.deferred_stale", "warning"),
  externalAdapterRule("probe.waiver_expired", "error"),
  scanIncompleteRule,
];
const rulesById = new Map(unorderedRules.map((rule) => [rule.id, rule]));

export const KNOWLEDGE_HYGIENE_RULES_V1 = createKnowledgeHygieneRuleRegistry(
  KnowledgeHygieneRuleIdV1.options.map((id) => {
    const rule = rulesById.get(id);
    if (!rule) throw new Error(`missing rule implementation: ${id}`);
    return rule;
  }),
);

export function evaluateKnowledgeHygieneRules(
  input: KnowledgeHygieneRuleInputV1,
  rules: readonly KnowledgeHygieneRuleV1[] = KNOWLEDGE_HYGIENE_RULES_V1,
): KnowledgeHygieneFindingV1[] {
  return rules.flatMap((rule) => rule.evaluate(input));
}

export interface SuppressedKnowledgeHygieneFindingV1 {
  finding: KnowledgeHygieneFindingV1;
  reason: string;
}

export function filterSuppressedKnowledgeHygieneFindings(
  findings: readonly KnowledgeHygieneFindingV1[],
  config: KnowledgeHygieneRuleInputV1["config"],
): {
  active: KnowledgeHygieneFindingV1[];
  suppressed: SuppressedKnowledgeHygieneFindingV1[];
} {
  if (!config) return { active: [...findings], suppressed: [] };
  const active: KnowledgeHygieneFindingV1[] = [];
  const suppressed: SuppressedKnowledgeHygieneFindingV1[] = [];
  for (const finding of findings) {
    const ignore = config.ignore.find(
      (candidate) =>
        candidate.rule_id === finding.rule_id &&
        candidate.paths.some((pattern) =>
          matchesKnowledgeHygienePathPatternV1(pattern, finding.location.path)),
    );
    if (ignore) suppressed.push({ finding, reason: ignore.reason });
    else active.push(finding);
  }
  return { active, suppressed };
}
