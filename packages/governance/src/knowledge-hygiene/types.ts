import { z } from "zod";

export const KnowledgeHygieneRuleIdV1 = z.enum([
  "instruction.canonical_missing",
  "instruction.mirror_missing",
  "instruction.mirror_drift",
  "surface.required_missing",
  "budget.warn_exceeded",
  "budget.error_exceeded",
  "reference.markdown_target_missing",
  "reference.instruction_import_missing",
  "contract.review_required",
  "scan.incomplete",
]);
export type KnowledgeHygieneRuleIdV1 = z.infer<
  typeof KnowledgeHygieneRuleIdV1
>;

export const KnowledgeHygieneSurfaceV1 = z.enum([
  "instruction",
  "documentation",
  "memory",
]);
export type KnowledgeHygieneSurfaceV1 = z.infer<
  typeof KnowledgeHygieneSurfaceV1
>;

export const KnowledgeHygieneSeverityV1 = z.enum([
  "error",
  "warning",
  "info",
]);
export type KnowledgeHygieneSeverityV1 = z.infer<
  typeof KnowledgeHygieneSeverityV1
>;

export const KnowledgeHygieneConfidenceV1 = z.enum([
  "high",
  "medium",
  "low",
]);
export type KnowledgeHygieneConfidenceV1 = z.infer<
  typeof KnowledgeHygieneConfidenceV1
>;

export const KnowledgeHygieneLocationV1 = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    anchor: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeHygieneLocationV1 = z.infer<
  typeof KnowledgeHygieneLocationV1
>;

