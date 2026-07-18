import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKnowledgeHygieneConfigV1 } from "./config.js";
import {
  planKnowledgeHygienePatches,
  type KnowledgeHygienePatchProviderError,
} from "./patch-provider.js";
import { KnowledgeHygieneReportV1 } from "./types.js";

const fingerprint = `khf_${"a".repeat(64)}`;
const diffId = `diff_${"b".repeat(64)}`;
const now = () => new Date("2026-07-17T00:00:00.000Z");

function report(root: string) {
  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: "2026-07-17T00:00:00.000Z",
    repo: { root, repo_id: "repo" },
    input: { mode: "worktree", diff_id: diffId },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
    findings: [{
      fingerprint,
      rule_id: "instruction.mirror_missing",
      rule_version: "1",
      surface: "instruction",
      severity: "warning",
      confidence: "high",
      location: { path: "CLAUDE.md", anchor: "mirror:CLAUDE.md" },
      observed: { exists: false },
      expected: { exists: true, mode: "import" },
      rationale: "The configured instruction mirror is missing.",
      evidence_refs: [{ kind: "proof", ref: "AGENTS.md" }],
      remediation: {
        mode: "safe_patch",
        action_id: "create_import_mirror:CLAUDE.md",
      },
    }],
    metrics: [],
  });
}

function config(mode: "import" | "symlink" | "import_or_symlink" = "import") {
  return parseKnowledgeHygieneConfigV1(`version: 1
instructions:
  canonical: AGENTS.md
  mirrors:
    - path: CLAUDE.md
      mode: ${mode}
`);
}

describe("knowledge hygiene patch provider", () => {
  it("previews an exact one-line import with stable hashes and source evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-patch-"));
    await writeFile(join(root, "AGENTS.md"), "# Canonical\n");

    const first = await planKnowledgeHygienePatches({
      report: report(root),
      config: config(),
    }, { now });
    const second = await planKnowledgeHygienePatches({
      report: report(root),
      config: config(),
    }, { now });

    expect(second).toEqual(first);
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0]).toMatchObject({
      kind: "create_instruction_import",
      target_path: "CLAUDE.md",
      before: { exists: false, sha256: null },
      after: {
        content: "@AGENTS.md\n",
        sha256: createHash("sha256").update("@AGENTS.md\n").digest("hex"),
      },
      source_fingerprint: fingerprint,
      source_finding: report(root).findings[0],
      evidence_refs: [{ kind: "proof", ref: "AGENTS.md" }],
    });
  });

  it("refuses an existing target instead of planning replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-patch-"));
    await writeFile(join(root, "AGENTS.md"), "# Canonical\n");
    await writeFile(join(root, "CLAUDE.md"), "preserve me\n");

    await expect(planKnowledgeHygienePatches({
      report: report(root),
      config: config(),
    }, { now })).rejects.toMatchObject({
      code: "target_exists",
    } as KnowledgeHygienePatchProviderError);
  });

  it("refuses unsupported symlink mode and a missing canonical source", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-patch-"));
    await writeFile(join(root, "AGENTS.md"), "# Canonical\n");
    await expect(planKnowledgeHygienePatches({
      report: report(root),
      config: config("symlink"),
    }, { now })).rejects.toMatchObject({
      code: "unsupported_mirror_mode",
    } as KnowledgeHygienePatchProviderError);

    const missingRoot = await mkdtemp(join(tmpdir(), "osstack-neat-patch-"));
    await expect(planKnowledgeHygienePatches({
      report: report(missingRoot),
      config: config(),
    }, { now })).rejects.toMatchObject({
      code: "canonical_unavailable",
    } as KnowledgeHygienePatchProviderError);
  });

  it("returns an empty stable preview when no finding is eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-patch-"));
    const clean = KnowledgeHygieneReportV1.parse({
      ...report(root),
      summary: { error: 0, warning: 0, info: 0, suppressed: 0 },
      findings: [],
    });

    await expect(planKnowledgeHygienePatches({
      report: clean,
      config: config(),
    }, { now })).resolves.toMatchObject({ actions: [] });
  });
});
