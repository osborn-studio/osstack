import { z } from "zod";

const sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters");
const gitObjectId = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "invalid Git object id");
const epochMilliseconds = z.number().int().nonnegative().finite();
const boundedText = z.string().trim().min(1).max(20_000);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/);
const sessionId = z.string().regex(/^probe_[a-z0-9][a-z0-9_-]{7,63}$/);
const itemId = z.string().regex(/^pi_[a-z0-9][a-z0-9_-]{7,63}$/);
const eventId = z.string().regex(/^pe_[a-z0-9][a-z0-9_-]{7,63}$/);
const questionId = z
  .string()
  .regex(/^(?:[a-z][a-z0-9_-]*\.)+[a-z0-9_-]+\.v[1-9][0-9]*$/);
const dynamicQuestionId = z
  .string()
  .regex(/^dynamic\.[a-f0-9]{64}\.v1$/);

export const ProbeRepositoryRelativePathV1 = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .superRefine((value, context) => {
    const segments = value.split("/");
    if (
      value.startsWith("/") ||
      /^[a-zA-Z]:[\\/]/.test(value) ||
      value.includes("\\") ||
      value.includes("\0") ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "path must be a normalized repository-relative path",
      });
    }
  });
export type ProbeRepositoryRelativePathV1 = z.infer<
  typeof ProbeRepositoryRelativePathV1
>;

export const ProbeQuadrantV1 = z.enum(["kk", "ku", "uk", "uu"]);
export type ProbeQuadrantV1 = z.infer<typeof ProbeQuadrantV1>;

export const ProbeItemKindV1 = z.enum([
  "fact",
  "assumption",
  "question",
  "risk",
]);
export type ProbeItemKindV1 = z.infer<typeof ProbeItemKindV1>;

export const ProbeItemStateV1 = z.enum([
  "open",
  "deferred",
  "resolved",
  "waived",
  "invalidated",
]);
export type ProbeItemStateV1 = z.infer<typeof ProbeItemStateV1>;

export const ProbeSessionStateV1 = z.enum([
  "active",
  "paused",
  "completed",
  "abandoned",
]);
export type ProbeSessionStateV1 = z.infer<typeof ProbeSessionStateV1>;

export const ProbeDocTypeV1 = z.enum(["product", "tech", "test"]);
export type ProbeDocTypeV1 = z.infer<typeof ProbeDocTypeV1>;

export const ProbeDepthV1 = z.enum(["quick", "standard", "deep"]);
export type ProbeDepthV1 = z.infer<typeof ProbeDepthV1>;

export const ProbeOriginV1 = z.enum([
  "calibration",
  "static_pack",
  "blindspot",
  "interview_followup",
  "prototype_reaction",
  "restatement_diff",
  "mid_build",
  "manual",
]);
export type ProbeOriginV1 = z.infer<typeof ProbeOriginV1>;

export const ProbeCategoryV1 = z.enum([
  "user",
  "outcome",
  "scope",
  "data_model",
  "interface",
  "user_flow",
  "failure_mode",
  "performance",
  "security",
  "dependency",
  "migration",
  "rollback",
  "observability",
  "acceptance",
  "test_data",
  "environment",
  "tacit_convention",
]);
export type ProbeCategoryV1 = z.infer<typeof ProbeCategoryV1>;

export const ProbeDestinationRoleV1 = z.enum([
  "session_profile",
  "prd",
  "technical_design",
  "test_plan",
  "adr",
  "instruction",
  "evaluation_spec",
  "open_questions",
]);
export type ProbeDestinationRoleV1 = z.infer<typeof ProbeDestinationRoleV1>;

export const ProbeActorV1 = z
  .object({
    type: z.enum(["human", "agent"]),
    id: z.string().trim().min(1).max(256),
  })
  .strict();
export type ProbeActorV1 = z.infer<typeof ProbeActorV1>;

export const ProbeOptionV1 = z
  .object({
    option_id: identifier,
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type ProbeOptionV1 = z.infer<typeof ProbeOptionV1>;

const evidenceMetadata = {
  sha256: sha256.optional(),
  line: z.number().int().positive().optional(),
  symbol: z.string().trim().min(1).max(512).optional(),
};

export const ProbeEvidenceRefV1 = z.union([
  z
    .object({
      kind: z.enum(["file", "artifact"]),
      ref: ProbeRepositoryRelativePathV1,
      ...evidenceMetadata,
    })
    .strict(),
  z
    .object({
      kind: z.literal("url"),
      ref: z.string().url().max(2_048),
      ...evidenceMetadata,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["symbol", "command_output", "user_statement"]),
      ref: z.string().trim().min(1).max(2_048),
      ...evidenceMetadata,
    })
    .strict(),
]);
export type ProbeEvidenceRefV1 = z.infer<typeof ProbeEvidenceRefV1>;

export const ProbeDeferralV1 = z
  .object({
    owner: z.string().trim().min(1).max(256),
    revisit_trigger: z.string().trim().min(1).max(2_000),
    deferred_at_ms: epochMilliseconds,
    review_after_ms: epochMilliseconds.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.review_after_ms !== undefined &&
      value.review_after_ms < value.deferred_at_ms
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["review_after_ms"],
        message: "review_after_ms cannot precede deferred_at_ms",
      });
    }
  });
