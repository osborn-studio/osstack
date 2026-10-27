import { z } from "zod";

/** R01 wire contracts. Shape validation grants no execution or qualification authority. */
const text = (maximum: number) => z.string().min(1).max(maximum).refine((value) =>
  value.trim().length > 0 && !value.includes("\0") && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
"must be nonblank Unicode text without NUL or lone surrogates");
const Id = text(512);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Version = z.string().max(64).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const Epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).refine((value) => !Object.is(value, -0));
const Timestamp = z.string().datetime({ offset: false }).max(40).refine((value) => Number.isFinite(Date.parse(value)));
const Path = text(4096).refine((value) => !value.includes("\\") && !value.includes(":")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  && ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127), "unsafe source path");
const unique = <T>(items: T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length;

export const BehaviorCapabilityIdV1 = z.string().regex(/^FM-(0[1-9]|1\d|2[0-4])$/);
export type BehaviorCapabilityIdV1 = z.infer<typeof BehaviorCapabilityIdV1>;
export const BehaviorQualificationLevelV1 = z.enum(["contract_tested", "host_verified", "journey_verified"]);
export type BehaviorQualificationLevelV1 = z.infer<typeof BehaviorQualificationLevelV1>;

export const BehaviorSourceV1 = z.object({
  repository: text(2048), commit: Commit, path: Path, content_sha256: Digest, license: text(128),
}).strict();
export type BehaviorSourceV1 = z.infer<typeof BehaviorSourceV1>;

/** Descriptions and source references are data. No command, permission or enabled fields exist. */
export const BehaviorContractV1 = z.object({
  schema_version: z.literal(1), kind: z.literal("behavior_contract"),
  capability_id: BehaviorCapabilityIdV1, version: Version,
  owner_component: Id, trigger: Id,
  summary: z.object({ en: text(2000), zh: text(2000) }).strict(),
  source_manifest_sha256: Digest,
  sources: z.array(BehaviorSourceV1).min(1).max(128),
  depends_on: z.array(z.object({ capability_id: BehaviorCapabilityIdV1, version: Version }).strict()).max(23),
  required_scenarios: z.array(z.object({ id: Id, level: BehaviorQualificationLevelV1 }).strict()).min(1).max(1000),
  invariants: z.array(text(2000)).min(1).max(100),
  semantic_differences: z.array(text(2000)).max(100),
}).strict().superRefine((value, context) => {
  const error = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (!unique(value.depends_on, (entry) => entry.capability_id)) error("duplicate dependency");
  if (value.depends_on.some((entry) => entry.capability_id === value.capability_id)) error("self dependency");
  if (!unique(value.sources, (source) => JSON.stringify([source.repository, source.commit, source.path]))) error("duplicate source");
  if (!unique(value.required_scenarios, (scenario) => scenario.id)) error("duplicate scenario ID");
});
export type BehaviorContractV1 = z.infer<typeof BehaviorContractV1>;

/** Shipped declaration inventory. Qualifications remain outside this digest to avoid circular signatures. */
export const BehaviorRegistryV1 = z.object({
  schema_version: z.literal(1), kind: z.literal("behavior_registry"), registry_version: Version,
  candidate_sha: Commit, target_code_sha256: Digest,
  entries: z.array(z.object({ contract: BehaviorContractV1, contract_sha256: Digest }).strict()).min(1).max(24),
}).strict().refine((value) => unique(value.entries, (entry) => entry.contract.capability_id), "duplicate capability ID");
export type BehaviorRegistryV1 = z.infer<typeof BehaviorRegistryV1>;

/** Qualification draft v1 measurement cell. This is not the executor SupportProfile or a grant. */
export const BehaviorQualificationProfileV1 = z.object({
  os: Id, architecture: Id, filesystem: Id, isolation_profile: Id,
  daemon_version: Id, adapter_id: Id, adapter_version: Id, provider: Id, model: Id,
  executor_id: Id, executor_version: Id, template_id: Id, template_version: Id,
  recovery_mode: z.enum(["query_and_deduplicate", "stop_and_reconcile"]), host_identity_sha256: Digest,
}).strict();
export type BehaviorQualificationProfileV1 = z.infer<typeof BehaviorQualificationProfileV1>;

export const BehaviorEvidenceV1 = z.object({
  scenario_id: Id, checker_id: Id, checker_version: Id,
  result: z.enum(["passed", "failed", "unknown", "not_run"]), artifact_sha256: Digest, subject_sha256: Digest,
}).strict();
export type BehaviorEvidenceV1 = z.infer<typeof BehaviorEvidenceV1>;
const EvidenceList = z.array(BehaviorEvidenceV1).min(1).max(1000)
  .refine((value) => unique(value, (entry) => entry.scenario_id), "duplicate evidence scenario");
export const BehaviorEvidenceBundleV1 = z.object({ schema_version: z.literal(1), evidence: EvidenceList }).strict();
export type BehaviorEvidenceBundleV1 = z.infer<typeof BehaviorEvidenceBundleV1>;

/** Compatible with qualification-contract.schema.json v1. Signature and host policy checks belong to R02. */
export const BehaviorQualificationV1 = z.object({
  schema_version: z.literal(1), canonicalization: z.literal("RFC8785"),
  payload: z.object({
    record_id: Id, capability_id: BehaviorCapabilityIdV1, profile: BehaviorQualificationProfileV1,
    candidate_sha: Commit, target_code_sha256: Digest, behavior_contract_sha256: Digest,
    source_manifest_sha256: Digest, policy_profile_sha256: Digest, registry_sha256: Digest,
    level: BehaviorQualificationLevelV1, evidence_bundle_sha256: Digest, evidence_refs: EvidenceList,
    limitations: z.array(text(512)).max(100), issuer_role: z.enum(["ci_verifier", "host_qualifier", "journey_verifier"]),
    issued_at: Timestamp, expires_at: Timestamp, revocation_epoch: Epoch, signer_key_id: Id,
    required_scenario_set_sha256: Digest, prerequisite_record_sha256: z.array(Digest).max(1),
  }).strict(),
  signature: z.object({ algorithm: z.literal("Ed25519"), value_base64: z.string().regex(/^[A-Za-z0-9+/]{85}[AQgw]==$/) }).strict(),
}).strict().superRefine(({ payload }, context) => {
  const error = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const roles = { contract_tested: "ci_verifier", host_verified: "host_qualifier", journey_verified: "journey_verifier" } as const;
  if (roles[payload.level] !== payload.issuer_role) error("issuer role does not match level");
  if (payload.prerequisite_record_sha256.length !== (payload.level === "contract_tested" ? 0 : 1)) error("exact predecessor required");
  if (Date.parse(payload.expires_at) <= Date.parse(payload.issued_at)) error("expiry must follow issuance");
});
export type BehaviorQualificationV1 = z.infer<typeof BehaviorQualificationV1>;

/** Progress projection only. R02 never uses it to establish qualification or authorization. */
export const BehaviorDeliveryRecordV1 = z.object({
  schema_version: z.literal(1), kind: z.literal("behavior_delivery"), capability_id: BehaviorCapabilityIdV1,
  contract_version: Version, behavior_contract_sha256: Digest, registry_sha256: Digest,
  candidate_sha: Commit, target_code_sha256: Digest,
  state: z.enum(["planned", "implemented", "local_verified", "blocked"]), scope: Id,
  evidence_sha256: z.array(Digest).max(1000), limitations: z.array(text(2000)).max(100), recorded_at: Timestamp,
}).strict().refine((value) => value.state !== "local_verified" || value.evidence_sha256.length > 0,
  "local verification requires evidence references");
export type BehaviorDeliveryRecordV1 = z.infer<typeof BehaviorDeliveryRecordV1>;
