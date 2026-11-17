import { expect, it } from "vitest";
import { DecisionsListParams, DecisionsListResult, PendingDecision } from "./decisions.js";
it("validates bounded decision list requests and rejects unknown fields", () => {
  expect(DecisionsListParams.parse({})).toEqual({ limit: 50 });
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { scope_id: "bad" }, { cursor: "x".repeat(2049) }, { notify: true }]) expect(DecisionsListParams.safeParse(input).success).toBe(false);
});
it("requires the uniform result shape and single line summaries", () => {
  expect(DecisionsListResult.parse({ items: [], failures: [], next_cursor: null }).items).toEqual([]);
  const item = { source: "session", source_id: "s", scope_id: null, waiting_since: null, summary: "Review", allowed_answers: [], answer_command: { name: "attention.answer", required_params: [] }, requires_local_signature: false, source_revision: null };
  expect(PendingDecision.safeParse(item).success).toBe(true);
  expect(PendingDecision.safeParse({ ...item, summary: "bad\nline" }).success).toBe(false);
  expect(PendingDecision.safeParse({ ...item, source: "unknown" }).success).toBe(false);
});
