import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  KnowledgeHygieneFindingV1,
  KnowledgeHygieneReportV1,
} from "./types.js";

interface KnowledgeHygieneSchemaEntryV1 {
  key: string;
  title: string;
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
] satisfies readonly KnowledgeHygieneSchemaEntryV1[]);

function renderSchema(entry: KnowledgeHygieneSchemaEntryV1): string {
  const generated = zodToJsonSchema(entry.schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return `${JSON.stringify({
    $schema: "http://json-schema.org/draft-07/schema#",
    title: entry.title,
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
