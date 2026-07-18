import { describe, expect, it } from "vitest";
import {
  KnowledgeHygienePatchActionV1,
  KnowledgeHygienePatchPlanV1,
} from "./patch-types.js";

const fingerprint = `khf_${"a".repeat(64)}`;
const diffId = `diff_${"b".repeat(64)}`;
const actionId = `kha_${"c".repeat(64)}`;
const patchId = `khp_${"d".repeat(64)}`;
const afterSha = "e".repeat(64);

function sourceFinding() {
  return {
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
    evidence_refs: [],
    remediation: {
      mode: "safe_patch",
      action_id: "create_import_mirror:CLAUDE.md",
    },
  };
}

function action() {
  return {
    schema_version: "1",
    action_id: actionId,
    kind: "create_instruction_import",
    risk: "low",
    policy_category: "docs",
    target_path: "CLAUDE.md",
    before: { exists: false, sha256: null },
    after: { content: "@AGENTS.md\n", sha256: afterSha },
    source_fingerprint: fingerprint,
    source_finding: sourceFinding(),
    evidence_refs: [],
  };
}

describe("knowledge hygiene patch contracts", () => {
  it("accepts the one approved create-instruction-import action", () => {
    expect(KnowledgeHygienePatchActionV1.parse(action())).toEqual(action());
    expect(KnowledgeHygienePatchPlanV1.parse({
      schema_version: "1",
      patch_id: patchId,
      generated_at: "2026-07-17T00:00:00.000Z",
      repo: { root: "/repo", repo_id: "repo" },
      diff_id: diffId,
      actions: [action()],
    })).toBeTruthy();
  });

  it.each(["/tmp/CLAUDE.md", "../CLAUDE.md", "docs/../../CLAUDE.md"])(
    "rejects outside-root target %s",
    (targetPath) => {
      expect(KnowledgeHygienePatchActionV1.safeParse({
        ...action(),
        target_path: targetPath,
      }).success).toBe(false);
    },
  );

  it("requires explicit before existence and hash state", () => {
    expect(KnowledgeHygienePatchActionV1.safeParse({
      ...action(),
      before: { exists: false },
    }).success).toBe(false);
    expect(KnowledgeHygienePatchActionV1.safeParse({
      ...action(),
      before: { exists: true, sha256: afterSha },
    }).success).toBe(false);
  });

  it("rejects unapproved action kinds and source-fingerprint mismatch", () => {
    expect(KnowledgeHygienePatchActionV1.safeParse({
      ...action(),
      kind: "replace_instruction_file",
    }).success).toBe(false);
    expect(KnowledgeHygienePatchActionV1.safeParse({
      ...action(),
      source_fingerprint: `khf_${"f".repeat(64)}`,
    }).success).toBe(false);
  });
});