export const KnowledgeHygieneRemediationV1 = z
  .object({
    mode: z.enum(["safe_patch", "agent_edit", "human_decision"]),
    action_id: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeHygieneRemediationV1 = z.infer<
  typeof KnowledgeHygieneRemediationV1
>;

export const KnowledgeHygieneEvidenceRefV1 = z
  .object({
    kind: z.enum(["report", "scorecard", "proof", "loop_state", "external"]),
    ref: z.string().min(1),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters")
      .optional(),
    run_id: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeHygieneEvidenceRefV1 = z.infer<
  typeof KnowledgeHygieneEvidenceRefV1
>;

const knowledgeHygieneFingerprint = z.string().regex(/^khf_[a-f0-9]{64}$/);
const knowledgeHygieneDiffId = z.string().regex(/^diff_[a-f0-9]{64}$/);

export const KnowledgeHygieneFindingV1 = z
  .object({
    fingerprint: knowledgeHygieneFingerprint,
    rule_id: KnowledgeHygieneRuleIdV1,
    rule_version: z.string().min(1),
    surface: KnowledgeHygieneSurfaceV1,
    severity: KnowledgeHygieneSeverityV1,
    confidence: KnowledgeHygieneConfidenceV1,
    location: KnowledgeHygieneLocationV1,
    observed: z.record(z.unknown()),
    expected: z.record(z.unknown()),
    rationale: z.string().min(1),
    evidence_refs: z.array(KnowledgeHygieneEvidenceRefV1),
    remediation: KnowledgeHygieneRemediationV1,
  })
  .strict();
export type KnowledgeHygieneFindingV1 = z.infer<
  typeof KnowledgeHygieneFindingV1
>;

const sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters");
const gitObjectId = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "invalid Git object id");

export const KnowledgeSurfaceMetricV1 = z
  .object({
    surface: KnowledgeHygieneSurfaceV1,
    path: z.string().min(1),
    kind: z.enum(["file", "directory"]),
    exists: z.boolean(),
    bytes: z.number().int().nonnegative().optional(),
    lines: z.number().int().nonnegative().optional(),
    sha256: sha256.optional(),
  })
  .strict();
export type KnowledgeSurfaceMetricV1 = z.infer<
  typeof KnowledgeSurfaceMetricV1
>;

export const KnowledgeSurfaceInventoryEntryV1 = KnowledgeSurfaceMetricV1.extend({
  content: z.string().optional(),
  link_target: z.string().optional(),
}).strict();
export type KnowledgeSurfaceInventoryEntryV1 = z.infer<
  typeof KnowledgeSurfaceInventoryEntryV1
>;

export const KnowledgeSurfaceInventoryV1 = z
  .object({
    surfaces: z.array(KnowledgeSurfaceInventoryEntryV1),
    completeness: z
      .object({
        complete: z.boolean(),
        skipped_files: z.number().int().nonnegative(),
        reasons: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type KnowledgeSurfaceInventoryV1 = z.infer<
  typeof KnowledgeSurfaceInventoryV1
>;

export const KnowledgeHygieneReportInputV1 = z
  .object({
    mode: z.enum(["all", "worktree", "range", "base_to_worktree"]),
    base_ref: z.string().min(1).optional(),
    base_sha: gitObjectId.optional(),
    head_ref: z.string().min(1).optional(),
    head_sha: gitObjectId.optional(),
    diff_id: knowledgeHygieneDiffId.optional(),
    config_path: z.string().min(1).optional(),
    config_sha256: sha256.optional(),
  })
  .strict();
export type KnowledgeHygieneReportInputV1 = z.infer<
  typeof KnowledgeHygieneReportInputV1
>;

export const KnowledgeHygieneReportV1 = z
  .object({
    schema_version: z.literal("1"),
    generated_at: z.string().datetime(),
    repo: z
      .object({
        root: z.string().min(1),
        repo_id: z.string().min(1).optional(),
      })
      .strict(),
    input: KnowledgeHygieneReportInputV1,
    completeness: z
      .object({
        complete: z.boolean(),
        skipped_files: z.number().int().nonnegative(),
        reasons: z.array(z.string().min(1)),
      })
      .strict(),
    summary: z
      .object({
        error: z.number().int().nonnegative(),
        warning: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
        suppressed: z.number().int().nonnegative(),
      })
      .strict(),
    findings: z.array(KnowledgeHygieneFindingV1),
    metrics: z.array(KnowledgeSurfaceMetricV1),
  })
  .strict();
export type KnowledgeHygieneReportV1 = z.infer<
  typeof KnowledgeHygieneReportV1
>;

export const KnowledgeHygieneResolutionV1 = z
  .object({
    schema_version: z.literal("1"),
    diff_id: knowledgeHygieneDiffId,
    fingerprint: knowledgeHygieneFingerprint,
    outcome: z.enum([
      "fixed",
      "reviewed_no_change",
      "accepted_risk",
      "suppressed",
      "obsolete",
    ]),
    actor: z
      .object({
        kind: z.enum(["human", "agent"]),
        id: z.string().trim().min(1),
      })
      .strict(),
    reason: z.string().trim().min(1),
    evidence_refs: z.array(KnowledgeHygieneEvidenceRefV1),
    resolved_at: z.string().datetime(),
  })
  .strict();
export type KnowledgeHygieneResolutionV1 = z.infer<
  typeof KnowledgeHygieneResolutionV1
>;

export const KnowledgeHygieneReviewArtifactV1 = z
  .object({
    schema_version: z.literal("1"),
    diff_id: knowledgeHygieneDiffId,
    resolutions: z.array(KnowledgeHygieneResolutionV1).min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    const fingerprints = artifact.resolutions.map(
      (resolution) => resolution.fingerprint,
    );
    if (new Set(fingerprints).size !== fingerprints.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resolutions must have unique fingerprints",
      });
    }
    if (
      artifact.resolutions.some(
        (resolution) => resolution.diff_id !== artifact.diff_id,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "resolution diff_id must match artifact diff_id",
      });
    }
  });
export type KnowledgeHygieneReviewArtifactV1 = z.infer<
  typeof KnowledgeHygieneReviewArtifactV1
>;

function hasDuplicates<T>(values: readonly T[]): boolean {
  return new Set(values).size !== values.length;
}

export const KnowledgeHygieneCheckInputV1 = z
  .object({
    repo_root: z.string().min(1),
    mode: z.enum(["all", "worktree", "range", "base_to_worktree"]),
    base_ref: z.string().min(1).optional(),
    head_ref: z.string().min(1).optional(),
    config_path: z.string().min(1).optional(),
    checks: z.array(KnowledgeHygieneRuleIdV1).optional(),
    skip_checks: z.array(KnowledgeHygieneRuleIdV1).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === "range" && (!input.base_ref || !input.head_ref)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "range mode requires base_ref and head_ref",
      });
    }
    if (input.mode === "base_to_worktree" && !input.base_ref) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base_to_worktree mode requires base_ref",
      });
    }
    if (
      (input.mode === "all" || input.mode === "worktree") &&
      (input.base_ref || input.head_ref)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${input.mode} mode does not accept Git refs`,
      });
    }
    if (input.mode === "base_to_worktree" && input.head_ref) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base_to_worktree mode does not accept head_ref",
      });
    }
    if (input.checks && input.skip_checks) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "checks and skip_checks are mutually exclusive",
      });
    }
    if (input.checks && hasDuplicates(input.checks)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "checks contains duplicate rule ids",
      });
    }
    if (input.skip_checks && hasDuplicates(input.skip_checks)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "skip_checks contains duplicate rule ids",
      });
    }
  });
export type KnowledgeHygieneCheckInputV1 = z.infer<
  typeof KnowledgeHygieneCheckInputV1
>;

export const KnowledgeHygieneChangeStatusV1 = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "untracked",
]);
export type KnowledgeHygieneChangeStatusV1 = z.infer<
  typeof KnowledgeHygieneChangeStatusV1
>;

export const KnowledgeHygieneChangeV1 = z
  .object({
    path: z.string().min(1),
    status: KnowledgeHygieneChangeStatusV1,
    old_path: z.string().min(1).optional(),
    content_sha256: sha256.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.status === "renamed" && change.old_path === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "renamed change requires old_path",
      });
    }
    if (change.status !== "renamed" && change.old_path !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "old_path is valid only for renamed changes",
      });
    }
    if (change.status === "deleted" && change.content_sha256 !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deleted change cannot have content_sha256",
      });
    }
  });
export type KnowledgeHygieneChangeV1 = z.infer<
  typeof KnowledgeHygieneChangeV1
>;

export const KnowledgeHygieneChangeSetV1 = z
  .object({
    schema_version: z.literal("1"),
    repo_root: z.string().min(1),
    mode: z.enum(["worktree", "range", "base_to_worktree"]),
    base_ref: z.string().min(1),
    base_sha: gitObjectId,
    head_ref: z.string().min(1).optional(),
    head_sha: gitObjectId.optional(),
    config_sha256: sha256.optional(),
    changes: z.array(KnowledgeHygieneChangeV1),
    changed_paths: z.array(z.string().min(1)),
    diff_id: knowledgeHygieneDiffId,
  })
  .strict()
  .superRefine((changeSet, context) => {
    if (
      changeSet.mode === "range" &&
      (!changeSet.head_ref || !changeSet.head_sha)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "range change set requires head_ref and head_sha",
      });
    }
    if (
      changeSet.mode !== "range" &&
      (changeSet.head_ref !== undefined || changeSet.head_sha !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "head_ref and head_sha are valid only for range mode",
      });
    }
    if (new Set(changeSet.changed_paths).size !== changeSet.changed_paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "changed_paths must not contain duplicates",
      });
    }
  });
export type KnowledgeHygieneChangeSetV1 = z.infer<
  typeof KnowledgeHygieneChangeSetV1
>;
