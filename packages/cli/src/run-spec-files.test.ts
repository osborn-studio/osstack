import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..", "..", "..");
const specDir = join(repoRoot, "docs", "specs");

describe("OSSTACK_RUN_SPEC_V1 files", () => {
  it("defines stable clauses and L1-L4 conformance levels", async () => {
    const spec = await readFile(join(specDir, "OSSTACK_RUN_SPEC_V1.md"), "utf-8");

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
      "R-011 Versioning and Deprecation",
      "R-012 Test Vectors",
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
  });

  it("keeps schema and test vector JSON parseable with required anchors", async () => {
    const jsonFiles = [
      "schemas/task.schema.json",
      "schemas/event.schema.json",
      "schemas/loop-state.schema.json",
      "schemas/policy-decision.schema.json",
      "schemas/proof-pack-manifest.schema.json",
      "test-vectors/OS-GOV-001.json",
      "test-vectors/OS-EVID-001.json",
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
  });
});