export type ProbeDeferralV1 = z.infer<typeof ProbeDeferralV1>;

export const ProbeResolutionV1 = z
  .object({
    answer: boundedText,
    actor: ProbeActorV1,
    resolved_at_ms: epochMilliseconds,
    selected_option_id: identifier.optional(),
  })
  .strict();
export type ProbeResolutionV1 = z.infer<typeof ProbeResolutionV1>;

export const ProbeDestinationV1 = z.union([
  z
    .object({
      role: z.literal("session_profile"),
      profile_key: z.enum(["domain", "repository", "intent"]),
      write_state: z.literal("verified"),
    })
    .strict(),
  z
    .object({
      role: z.enum([
        "prd",
        "technical_design",
        "test_plan",
        "adr",
        "instruction",
        "evaluation_spec",
        "open_questions",
      ]),
      path: ProbeRepositoryRelativePathV1,
      anchor: z.string().trim().min(1).max(512).optional(),
      write_state: z.enum(["pending", "applied", "verified"]),
      content_sha256: sha256.optional(),
    })
    .strict(),
]);
export type ProbeDestinationV1 = z.infer<typeof ProbeDestinationV1>;

export const ProbeWaiverV1 = z
  .object({
    reason: boundedText,
    approved_by: z.string().trim().min(1).max(256),
    approved_at_ms: epochMilliseconds,
    expires_at_ms: epochMilliseconds.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expires_at_ms !== undefined &&
      value.expires_at_ms < value.approved_at_ms
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expires_at_ms"],
        message: "expires_at_ms cannot precede approved_at_ms",
      });
    }
  });
export type ProbeWaiverV1 = z.infer<typeof ProbeWaiverV1>;

export const ProbeInvalidationV1 = z
  .object({
    reason: boundedText,
    actor: ProbeActorV1,
    invalidated_at_ms: epochMilliseconds,
  })
  .strict();
export type ProbeInvalidationV1 = z.infer<typeof ProbeInvalidationV1>;

export const ProbeCompilationV1 = z.union([
  z.object({ state: z.literal("not_eligible") }).strict(),
  z
    .object({
      state: z.literal("manual_required"),
      reason: boundedText,
    })
    .strict(),
  z
    .object({
      state: z.literal("compiled"),
      spec_ref: ProbeRepositoryRelativePathV1,
      template_id: identifier,
    })
    .strict(),
]);
export type ProbeCompilationV1 = z.infer<typeof ProbeCompilationV1>;

export const ProbeItemBaseV1 = z
  .object({
    schema_version: z.literal("1"),
    item_id: itemId,
    question_id: questionId,
    session_id: sessionId,
    supersedes_item_id: itemId.optional(),
    source_pack: z
      .object({ pack_id: identifier, version: z.string().trim().min(1) })
      .strict()
      .optional(),
    item_kind: ProbeItemKindV1,
    initial_quadrant: ProbeQuadrantV1,
    current_quadrant: ProbeQuadrantV1,
    doc_type: ProbeDocTypeV1,
    category: ProbeCategoryV1,
    origin: ProbeOriginV1,
    prompt: z.string().trim().min(1).max(4_000),
    options: z.array(ProbeOptionV1).max(4),
    impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    irreversibility: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    uncertainty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    required: z.boolean(),
    evidence_refs: z.array(ProbeEvidenceRefV1).max(32),
    destination_hint: ProbeDestinationRoleV1.optional(),
    created_at_ms: epochMilliseconds,
    updated_at_ms: epochMilliseconds,
  })
  .strict();
export type ProbeItemBaseV1 = z.infer<typeof ProbeItemBaseV1>;

