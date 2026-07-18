import { z } from "zod";
import { CALIBRATION_QUESTION_PACK_DEFINITION_V1 } from "./packs/calibration-v1.js";
import { PRODUCT_QUESTION_PACK_DEFINITION_V1 } from "./packs/product-v1.js";
import { TECH_QUESTION_PACK_DEFINITION_V1 } from "./packs/tech-v1.js";
import { TEST_QUESTION_PACK_DEFINITION_V1 } from "./packs/test-v1.js";
import {
  ProbeCategoryV1,
  ProbeDestinationRoleV1,
  ProbeDocTypeV1,
  ProbeEvidenceRefV1,
  type ProbeFamiliarityV1,
  ProbeItemKindV1,
  ProbeItemV1,
  ProbeOptionV1,
  ProbeQuadrantV1,
  type ProbeDepthV1,
  type ProbeItemV1 as ProbeItem,
} from "./types.js";

const staticQuestionId = z
  .string()
  .regex(/^(?:[a-z][a-z0-9_-]*\.)+[a-z0-9_-]+\.v[1-9][0-9]*$/);

export const ProbeQuestionTemplateV1 = z
  .object({
    schema_version: z.literal("1"),
    question_id: staticQuestionId,
    item_kind: ProbeItemKindV1,
    initial_quadrant: ProbeQuadrantV1,
    current_quadrant: ProbeQuadrantV1,
    doc_type: ProbeDocTypeV1,
    category: ProbeCategoryV1,
    origin: z.enum(["calibration", "static_pack"]),
    prompt: z.string().trim().min(1).max(4_000),
    options: z.array(ProbeOptionV1).max(4),
    impact: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    irreversibility: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    uncertainty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    required: z.boolean(),
    evidence_refs: z.array(ProbeEvidenceRefV1).max(32),
    destination_hint: ProbeDestinationRoleV1,
    profile_key: z.enum(["domain", "repository", "intent"]).optional(),
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
    if (
      question.origin === "calibration" &&
      (question.profile_key === undefined ||
        question.destination_hint !== "session_profile")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "calibration questions require a session profile key",
      });
    }
    if (
      question.origin === "static_pack" &&
      (question.profile_key !== undefined ||
        question.destination_hint === "session_profile")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "static questions cannot target the session profile",
      });
    }
  });
export type ProbeQuestionTemplateV1 = z.infer<
  typeof ProbeQuestionTemplateV1
>;

export const ProbeQuestionPackV1 = z
  .object({
    schema_version: z.literal("1"),
    pack_id: z.string().regex(/^probe\.[a-z][a-z0-9_-]*$/),
    version: z.string().regex(/^[1-9][0-9]*$/),
    priority: z.number().int().nonnegative(),
    doc_type: ProbeDocTypeV1.nullable(),
    provenance: z
      .object({
        kind: z.literal("osstack_original"),
        source: z.string().trim().min(1).max(1_024),
        inspiration: z.string().url().max(2_048).optional(),
      })
      .strict(),
    questions: z.array(ProbeQuestionTemplateV1).min(1).max(100),
  })
  .strict()
  .superRefine((pack, context) => {
    const ids = pack.questions.map((question) => question.question_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions"],
        message: "question ids must be unique within a pack",
      });
    }
    for (const [index, question] of pack.questions.entries()) {
      if (
        pack.doc_type !== null &&
        question.doc_type !== pack.doc_type
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", index, "doc_type"],
          message: "question doc type must match its pack",
        });
      }
    }
  });
export type ProbeQuestionPackV1 = z.infer<typeof ProbeQuestionPackV1>;

export const CALIBRATION_QUESTION_PACK_V1 = ProbeQuestionPackV1.parse(
  CALIBRATION_QUESTION_PACK_DEFINITION_V1,
);
export const PRODUCT_QUESTION_PACK_V1 = ProbeQuestionPackV1.parse(
  PRODUCT_QUESTION_PACK_DEFINITION_V1,
);
export const TECH_QUESTION_PACK_V1 = ProbeQuestionPackV1.parse(
  TECH_QUESTION_PACK_DEFINITION_V1,
);
export const TEST_QUESTION_PACK_V1 = ProbeQuestionPackV1.parse(
  TEST_QUESTION_PACK_DEFINITION_V1,
);

export const ALL_PROBE_QUESTION_PACKS_V1 = Object.freeze([
  CALIBRATION_QUESTION_PACK_V1,
  PRODUCT_QUESTION_PACK_V1,
  TECH_QUESTION_PACK_V1,
  TEST_QUESTION_PACK_V1,
]);

export type SelectedProbeQuestionV1 = ProbeQuestionTemplateV1 & {
  source_pack: { pack_id: string; version: string };
  pack_priority: number;
  pack_order: number;
};

export interface SelectProbeQuestionsInputV1 {
  doc_types: readonly ProbeDocTypeV1[];
  depth: ProbeDepthV1;
  familiarity?: Partial<ProbeFamiliarityV1>;
  question_budget?: number;
}

