import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";
import { KnowledgeHygieneConfigV2Schema } from "./config-v2.js";
import {
  generateAllKnowledgeHygieneSchemasV2,
  KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V2,
} from "./generate.js";
import {
  CoverageDimensionV2,
  KnowledgeHygieneFindingV2,
  KnowledgeHygieneReportV2,
  KnowledgeHygieneResolutionEventV2,
  KnowledgeHygieneRuleIdV2,
} from "./types-v2.js";

const schemasDirectory = fileURLToPath(
  new URL("../../schemas", import.meta.url),
);
const fixturesDirectory = fileURLToPath(
  new URL("../../fixtures/knowledge-hygiene", import.meta.url),
);

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDirectory}/${path}`, "utf8"));
}

describe("knowledge hygiene V2 public schemas", () => {
  const generated = generateAllKnowledgeHygieneSchemasV2();

  it("has one deterministic artifact per public V2 contract", () => {
    expect(Object.keys(generated).sort()).toEqual([
      "knowledge-hygiene-config-v2.schema.json",
      "knowledge-hygiene-coverage-v2.schema.json",
      "knowledge-hygiene-finding-v2.schema.json",
      "knowledge-hygiene-report-v2.schema.json",
      "knowledge-hygiene-resolution-event-v2.schema.json",
      "knowledge-hygiene-rule-id-v2.schema.json",
    ]);
    expect(KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V2).toHaveLength(6);
  });

  for (const [filename, content] of Object.entries(generated)) {
    it(`keeps schemas/${filename} in sync with Zod`, () => {
      expect(readFileSync(`${schemasDirectory}/${filename}`, "utf8")).toBe(
        content,
      );
    });
  }

  const vectors: ReadonlyArray<{
    name: string;
    schema: ZodTypeAny;
    valid: string;
    invalid: string;
  }> = [
    {
      name: "rule-id-v2",
      schema: KnowledgeHygieneRuleIdV2,
      valid: "valid/rule-id-v2.valid.json",
      invalid: "invalid/rule-id-v2.invalid.json",
    },
    {
      name: "finding-v2",
      schema: KnowledgeHygieneFindingV2,
      valid: "valid/finding-v2.valid.json",
      invalid: "invalid/finding-v2.invalid.json",
    },
    {
      name: "coverage-v2",
      schema: CoverageDimensionV2,
      valid: "valid/coverage-v2.valid.json",
      invalid: "invalid/coverage-v2.invalid.json",
    },
    {
      name: "report-v2",
      schema: KnowledgeHygieneReportV2,
      valid: "valid/report-v2.valid.json",
      invalid: "invalid/report-v2.invalid.json",
    },
    {
      name: "resolution-event-v2",
      schema: KnowledgeHygieneResolutionEventV2,
      valid: "valid/resolution-event-v2.valid.json",
      invalid: "invalid/resolution-event-v2.invalid.json",
    },
    {
      name: "config-v2",
      schema: KnowledgeHygieneConfigV2Schema,
      valid: "valid/config-v2.valid.json",
      invalid: "invalid/config-v2.invalid.json",
    },
  ];

  for (const vector of vectors) {
    it(`${vector.name} accepts its frozen valid vector`, () => {
      expect(vector.schema.safeParse(fixture(vector.valid)).success).toBe(true);
    });

    it(`${vector.name} rejects its labelled invalid vector`, () => {
      expect(vector.schema.safeParse(fixture(vector.invalid)).success).toBe(
        false,
      );
    });
  }
});