export const ProbeItemV1 = z
  .union([
    ProbeItemBaseV1.extend({ state: z.literal("open") }),
    ProbeItemBaseV1.extend({
      state: z.literal("deferred"),
      deferral: ProbeDeferralV1,
    }),
    ProbeItemBaseV1.extend({
      state: z.literal("resolved"),
      resolution: ProbeResolutionV1,
      destination: ProbeDestinationV1,
      compilation: ProbeCompilationV1,
    }),
    ProbeItemBaseV1.extend({
      state: z.literal("waived"),
      waiver: ProbeWaiverV1,
    }),
    ProbeItemBaseV1.extend({
      state: z.literal("invalidated"),
      invalidation: ProbeInvalidationV1,
    }),
  ])
  .superRefine((item, context) => {
    const optionIds = item.options.map((option) => option.option_id);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "option ids must be unique within a question",
      });
    }
    if (
      item.state === "resolved" &&
      item.resolution.selected_option_id !== undefined &&
      !optionIds.includes(item.resolution.selected_option_id)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution", "selected_option_id"],
        message: "selected option must exist on the item",
      });
    }
    if (
      item.state === "resolved" &&
      item.origin !== "calibration" &&
      item.destination.role === "session_profile"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destination", "role"],
        message: "only calibration items may target the session profile",
      });
    }
  });
export type ProbeItemV1 = z.infer<typeof ProbeItemV1>;

export const ProbeFamiliarityV1 = z
  .object({
    domain: z.enum(["novice", "working", "expert"]).optional(),
    repository: z.enum(["new", "familiar", "maintainer"]).optional(),
    intent: z.enum(["sketch", "draft", "review_ready"]).optional(),
  })
  .strict()
  .superRefine((familiarity, context) => {
    if (Object.values(familiarity).every((value) => value === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "familiarity must record at least one calibrated dimension",
      });
    }
  });
export type ProbeFamiliarityV1 = z.infer<typeof ProbeFamiliarityV1>;

export const ProbeInputRefV1 = z
  .object({
    kind: z.enum(["input", "reference", "prior_ledger"]),
    label: z.string().trim().min(1).max(256),
    sha256,
    external: z.boolean(),
    repo_relative_path: ProbeRepositoryRelativePathV1.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.external === (value.repo_relative_path !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repo_relative_path"],
        message:
          "internal inputs require a repository path and external inputs must omit it",
      });
    }
  });
export type ProbeInputRefV1 = z.infer<typeof ProbeInputRefV1>;

export const ProbeSessionBaseV1 = z
  .object({
    schema_version: z.literal("1"),
    session_id: sessionId,
    repo_id: z.string().trim().min(1).max(256),
    source_revision: gitObjectId.optional(),
    worktree_state: z.enum(["clean", "dirty", "not_git"]),
    task_ref: z.string().trim().min(1).max(512).optional(),
    input_refs: z.array(ProbeInputRefV1).max(128),
    doc_types: z.array(ProbeDocTypeV1).min(1).max(3),
    question_pack_refs: z.array(
      z
        .object({ pack_id: identifier, version: z.string().trim().min(1) })
        .strict(),
    ),
    selected_question_ids: z.array(questionId),
    unselected_required_question_ids: z.array(questionId),
    depth: ProbeDepthV1,
    question_budget: z.number().int().min(1).max(100).finite(),
    questions_presented: z.number().int().nonnegative().max(100).finite(),
    familiarity: ProbeFamiliarityV1.optional(),
    revision: z.number().int().positive().finite(),
    created_at_ms: epochMilliseconds,
    updated_at_ms: epochMilliseconds,
  })
  .strict();
export type ProbeSessionBaseV1 = z.infer<typeof ProbeSessionBaseV1>;

export const ProbeSessionV1 = z
  .union([
    ProbeSessionBaseV1.extend({
      state: z.literal("active"),
      current_question_id: itemId,
    }),
    ProbeSessionBaseV1.extend({
      state: z.literal("paused"),
      current_question_id: itemId.optional(),
      pause_reason: z.enum(["budget", "diminishing_returns", "user"]),
    }),
    ProbeSessionBaseV1.extend({
      state: z.literal("completed"),
      completed_at_ms: epochMilliseconds,
    }),
    ProbeSessionBaseV1.extend({
      state: z.literal("abandoned"),
      abandoned_at_ms: epochMilliseconds,
      reason: boundedText,
    }),
  ])
  .superRefine((session, context) => {
    if (session.questions_presented > session.question_budget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions_presented"],
        message: "questions_presented cannot exceed question_budget",
      });
    }
    const docTypes = new Set(session.doc_types);
    if (docTypes.size !== session.doc_types.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["doc_types"],
        message: "doc_types must be unique",
      });
    }
    const selected = new Set(session.selected_question_ids);
    if (selected.size !== session.selected_question_ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selected_question_ids"],
        message: "selected question ids must be unique",
      });
    }
    if (
      session.unselected_required_question_ids.some((id) => selected.has(id))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unselected_required_question_ids"],
        message: "selected and unselected question ids must be disjoint",
      });
    }
  });
