import { expect, it } from "vitest";
import { FollowUpCreateParams, FollowUpResolveParams } from "./follow-up.js";
const input = { repo_path: "/repo", default_tenant: true, source_session_id: "s", expected_source_version: 1,
  idempotency_key: "once", actor: "local operator", promise: "Review outcome locally", destination_ref: "local_operator", resolution_condition: "session_completed" };
it("requires explicit default tenant and an exact local destination", () => {
  expect(FollowUpCreateParams.parse(input)).toMatchObject(input);
  for (const patch of [{ default_tenant: false }, { default_tenant: undefined }, { destination_ref: "https://example.invalid" }, { promise: " " }, { promise: "中".repeat(2000) }, { due_at: Infinity }, { expected_source_version: 1.5 }])
    expect(FollowUpCreateParams.safeParse({ ...input, ...patch }).success).toBe(false);
});
it("does not accept external receipt claims or draft as resolution", () => {
  const base = { repo_path: "/repo", default_tenant: true, obligation_id: "c063e75f-8f3b-4b54-9eb8-e464b7f17bb7", expected_revision: 1, actor: "operator", reason: "No longer needed" };
  expect(FollowUpResolveParams.parse({ ...base, mode: "waive" })).toMatchObject({ mode: "waive" });
  for (const mode of ["draft", "delivered", "external_delivered"]) expect(FollowUpResolveParams.safeParse({ ...base, mode }).success).toBe(false);
  expect(FollowUpResolveParams.safeParse({ ...base, mode: "waive", provider_receipt: "file:///local" }).success).toBe(false);
});
it("rejects operator fields with no visible content", () => {
  for (const invisible of ["\u0000", "\u200b", "\u2060", "\r\n\t"]) {
    expect(FollowUpCreateParams.safeParse({ ...input, promise: invisible }).success).toBe(false);
    expect(FollowUpCreateParams.safeParse({ ...input, actor: invisible }).success).toBe(false);
  }
});
