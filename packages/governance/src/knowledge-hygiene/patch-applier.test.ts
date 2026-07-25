import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKnowledgeHygieneConfigV1 } from "./config.js";
import {
  applyKnowledgeHygienePatchPlan,
  type KnowledgeHygienePatchConflictError,
} from "./patch-applier.js";
import { planKnowledgeHygienePatches } from "./patch-provider.js";
import { KnowledgeHygieneReportV1 } from "./types.js";

const now = () => new Date("2026-07-17T01:00:00.000Z");

function report(root: string, target = "CLAUDE.md") {
  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: "2026-07-17T00:00:00.000Z",
    repo: { root, repo_id: "repo" },
    input: { mode: "worktree", diff_id: `diff_${"b".repeat(64)}` },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
    findings: [{
      fingerprint: `khf_${"a".repeat(64)}`,
      rule_id: "instruction.mirror_missing",
      rule_version: "1",
      surface: "instruction",
      severity: "warning",
      confidence: "high",
      location: { path: target },
      observed: { exists: false },
      expected: { exists: true, mode: "import" },
      rationale: "The configured instruction mirror is missing.",
      evidence_refs: [],
      remediation: { mode: "safe_patch" },
    }],
    metrics: [],
  });
}

function config(target = "CLAUDE.md") {
  return parseKnowledgeHygieneConfigV1(`version: 1
instructions:
  canonical: AGENTS.md
  mirrors:
    - path: ${target}
      mode: import
`);
}

async function plan(root: string, target = "CLAUDE.md") {
  return planKnowledgeHygienePatches({
    report: report(root, target),
    config: config(target),
  }, { now });
}

describe("knowledge hygiene patch applier", () => {
  it("creates atomically and records before/after hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-apply-"));
    await writeFile(join(root, "AGENTS.md"), "# Canonical\n");
    const patch = await plan(root);

    const result = await applyKnowledgeHygienePatchPlan(patch, { now });

    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(result).toMatchObject({
      patch_id: patch.patch_id,
      actions: [{
        action_id: patch.actions[0]?.action_id,
        status: "applied",
        before: { exists: false, sha256: null },
        after: { exists: true, sha256: patch.actions[0]?.after.sha256 },
      }],
    });
    expect((await readdir(root)).sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("is idempotent when the exact action is applied again", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-apply-"));
    await writeFile(join(root, "AGENTS.md"), "# Canonical\n");
    const patch = await plan(root);
    await applyKnowledgeHygienePatchPlan(patch, { now });

    const repeated = await applyKnowledgeHygienePatchPlan(patch, { now });

    expect(repeated.actions).toEqual([expect.objectContaining({
      status: "already_applied",
      before: {
        exists: true,
        sha256: patch.actions[0]?.after.sha256,
      },
    })]);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("refuses changed target state without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-apply-"));
    await writeFile(join(root, "AGENTS.md"), "# Canonical\n");
    const patch = await plan(root);
    await writeFile(join(root, "CLAUDE.md"), "preserve me\n");

    await expect(applyKnowledgeHygienePatchPlan(patch, { now }))
      .rejects.toMatchObject({ code: "target_changed" } as KnowledgeHygienePatchConflictError);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("preserve me\n");
  });

  it("refuses a parent symlink that escapes the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-apply-"));
    const outside = await mkdtemp(join(tmpdir(), "osstack-neat-outside-"));
    await writeFile(join(root, "AGENTS.md"), "# Canonical\n");
    await symlink(outside, join(root, "links"));
    const patch = await plan(root, "links/CLAUDE.md");

    await expect(applyKnowledgeHygienePatchPlan(patch, { now }))
      .rejects.toMatchObject({ code: "parent_outside_repo" } as KnowledgeHygienePatchConflictError);
    await expect(readFile(join(outside, "CLAUDE.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
