import { z } from "zod";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Id = z.string().min(1).max(256);
const hasControlCharacter = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const Ref = z.string().min(1).max(255).refine((value) =>
  !value.startsWith("-") && !/\s/.test(value) && !hasControlCharacter(value), "unsafe ref");
const RelativePath = z.string().min(1).max(4096).refine((value) =>
  !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !hasControlCharacter(value), "unsafe relative path");

export const DeliveryCompletionV2 = z.enum(["local_verified", "pr_opened", "merged", "deployed"]);
export const DeliveryPublicationScopeV2 = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({
    mode: z.enum(["push", "draft_pr", "review_pr"]),
    hostname: z.literal("github.com"),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    base_ref: Ref,
    head_ref: Ref,
  }).strict(),
]);
/** Scope and authority references constrain existing host authorization. Neither grants it. */
export const DeliveryContractV2 = z.object({
  schema_version: z.literal(2),
  contract_id: Id,
  parent_contract_id: Id.optional(),
  task_id: Id,
  canonical_repo: z.string().min(1).max(4096).refine((value) => value.startsWith("/") && !hasControlCharacter(value), "absolute repo required"),
  mode: z.enum(["scout", "implement"]),
  base_head: Commit,
  goal: z.string().min(1).max(16000),
  required_checks: z.array(z.object({ id: Id, registry_ref: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()).min(1).max(100),
  review_policy_ref: Id,
  requested_completion: DeliveryCompletionV2,
  allowed_paths: z.array(RelativePath).min(1).max(1000),
  requested_actions: z.array(z.enum(["build", "verify", "commit", "push", "open_pr", "merge", "deploy:staging", "deploy:production"])).min(1).max(8),
  budget_ref: Id,
  policy_digest: Digest,
  publication_scope: DeliveryPublicationScopeV2,
  merge_authority: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("none") }).strict(),
    z.object({ mode: z.literal("existing_guarded_policy"), policy_ref: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const error = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(value.required_checks.map((check) => check.id)).size !== value.required_checks.length) error("duplicate check ID");
  if (new Set(value.required_checks.map((check) => check.registry_ref)).size !== value.required_checks.length) error("duplicate check reference");
  if (value.mode === "implement" && (!["build", "verify"].every(action => value.requested_actions.includes(action as "build" | "verify")))) error("implement requires build and verify actions");
  if (value.parent_contract_id === value.contract_id) error("contract cannot parent itself");
  if (value.mode === "scout" && (value.requested_completion !== "local_verified" || value.publication_scope.mode !== "none"
    || value.merge_authority.mode !== "none" || value.requested_actions.some((action) => action !== "verify"))) error("scout must remain read-only and local");
  if (value.requested_completion === "local_verified" && (value.publication_scope.mode !== "none"
    || value.requested_actions.some((action) => !["build", "verify"].includes(action)))) error("local completion forbids publication and commit");
  if (value.requested_completion === "merged" && value.requested_actions.some((action) => action.startsWith("deploy:"))) error("merge completion forbids deployment");
  if (value.requested_completion === "pr_opened" && !["draft_pr", "review_pr"].includes(value.publication_scope.mode)) error("PR completion requires PR scope");
  if (["local_verified", "pr_opened"].includes(value.requested_completion)
    && (value.merge_authority.mode !== "none" || value.requested_actions.some((action) => action === "merge" || action.startsWith("deploy:")))) error("requested completion forbids merge/deploy authority");
  if (["merged", "deployed"].includes(value.requested_completion)
    && (value.publication_scope.mode !== "review_pr" || value.merge_authority.mode !== "existing_guarded_policy")) error("merge requires an existing guarded policy reference");
  if (value.merge_authority.mode === "existing_guarded_policy" && value.merge_authority.policy_ref !== `sha256:${value.policy_digest}`) error("merge policy reference mismatch");
  if (value.publication_scope.mode !== "none" && value.publication_scope.base_ref === value.publication_scope.head_ref) error("publication base and head must differ");
});
export type DeliveryContractV2 = z.infer<typeof DeliveryContractV2>;
export const FrozenDeliveryContractV2 = z.object({ contract: DeliveryContractV2, digest: Digest, brief: z.string().min(1).max(32000) }).strict();
export type FrozenDeliveryContractV2 = z.infer<typeof FrozenDeliveryContractV2>;
export const DeliveryCandidateIdentityV2 = z.object({ base_head: Commit, head: Commit, tree_id: Commit, diff_digest: Digest }).strict();
export type DeliveryCandidateIdentityV2 = z.infer<typeof DeliveryCandidateIdentityV2>;
/** Host-generated receipt. Parsing validates structure, never establishes provenance. */
export const DeliveryVerificationReceiptV2 = z.object({
  schema_version: z.literal(2),
  source: z.literal("osstack_loop_host"),
  run_id: Id,
  task_id: Id,
  run_kind: z.enum(["guarded-local", "guarded-git"]),
  contract_digest: Digest,
  policy_digest: Digest,
  candidate: DeliveryCandidateIdentityV2,
  workspace_state_digest: Digest,
  checks: z.array(z.object({ id: Id, registry_ref: z.string().regex(/^sha256:[a-f0-9]{64}$/), command_digest: Digest,
    exit_code: z.number().int(), duration_ms: z.number().finite().nonnegative() }).strict()).min(1).max(200),
  review: z.object({
    policy_ref: Id,
    verdict: z.enum(["approved", "changes_requested", "blocked", "inconclusive"]),
    builder_agent_id: Id,
    reviewer_agent_id: Id,
    builder_provider: Id,
    builder_model: Id,
    reviewer_provider: Id,
    reviewer_model: Id,
    identity_source: z.literal("reported"),
    artifact_digest: Digest,
  }).strict(),
  observed_at: z.string().datetime(),
  context_receipt_refs: z.array(z.object({ path: z.string().min(1), digest: Digest }).strict()).max(100).default([]),
}).strict();
export type DeliveryVerificationReceiptV2 = z.infer<typeof DeliveryVerificationReceiptV2>;
export const DeliveryReceiptReferenceV2 = z.object({ path: z.string().min(1).max(4096), digest: Digest }).strict();
export type DeliveryReceiptReferenceV2 = z.infer<typeof DeliveryReceiptReferenceV2>;
