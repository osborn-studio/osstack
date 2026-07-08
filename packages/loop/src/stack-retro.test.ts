import { describe, expect, it } from "vitest";
import {
  renderStackRetro,
  type StackRetroCard,
  type StackRetroInput,
} from "./stack-retro.js";

function card(overrides: Partial<StackRetroCard> = {}): StackRetroCard {
  return {
    cardId: "pr-47",
    title: "#47 Add base layer",
    cardType: "pr",
    status: "done",
    assignee: "claude-code",
    checks: [{ label: "CI green", state: "pass" }],
    reworkCount: 0,
    ...overrides,
  };
}

describe("renderStackRetro (pure)", () => {
  it("cites which checks caught issues", () => {
    const input: StackRetroInput = {
      board: "stack",
      cards: [
        card({
          cardId: "pr-48",
          title: "#48 UI layer",
          status: "blocked",
          checks: [
            { label: "CI green", state: "pass" },
            { label: "endpoint/UI smoke", state: "fail" },
          ],
        }),
      ],
    };

    const result = renderStackRetro(input);

    expect(result.caughtIssues).toContainEqual({
      cardId: "pr-48",
      label: "endpoint/UI smoke",
    });
    expect(result.markdown).toContain("## What The Checks Caught");
    expect(result.markdown).toContain("- pr-48: endpoint/UI smoke failed");
    expect(result.missingGates.length).toBeGreaterThan(0);
  });

  it("clean run reports no failing checks", () => {
    const input: StackRetroInput = {
      board: "stack",
      cards: [
        card({ cardId: "pr-47", checks: [{ label: "CI green", state: "pass" }] }),
        card({ cardId: "pr-48", checks: [{ label: "suite green", state: "pass" }] }),
      ],
    };

    const result = renderStackRetro(input);

    expect(result.caughtIssues).toEqual([]);
    expect(result.markdown).toContain("## What The Checks Caught");
    expect(result.markdown).toContain("- No failing checks recorded.");
    expect(result.missingGates).toEqual([]);
    expect(result.memoryFactText.startsWith("retro(")).toBe(true);
    expect(result.memoryFactText).toContain("clean run");
  });

  it("summary counts done/blocked and checks", () => {
    const input: StackRetroInput = {
      board: "stack",
      cards: [
        card({
          cardId: "pr-47",
          status: "done",
          checks: [
            { label: "CI green", state: "pass" },
            { label: "suite green", state: "pass" },
          ],
        }),
        card({
          cardId: "pr-48",
          status: "blocked",
          checks: [{ label: "CI green", state: "fail" }],
        }),
      ],
    };

    const result = renderStackRetro(input);

    expect(result.markdown).toContain("## Summary");
    expect(result.markdown).toContain("- Cards: 2 (1 done, 1 blocked)");
    expect(result.markdown).toContain("- Checks: 2/3 passed");
  });

  it("rework is listed", () => {
    const input: StackRetroInput = {
      board: "stack",
      cards: [card({ cardId: "pr-47", reworkCount: 2 })],
    };

    const result = renderStackRetro(input);

    expect(result.markdown).toContain("## Rework");
    expect(result.markdown).toContain("- pr-47 reworked 2×");
  });
});
