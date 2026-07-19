import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KnowledgeHygieneTransactionPlanV1,
  approveKnowledgeHygieneTransactionPlanV1,
  createKnowledgeHygieneTransactionPlanV1,
  renderKnowledgeHygieneTransactionPlanMarkdownV1,
} from "./transaction-plan.js";

const sha = (character: string) => character.repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function moveAction() {
  return {
    action_id: `khta_${sha("a")}`,
    kind: "move" as const,
    risk: "medium" as const,
    source: {
      root_id: "memory" as const,
      path: "MEMORY.md",
      blob_sha256: sha("b"),
      start_byte: 0,
      end_byte: 5,
      bytes_sha256: sha("c"),
      start_line: 1,
      end_line: 1,
    },
    target: {
      root_id: "repo" as const,
      path: "docs/knowledge.md",
      preimage_sha256: null,
      placement: "after" as const,
    },
  };
}

function plan() {
  return createKnowledgeHygieneTransactionPlanV1({
    kind: "memory",
    revision: 1,
    created_at: "2026-07-18T00:00:00.000Z",
    expires_at: "2026-07-19T00:00:00.000Z",
    repo: {
      repo_id: "repo-1",
      root_realpath: "/repo",
      base_revision: sha("d"),
      fingerprint: sha("e"),
    },
    memory_root: {
      root_realpath: "/memory",
      fingerprint: sha("f"),
    },
    actions: [moveAction()],
    write_set: [
      {
        root_id: "memory",
        path: "MEMORY.md",
        preimage_sha256: sha("b"),
        after_sha256: digest("after-memory"),
        after_utf8: "after-memory",
        mode: 0o644,
      },
      {
        root_id: "repo",
        path: "docs/knowledge.md",
        preimage_sha256: null,
        after_sha256: digest("after-docs"),
        after_utf8: "after-docs",
        mode: 0o644,
      },
    ],
    target_allowlist: [{
      root_id: "repo",
      path: "docs/knowledge.md",
      purpose: "documentation",
    }],
    evidence_refs: [],
  });
}

describe("knowledge hygiene transaction plan", () => {
  it("creates a strict content-addressed plan and deterministic Markdown", () => {
    const value = plan();
    expect(value.plan_id).toMatch(/^khtp_[a-f0-9]{64}$/);
    expect(KnowledgeHygieneTransactionPlanV1.parse(value)).toEqual(value);
    expect(renderKnowledgeHygieneTransactionPlanMarkdownV1(value)).toContain(
      `Plan ${value.plan_id}`,
    );
  });

  it("rejects overlapping source consumption and incomplete delete ledgers", () => {
    const value = plan();
    expect(KnowledgeHygieneTransactionPlanV1.safeParse({
      ...value,
      actions: [moveAction(), { ...moveAction(), action_id: `khta_${sha("9")}` }],
    }).success).toBe(false);
    expect(KnowledgeHygieneTransactionPlanV1.safeParse({
      ...value,
      actions: [{
        action_id: `khta_${sha("8")}`,
        kind: "delete",
        risk: "high",
        sources: [moveAction().source],
        discards: [],
      }],
    }).success).toBe(false);
  });

  it("approves move actions idempotently while requiring high-risk actions one by one", () => {
    const value = plan();
    const approved = approveKnowledgeHygieneTransactionPlanV1(value, {
      action_ids: [value.actions[0]!.action_id],
      actor: "owner",
      reason: "Reviewed the exact byte move.",
      if_revision: 1,
      local_user_id: "501",
      tty_consented_at: "2026-07-18T00:01:00.000Z",
    });
    expect(approved.state).toBe("approved");
    expect(approveKnowledgeHygieneTransactionPlanV1(approved, {
      action_ids: [value.actions[0]!.action_id],
      actor: "owner",
      reason: "Reviewed the exact byte move.",
      if_revision: 1,
      local_user_id: "501",
      tty_consented_at: "2026-07-18T00:01:00.000Z",
    })).toEqual(approved);
    expect(() => approveKnowledgeHygieneTransactionPlanV1(value, {
      action_ids: [value.actions[0]!.action_id],
      actor: "owner",
      reason: "stale",
      if_revision: 2,
      local_user_id: "501",
      tty_consented_at: "2026-07-18T00:01:00.000Z",
    })).toThrow("revision conflict");
  });
});
