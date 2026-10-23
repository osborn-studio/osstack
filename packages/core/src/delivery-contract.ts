import { createHash } from "node:crypto";
import {
  DeliveryContractV2, FrozenDeliveryContractV2, DeliveryVerificationReceiptV2,
  type DeliveryCandidateIdentityV2,
} from "@osstack/protocol";

export function deliveryContractDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, val]) => [key, canonical(val)]));
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function deliveryCheckReference(command: string): string {
  return `sha256:${createHash("sha256").update(command).digest("hex")}`;
}
/** Canonicalization is pure: callers must separately resolve workspace/policy authority. */
export function freezeDeliveryContract(value: unknown): FrozenDeliveryContractV2 {
  const parsed = DeliveryContractV2.parse(value);
  const contract = { ...parsed,
    required_checks: [...parsed.required_checks].sort((a, b) => a.id.localeCompare(b.id, "en")),
    allowed_paths: [...new Set(parsed.allowed_paths)].sort(),
    requested_actions: [...new Set(parsed.requested_actions)].sort(),
  };
  const digest = deliveryContractDigest(contract);
  return FrozenDeliveryContractV2.parse({ contract, digest, brief: [
    `Delivery contract V2: ${contract.contract_id} (${digest})`,
    `Mode: ${contract.mode}`, `Goal: ${contract.goal}`, `Repository: ${contract.canonical_repo}`,
    `Base: ${contract.base_head}`, `Completion ceiling: ${contract.requested_completion}`,
    `Paths: ${contract.allowed_paths.join(", ")}`, `Actions: ${contract.requested_actions.join(", ")}`,
    `Required checks: ${contract.required_checks.map((check) => `${check.id}=${check.registry_ref}`).join(", ")}`,
    `Policy: ${contract.policy_digest}`, "This contract does not grant execution, publication or merge authority.",
  ].join("\n") });
}
export function assertFrozenDeliveryContract(value: unknown): FrozenDeliveryContractV2 {
  const input = FrozenDeliveryContractV2.parse(value);
  const expected = freezeDeliveryContract(input.contract);
  if (expected.digest !== input.digest || expected.brief !== input.brief) throw new Error("delivery_contract_digest_mismatch");
  return expected;
}
/** References select already accepted host/CLI commands; contract text never becomes shell. */
export function resolveDeliveryContractChecks(frozen: FrozenDeliveryContractV2, acceptedCommands: readonly string[]) {
  const { contract } = assertFrozenDeliveryContract(frozen);
  const registry = new Map(acceptedCommands.map((command) => [deliveryCheckReference(command), command]));
  return contract.required_checks.map((check) => {
    const command = registry.get(check.registry_ref);
    if (command === undefined) throw new Error(`delivery_check_not_registered:${check.id}`);
    return { ...check, command };
  });
}
export function assertDeliveryContractAdmission(frozen: FrozenDeliveryContractV2, input: {
  canonicalRepo: string; baseHead: string; taskId: string; goal: string; policyDigest: string;
  reviewPolicyRef: string; acceptedCommands: readonly string[];
}): void {
  const { contract } = assertFrozenDeliveryContract(frozen);
  if (contract.mode === "scout") throw new Error("delivery_scout_tool_guarantee_unavailable");
  if (contract.canonical_repo !== input.canonicalRepo || contract.base_head !== input.baseHead
    || contract.task_id !== input.taskId || contract.goal !== input.goal || contract.policy_digest !== input.policyDigest
    || contract.budget_ref !== `policy:${input.policyDigest}` || contract.review_policy_ref !== input.reviewPolicyRef) throw new Error("delivery_contract_admission_mismatch");
  resolveDeliveryContractChecks(frozen, input.acceptedCommands);
}
export function assertDeliveryContractPaths(frozen: FrozenDeliveryContractV2, paths: readonly string[]): void {
  const { contract } = assertFrozenDeliveryContract(frozen);
  if (paths.some((path) => !contract.allowed_paths.some((allowed) => path === allowed || path.startsWith(`${allowed.replace(/\/$/, "")}/`))))
    throw new Error("delivery_contract_path_outside_scope");
}
/** Only use after a trusted host has loaded its persisted receipt by digest.
 * Independence follows the existing profile rule: different adapter IDs and
 * different provider OR model, based on reported metadata, not provider attestation.
 * Parsing or calling this function on arbitrary JSON does not confer provenance. */
export function verifyDeliveryContractReceipt(frozen: FrozenDeliveryContractV2, value: unknown, expected: {
  runId: string; candidate: DeliveryCandidateIdentityV2; policyDigest: string;
}): DeliveryVerificationReceiptV2 {
  const { contract, digest } = assertFrozenDeliveryContract(frozen);
  const receipt = DeliveryVerificationReceiptV2.parse(value);
  if (receipt.contract_digest !== digest || receipt.run_id !== expected.runId || receipt.task_id !== contract.task_id
    || receipt.policy_digest !== expected.policyDigest || receipt.policy_digest !== contract.policy_digest
    || receipt.candidate.base_head !== contract.base_head
    || deliveryContractDigest(receipt.candidate) !== deliveryContractDigest(expected.candidate)) throw new Error("delivery_receipt_binding_mismatch");
  if (new Set(receipt.checks.map((check) => check.id)).size !== receipt.checks.length) throw new Error("delivery_duplicate_receipt_check");
  for (const required of contract.required_checks) {
    const check = receipt.checks.find((item) => item.id === required.id && item.registry_ref === required.registry_ref);
    if (check?.exit_code !== 0 || `sha256:${check.command_digest}` !== required.registry_ref) throw new Error("delivery_required_check_failed");
  }
  if (receipt.checks.some((check) => check.exit_code !== 0)) throw new Error("delivery_host_check_failed");
  const review = receipt.review;
  if (review.policy_ref !== contract.review_policy_ref || review.verdict !== "approved"
    || review.builder_agent_id === review.reviewer_agent_id
    || (review.builder_provider === review.reviewer_provider && review.builder_model === review.reviewer_model))
    throw new Error("delivery_independent_review_required");
  return receipt;
}
/** Explicit promotion creates a new contract; it carries no prior receipts or approval. */
export function promoteDeliveryScout(frozen: FrozenDeliveryContractV2, input: {
  contractId: string; baseHead: string; policyDigest: string; requestedActions: DeliveryContractV2["requested_actions"];
}): FrozenDeliveryContractV2 {
  const parent = assertFrozenDeliveryContract(frozen);
  if (parent.contract.mode !== "scout" || input.contractId === parent.contract.contract_id) throw new Error("delivery_invalid_promotion");
  return freezeDeliveryContract({ ...parent.contract, contract_id: input.contractId, parent_contract_id: parent.contract.contract_id,
    mode: "implement", base_head: input.baseHead, policy_digest: input.policyDigest, budget_ref: `policy:${input.policyDigest}`, requested_actions: input.requestedActions });
}
