import { jointDigest } from './joint-json.js';
import { z } from 'zod';
import { Digest, Ref, UInt, issue, unique } from './joint-primitives.js';
const Text = z.string().min(1).max(16_384).refine(v => Buffer.byteLength(v, 'utf8') <= 16_384, 'MATERIAL_TEXT_BYTE_LIMIT');
const Texts = z.array(Text).max(128);
const Refs = z.array(Ref).max(128);
const fields = { schema_version: z.literal(1) };
const MaterialIntentFrame = z.object({ ...fields, kind: z.literal('material:intent_frame'), task_id: Ref, intent_revision: UInt, goals: Texts.min(1), non_goals: Texts, observations: Texts, hypotheses: Texts, unknowns: Texts, source_refs: Refs }).strict();
const MaterialGrounding = z.object({ ...fields, kind: z.literal('material:grounding'), facts: Texts, inferences: Texts, unknowns: Texts, source_refs: Refs }).strict();
const MaterialImpactMap = z.object({ ...fields, kind: z.literal('material:impact_map'), changed_surfaces: Texts.min(1), assumptions: Texts, check_refs: Refs.min(1) }).strict();
const MaterialVerificationPlan = z.object({ ...fields, kind: z.literal('material:verification_plan'), scenario_refs: Refs.min(1), required_checks: Refs.min(1), environment_refs: Refs.min(1) }).strict();
const MaterialReviewDispositions = z.object({ ...fields, kind: z.literal('material:review_dispositions'), finding_ref: Ref, decision: z.enum(['accept', 'reject', 'defer']), rationale: Text, evidence_refs: Refs.min(1) }).strict();
const MaterialDecisionTrail = z.object({ ...fields, kind: z.literal('material:decision_trail'), revision: UInt, supersedes: Ref.nullable(), decision: Text, evidence_refs: Refs.min(1) }).strict();
const MaterialFeatureMap = z.object({ ...fields, kind: z.literal('material:feature_map'), entry: Text, preconditions: Texts, actions: Texts.min(1), observable_end: Text, recovery: Texts.min(1), owner: Ref }).strict();
const MaterialExperimentResult = z.object({ ...fields, kind: z.literal('material:experiment_result'), protocol: Ref, arms: z.array(z.object({ id: Ref, candidate_digest: Digest, observation_refs: Refs.min(1) }).strict()).min(2).max(16), ledger: Ref, oracle_digest: Digest, result: z.enum(['inconclusive', 'supports_hypothesis', 'rejects_hypothesis']), uncertainty: Text }).strict();
const MaterialUsageSketch = z.object({ ...fields, kind: z.literal('material:usage_sketch'), caller: Ref, input: Text, output: Text, errors: Texts, alternatives: Texts }).strict();
const MaterialPrototypeDecision = z.object({ ...fields, kind: z.literal('material:prototype_decision'), hypothesis: Text, observations: Texts.min(1), decision: z.enum(['continue', 'revise', 'stop']), limits: Texts.min(1) }).strict();
/** Ten material bodies. These describe evidence and never issue host receipts or grants. */
export const MethodMaterial = z.discriminatedUnion('kind', [MaterialIntentFrame, MaterialGrounding, MaterialImpactMap, MaterialVerificationPlan, MaterialReviewDispositions, MaterialDecisionTrail, MaterialFeatureMap, MaterialExperimentResult, MaterialUsageSketch, MaterialPrototypeDecision]).superRefine((v, ctx) => {
  if (v.kind === 'material:experiment_result' && !unique(v.arms.map(a => a.id))) issue(ctx, 'DUPLICATE_EXPERIMENT_ARM');
  if (v.kind === 'material:decision_trail' && ((v.revision === 0) !== (v.supersedes === null))) issue(ctx, 'INVALID_DECISION_PREDECESSOR');
});
export type MethodMaterial = z.infer<typeof MethodMaterial>;

export const MaterialSchemas = { MaterialIntentFrame, MaterialGrounding, MaterialImpactMap, MaterialVerificationPlan, MaterialReviewDispositions, MaterialDecisionTrail, MaterialFeatureMap, MaterialExperimentResult, MaterialUsageSketch, MaterialPrototypeDecision };

export const intentDigest = (input: unknown): string => jointDigest('osstack.joint.intent.v1', MaterialIntentFrame.parse(input));