export type ProbeSessionV1 = z.infer<typeof ProbeSessionV1>;

export const ProbeEventV1 = z
  .object({
    schema_version: z.literal("1"),
    event_id: eventId,
    session_id: sessionId,
    revision: z.number().int().positive().finite(),
    type: z.enum([
      "session_started",
      "answer_recorded",
      "item_deferred",
      "item_waived",
      "item_invalidated",
      "items_added",
      "items_compiled",
      "session_paused",
      "session_resumed",
      "session_abandoned",
      "destination_updated",
    ]),
    actor: ProbeActorV1,
    idempotency_key: z.string().trim().min(1).max(256),
    item_id: itemId.optional(),
    occurred_at_ms: epochMilliseconds,
    payload: z.record(z.unknown()),
  })
  .strict();
export type ProbeEventV1 = z.infer<typeof ProbeEventV1>;

export const ProbeSeverityV1 = z.enum(["high", "medium", "low"]);
export type ProbeSeverityV1 = z.infer<typeof ProbeSeverityV1>;

export const ProbeMetricItemFactV1 = z
  .object({
    item_id: itemId,
    required: z.boolean(),
    severity: ProbeSeverityV1,
    impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    origin: ProbeOriginV1,
  })
  .strict();
export type ProbeMetricItemFactV1 = z.infer<
  typeof ProbeMetricItemFactV1
>;

export const ProbeGateViolationV1 = z
  .object({
    code: identifier,
    severity: ProbeSeverityV1,
    message: z.string().trim().min(1).max(2_000),
    item_id: itemId.optional(),
    question_id: questionId.optional(),
    advisory: z.boolean().optional(),
  })
  .strict();
export type ProbeGateViolationV1 = z.infer<typeof ProbeGateViolationV1>;

export const ProbeReadinessV1 = z
  .object({
    required_total: z.number().int().nonnegative(),
    required_disposed: z.number().int().nonnegative(),
    open_by_severity: z
      .object({
        high: z.number().int().nonnegative(),
        medium: z.number().int().nonnegative(),
        low: z.number().int().nonnegative(),
      })
      .strict(),
    deferred_due: z.number().int().nonnegative(),
    waived_active: z.number().int().nonnegative(),
    waived_expired: z.number().int().nonnegative(),
    resolved_destination_pending: z.number().int().nonnegative(),
    resolved_destination_applied: z.number().int().nonnegative(),
    compilation_manual_required: z.number().int().nonnegative(),
    completion_percent: z.number().min(0).max(100).finite(),
    eligible: z.boolean(),
    violations: z.array(ProbeGateViolationV1),
  })
  .strict()
  .superRefine((readiness, context) => {
    if (readiness.required_disposed > readiness.required_total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required_disposed"],
        message: "required_disposed cannot exceed required_total",
      });
    }
  });
export type ProbeReadinessV1 = z.infer<typeof ProbeReadinessV1>;

export const ProbeLedgerV1 = z
  .object({
    schema_version: z.literal("1"),
    session: ProbeSessionV1,
    items: z.array(ProbeItemV1),
    events: z.array(ProbeEventV1),
    readiness: ProbeReadinessV1,
    artifact: z
      .object({
        exported_revision: z.number().int().positive(),
        exported_at_ms: epochMilliseconds,
        generator_version: z.string().trim().min(1).max(128),
      })
      .strict(),
    redactions: z.array(
      z
        .object({
          field: z.string().trim().min(1).max(512),
          reason: z.string().trim().min(1).max(512),
          replacement: z.literal("[REDACTED]").optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((ledger, context) => {
    const itemIds = new Set<string>();
    for (const [index, item] of ledger.items.entries()) {
      if (item.session_id !== ledger.session.session_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "session_id"],
          message: "item session must match ledger session",
        });
      }
      if (itemIds.has(item.item_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "item_id"],
          message: "item ids must be unique",
        });
      }
      itemIds.add(item.item_id);
    }
    const revisions = new Set<number>();
    for (const [index, event] of ledger.events.entries()) {
      if (event.session_id !== ledger.session.session_id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", index, "session_id"],
          message: "event session must match ledger session",
        });
      }
      if (revisions.has(event.revision)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", index, "revision"],
          message: "event revisions must be unique",
        });
      }
      revisions.add(event.revision);
    }
    const currentQuestionId =
      ledger.session.state === "active" || ledger.session.state === "paused"
        ? ledger.session.current_question_id
        : undefined;
    if (
      currentQuestionId !== undefined &&
      !itemIds.has(currentQuestionId)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["session", "current_question_id"],
        message: "current question must reference an item in the ledger",
      });
    }
    if (ledger.artifact.exported_revision !== ledger.session.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact", "exported_revision"],
        message: "artifact revision must match the exported session revision",
      });
    }
  });
