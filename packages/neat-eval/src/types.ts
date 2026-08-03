import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const ParityDefectCategoryV1 = z.enum([
  "narrative_marker",
  "narrative_history",
  "contradiction",
  "drift",
  "memory_overlap",
  "volume_inversion",
  "cross_repository",
]);
export type ParityDefectCategoryV1 = z.infer<typeof ParityDefectCategoryV1>;

export const ParityDefectV1 = z.object({
  defect_id: z.string().regex(/^nd_[a-f0-9]{16}$/u),
  category: ParityDefectCategoryV1,
  origin: z.enum(["natural_derived", "controlled_seed"]),
  paths: z.array(z.string().min(1)).min(1),
  expected_rule_ids: z.array(z.string().min(1)),
  expected_dimensions: z.array(z.string().min(1)),
  acceptable_remedies: z.array(z.string().min(1)).min(1),
  impact_scope: z.array(z.string().min(1)).min(1),
  provenance: z.object({
    source_url: z.string().url(),
    source_commit: z.string().min(7),
    source_sha256: sha256,
    license: z.string().min(1),
    derivation: z.string().min(1),
  }).strict(),
}).strict();
export type ParityDefectV1 = z.infer<typeof ParityDefectV1>;

export const ParityCorpusCaseV1 = z.object({
  case_id: z.string().regex(/^case-[0-9]{3}$/u),
  repository_id: z.string().min(1),
  split: z.enum(["train", "dev"]),
  defects: z.array(ParityDefectV1).length(4),
}).strict();
export type ParityCorpusCaseV1 = z.infer<typeof ParityCorpusCaseV1>;

export const DevelopmentCorpusV1 = z.object({
  schema_version: z.literal("1"),
  corpus_id: z.literal("osstack-neat-parity-development-v1"),
  generator_version: z.literal("1"),
  seed: z.literal(20260718),
  repositories: z.array(z.object({
    repository_id: z.string().min(1),
    role: z.string().min(1),
  }).strict()).length(5),
  cases: z.array(ParityCorpusCaseV1).length(30),
  summary: z.object({
    cases: z.literal(30),
    defects: z.literal(120),
    natural_derived_defects: z.number().int().min(40),
    controlled_seed_defects: z.number().int().nonnegative(),
  }).strict(),
  hidden_protocol: z.object({
    external_bundle_required: z.literal(true),
    minimum_cases: z.literal(30),
    minimum_defects: z.literal(120),
    labels_visible_to_builder: z.literal(false),
  }).strict(),
  baseline: z.object({
    repository: z.literal("KKKKhazix/khazix-skills"),
    commit: z.literal("2b4a645cfdc894156ae347d897723562f719ce95"),
    path: z.literal("neat-freak"),
    sha256: z.literal("e77e30e39e67f05d3159548605057d396794d1bde20bd59a070670e109c3d904"),
    license: z.literal("MIT"),
  }).strict(),
}).strict().superRefine((corpus, context) => {
  const defects = corpus.cases.flatMap((entry) => entry.defects);
  if (new Set(corpus.cases.map((entry) => entry.case_id)).size !== 30) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "case ids must be unique" });
  }
  if (new Set(defects.map((entry) => entry.defect_id)).size !== 120) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "defect ids must be unique" });
  }
  if (defects.length !== corpus.summary.defects) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "defect summary mismatch" });
  }
  if (
    defects.filter((entry) => entry.origin === "natural_derived").length
    !== corpus.summary.natural_derived_defects
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "origin summary mismatch" });
  }
});
export type DevelopmentCorpusV1 = z.infer<typeof DevelopmentCorpusV1>;

export const CorpusLockV1 = z.object({
  schema_version: z.literal("1"),
  corpus_id: z.string().min(1),
  manifest_sha256: sha256,
  generated_tree_sha256: sha256,
  cases: z.literal(30),
  defects: z.literal(120),
  baseline_sha256: sha256,
}).strict();
export type CorpusLockV1 = z.infer<typeof CorpusLockV1>;

const portableRelativePath = z.string().min(1).superRefine((value, context) => {
  if (value.startsWith("/") || value.startsWith("\\") || value.split(/[\\/]/u).includes("..")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "path must be portable, relative, and traversal-free",
    });
  }
});

