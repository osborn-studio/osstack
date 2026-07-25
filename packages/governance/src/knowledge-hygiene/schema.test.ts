import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";
import {
  generateAllKnowledgeHygieneSchemasV1,
  KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V1,
} from "./generate.js";
import {
  KnowledgeHygieneFindingV1,
  KnowledgeHygieneReportV1,
  KnowledgeHygieneResolutionV1,
  KnowledgeHygieneReviewArtifactV1,
  KnowledgeHygieneRuleIdV1,
} from "./types.js";
import {
  KnowledgeHygienePatchActionV1,
  KnowledgeHygienePatchPlanV1,
} from "./patch-types.js";

const schemasDirectory = fileURLToPath(
  new URL("../../schemas", import.meta.url),
);
const fixturesDirectory = fileURLToPath(
  new URL("../../fixtures/knowledge-hygiene", import.meta.url),
);

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDirectory}/${path}`, "utf8"));
}

describe("knowledge hygiene public schemas", () => {
  const generated = generateAllKnowledgeHygieneSchemasV1();

  it("has one deterministic artifact per public v1 schema", () => {
    expect(Object.keys(generated).sort()).toEqual([
      "knowledge-hygiene-finding-v1.schema.json",
      "knowledge-hygiene-patch-action-v1.schema.json",
      "knowledge-hygiene-patch-plan-v1.schema.json",
      "knowledge-hygiene-report-v1.schema.json",
      "knowledge-hygiene-resolution-v1.schema.json",
      "knowledge-hygiene-review-artifact-v1.schema.json",
      "knowledge-hygiene-transaction-action-v1.schema.json",
      "knowledge-hygiene-transaction-plan-v1.schema.json",
    ]);
    expect(KNOWLEDGE_HYGIENE_SCHEMA_MANIFEST_V1).toHaveLength(8);
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
      name: "finding-v1",
      schema: KnowledgeHygieneFindingV1,
      valid: "valid/finding-v1.valid.json",
      invalid: "invalid/finding-v1.invalid.json",
    },
    {
      name: "report-v1",
      schema: KnowledgeHygieneReportV1,
      valid: "valid/report-v1.valid.json",
      invalid: "invalid/report-v1.invalid.json",
    },
    {
      name: "resolution-v1",
      schema: KnowledgeHygieneResolutionV1,
      valid: "valid/resolution-v1.valid.json",
      invalid: "invalid/resolution-v1.invalid.json",
    },
    {
      name: "review-artifact-v1",
      schema: KnowledgeHygieneReviewArtifactV1,
      valid: "valid/review-artifact-v1.valid.json",
      invalid: "invalid/review-artifact-v1.invalid.json",
    },
    {
      name: "patch-action-v1",
      schema: KnowledgeHygienePatchActionV1,
      valid: "valid/patch-action-v1.valid.json",
      invalid: "invalid/patch-action-v1.invalid.json",
    },
    {
      name: "patch-plan-v1",
      schema: KnowledgeHygienePatchPlanV1,
      valid: "valid/patch-plan-v1.valid.json",
      invalid: "invalid/patch-plan-v1.invalid.json",
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

  it("protects the additive v1 compatibility baseline", () => {
    const findingSchema = JSON.parse(
      generated["knowledge-hygiene-finding-v1.schema.json"] ?? "{}",
    ) as { required?: string[]; properties?: Record<string, unknown> };
    const reportSchema = JSON.parse(
      generated["knowledge-hygiene-report-v1.schema.json"] ?? "{}",
    ) as { required?: string[]; properties?: Record<string, unknown> };

    expect(findingSchema.required).toEqual(expect.arrayContaining([
      "fingerprint",
      "rule_id",
      "rule_version",
      "surface",
      "severity",
      "confidence",
      "location",
      "observed",
      "expected",
      "rationale",
      "evidence_refs",
      "remediation",
    ]));
    expect(Object.keys(reportSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        "schema_version",
        "generated_at",
        "repo",
        "input",
        "completeness",
        "summary",
        "findings",
        "metrics",
      ]),
    );
    expect(Object.keys(reportSchema.properties ?? {})).toContain("adapters");
    expect(KnowledgeHygieneRuleIdV1.options).toEqual(expect.arrayContaining([
      "instruction.canonical_missing",
      "instruction.mirror_missing",
      "instruction.mirror_drift",
      "surface.required_missing",
      "budget.warn_exceeded",
      "budget.error_exceeded",
      "reference.markdown_target_missing",
      "reference.instruction_import_missing",
      "contract.review_required",
      "memory.platform_limit_exceeded",
      "probe.artifact_integrity",
      "probe.destination_missing",
      "probe.deferred_stale",
      "probe.waiver_expired",
      "scan.incomplete",
    ]));
    expect(KnowledgeHygieneResolutionV1.shape.outcome.options).toEqual(
      expect.arrayContaining([
        "fixed",
        "reviewed_no_change",
        "accepted_risk",
        "suppressed",
        "obsolete",
      ]),
    );
  });
});
