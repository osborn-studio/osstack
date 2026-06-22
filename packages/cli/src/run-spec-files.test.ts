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
    expect(spec).toContain("schemas/agent-runtime.schema.json");
    expect(spec).toContain("schemas/verify-results.schema.json");
    expect(spec).toContain("schemas/worktree-status.schema.json");
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
      "schemas/agent-runtime.schema.json",
      "schemas/verify-results.schema.json",
      "schemas/worktree-status.schema.json",
      "schemas/knowledge-pack.schema.json",
      "test-vectors/OS-GOV-001.json",
      "test-vectors/OS-EVID-001.json",
      "test-vectors/OS-EVID-BAD-001.json",
      "test-vectors/OS-PROOF-BAD-001.json",
      "test-vectors/OS-AUDIT-001.json",
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
    ) as {
      expected_conformance: string;
      proof_manifest: { kind: string };
      agent_runtime: { status: string; agents: Array<{ auth_mode: string }> };
      verify_results: { status: string; results: Array<{ reviewer_agent_id: string }> };
      worktree_status: { status: string; entries: Array<{ status: string }> };
    };
    expect(evidenceVector.expected_conformance).toBe("L2");
    expect(evidenceVector.proof_manifest.kind).toBe("osstack.proof_pack");
    expect(evidenceVector.agent_runtime.status).toBe("recorded");
    expect(evidenceVector.agent_runtime.agents[0]?.auth_mode).toBe("subprocess/login-reuse");
    expect(evidenceVector.verify_results.status).toBe("pass");
    expect(evidenceVector.verify_results.results[0]?.reviewer_agent_id).toBe("local-verifier");
    expect(evidenceVector.worktree_status.status).toBe("recorded");
    expect(evidenceVector.worktree_status.entries[0]?.status).toBe("merged");

    const malformedEvidenceVector = JSON.parse(
      await readFile(join(specDir, "test-vectors", "OS-EVID-BAD-001.json"), "utf-8"),
    ) as { expected_status: string; expected_errors: string[] };
    expect(malformedEvidenceVector.expected_status).toBe("reject");
    expect(malformedEvidenceVector.expected_errors).toEqual(expect.arrayContaining([
      "verify-results.results[0].reviewer_agent_id is required",
      "worktree-status.entries[0].path is required",
    ]));

    const malformedProofVector = JSON.parse(
      await readFile(join(specDir, "test-vectors", "OS-PROOF-BAD-001.json"), "utf-8"),
    ) as {
      expected_status: string;
      expected_errors: string[];
      proof_manifest: { artifacts: Array<{ path: string; sha256?: string; bytes?: number }> };
      policy_decision: { status: string; reason: string };
      knowledge_results: { results: Array<{ source_refs: string[] }> };
    };
    expect(malformedProofVector.expected_status).toBe("reject");
    expect(malformedProofVector.proof_manifest.artifacts[0]?.sha256).toBe("not-a-sha256");
    expect(malformedProofVector.proof_manifest.artifacts[0]?.bytes).toBe(0);
    expect(malformedProofVector.policy_decision).toEqual({ status: "unknown", reason: "" });
    expect(malformedProofVector.knowledge_results.results[0]?.source_refs).toEqual([]);
    expect(malformedProofVector.expected_errors).toEqual(expect.arrayContaining([
      "manifest.artifacts[0].sha256 must be a 64-character lowercase hex checksum",
      "manifest.artifacts[0].bytes must be greater than zero",
      "manifest.artifacts[1].sha256 is required",
      "manifest.artifacts[1].bytes is required",
      "policy-decision.reason is required when status is unknown",
      "knowledge-results.results[0].source_refs must contain at least one source reference",
    ]));

    const auditVector = JSON.parse(
      await readFile(join(specDir, "test-vectors", "OS-AUDIT-001.json"), "utf-8"),
    ) as {
      expected_conformance: string;
      expected_review_level: string;
      proof_manifest: { artifacts: Array<{ path: string; sha256: string; bytes: number }> };
      verify_results: { results: Array<{ reviewer_agent_id: string; event_seq: number }> };
      policy_decision: { decisions: Array<{ reason: string }> };
      governance_results: { status: string };
      knowledge_results: { chunks: string[] };
    };
    expect(auditVector.expected_conformance).toBe("L4");
    expect(auditVector.expected_review_level).toBe("L3");
    expect(auditVector.verify_results.results[0]?.reviewer_agent_id).toBe("local-verifier");
    expect(auditVector.verify_results.results[0]?.event_seq).toBe(8);
    expect(auditVector.policy_decision.decisions[0]?.reason).toContain("matched code.test capability");
    expect(auditVector.governance_results.status).toBe("pass");
    expect(auditVector.knowledge_results.chunks).toContain("proof-checksum-pack");
    expect(auditVector.proof_manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "checker-output/task-audit-001-local-verifier.txt",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
      }),
      expect.objectContaining({
        path: "worktree-status.json",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
      }),
    ]));

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
