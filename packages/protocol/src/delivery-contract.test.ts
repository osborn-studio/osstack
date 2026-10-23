import { expect, it } from "vitest";
import { DeliveryContractV2 } from "./delivery-contract.js";
const value = () => ({ schema_version: 2, contract_id: "c", task_id: "t", canonical_repo: "/repo", mode: "implement",
  base_head: "a".repeat(40), goal: "Fix", required_checks: [{ id: "test", registry_ref: `sha256:${"b".repeat(64)}` }],
  review_policy_ref: "profile:guarded", requested_completion: "local_verified", allowed_paths: ["src"],
  requested_actions: ["build", "verify"], budget_ref: "policy", policy_digest: "b".repeat(64),
  publication_scope: { mode: "none" }, merge_authority: { mode: "none" } });
it("accepts strict V2 local contracts without authorizing their declared scope", () => {
  expect(DeliveryContractV2.parse(value()).schema_version).toBe(2);
  expect(() => DeliveryContractV2.parse({ ...value(), reviewed: true })).toThrow();
  expect(() => DeliveryContractV2.parse({ ...value(), schema_version: 1 })).toThrow();
  expect(() => DeliveryContractV2.parse({ ...value(), requested_actions: ["verify"] })).toThrow();
});
it("rejects duplicate checks and scout writes or publication", () => {
  const c = value();
  expect(() => DeliveryContractV2.parse({ ...c, required_checks: [...c.required_checks, ...c.required_checks] })).toThrow();
  expect(() => DeliveryContractV2.parse({ ...c, mode: "scout" })).toThrow();
  expect(DeliveryContractV2.parse({ ...c, mode: "scout", requested_actions: ["verify"] }).mode).toBe("scout");
  expect(() => DeliveryContractV2.parse({ ...c, allowed_paths: ["../outside"] })).toThrow();
});
it("PR-only forbids merge and merge authority references cannot cite another policy", () => {
  const c = { ...value(), requested_completion: "pr_opened", publication_scope: { mode: "draft_pr", hostname: "github.com",
    repository: "owner/repo", remote: "origin", base_ref: "main", head_ref: "codex/work" } };
  expect(DeliveryContractV2.parse(c).requested_completion).toBe("pr_opened");
  expect(() => DeliveryContractV2.parse({ ...c, requested_actions: ["merge"] })).toThrow();
  expect(() => DeliveryContractV2.parse({ ...c, requested_completion: "merged", publication_scope: { ...c.publication_scope, mode: "review_pr" },
    merge_authority: { mode: "existing_guarded_policy", policy_ref: `sha256:${"c".repeat(64)}` } })).toThrow();
});
