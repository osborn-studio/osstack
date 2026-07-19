import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildKnowledgeHygieneTransactionPlanV1 } from "./transaction-builder.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function common() {
  return {
    kind: "memory" as const,
    revision: 1,
    created_at: "2026-07-18T00:00:00.000Z",
    expires_at: "2026-07-19T00:00:00.000Z",
    repo: {
      repo_id: "repo-1",
      root_realpath: "/repo",
      base_revision: "HEAD",
      fingerprint: digest("repo"),
    },
    memory_root: {
      root_realpath: "/memory",
      fingerprint: digest("memory"),
    },
    evidence_refs: [],
  };
}

describe("knowledge hygiene transaction builder", () => {
  it("builds a byte-conserving move preview", () => {
    const plan = buildKnowledgeHygieneTransactionPlanV1({
      ...common(),
      snapshots: [
        { root_id: "memory", path: "MEMORY.md", content_utf8: "alpha\nbeta\n", mode: 0o644 },
        { root_id: "repo", path: "docs/knowledge.md", content_utf8: "# Knowledge\n", mode: 0o644 },
      ],
      drafts: [{
        kind: "move",
        source: { root_id: "memory", path: "MEMORY.md", start_line: 1, end_line: 1 },
        target: { root_id: "repo", path: "docs/knowledge.md", placement: "after" },
      }],
    });

    expect(plan.actions[0]).toMatchObject({ kind: "move", risk: "medium" });
    expect(plan.write_set.find((entry) => entry.root_id === "memory")?.after_utf8)
      .toBe("beta\n");
    expect(plan.write_set.find((entry) => entry.root_id === "repo")?.after_utf8)
      .toContain("alpha\n");
  });

  it("builds complete claim and discard ledgers", () => {
    const snapshots = [{
      root_id: "repo" as const,
      path: "AGENTS.md",
      content_utf8: "2026-07-18 session note\nKeep durable rule.\n",
      mode: 0o644,
    }];
    const compressed = buildKnowledgeHygieneTransactionPlanV1({
      ...common(),
      kind: "narrative",
      snapshots,
      drafts: [{
        kind: "compress",
        sources: [{ root_id: "repo", path: "AGENTS.md", start_line: 1, end_line: 1 }],
        target: { root_id: "repo", path: "AGENTS.md", placement: "replace" },
        replacement_utf8: "Keep decisions durable, not session history.\n",
      }],
    });
    expect(compressed.actions[0]).toMatchObject({
      kind: "compress",
      claims: [{ disposition: { status: "preserved" } }],
    });

    const deleted = buildKnowledgeHygieneTransactionPlanV1({
      ...common(),
      kind: "narrative",
      snapshots,
      drafts: [{
        kind: "delete",
        sources: [{ root_id: "repo", path: "AGENTS.md", start_line: 1, end_line: 1 }],
        reasons: ["Transient session history is not a durable instruction."],
      }],
    });
    expect(deleted.actions[0]).toMatchObject({
      kind: "delete",
      discards: [{ reason: "Transient session history is not a durable instruction." }],
    });
  });
});