export type ProbeLedgerV1 = z.infer<typeof ProbeLedgerV1>;

export const ProbeItemDraftV1 = z
  .object({
    schema_version: z.literal("1"),
    question_id: dynamicQuestionId,
    supersedes_item_id: itemId.optional(),
    item_kind: ProbeItemKindV1,
    initial_quadrant: ProbeQuadrantV1,
    current_quadrant: ProbeQuadrantV1,
    doc_type: ProbeDocTypeV1,
    category: ProbeCategoryV1,
    origin: z.enum([
      "blindspot",
      "interview_followup",
      "prototype_reaction",
      "restatement_diff",
      "mid_build",
      "manual",
    ]),
    prompt: z.string().trim().min(1).max(4_000),
    options: z.array(ProbeOptionV1).max(4),
    impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    irreversibility: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    uncertainty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    required: z.boolean(),
    evidence_refs: z.array(ProbeEvidenceRefV1).min(1).max(32),
    destination_hint: ProbeDestinationRoleV1,
  })
  .strict()
  .superRefine((question, context) => {
    const optionIds = question.options.map((option) => option.option_id);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "option ids must be unique within a question",
      });
    }
  });
export type ProbeItemDraftV1 = z.infer<typeof ProbeItemDraftV1>;

export const ProbeQuestionBatchV1 = z
  .object({
    schema_version: z.literal("1"),
    batch_id: z.string().regex(/^pqb_[a-z0-9][a-z0-9_-]{7,63}$/),
    origin: z.enum([
      "blindspot",
      "interview_followup",
      "prototype_reaction",
      "restatement_diff",
      "mid_build",
      "manual",
    ]),
    generated_by: ProbeActorV1,
    source_revision: gitObjectId,
    questions: z.array(ProbeItemDraftV1).min(1).max(100),
  })
  .strict()
  .superRefine((batch, context) => {
    const ids = batch.questions.map((question) => question.question_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "question ids must be unique within a batch",
      });
    }
    for (const [index, question] of batch.questions.entries()) {
      if (question.origin !== batch.origin) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", index, "origin"],
          message: "question origin must match the batch origin",
        });
      }
    }
  });
export type ProbeQuestionBatchV1 = z.infer<typeof ProbeQuestionBatchV1>;

export const ProbeRestatementEvidenceV1 = z
  .object({
    sha256,
    path: ProbeRepositoryRelativePathV1.optional(),
    line: z.number().int().positive().optional(),
    anchor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type ProbeRestatementEvidenceV1 = z.infer<
  typeof ProbeRestatementEvidenceV1
>;

export const ProbeRestatementFindingV1 = z
  .object({
    schema_version: z.literal("1"),
    finding_id: z.string().regex(/^prf_[a-z0-9][a-z0-9_-]{7,63}$/),
    kind: z.enum(["omitted", "added", "changed", "ambiguous"]),
    spec_evidence: ProbeRestatementEvidenceV1.nullable(),
    restatement_evidence: ProbeRestatementEvidenceV1.nullable(),
    explanation: boundedText,
    proposed_question: z.string().trim().min(1).max(4_000),
    impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    irreversibility: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    uncertainty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    destination_hint: ProbeDestinationRoleV1,
  })
  .strict()
  .superRefine((finding, context) => {
    if (
      finding.spec_evidence === null &&
      finding.restatement_evidence === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "at least one side of a restatement finding needs evidence",
      });
    }
  });
export type ProbeRestatementFindingV1 = z.infer<
  typeof ProbeRestatementFindingV1
>;

export const ProbeRenderManifestV1 = z
  .object({
    schema_version: z.literal("1"),
    session_id: sessionId,
    exported_revision: z.number().int().positive(),
    files: z
      .array(
        z
          .object({
            path: ProbeRepositoryRelativePathV1,
            sha256,
            bytes: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(2),
    generator_version: z.string().trim().min(1).max(128),
    completed_at_ms: epochMilliseconds,
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.files.map((file) => file.path);
    if (
      paths.includes("render-manifest.json") ||
      new Set(paths).size !== paths.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message:
          "manifest file entries must be unique and exclude the manifest itself",
      });
    }
  });
export type ProbeRenderManifestV1 = z.infer<typeof ProbeRenderManifestV1>;
