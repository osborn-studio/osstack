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
it("requires answer credentials, identity and source revision", async () => {
  const { DecisionsAnswerParams, DecisionsAnswerResult } = await import("./decisions.js");
  const request = { credential: "c".repeat(32), source: "hermes", source_id: "approval:a", answer: "choice", params: { choice: "yes" }, answer_id: "client:1", source_revision: "a".repeat(64) };
  expect(DecisionsAnswerParams.parse(request)).toEqual(request);
  for (const field of ["credential", "answer_id", "source_revision"]) {
    expect(DecisionsAnswerParams.safeParse({ ...request, [field]: undefined }).success).toBe(false);
  }
  expect(DecisionsAnswerResult.safeParse({ accepted: false, replay: false, outcome: "local_only", code: "local_only", current: { state: "pending", item: null }, local_command: "autonomy approve" }).success).toBe(true);
});

it("appends probe to the source order and permits one failure for each source", async () => {
  const { DecisionSource } = await import("./decisions.js");
  expect(DecisionSource.options.at(-1)).toBe("probe");
  const failures = DecisionSource.options.map(source => ({ source, code: "read_failed" }));
  const page = { items: [], failures, next_cursor: null };
  expect(DecisionsListResult.parse(page).failures).toHaveLength(8);
  expect(DecisionsListResult.safeParse({ ...page, failures: [...failures, failures[0]] }).success).toBe(false);
});

it("uses strict credentialed try requests and exposes only public card fields", async () => {
  const { DecisionsTryCreateParams, DecisionsTryStatusParams, DecisionsTryContinueParams, DecisionsTryResult } = await import("./decisions.js");
  const credential = "c".repeat(32), probe_id = "a".repeat(32);
  expect(DecisionsTryCreateParams.safeParse({ credential, summary: "custom" }).success).toBe(false);
  for (const schema of [DecisionsTryStatusParams, DecisionsTryContinueParams]) {
    expect(schema.safeParse({ credential, probe_id }).success).toBe(true);
    expect(schema.safeParse({ credential, probe_id, answer: "green" }).success).toBe(false);
  }
  const card = { probe_id, state: "expired", revision: 1, created_at: 1, expires_at: 3600001, answer: null, continued_at: null };
  expect(DecisionsTryResult.parse(card)).toEqual(card);
  expect(DecisionsTryResult.safeParse({ ...card, created_by: "owner" }).success).toBe(false);
});
