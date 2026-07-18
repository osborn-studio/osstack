import {
  ProbeActorV1,
  ProbeEvidenceRefV1,
  ProbeItemV1,
  ProbeQuestionBatchV1,
  ProbeRestatementFindingV1,
  type ProbeEvidenceRefV1 as ProbeEvidenceRef,
  type ProbeItemV1 as ProbeItem,
  type ProbeQuestionBatchV1 as ProbeQuestionBatch,
  type ProbeRestatementFindingV1 as ProbeRestatementFinding,
} from "./types.js";
import { canonicalProbeJson, probeSha256 } from "./render.js";

export class ProbeDynamicInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeDynamicInputError";
  }
}

export interface MaterializeProbeQuestionBatchInputV1 {
  batch: unknown;
  session_id: string;
  source_revision: string;
  actor: ProbeActorV1;
  existing_items: readonly ProbeItem[];
  created_at_ms: number;
  create_item_id: () => string;
  verify_evidence: (
    evidence: ProbeEvidenceRef,
  ) => Promise<{ verifiable: boolean }>;
}

function sameActor(left: ProbeActorV1, right: ProbeActorV1): boolean {
  return left.type === right.type && left.id === right.id;
}

export async function materializeProbeQuestionBatch(
  input: MaterializeProbeQuestionBatchInputV1,
): Promise<{ batch: ProbeQuestionBatch; items: ProbeItem[] }> {
  const batch = ProbeQuestionBatchV1.parse(input.batch);
  const actor = ProbeActorV1.parse(input.actor);
  if (batch.source_revision !== input.source_revision) {
    throw new ProbeDynamicInputError(
      "question batch source revision does not match the repository",
    );
  }
  if (!sameActor(batch.generated_by, actor)) {
    throw new ProbeDynamicInputError(
      "question batch generated_by must match the command actor",
    );
  }
  const itemIds = new Set(input.existing_items.map((item) => item.item_id));
  const questionIds = new Set(
    input.existing_items.map((item) => item.question_id),
  );
  const items: ProbeItem[] = [];
  for (const question of batch.questions) {
    if (questionIds.has(question.question_id)) {
      throw new ProbeDynamicInputError(
        `duplicate dynamic question: ${question.question_id}`,
      );
    }
    if (
      question.supersedes_item_id !== undefined &&
      !itemIds.has(question.supersedes_item_id)
    ) {
      throw new ProbeDynamicInputError(
        `superseded item does not exist: ${question.supersedes_item_id}`,
      );
    }
    const verified = await Promise.all(
      question.evidence_refs.map((evidence) =>
        input.verify_evidence(evidence),
      ),
    );
    if (!verified.some((result) => result.verifiable)) {
      throw new ProbeDynamicInputError(
        `question has no verifiable evidence: ${question.question_id}`,
      );
    }
    const itemId = input.create_item_id();
    if (itemIds.has(itemId)) {
      throw new ProbeDynamicInputError(`duplicate dynamic item id: ${itemId}`);
    }
    const item = ProbeItemV1.parse({
      ...question,
      item_id: itemId,
      session_id: input.session_id,
      created_at_ms: input.created_at_ms,
      updated_at_ms: input.created_at_ms,
      state: "open",
    });
    itemIds.add(item.item_id);
    questionIds.add(item.question_id);
    items.push(item);
  }
  return { batch, items };
}

export const ProbeRestatementFindingsV1 = ProbeRestatementFindingV1.array()
  .min(1)
  .max(100)
  .superRefine((findings, context) => {
    const ids = findings.map((finding) => finding.finding_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "restatement finding ids must be unique",
      });
    }
  });
export type ProbeRestatementFindingsV1 = ProbeRestatementFinding[];

export interface CreateRestatementQuestionBatchInputV1 {
  findings: unknown;
  generated_by: ProbeActorV1;
  source_revision: string;
  evidence_refs: readonly (readonly ProbeEvidenceRef[])[];
}

export function createRestatementQuestionBatch(
  input: CreateRestatementQuestionBatchInputV1,
): ProbeQuestionBatch {
  const findings = ProbeRestatementFindingsV1.parse(input.findings);
  const generatedBy = ProbeActorV1.parse(input.generated_by);
  if (findings.length !== input.evidence_refs.length) {
    throw new ProbeDynamicInputError(
      "each restatement finding requires a verified evidence set",
    );
  }
  const digest = probeSha256(
    canonicalProbeJson({
      findings,
      generated_by: generatedBy,
      source_revision: input.source_revision,
    }),
  );
  return ProbeQuestionBatchV1.parse({
    schema_version: "1",
    batch_id: `pqb_${digest.slice(0, 16)}`,
    origin: "restatement_diff",
    generated_by: generatedBy,
    source_revision: input.source_revision,
    questions: findings.map((finding, index) => {
      const evidenceRefs = (input.evidence_refs[index] ?? []).map((evidence) =>
        ProbeEvidenceRefV1.parse(evidence),
      );
      const questionDigest = probeSha256(
        canonicalProbeJson({ finding, evidence_refs: evidenceRefs }),
      );
      return {
        schema_version: "1",
        question_id: `dynamic.${questionDigest}.v1`,
        item_kind: "question",
        initial_quadrant: "uk",
        current_quadrant: "uk",
        doc_type: "tech",
        category: "tacit_convention",
        origin: "restatement_diff",
        prompt: finding.proposed_question,
        options: [],
        impact: finding.impact,
        irreversibility: finding.irreversibility,
        uncertainty: finding.uncertainty,
        required: true,
        evidence_refs: evidenceRefs,
        destination_hint: finding.destination_hint,
      };
    }),
  });
}
