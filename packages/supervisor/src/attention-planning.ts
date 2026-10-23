import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const AttentionDeliveryContract = z
  .object({
    version: z.literal(1),
    contract_id: z.string().min(1).max(256),
    parent_contract_id: z.string().nullable(),
    mode: z.enum(["scout", "implement"]),
    repo_path: z.string().min(1).max(4096),
    head: sha,
    goal: z.string().min(1).max(4000),
    required_verification: z.array(z.string().min(1).max(500)).min(1).max(30),
    review_required: z.boolean(),
    completion: z.enum(["local_verified", "pr_opened", "merged", "deployed"]),
  })
  .strict();
export type AttentionDeliveryContract = z.infer<
  typeof AttentionDeliveryContract
>;
export function deliveryContract(raw: unknown) {
  const contract = AttentionDeliveryContract.parse(raw);
  if (contract.mode === "scout" && contract.completion !== "local_verified")
    throw new Error("scout_cannot_deliver");
  const canonical = {
    ...contract,
    required_verification: [...new Set(contract.required_verification)].sort(),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return {
    contract: canonical,
    digest,
    brief: `${canonical.mode}: ${canonical.goal}\nHead: ${
      canonical.head
    }\nRequired: ${canonical.required_verification.join("; ")}\nCompletion: ${
      canonical.completion
    }`,
    effective_options: {
      mode: canonical.mode,
      head: canonical.head,
      verify: canonical.required_verification,
      review: canonical.review_required,
      completion: canonical.completion,
    },
  };
}
export function promoteScout(raw: unknown, head: string) {
  const old = deliveryContract(raw).contract;
  if (old.mode !== "scout") throw new Error("scout_required");
  return deliveryContract({
    ...old,
    contract_id: randomUUID(),
    parent_contract_id: old.contract_id,
    mode: "implement",
    head,
  });
}
export function verifyDeliveryContract(
  raw: unknown,
  evidence: {
    digest: string;
    mode: string;
    head: string;
    passed: string[];
    reviewed: boolean;
    completion: string;
  }
) {
  const frozen = deliveryContract(raw);
  if (
    evidence.digest !== frozen.digest ||
    evidence.mode !== frozen.contract.mode ||
    evidence.head !== frozen.contract.head
  )
    throw new Error("contract_identity_mismatch");
  if (
    frozen.contract.required_verification.some(
      (v) => !evidence.passed.includes(v)
    ) ||
    (frozen.contract.review_required && !evidence.reviewed)
  )
    throw new Error("required_verification_missing");
  if (evidence.completion !== frozen.contract.completion)
    throw new Error("completion_level_mismatch");
  return {
    verified: true as const,
    digest: frozen.digest,
    authority: "existing_approval_required" as const,
  };
}
const Triage = z
  .object({
    category: z.enum(["human_decision", "system_wait", "source_uncertain"]),
    explanation: z.string().max(500),
  })
  .strict();
export function acceptAttentionTriage(
  raw: unknown,
  remainingCalls: number,
  fallback: z.infer<typeof Triage>
) {
  if (!Number.isSafeInteger(remainingCalls) || remainingCalls < 1)
    return { result: fallback, used: false };
  const parsed = Triage.safeParse(raw);
  return {
    result: parsed.success ? parsed.data : fallback,
    used: parsed.success,
  };
}
export function evaluateAttentionRouting(
  cases: readonly {
    id: string;
    expected: string;
    intentRoute: string;
    promptRoute: string;
    reviewRequired: boolean;
    intentReview: boolean;
    promptReview: boolean;
    intentTokens: number;
    promptTokens: number;
  }[]
) {
  if (!cases.length) throw new Error("golden_set_required");
  return {
    cases: cases.length,
    intent_accuracy:
      cases.filter((c) => c.intentRoute === c.expected).length / cases.length,
    prompt_accuracy:
      cases.filter((c) => c.promptRoute === c.expected).length / cases.length,
    intent_missed_review: cases.filter(
      (c) => c.reviewRequired && !c.intentReview
    ).length,
    prompt_missed_review: cases.filter(
      (c) => c.reviewRequired && !c.promptReview
    ).length,
    intent_tokens: cases.reduce((n, c) => n + c.intentTokens, 0),
    prompt_tokens: cases.reduce((n, c) => n + c.promptTokens, 0),
    default_enabled: false,
  };
}
export function budgetAttentionContext(
  entries: readonly {
    id: string;
    text: string;
    verified_at: number;
    expires_at: number;
    tier: "required" | "task" | "background";
  }[],
  budgetBytes: number,
  now: number
) {
  if (
    !Number.isSafeInteger(budgetBytes) ||
    budgetBytes < 0 ||
    budgetBytes > 1000000 ||
    !Number.isFinite(now)
  )
    throw new Error("invalid_budget");
  let bytes = 0;
  const selected: (typeof entries)[number][] = [];
  const omitted: string[] = [];
  for (const e of [...entries].sort(
    (a, b) =>
      ({ required: 0, task: 1, background: 2 }[a.tier] -
        { required: 0, task: 1, background: 2 }[b.tier] ||
      b.verified_at - a.verified_at)
  )) {
    const size = Buffer.byteLength(e.text);
    if (
      !Number.isFinite(e.expires_at) ||
      !Number.isFinite(e.verified_at) ||
      e.expires_at < now ||
      e.verified_at > now ||
      bytes + size > budgetBytes
    ) {
      omitted.push(e.id);
      continue;
    }
    selected.push(e);
    bytes += size;
  }
  return {
    selected,
    omitted,
    bytes,
    required_omitted: entries
      .filter((e) => e.tier === "required" && omitted.includes(e.id))
      .map((e) => e.id),
    promote_memory: false,
  };
}