export interface ProbeQuestionSelectionV1 {
  question_budget: number;
  selected_questions: SelectedProbeQuestionV1[];
  unselected_required_question_ids: string[];
  question_pack_refs: Array<{ pack_id: string; version: string }>;
}

const depthBudgets: Readonly<Record<ProbeDepthV1, number>> = {
  quick: 8,
  standard: 20,
  deep: 40,
};

const originBoost = { calibration: 1, static_pack: 2 } as const;
const quadrantBoost = { kk: 0, ku: 1, uk: 3, uu: 2 } as const;

function templatePriority(question: SelectedProbeQuestionV1): number {
  return (
    question.impact * question.irreversibility * 100 +
    question.uncertainty * 10 +
    (question.required ? 5 : 0) +
    originBoost[question.origin] +
    quadrantBoost[question.current_quadrant]
  );
}

function selectPack(docType: ProbeDocTypeV1): ProbeQuestionPackV1 {
  if (docType === "product") return PRODUCT_QUESTION_PACK_V1;
  if (docType === "test") return TEST_QUESTION_PACK_V1;
  return TECH_QUESTION_PACK_V1;
}

function withPackMetadata(
  pack: ProbeQuestionPackV1,
  question: ProbeQuestionTemplateV1,
  packOrder: number,
): SelectedProbeQuestionV1 {
  return {
    ...question,
    source_pack: { pack_id: pack.pack_id, version: pack.version },
    pack_priority: pack.priority,
    pack_order: packOrder,
  };
}

function compareSelectedQuestions(
  left: SelectedProbeQuestionV1,
  right: SelectedProbeQuestionV1,
): number {
  const priority = templatePriority(right) - templatePriority(left);
  if (priority !== 0) return priority;
  if (left.pack_priority !== right.pack_priority) {
    return right.pack_priority - left.pack_priority;
  }
  if (left.pack_order !== right.pack_order) {
    return left.pack_order - right.pack_order;
  }
  return left.question_id.localeCompare(right.question_id);
}

export function selectProbeQuestions(
  input: SelectProbeQuestionsInputV1,
): ProbeQuestionSelectionV1 {
  const docTypes = z.array(ProbeDocTypeV1).min(1).max(3).parse(input.doc_types);
  const uniqueDocTypes = [...new Set(docTypes)];
  const budget = z.number().int().min(1).max(100).parse(
    input.question_budget ?? depthBudgets[input.depth],
  );
  const missingProfileKeys = (
    ["domain", "repository", "intent"] as const
  ).filter((key) => input.familiarity?.[key] === undefined);
  const calibration = CALIBRATION_QUESTION_PACK_V1.questions
    .map((question, index) =>
      withPackMetadata(CALIBRATION_QUESTION_PACK_V1, question, index),
    )
    .filter(
      (question) =>
        question.profile_key !== undefined &&
        missingProfileKeys.includes(question.profile_key),
    );
  const documentPacks = uniqueDocTypes.map(selectPack);
  const staticQuestions = documentPacks
    .flatMap((pack) =>
      pack.questions.map((question, index) =>
        withPackMetadata(pack, question, index),
      ),
    )
    .sort(compareSelectedQuestions);
  const allCandidates = [...calibration, ...staticQuestions];
  const selectedQuestions = allCandidates.slice(0, budget);
  const selectedIds = new Set(
    selectedQuestions.map((question) => question.question_id),
  );
  const questionPackRefs = [
    ...(calibration.length === 0 ? [] : [CALIBRATION_QUESTION_PACK_V1]),
    ...documentPacks,
  ].map((pack) => ({ pack_id: pack.pack_id, version: pack.version }));

  return {
    question_budget: budget,
    selected_questions: selectedQuestions,
    unselected_required_question_ids: allCandidates
      .filter(
        (question) => question.required && !selectedIds.has(question.question_id),
      )
      .map((question) => question.question_id),
    question_pack_refs: questionPackRefs,
  };
}

export interface MaterializeProbeQuestionsInputV1 {
  session_id: string;
  questions: readonly SelectedProbeQuestionV1[];
  created_at_ms: number;
  create_item_id: () => string;
}

export function materializeProbeQuestions(
  input: MaterializeProbeQuestionsInputV1,
): ProbeItem[] {
  return input.questions.map((question) =>
    ProbeItemV1.parse({
      schema_version: "1",
      item_id: input.create_item_id(),
      question_id: question.question_id,
      session_id: input.session_id,
      source_pack: question.source_pack,
      item_kind: question.item_kind,
      initial_quadrant: question.initial_quadrant,
      current_quadrant: question.current_quadrant,
      doc_type: question.doc_type,
      category: question.category,
      origin: question.origin,
      prompt: question.prompt,
      options: question.options,
      impact: question.impact,
      irreversibility: question.irreversibility,
      uncertainty: question.uncertainty,
      required: question.required,
      evidence_refs: question.evidence_refs,
      destination_hint: question.destination_hint,
      created_at_ms: input.created_at_ms,
      updated_at_ms: input.created_at_ms,
      state: "open",
    }),
  );
}
