import { describe, expect, it } from "vitest";
import { createKnowledgeHygieneFingerprint } from "./fingerprint.js";

describe("createKnowledgeHygieneFingerprint", () => {
  it("is stable across line and human-message changes", () => {
    const first = createKnowledgeHygieneFingerprint({
      schema_version: "1",
      rule_id: "reference.markdown_target_missing",
      rule_version: "1",
      repo_identity: "repo-1",
      location: { path: "./docs\\guide.md", anchor: "target:missing.md", line: 4 },
      rationale: "first wording",
    });
    const second = createKnowledgeHygieneFingerprint({
      schema_version: "1",
      rule_id: "reference.markdown_target_missing",
      rule_version: "1",
      repo_identity: "repo-1",
      location: { path: "docs/guide.md", anchor: "target:missing.md", line: 99 },
      rationale: "different wording",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^khf_[a-f0-9]{64}$/);
  });

  it("changes when the semantic identity changes", () => {
    const base = {
      schema_version: "1" as const,
      rule_id: "reference.markdown_target_missing" as const,
      rule_version: "1",
      repo_identity: "repo-1",
      location: { path: "docs/guide.md", anchor: "target:one.md" },
    };

    expect(createKnowledgeHygieneFingerprint(base)).not.toBe(
      createKnowledgeHygieneFingerprint({
        ...base,
        location: { ...base.location, anchor: "target:two.md" },
      }),
    );
  });
});
