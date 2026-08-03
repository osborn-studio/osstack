import { Buffer } from "node:buffer";
import { z } from "zod";
import { assertKnowledgeHygieneRepositoryPathV1 } from "./path-pattern.js";
import {
  KnowledgeHygieneEvidenceRefV1,
  KnowledgeHygieneCheckInputV1,
  KnowledgeHygieneFindingV1,
  KnowledgeHygieneReportV1,
  KnowledgeHygieneRuleIdV1,
  KnowledgeHygieneSurfaceV1,
} from "./types.js";

const sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters");
const knowledgeHygieneFingerprint = z.string().regex(/^khf_[a-f0-9]{64}$/);
const knowledgeHygieneEventId = z.string().regex(/^khev_[a-f0-9]{64}$/);

function portableRepositoryPath(value: string): boolean {
  if (value.includes("\0")) return false;
  try {
    assertKnowledgeHygieneRepositoryPathV1(value);
    return true;
  } catch {
    return false;
  }
}

const repositoryPath = z
  .string()
  .min(1)
  .refine(portableRepositoryPath, "must be a portable repository-relative path");

export const KnowledgeHygieneRuleIdV2 = z.enum([
  ...KnowledgeHygieneRuleIdV1.options,
  "rulebook.managed_context_block",
  "rulebook.narrative_block",
  "rulebook.narrative_density",
  "rulebook.invalid_waiver",
  "dependency.review_due",
  "semantic.narrative",
  "semantic.contradiction",
  "semantic.drift",
  "semantic.memory_overlap",
  "semantic.cross_repository_impact",
]);
export type KnowledgeHygieneRuleIdV2 = z.infer<
  typeof KnowledgeHygieneRuleIdV2
>;

const ruleOrderV2 = new Map(
  KnowledgeHygieneRuleIdV2.options.map((ruleId, index) => [ruleId, index]),
);

export const KnowledgeHygieneAssessmentScopeV2 = z
  .object({
    selected_rule_ids: z.array(KnowledgeHygieneRuleIdV2),
  })
  .strict()
  .superRefine((scope, context) => {
    const selected = scope.selected_rule_ids;
    if (new Set(selected).size !== selected.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_rule_ids"],
        message: "selected_rule_ids must be unique",
      });
    }
    if (selected.some((ruleId, index) =>
      index > 0
      && (ruleOrderV2.get(selected[index - 1]!) ?? -1)
        >= (ruleOrderV2.get(ruleId) ?? -1)
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_rule_ids"],
        message: "selected_rule_ids must follow canonical registry order",
      });
    }
  });
export type KnowledgeHygieneAssessmentScopeV2 = z.infer<
  typeof KnowledgeHygieneAssessmentScopeV2
>;

