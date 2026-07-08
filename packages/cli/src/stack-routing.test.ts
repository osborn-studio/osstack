// Pure unit tests for recommendRouting() — deterministic agent/role/test/QA
// routing hints derived from a kanban card's type + meta, optionally
// overridden by a learned "prefer_agent" memory fact.

import { describe, expect, it } from "vitest";
import { recommendRouting } from "./stack-routing.js";

describe("recommendRouting: role", () => {
  it("routes a pr card, with no facts, to merge-manager/claude-code/targeted/no browser QA", () => {
    const hint = recommendRouting({ card_type: "pr", meta: null });

    expect(hint).toMatchObject({
      agent: "claude-code",
      role: "merge-manager",
      browserQa: false,
      tests: "targeted",
    });
    expect(hint.reasons).toContain("pr/merge card → merge-manager");
    expect(hint.reasons).toContain("no migration → targeted tests");
  });

  it("routes a merge card to merge-manager", () => {
    const hint = recommendRouting({ card_type: "merge", meta: null });
    expect(hint.role).toBe("merge-manager");
    expect(hint.reasons).toContain("pr/merge card → merge-manager");
  });

  it("routes a review card to role review", () => {
    const hint = recommendRouting({ card_type: "review", meta: null });
    expect(hint.role).toBe("review");
  });

  it("routes an implementation card to role code", () => {
    const hint = recommendRouting({ card_type: "implementation", meta: null });
    expect(hint.role).toBe("code");
  });
});

describe("recommendRouting: tests", () => {
  it("requires the full suite when meta.migration is true", () => {
    const hint = recommendRouting({ card_type: "pr", meta: { migration: true } });
    expect(hint.tests).toBe("full");
    expect(hint.reasons).toContain("migration-bearing → full suite");
  });

  it("uses targeted tests when meta.migration is absent", () => {
    const hint = recommendRouting({ card_type: "pr", meta: null });
    expect(hint.tests).toBe("targeted");
    expect(hint.reasons).toContain("no migration → targeted tests");
  });

  it("uses targeted tests when meta.migration is explicitly false", () => {
    const hint = recommendRouting({ card_type: "pr", meta: { migration: false } });
    expect(hint.tests).toBe("targeted");
  });
});

describe("recommendRouting: browserQa", () => {
  it("requires browser QA when meta.ui is true", () => {
    const hint = recommendRouting({ card_type: "implementation", meta: { ui: true } });
    expect(hint.browserQa).toBe(true);
    expect(hint.reasons).toContain("UI card → browser QA");
  });

  it("does not require browser QA when meta.ui is absent", () => {
    const hint = recommendRouting({ card_type: "implementation", meta: null });
    expect(hint.browserQa).toBe(false);
  });
});

describe("recommendRouting: agent (memory-backed preference)", () => {
  it("defaults to claude-code when no facts are supplied", () => {
    const hint = recommendRouting({ card_type: "pr", meta: null });
    expect(hint.agent).toBe("claude-code");
  });

  it("uses codex-cli when a prefer_agent/codex-cli fact is present, with a memory reason", () => {
    const hint = recommendRouting(
      { card_type: "pr", meta: null },
      [{ fact_type: "prefer_agent", fact_text: "codex-cli" }],
    );
    expect(hint.agent).toBe("codex-cli");
    expect(hint.reasons).toContain("learned preference from memory: codex-cli");
  });

  it("ignores a prefer_agent fact with a bogus agent value and stays on claude-code", () => {
    const hint = recommendRouting(
      { card_type: "pr", meta: null },
      [{ fact_type: "prefer_agent", fact_text: "bogus" }],
    );
    expect(hint.agent).toBe("claude-code");
    expect(hint.reasons).not.toContain("learned preference from memory: bogus");
  });

  it("uses the LAST matching prefer_agent fact when multiple are present", () => {
    const hint = recommendRouting(
      { card_type: "pr", meta: null },
      [
        { fact_type: "prefer_agent", fact_text: "codex-cli" },
        { fact_type: "prefer_agent", fact_text: "claude-code" },
      ],
    );
    expect(hint.agent).toBe("claude-code");
    expect(hint.reasons).toContain("learned preference from memory: claude-code");
  });

  it("ignores facts with a different fact_type", () => {
    const hint = recommendRouting(
      { card_type: "pr", meta: null },
      [{ fact_type: "some_other_fact", fact_text: "codex-cli" }],
    );
    expect(hint.agent).toBe("claude-code");
  });
});
