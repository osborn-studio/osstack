import { describe, expect, it } from "vitest";
import {
  evaluateKanbanTransitionGuards,
  type KanbanTransitionGuard,
  type KanbanTransitionGuardInput,
} from "./transition-guard.js";

const input: KanbanTransitionGuardInput = {
  cardId: "card-1",
  from: "ready",
  to: "running",
  workspacePath: "/workspace",
};

describe("evaluateKanbanTransitionGuards", () => {
  it("is byte-compatible by default when no guards are registered", async () => {
    await expect(evaluateKanbanTransitionGuards([], input)).resolves.toEqual({
      allow: true,
      decisions: [],
    });
  });

  it("evaluates every guard before denying in registration order", async () => {
    const evaluated: string[] = [];
    const guards: KanbanTransitionGuard[] = [
      {
        id: "deny-first",
        evaluate: async () => {
          evaluated.push("deny-first");
          return { allow: false, reason: "readiness denied", evidenceRefs: ["ledger.json"] };
        },
      },
      {
        id: "allow-second",
        evaluate: async () => {
          evaluated.push("allow-second");
          return { allow: true, reason: "checks passed", evidenceRefs: [] };
        },
      },
    ];

    await expect(evaluateKanbanTransitionGuards(guards, input)).resolves.toEqual({
      allow: false,
      decisions: [
        { guardId: "deny-first", allow: false, reason: "readiness denied", evidenceRefs: ["ledger.json"] },
        { guardId: "allow-second", allow: true, reason: "checks passed", evidenceRefs: [] },
      ],
    });
    expect(evaluated.sort()).toEqual(["allow-second", "deny-first"]);
  });

  it("turns a guard exception into a fail-closed decision without skipping peers", async () => {
    let peerEvaluated = false;
    const guards: KanbanTransitionGuard[] = [
      { id: "broken", evaluate: async () => { throw new Error("unavailable"); } },
      {
        id: "peer",
        evaluate: async () => {
          peerEvaluated = true;
          return { allow: true, reason: "ok", evidenceRefs: [] };
        },
      },
    ];

    const result = await evaluateKanbanTransitionGuards(guards, input);
    expect(result).toMatchObject({
      allow: false,
      decisions: [
        { guardId: "broken", allow: false, reason: "guard error: unavailable" },
        { guardId: "peer", allow: true },
      ],
    });
    expect(peerEvaluated).toBe(true);
  });
});
