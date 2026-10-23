import { expect, it } from "vitest";
import {
  deliveryContract,
  promoteScout,
  verifyDeliveryContract,
  acceptAttentionTriage,
  budgetAttentionContext,
} from "./attention-planning.js";
const input = {
  version: 1,
  contract_id: "a",
  parent_contract_id: null,
  mode: "scout",
  repo_path: "/repo",
  head: "a".repeat(40),
  goal: "test",
  required_verification: ["unit"],
  review_required: true,
  completion: "local_verified",
};
it("promotes scout to a new contract without reusing authority or verification", () => {
  const a = deliveryContract(input);
  const b = promoteScout(input, "b".repeat(40));
  expect(b.contract.contract_id).not.toBe("a");
  expect(b.contract.parent_contract_id).toBe("a");
  expect(() =>
    verifyDeliveryContract(input, {
      digest: a.digest,
      mode: "implement",
      head: input.head,
      passed: ["unit"],
      reviewed: true,
      completion: "local_verified",
    })
  ).toThrow("identity");
  expect(() =>
    verifyDeliveryContract(input, {
      digest: a.digest,
      mode: "scout",
      head: input.head,
      passed: [],
      reviewed: true,
      completion: "local_verified",
    })
  ).toThrow("required");
});
it("does not permit model output to add tools, actions or authority", () => {
  const fallback = {
    category: "source_uncertain" as const,
    explanation: "unknown",
  };
  expect(
    acceptAttentionTriage(
      { category: "human_decision", explanation: "send", action: "answer" },
      1,
      fallback
    ).used
  ).toBe(false);
  expect(acceptAttentionTriage(fallback, 0, fallback).used).toBe(false);
});
it("budgets bytes, expires evidence and exposes omitted required context", () => {
  const result = budgetAttentionContext(
    [
      {
        id: "a",
        text: "12345",
        tier: "required",
        verified_at: 1,
        expires_at: 100,
      },
      { id: "b", text: "old", tier: "task", verified_at: 1, expires_at: 2 },
    ],
    4,
    10
  );
  expect(result.required_omitted).toEqual(["a"]);
  expect(result.selected).toEqual([]);
  expect(result.promote_memory).toBe(false);
});
