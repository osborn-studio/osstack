import { expect, it } from "vitest";
import {
  FollowUpDeliveryPrepareParams,
  FollowUpDeliveryActionParams,
  FollowUpDeliveryListParams,
} from "./follow-up-delivery.js";
const scope = { repo_path: "/repo", default_tenant: true as const };
const prepare = {
  ...scope,
  obligation_id: "11111111-1111-4111-8111-111111111111",
  expected_obligation_revision: 1,
  destination_ref: "thread",
  body: "Exact body",
  idempotency_key: "once",
};
it.each([
  "x\ud800",
  "x\udfff",
  "\0\u009b\u200b",
  "é".repeat(8001),
])("rejects non-canonical UTF-8, invisible or oversized text", (body) => {
  expect(FollowUpDeliveryPrepareParams.safeParse({ ...prepare, body }).success).toBe(false);
});
it("preserves valid Unicode, whitespace and exact content without normalization", () => {
  const body = " e\u0301 😀\r\n";
  expect(FollowUpDeliveryPrepareParams.parse({ ...prepare, body }).body).toBe(body);
});
it("rejects caller authority and receipts on action requests", () => {
  const action = { ...scope, attempt_id: prepare.obligation_id, expected_revision: 1 };
  for (const extra of [
    { delivered: true },
    { receipt: {} },
    { approved: true },
    { transport: "production" },
    { actor: "human" },
  ])
    expect(FollowUpDeliveryActionParams.safeParse({ ...action, ...extra }).success).toBe(false);
});
it("requires explicit scope and bounds page limits", () => {
  expect(FollowUpDeliveryListParams.safeParse({ repo_path: "/repo" }).success).toBe(false);
  for (const limit of [0, 51, 1.5, Infinity])
    expect(FollowUpDeliveryListParams.safeParse({ ...scope, limit }).success).toBe(false);
  expect(FollowUpDeliveryListParams.parse(scope).limit).toBe(20);
});
it("normalizes only pagination UUID case and preserves explicitly reviewed BOM/control body data", () => {
  const after_id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  expect(FollowUpDeliveryListParams.parse({ ...scope, after_id }).after_id).toBe(after_id.toLowerCase());
  const body = "\uFEFFexplicit\u009b\u200b";
  expect(FollowUpDeliveryPrepareParams.parse({ ...prepare, body }).body).toBe(body);
});
