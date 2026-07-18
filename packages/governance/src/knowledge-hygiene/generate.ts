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
      "Source fingerprint/finding equality and target/finding equality are enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygienePatchActionV1,
  },
  {
    key: "knowledge-hygiene-patch-plan-v1",
    title: "Osstack Knowledge Hygiene Patch Plan v1",
    comment:
      "Action-id uniqueness is enforced by @osstack/governance Zod validation.",
    schema: KnowledgeHygienePatchPlanV1,
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