export const HiddenExecutionBundleV1 = z.object({
  schema_version: z.literal("1"),
  bundle_id: z.string().min(1),
  custodian_id: z.string().min(1),
  created_at: z.string().datetime(),
  labels_included: z.literal(false),
  cases: z.array(z.object({
    case_id: z.string().min(1),
    rot_root: portableRelativePath,
    snapshot_sha256: sha256,
  }).strict()).min(46),
}).strict().superRefine((bundle, context) => {
  if (new Set(bundle.cases.map((entry) => entry.case_id)).size !== bundle.cases.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "case ids must be unique" });
  }
});
export type HiddenExecutionBundleV1 = z.infer<typeof HiddenExecutionBundleV1>;

export const CustodyReceiptV1 = z.object({
  schema_version: z.literal("1"),
  builder_id: z.string().min(1),
  custodian_id: z.string().min(1),
  bundle_sha256: sha256,
  labels_sha256: sha256,
  injected_at: z.string().datetime(),
}).strict().superRefine((receipt, context) => {
  if (receipt.builder_id === receipt.custodian_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "builder and custodian must differ" });
  }
});
export type CustodyReceiptV1 = z.infer<typeof CustodyReceiptV1>;

const protocolBudget = z.object({
  max_input_tokens: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  max_calls: z.number().int().positive(),
  max_wall_clock_ms: z.number().int().min(1_000).max(3_600_000),
}).strict();

export const ParityProtocolV1 = z.object({
  schema_version: z.literal("1"),
  protocol_id: z.string().min(1),
  status: z.enum(["preregistered_waiting_external_hidden_bundle", "frozen"]),
  registered_at: z.string().datetime(),
  random_seed: z.number().int(),
  baseline: z.object({
    repository: z.string().min(1),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    path: portableRelativePath,
    sha256,
    license: z.string().min(1),
  }).strict(),
  primary_model_id: z.string().min(1).nullable(),
  secondary_model_id: z.string().min(1).nullable(),
  hidden_bundle_sha256: sha256.nullable(),
  runs_per_case: z.object({
    A_primary: z.literal(3),
    B_primary: z.literal(3),
    A_secondary: z.literal(2),
    B_secondary: z.literal(2),
    C_deterministic: z.literal(2),
  }).strict(),
  budgets: protocolBudget,
  thresholds: z.object({
    recall_precision_margin: z.literal(-0.05),
    edit_quality_margin: z.literal(-0.25),
    alpha_minimum: z.literal(0.67),
    median_jaccard_minimum: z.literal(0.8),
    dimension_jaccard_minimum: z.literal(0.7),
    systemic_failure_maximum: z.literal(0.05),
  }).strict(),
  bootstrap: z.object({
    unit: z.literal("case_cluster"),
    iterations: z.number().int().min(1_000),
    confidence: z.literal(0.95),
  }).strict(),
  power_analysis: z.object({
    method: z.literal("paired_case_normal_approximation"),
    alpha: z.literal(0.05),
    target_power: z.literal(0.8),
    assumed_case_sd: z.literal(0.12),
    noninferiority_margin: z.literal(0.05),
    required_cases: z.literal(46),
    required_defects: z.literal(184),
  }).strict(),
  edit_rubric: z.object({
    scale: z.tuple([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    dimensions: z.array(z.string().min(1)).min(1),
    blinding: z.string().min(1),
    judges: z.literal(2),
    human_adjudication: z.string().min(1),
  }).strict(),
  claim_policy: z.object({
    all_gates_required: z.literal(true),
    insufficient_power_is_failure: z.literal(true),
    missing_or_failed_runs_stay_in_denominator: z.literal(true),
    development_results_cannot_authorize_parity_claim: z.literal(true),
    self_custody_cannot_authorize_parity_claim: z.literal(true),
  }).strict(),
}).strict().superRefine((protocol, context) => {
  if (
    protocol.status === "frozen"
    && (
      protocol.primary_model_id === null
      || protocol.secondary_model_id === null
      || protocol.hidden_bundle_sha256 === null
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "frozen protocol requires both model ids and hidden bundle commitment",
    });
  }
});
export type ParityProtocolV1 = z.infer<typeof ParityProtocolV1>;