const checkInputV1Object = KnowledgeHygieneCheckInputV1.innerType();
export const KnowledgeHygieneCheckInputV2 = checkInputV1Object
  .omit({ checks: true, skip_checks: true })
  .extend({
    schema_version: z.literal("2"),
    checks: z.array(KnowledgeHygieneRuleIdV2).optional(),
    skip_checks: z.array(KnowledgeHygieneRuleIdV2).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const projected: Record<string, unknown> = { ...input };
    delete projected.schema_version;
    if (input.checks !== undefined) {
      projected.checks = input.checks.filter(
        (ruleId) => KnowledgeHygieneRuleIdV1.safeParse(ruleId).success,
      );
    }
    if (input.skip_checks !== undefined) {
      projected.skip_checks = input.skip_checks.filter(
        (ruleId) => KnowledgeHygieneRuleIdV1.safeParse(ruleId).success,
      );
    }
    const v1Result = KnowledgeHygieneCheckInputV1.safeParse(projected);
    if (!v1Result.success) {
      for (const issue of v1Result.error.issues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: issue.path,
          message: issue.message,
        });
      }
    }
    for (const [field, values] of [
      ["checks", input.checks],
      ["skip_checks", input.skip_checks],
    ] as const) {
      if (values !== undefined && new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} contains duplicate rule ids`,
        });
      }
    }
  });
export type KnowledgeHygieneCheckInputV2 = z.infer<
  typeof KnowledgeHygieneCheckInputV2
>;

export const KnowledgeHygieneSurfaceV2 = z.enum([
  ...KnowledgeHygieneSurfaceV1.options,
  "dependency",
]);
export type KnowledgeHygieneSurfaceV2 = z.infer<
  typeof KnowledgeHygieneSurfaceV2
>;

const repositoryLocation = z
  .object({
    kind: z.literal("repository"),
    repo_id: z.string().min(1),
    path: repositoryPath,
    line: z.number().int().positive().optional(),
    anchor: z.string().min(1).optional(),
  })
  .strict();

const repositoryScopeLocation = z
  .object({
    kind: z.literal("repository_scope"),
    repo_id: z.string().min(1),
  })
  .strict();

const adapterLocation = z
  .object({
    kind: z.literal("adapter"),
    adapter_id: z.string().min(1),
    uri: z.string().min(1),
    line: z.number().int().positive().optional(),
    anchor: z.string().min(1).optional(),
  })
  .strict();

const registryLocation = z
  .object({
    kind: z.literal("registry"),
    registry_scope: sha256,
    repo_id: z.string().min(1),
    obligation_id: z.string().min(1).optional(),
    edge_id: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((location, context) => {
    if ((location.obligation_id === undefined) === (location.edge_id === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "registry location requires exactly one of obligation_id or edge_id",
      });
    }
  });

export const KnowledgeHygieneLocationV2 = z.union([
  repositoryScopeLocation,
  repositoryLocation,
  adapterLocation,
  registryLocation,
]);
export type KnowledgeHygieneLocationV2 = z.infer<
  typeof KnowledgeHygieneLocationV2
>;

const evidencePackRef = z
  .object({
    kind: z.literal("evidence_pack"),
    ref: z.string().min(1),
    sha256,
    run_id: z.string().min(1),
  })
  .strict();

const obligationRef = z
  .object({
    kind: z.literal("obligation"),
    ref: z.string().min(1),
    sha256,
    run_id: z.string().min(1).optional(),
  })
  .strict();

export const KnowledgeHygieneEvidenceRefV2 = z.union([
  KnowledgeHygieneEvidenceRefV1,
  evidencePackRef,
  obligationRef,
]);
export type KnowledgeHygieneEvidenceRefV2 = z.infer<
  typeof KnowledgeHygieneEvidenceRefV2
>;

export const CoverageDimensionNameV2 = z.enum([
  "mechanical",
  "narrative",
  "contradiction",
  "drift",
  "memory_overlap",
  "cross_repository",
]);
export type CoverageDimensionNameV2 = z.infer<
  typeof CoverageDimensionNameV2
>;
export const COVERAGE_DIMENSION_ORDER_V2 = CoverageDimensionNameV2.options;

export const CoverageStateV2 = z.enum([
  "complete",
  "partial",
  "not_assessed",
  "truncated",
  "failed",
]);
export type CoverageStateV2 = z.infer<typeof CoverageStateV2>;

export const CoverageReasonCodeV2 = z.enum([
  "not_requested",
  "bounded_candidate_generator",
  "input_budget_exhausted",
  "output_budget_exhausted",
  "call_budget_exhausted",
  "judge_unavailable",
  "scan_incomplete",
  "provider_error",
]);
export type CoverageReasonCodeV2 = z.infer<typeof CoverageReasonCodeV2>;

const budgetReasons: ReadonlySet<CoverageReasonCodeV2> = new Set([
  "input_budget_exhausted",
  "output_budget_exhausted",
  "call_budget_exhausted",
]);
const partialForbiddenReasons: ReadonlySet<CoverageReasonCodeV2> = new Set([
  ...budgetReasons,
  "judge_unavailable",
  "scan_incomplete",
  "provider_error",
]);

export const CoverageDimensionV2 = z
  .object({
    dimension: CoverageDimensionNameV2,
    state: CoverageStateV2,
    source_units_total: z.number().int().nonnegative(),
    candidates_generated: z.number().int().nonnegative(),
    candidates_assessed: z.number().int().nonnegative(),
    candidates_skipped: z.number().int().nonnegative(),
    reason_codes: z.array(CoverageReasonCodeV2),
  })
  .strict()
  .superRefine((coverage, context) => {
    const reasons = new Set(coverage.reason_codes);
    if (reasons.size !== coverage.reason_codes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason_codes"],
        message: "reason_codes must be unique",
      });
    }
    if (
      coverage.candidates_assessed + coverage.candidates_skipped
      !== coverage.candidates_generated
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assessed plus skipped candidates must equal generated candidates",
      });
    }

    if (
      coverage.state === "complete"
      && (coverage.candidates_skipped !== 0 || coverage.reason_codes.length !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "complete coverage cannot skip candidates or include reason codes",
      });
    }
    if (coverage.state === "complete" && coverage.dimension !== "mechanical") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: "only the exhaustively enumerable mechanical dimension can be complete",
      });
    }
    if (
      coverage.state === "partial"
      && (
        !reasons.has("bounded_candidate_generator")
        || coverage.reason_codes.some((reason) => partialForbiddenReasons.has(reason))
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "partial coverage requires only bounded-generation reasons",
      });
    }
    if (coverage.state === "not_assessed") {
      const countsAreZero = coverage.source_units_total === 0
        && coverage.candidates_generated === 0
        && coverage.candidates_assessed === 0
        && coverage.candidates_skipped === 0;
      const reasonsAreValid = coverage.reason_codes.length === 1
        && coverage.reason_codes.every(
          (reason) => reason === "not_requested" || reason === "judge_unavailable",
        );
      if (!countsAreZero || !reasonsAreValid) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "not_assessed coverage requires zero counts and an allowed reason",
        });
      }
    }
    if (
      coverage.state === "truncated"
      && (
        coverage.candidates_skipped < 1
        || !coverage.reason_codes.some((reason) => budgetReasons.has(reason))
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "truncated coverage requires skipped candidates and a budget reason",
      });
    }
    if (
      coverage.state === "failed"
      && !reasons.has("scan_incomplete")
      && !reasons.has("provider_error")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failed coverage requires a scan or provider failure reason",
      });
    }
  });
export type CoverageDimensionV2 = z.infer<typeof CoverageDimensionV2>;

const citationSource = z.discriminatedUnion("kind", [
  repositoryLocation.omit({ line: true, anchor: true }),
  adapterLocation.omit({ line: true, anchor: true }),
]);

export const KnowledgeHygieneCitationV2 = z
  .object({
    source: citationSource,
    blob_sha256: sha256,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    text_sha256: sha256,
    excerpt: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 1024,
        "excerpt must not exceed 1024 UTF-8 bytes",
      ),
  })
  .strict()
  .superRefine((citation, context) => {
    if (citation.end_line < citation.start_line) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_line"],
        message: "end_line must be greater than or equal to start_line",
      });
    }
  });
export type KnowledgeHygieneCitationV2 = z.infer<
  typeof KnowledgeHygieneCitationV2
>;

const newRuleDimensions: Readonly<
  Partial<Record<KnowledgeHygieneRuleIdV2, CoverageDimensionNameV2>>
> = {
  "rulebook.managed_context_block": "narrative",
  "rulebook.narrative_block": "narrative",
  "rulebook.narrative_density": "narrative",
  "rulebook.invalid_waiver": "mechanical",
  "dependency.review_due": "cross_repository",
  "semantic.narrative": "narrative",
  "semantic.contradiction": "contradiction",
  "semantic.drift": "drift",
  "semantic.memory_overlap": "memory_overlap",
  "semantic.cross_repository_impact": "cross_repository",
};

export const KnowledgeHygieneFindingV2 = KnowledgeHygieneFindingV1.omit({
  rule_id: true,
  surface: true,
  location: true,
  evidence_refs: true,
})
  .extend({
    rule_id: KnowledgeHygieneRuleIdV2,
    surface: KnowledgeHygieneSurfaceV2,
    location: KnowledgeHygieneLocationV2,
    evidence_refs: z.array(KnowledgeHygieneEvidenceRefV2),
    origin: z.enum(["mechanical", "semantic"]),
    dimension: CoverageDimensionNameV2,
    closure_policy: z.enum([
      "mechanical_sufficient",
      "semantic_confirmation_required",
    ]),
    citations: z.array(KnowledgeHygieneCitationV2),
  })
  .strict()
  .superRefine((finding, context) => {
    if (
      finding.surface === "dependency"
      && finding.location.kind === "adapter"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["location"],
        message: "dependency findings require repository or registry locations",
      });
    }
    if (
      finding.surface !== "dependency"
      && finding.location.kind === "registry"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["location"],
        message: "registry locations are valid only for dependency findings",
      });
    }
    const semanticRule = finding.rule_id.startsWith("semantic.");
    if (
      semanticRule
      && (
        finding.origin !== "semantic"
        || finding.closure_policy !== "semantic_confirmation_required"
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantic rules require semantic origin and confirmation",
      });
    }
    if (!semanticRule && finding.origin !== "mechanical") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["origin"],
        message: "deterministic rules require mechanical origin",
      });
    }
    const expectedDimension = newRuleDimensions[finding.rule_id]
      ?? (KnowledgeHygieneRuleIdV1.safeParse(finding.rule_id).success
        ? "mechanical"
        : undefined);
    if (expectedDimension === undefined || finding.dimension !== expectedDimension) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimension"],
        message: "finding dimension does not match the rule registry",
      });
    }
    if (
      (finding.rule_id.startsWith("rulebook.")
        || finding.rule_id === "dependency.review_due")
      && finding.closure_policy !== "mechanical_sufficient"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closure_policy"],
        message: "deterministic V2 rules require mechanical closure",
      });
    }
  });
export type KnowledgeHygieneFindingV2 = z.infer<
  typeof KnowledgeHygieneFindingV2
>;

export const FindingLifecycleStateV2 = z.enum([
  "open",
  "mechanically_applied",
  "mechanically_resolved",
  "semantically_resolved",
  "reviewed_no_change",
  "accepted_risk",
  "suppressed",
  "obsolete",
  "closed_absent",
  "resolved_legacy",
]);
export type FindingLifecycleStateV2 = z.infer<
  typeof FindingLifecycleStateV2
>;

const writableTransitions: Readonly<
  Partial<Record<FindingLifecycleStateV2, ReadonlySet<FindingLifecycleStateV2>>>
> = {
  open: new Set([
    "mechanically_applied",
    "reviewed_no_change",
    "accepted_risk",
    "suppressed",
    "obsolete",
    "closed_absent",
  ]),
  mechanically_applied: new Set([
    "mechanically_resolved",
    "semantically_resolved",
    "accepted_risk",
    "suppressed",
    "obsolete",
  ]),
};

export const KnowledgeHygieneResolutionEventV2 = z
  .object({
    schema_version: z.literal("2"),
    event_id: knowledgeHygieneEventId,
    repo_id: z.string().min(1),
    fingerprint: knowledgeHygieneFingerprint,
    from_state: FindingLifecycleStateV2,
    to_state: FindingLifecycleStateV2,
    actor: z
      .object({
        kind: z.enum(["human", "agent", "system"]),
        id: z.string().trim().min(1),
      })
      .strict(),
    reason: z.string().trim().min(1),
    evidence_refs: z.array(KnowledgeHygieneEvidenceRefV2).min(1),
    occurred_at: z.string().datetime(),
    plan_id: z.string().min(1).optional(),
    suppression: z
      .object({
        scope: z.string().trim().min(1),
        expires_at: z.string().datetime().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.from_state === "resolved_legacy"
      || event.to_state === "resolved_legacy"
      || !writableTransitions[event.from_state]?.has(event.to_state)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to_state"],
        message: "illegal V2 finding lifecycle transition",
      });
    }
    if ((event.to_state === "suppressed") !== (event.suppression !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suppression"],
        message: "suppression metadata is required only for suppressed events",
      });
    }
    if (
      event.suppression?.expires_at !== undefined
      && Date.parse(event.suppression.expires_at) <= Date.parse(event.occurred_at)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suppression", "expires_at"],
        message: "suppression expiry must be after the event time",
      });
    }
    if (
      event.to_state === "closed_absent"
      && !event.evidence_refs.some(
        (ref) => (ref.kind === "report" || ref.kind === "evidence_pack")
          && ref.run_id !== undefined,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_refs"],
        message: "closed_absent requires coverage evidence for the current run",
      });
    }
  });
export type KnowledgeHygieneResolutionEventV2 = z.infer<
  typeof KnowledgeHygieneResolutionEventV2
>;

export const KnowledgeHygieneResolvedFindingV2 = z
  .object({
    finding: KnowledgeHygieneFindingV2,
    resolution_events: z.array(KnowledgeHygieneResolutionEventV2).min(1),
  })
  .strict();
export type KnowledgeHygieneResolvedFindingV2 = z.infer<
  typeof KnowledgeHygieneResolvedFindingV2
>;

export const KnowledgeHygieneHealthClaimV2 = z.enum([
  "findings_present",
  "assessed_scope_clean",
  "assessment_incomplete",
]);
export type KnowledgeHygieneHealthClaimV2 = z.infer<
  typeof KnowledgeHygieneHealthClaimV2
>;

const rejectionCounts = z
  .object({
    schema_error: z.number().int().nonnegative().optional(),
    quote_mismatch: z.number().int().nonnegative().optional(),
    input_drift: z.number().int().nonnegative().optional(),
    unsupported_claim: z.number().int().nonnegative().optional(),
    low_confidence: z.number().int().nonnegative().optional(),
    provider_error: z.number().int().nonnegative().optional(),
  })
  .strict();

function expectedHealthClaim(report: {
  findings: readonly unknown[];
  coverage: readonly CoverageDimensionV2[];
}): KnowledgeHygieneHealthClaimV2 {
  const assessmentIncomplete = report.coverage.some((coverage) => {
    if (coverage.state === "failed" || coverage.state === "truncated") return true;
    if (coverage.state !== "not_assessed") return false;
    return !coverage.reason_codes.includes("not_requested");
  });
  if (assessmentIncomplete) return "assessment_incomplete";
  if (report.findings.length > 0) return "findings_present";
  return "assessed_scope_clean";
}

export const KnowledgeHygieneReportV2 = KnowledgeHygieneReportV1.omit({
  schema_version: true,
  findings: true,
  resolved_findings: true,
})
  .extend({
    schema_version: z.literal("2"),
    findings: z.array(KnowledgeHygieneFindingV2),
    resolved_findings: z.array(KnowledgeHygieneResolvedFindingV2).optional(),
    assessment_scope: KnowledgeHygieneAssessmentScopeV2,
    coverage: z.array(CoverageDimensionV2).min(1),
    health_claim: KnowledgeHygieneHealthClaimV2,
    rejection_counts: rejectionCounts,
  })
  .strict()
  .superRefine((report, context) => {
    const fingerprints = report.findings.map((finding) => finding.fingerprint);
    if (new Set(fingerprints).size !== fingerprints.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "findings must have unique fingerprints",
      });
    }
    const dimensions = report.coverage.map((coverage) => coverage.dimension);
    if (
      dimensions.length !== COVERAGE_DIMENSION_ORDER_V2.length
      || dimensions.some(
        (dimension, index) => dimension !== COVERAGE_DIMENSION_ORDER_V2[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage"],
        message: "coverage must include every dimension once in canonical order",
      });
    }
    if (report.health_claim !== expectedHealthClaim(report)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["health_claim"],
        message: "health_claim does not match coverage and findings",
      });
    }
  });
export type KnowledgeHygieneReportV2 = z.infer<
  typeof KnowledgeHygieneReportV2
>;
