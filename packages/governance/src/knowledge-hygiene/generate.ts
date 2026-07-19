import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  KnowledgeHygieneFindingV1,
  KnowledgeHygieneReportV1,
  KnowledgeHygieneResolutionV1,
  KnowledgeHygieneReviewArtifactV1,
} from "./types.js";
import {
  KnowledgeHygienePatchActionV1,
  KnowledgeHygienePatchPlanV1,
} from "./patch-types.js";
import {
  KnowledgeHygienePlanActionV1,
  KnowledgeHygieneTransactionPlanV1,
} from "./transaction-plan.js";
import { KnowledgeHygieneConfigV2Schema } from "./config-v2.js";
import {
  CoverageDimensionV2,
  KnowledgeHygieneFindingV2,
  KnowledgeHygieneReportV2,
  KnowledgeHygieneResolutionEventV2,
  KnowledgeHygieneRuleIdV2,
} from "./types-v2.js";

interface KnowledgeHygieneSchemaEntryV1 {
  key: string;
  title: string;
  comment?: string;
  schema: ZodTypeAny;
}

export const KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V1 = Object.freeze([
  {
    key: "knowledge-hygiene-finding-v1",
    title: "Osstack Knowledge Hygiene Finding v1",
    schema: KnowledgeHygieneFindingV1,
  },
  {
    key: "knowledge-hygiene-report-v1",
    title: "Osstack Knowledge Hygiene Report v1",
    schema: KnowledgeHygieneReportV1,
  },
  {
    key: "knowledge-hygiene-resolution-v1",
    title: "Osstack Knowledge Hygiene Resolution v1",
    schema: KnowledgeHygieneResolutionV1,
  },
  {
    key: "knowledge-hygiene-review-artifact-v1",
    title: "Osstack Knowledge Hygiene Review Artifact v1",
    comment:
      "Resolution diff_id equality and fingerprint uniqueness are enforced by @osstack/governance Zod validation and are not expressible in this generated JSON Schema.",
    schema: KnowledgeHygieneReviewArtifactV1,
  },
  {
    key: "knowledge-hygiene-patch-action-v1",
    title: "Osstack Knowledge Hygiene Patch Action v1",
    comment:
      "Source/target equality, exact one-line confined import content, and content SHA equality are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygienePatchActionV1,
  },
  {
    key: "knowledge-hygiene-patch-plan-v1",
    title: "Osstack Knowledge Hygiene Patch Plan v1",
    comment:
      "Action-id uniqueness is enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygienePatchPlanV1,
  },
  {
    key: "knowledge-hygiene-transaction-action-v1",
    title: "Osstack Knowledge Hygiene Transaction Action v1",
    comment:
      "Byte-span, content-conservation, claim-ledger, and discard-ledger invariants are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygienePlanActionV1,
  },
  {
    key: "knowledge-hygiene-transaction-plan-v1",
    title: "Osstack Knowledge Hygiene Transaction Plan v1",
    comment:
      "Content-addressed identity, non-overlap, approval, write-set, expiry, and state invariants are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygieneTransactionPlanV1,
  },
] satisfies readonly KnowledgeHygieneSchemaEntryV1[]);

export const KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V2 = Object.freeze([
  {
    key: "knowledge-hygiene-rule-id-v2",
    title: "Osstack Knowledge Hygiene Rule ID v2",
    schema: KnowledgeHygieneRuleIdV2,
  },
  {
    key: "knowledge-hygiene-finding-v2",
    title: "Osstack Knowledge Hygiene Finding v2",
    comment:
      "Portable-path, surface/location, rule/dimension, and closure-policy refinements are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygieneFindingV2,
  },
  {
    key: "knowledge-hygiene-coverage-v2",
    title: "Osstack Knowledge Hygiene Coverage Dimension v2",
    comment:
      "Coverage count and state invariants are enforced by @osstack/governance Zod validation.",
    schema: CoverageDimensionV2,
  },
  {
    key: "knowledge-hygiene-report-v2",
    title: "Osstack Knowledge Hygiene Report v2",
    comment:
      "Assessment-scope ordering, coverage order/completeness, and health-claim precedence are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygieneReportV2,
  },
  {
    key: "knowledge-hygiene-resolution-event-v2",
    title: "Osstack Knowledge Hygiene Resolution Event v2",
    comment:
      "Lifecycle transitions and suppression/coverage evidence requirements are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygieneResolutionEventV2,
  },
  {
    key: "knowledge-hygiene-config-v2",
    title: "Osstack Knowledge Hygiene Config v2",
    comment:
      "Semantic scheduling, uniqueness, common-config, and dependency-time refinements are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygieneConfigV2Schema,
  },
] satisfies readonly KnowledgeHygieneSchemaEntryV1[]);

function renderSchema(entry: KnowledgeHygieneSchemaEntryV1): string {
  const generated = zodToJsonSchema(entry.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return `${JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    title: entry.title,
    ...(entry.comment === undefined ? {} : { $comment: entry.comment }),
    ...generated,
  }, null, 2)}\n`;
}

export function generateAllKnowledgeHygieneSchemasV1(): Record<string, string> {
  return Object.fromEntries(
    KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V1.map((entry) => [
      `${entry.key}.schema.json`,
      renderSchema(entry),
    ]),
  );
}

export function generateAllKnowledgeHygieneSchemasV2(): Record<string, string> {
  return Object.fromEntries(
    KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V2.map((entry) => [
      `${entry.key}.schema.json`,
      renderSchema(entry),
    ]),
  );
}
