import type { KnowledgeHygieneConfigV1 } from "../config.js";
import { createKnowledgeHygieneFingerprint } from "../fingerprint.js";
import type { InstructionSourceObservationV1 } from "../instruction-source.js";
import {
  KnowledgeHygieneFindingV1,
  type KnowledgeHygieneEvidenceRefV1,
  type KnowledgeHygieneRemediationV1,
  type KnowledgeHygieneRuleIdV1,
  type KnowledgeHygieneSeverityV1,
  type KnowledgeHygieneSurfaceV1,
  type KnowledgeSurfaceInventoryEntryV1,
  type KnowledgeSurfaceInventoryV1,
} from "../types.js";

export interface KnowledgeHygieneRuleInputV1 {
  repo_identity: string;
  config: KnowledgeHygieneConfigV1 | undefined;
  inventory: KnowledgeSurfaceInventoryV1;
  instruction_observations: readonly InstructionSourceObservationV1[];
}

export interface KnowledgeHygieneRuleV1 {
  readonly id: KnowledgeHygieneRuleIdV1;
  readonly version: string;
  readonly default_severity: KnowledgeHygieneSeverityV1;
  evaluate(
    input: KnowledgeHygieneRuleInputV1,
  ): readonly KnowledgeHygieneFindingV1[];
}

interface FindingDraftV1 {
  path: string;
  anchor?: string;
  surface: KnowledgeHygieneSurfaceV1;
  severity: KnowledgeHygieneSeverityV1;
  confidence: "high" | "medium" | "low";
  observed: Record<string, unknown>;
  expected: Record<string, unknown>;
  rationale: string;
  evidence_refs?: KnowledgeHygieneEvidenceRefV1[];
  remediation: KnowledgeHygieneRemediationV1;
}

export function findingEvidence(
  surface: KnowledgeSurfaceInventoryEntryV1 | undefined,
): KnowledgeHygieneEvidenceRefV1[] {
  if (!surface?.sha256) return [];
  return [{ kind: "proof", ref: surface.path, sha256: surface.sha256 }];
}

export function createRuleFinding(
  rule: Pick<KnowledgeHygieneRuleV1, "id" | "version">,
  input: KnowledgeHygieneRuleInputV1,
  draft: FindingDraftV1,
): KnowledgeHygieneFindingV1 {
  const location = {
    path: draft.path,
    ...(draft.anchor === undefined ? {} : { anchor: draft.anchor }),
  };
  return KnowledgeHygieneFindingV1.parse({
    fingerprint: createKnowledgeHygieneFingerprint({
      schema_version: "1",
      rule_id: rule.id,
      rule_version: rule.version,
      repo_identity: input.repo_identity,
      location,
    }),
    rule_id: rule.id,
    rule_version: rule.version,
    surface: draft.surface,
    severity: draft.severity,
    confidence: draft.confidence,
    location,
    observed: draft.observed,
    expected: draft.expected,
    rationale: draft.rationale,
    evidence_refs: draft.evidence_refs ?? [],
    remediation: draft.remediation,
  });
}
