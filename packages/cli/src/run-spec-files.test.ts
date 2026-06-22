import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const specDir = join(repoRoot, "docs", "specs");

describe("OSSTACK_RUN_SPEC_V1 files", () => {
  it("defines stable clauses and L1-L4 conformance levels", async () => {
    const spec = await readFile(join(specDir, "OSSTACK_RUN_SPEC_V1.md"), "utf-8");
    const version = spec.match(/^Version:\s*(\S+)$/m)?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    for (const clause of [
      "R-001 Lifecycle",
      "R-002 Task Schema",
      "R-003 Capability and Adapter Contract",
      "R-004 Policy Decision",
      "R-005 Event Schema",
      "R-006 Loop State",
      "R-007 Verify Gates",
      "R-008 Worktree Safety",
      "R-009 Proof Pack",
      "R-010 Conformance Levels",
      "R-011 Knowledge Evidence",
      "R-012 PR Evidence",
      "R-013 Versioning and Deprecation",
      "R-014 Test Vectors",
    ]) {
      expect(spec).toContain(clause);
    }
    for (const level of ["L1 Tracked", "L2 Verified", "L3 Reviewed", "L4 Audited"]) {
      expect(spec).toContain(level);
    }
    expect(spec).toContain("schemas/task.schema.json");
    expect(spec).toContain("schemas/event.schema.json");
    expect(spec).toContain("schemas/loop-state.schema.json");
    expect(spec).toContain("schemas/policy-decision.schema.json");
    expect(spec).toContain("schemas/proof-pack-manifest.schema.json");
    expect(spec).toContain("schemas/knowledge-pack.schema.json");
  });

  it("keeps a conformance matrix for every stable run spec clause", async () => {
    const matrix = await readFile(join(specDir, "CONFORMANCE_MATRIX.md"), "utf-8");

    for (const clause of [
      "R-001 Lifecycle",
      "R-002 Task Schema",
      "R-003 Capability and Adapter Contract",
      "R-004 Policy Decision",
      "R-005 Event Schema",
      "R-006 Loop State",
      "R-007 Verify Gates",
      "R-008 Worktree Safety",
      "R-009 Proof Pack",
      "R-010 Conformance Levels",
      "R-011 Knowledge Evidence",
      "R-012 PR Evidence",
      "R-013 Versioning and Deprecation",
      "R-014 Test Vectors",
    ]) {
      expect(matrix).toContain(clause);
    }

    expect(matrix).toContain("Status Legend");
    expect(matrix).toContain("Current Conformance Summary");
    expect(matrix).toContain("Required Follow-Up Tests");
  });

  it("keeps schema and test vector JSON parseable with required anchors", async () => {
    const jsonFiles = [
      "schemas/task.schema.json",
      "schemas/event.schema.json",
      "schemas/loop-state.schema.json",
      "schemas/policy-decision.schema.json",
      "schemas/proof-pack-manifest.schema.json",
      "schemas/knowledge-pack.schema.json",
      "test-vectors/OS-GOV-001.json",
      "test-vectors/OS-EVID-001.json",
      "test-vectors/OS-KNOW-001.json",
    ];

    for (const relative of jsonFiles) {
      const parsed = JSON.parse(await readFile(join(specDir, relative), "utf-8")) as Record<string, unknown>;
      expect(parsed).toBeTypeOf("object");
    }

    const proofManifestSchema = JSON.parse(
      await readFile(join(specDir, "schemas", "proof-pack-manifest.schema.json"), "utf-8"),
    ) as { required: string[] };
    expect(proofManifestSchema.required).toEqual(expect.arrayContaining([
      "schema_version",
      "kind",
      "loop_id",
      "artifacts",
    ]));

    const evidenceVector = JSON.parse(
      await readFile(join(specDir, "test-vectors", "OS-EVID-001.json"), "utf-8"),
    ) as { expected_conformance: string; proof_manifest: { kind: string } };
    expect(evidenceVector.expected_conformance).toBe("L2");
    expect(evidenceVector.proof_manifest.kind).toBe("osstack.proof_pack");

    const knowledgeVector = JSON.parse(
      await readFile(join(specDir, "test-vectors", "OS-KNOW-001.json"), "utf-8"),
    ) as { expected_mode: string; knowledge_pack: { source_kind: string; quality_score: number } };
    expect(knowledgeVector.expected_mode).toBe("local");
    expect(knowledgeVector.knowledge_pack.source_kind).toBe("processed_mit");
    expect(knowledgeVector.knowledge_pack.quality_score).toBeGreaterThan(0);
  });

  it("ships product companion docs for the run spec", async () => {
    const productDir = join(repoRoot, "docs", "product");
    const productDocs = [
      "00_TERMINOLOGY_CONSISTENCY.md",
      "01_VISION.md",
      "02_PRD.md",
      "03_USER_JOURNEY_AND_USE_CASES.md",
      "04_SYSTEM_ARCHITECTURE.md",
      "05_AI_AND_LLM_ARCHITECTURE.md",
      "06_SKILLS_AND_AGENT_REGISTRY.md",
      "07_REPORT_TEMPLATES_AND_OUTPUTS.md",
      "08_LIVE_WORKBENCH_UI_SPEC.md",
      "09_IMPLEMENTATION_PLAN.md",
      "10_TASK_BREAKDOWN.md",
      "11_TEST_AND_EVAL_PLAN.md",
      "12_RUNBOOK.md",
      "13_DECISIONS.md",
    ];

    for (const relative of productDocs) {
      const text = await readFile(join(productDir, relative), "utf-8");
      expect(text.trim().length).toBeGreaterThan(200);
      expect(text).not.toContain("TBD");
      expect(text).not.toContain("TODO");
    }

    const architecture = await readFile(join(productDir, "04_SYSTEM_ARCHITECTURE.md"), "utf-8");
    expect(architecture).toContain("@osstack/loop");
    expect(architecture).toContain("Knowledge Cloud");

    const decisions = await readFile(join(productDir, "13_DECISIONS.md"), "utf-8");
    expect(decisions).toContain("D-001");
    expect(decisions).toContain("Osstack-Native");
  });
});
