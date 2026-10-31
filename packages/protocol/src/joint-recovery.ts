import { z } from 'zod';
import { RecoveryReceiptShape } from './joint-shapes.js';
import { Digest, Ref, UInt, issue, unique } from './contract-primitives.js';
import { jointDigest, canonicalJointJson } from './joint-json.js';
export const RecoverySubject = RecoveryReceiptShape.shape.subject;
export type RecoverySubject = z.infer<typeof RecoverySubject>;
export const RecoveryProof = RecoveryReceiptShape.shape.proofs.element;
export function recoverySubjectDigest(input: unknown): string {
  return jointDigest('osstack.joint.recovery-subject.v1', RecoverySubject.parse(input));
}

/** Clients request a decision; they cannot supply trusted phase, operator or generation. */
export const RecoveryRequest = z.object({
  kind: z.literal('recovery_request'), schema_version: z.literal(1), request_id: Ref.refine(v => v.length <= 256, 'REFERENCE_TOO_LONG'),
  if_revision: UInt, subject: RecoverySubject,
  decision: RecoveryReceiptShape.shape.decision, proof_refs: z.array(Ref).max(256),
  schema_spec_digest: Digest,
}).strict();
export type RecoveryRequest = z.infer<typeof RecoveryRequest>;
export const RecoveryProofEnvelope = z.object({
  kind: z.literal('recovery_proof'), schema_version: z.literal(1), subject: RecoverySubject,
  proof: RecoveryProof, owner_generation: UInt.positive(), observed_at_ms: UInt,
  binding_generation: UInt.nullable(), support_profile_digest: Digest.nullable(),
  prior_phase: RecoveryReceiptShape.shape.prior_phase,
  schema_spec_digest: Digest, recovery_build_digest: Digest,
  record_ref: Ref, authorization_ref: Ref,
}).strict().superRefine((v, ctx) => {
  let subjectDigest: string;
  try { subjectDigest = recoverySubjectDigest(v.subject); } catch { issue(ctx, 'INVALID_SUBJECT'); return; }
  if (v.record_ref !== v.proof.record_ref) issue(ctx, 'PROOF_RECORD_MISMATCH');
  if (v.proof.subject_digest !== subjectDigest) issue(ctx, 'PROOF_SUBJECT_MISMATCH');
  if (v.subject.kind === 'effect' ? v.proof.effect_id !== v.subject.effect_id : v.proof.effect_id !== undefined) issue(ctx, 'PROOF_EFFECT_MISMATCH');
  if (v.subject.kind === 'broker_lease') {
    const b = v.proof.broker_identity;
    if (!b || b.broker_id !== v.subject.broker_id || b.lease_id !== v.subject.lease_id || b.owner_generation !== v.owner_generation) issue(ctx, 'PROOF_BROKER_MISMATCH');
  } else if (v.proof.broker_identity !== undefined) issue(ctx, 'UNEXPECTED_BROKER_PROOF');
});
export type RecoveryProofEnvelope = z.infer<typeof RecoveryProofEnvelope>;

/** Structural evidence consistency only. J12 must load and authenticate every referenced fact. */
export const RecoveryReceipt = RecoveryReceiptShape.superRefine((v, ctx) => {
  let subjectDigest: string;
  try { subjectDigest = recoverySubjectDigest(v.subject); } catch { issue(ctx, 'INVALID_SUBJECT'); return; }
  const broker = v.subject.kind === 'broker_lease';
  if (v.subject_digest !== subjectDigest || v.subject.home_id !== v.target_home_id) issue(ctx, 'SUBJECT_MISMATCH');
  if (broker !== (v.target === 'broker') || broker !== (v.prior_phase === 'broker_unknown')) issue(ctx, 'TARGET_PHASE_MISMATCH');
  if (v.subject.kind === 'effect') {
    if (v.effect_id !== v.subject.effect_id || v.binding_generation === null || v.support_profile_digest === null) issue(ctx, 'EFFECT_IDENTITY_MISSING');
  } else if (v.effect_id !== undefined) issue(ctx, 'UNEXPECTED_EFFECT_ID');
  const decision = v.decision;
  if (v.prior_phase === 'legacy_unknown' && (v.subject.kind !== 'attention_action' || v.binding_generation !== null || v.support_profile_digest !== null)) issue(ctx, 'INVALID_LEGACY_IDENTITY');
  if ((v.prior_phase === 'legacy_unknown' || (v.prior_phase === 'reserved' && v.prior_resolution !== 'none')) && decision !== 'preserve_unknown') issue(ctx, 'UNKNOWN_CANNOT_RESOLVE');
  if (decision === 'proven_not_started' && v.prior_phase !== 'reserved') issue(ctx, 'ALREADY_COMMITTED');
  if ((decision === 'proven_stopped' || decision === 'applied_observed') && v.prior_phase === 'reserved') issue(ctx, 'NOT_COMMITTED');
  if (broker && decision !== 'preserve_unknown' && decision !== 'proven_stopped') issue(ctx, 'INVALID_BROKER_DECISION');
  const required = { preserve_unknown: null, proven_not_started: 'cancelled_before_dispatch', proven_stopped: 'invocation_contained', applied_observed: 'applied_completion' }[decision];
  if (!unique(v.proof_refs) || v.proof_refs.length !== v.proofs.length || v.proofs.some(p => !v.proof_refs.includes(p.record_ref))) issue(ctx, 'PROOF_REFERENCE_MISMATCH');
  if (required ? v.proofs.length !== 1 || v.proofs[0]?.type !== required : v.proofs.length !== 0) issue(ctx, 'INVALID_DECISION_PROOFS');
  for (const p of v.proofs) {
    if (p.subject_digest !== v.subject_digest) issue(ctx, 'PROOF_SUBJECT_MISMATCH');
    if (v.subject.kind === 'effect' ? p.effect_id !== v.subject.effect_id : p.effect_id !== undefined) issue(ctx, 'PROOF_EFFECT_MISMATCH');
    if (v.subject.kind === 'broker_lease') {
      const b = p.broker_identity;
      if (!b || b.broker_id !== v.subject.broker_id || b.lease_id !== v.subject.lease_id || b.schema !== v.actual_target_schema || b.owner_generation !== v.owner_generation) issue(ctx, 'PROOF_BROKER_MISMATCH');
    } else if (p.broker_identity !== undefined) issue(ctx, 'UNEXPECTED_BROKER_PROOF');
  }
});
export type RecoveryReceipt = z.infer<typeof RecoveryReceipt>;

/** Join host-loaded immutable envelopes to a receipt. Authentication, evidence-byte hashing,
 * containment/source identity and current-state CAS remain the host's responsibility. */
export function verifyRecoveryProofEnvelopes(receiptInput: unknown, envelopesInput: unknown): RecoveryReceipt {
  const receipt = RecoveryReceipt.parse(receiptInput);
  const envelopes = z.array(RecoveryProofEnvelope).max(256).parse(envelopesInput);
  if (envelopes.length !== receipt.proofs.length || !unique(envelopes.map(e => e.record_ref))) throw Error('PROOF_REFERENCE_MISMATCH');
  for (const envelope of envelopes) {
    const proof = receipt.proofs.find(p => p.record_ref === envelope.record_ref);
    if (!proof || canonicalJointJson(proof) !== canonicalJointJson(envelope.proof) || recoverySubjectDigest(envelope.subject) !== receipt.subject_digest) throw Error('PROOF_CONTENT_MISMATCH');
    for (const key of ['owner_generation', 'binding_generation', 'support_profile_digest', 'prior_phase', 'schema_spec_digest', 'recovery_build_digest'] as const) {
      if (envelope[key] !== receipt[key]) throw Error('PROOF_CONTEXT_MISMATCH');
    }
    if (envelope.observed_at_ms > receipt.observed_at_ms) throw Error('PROOF_AFTER_RECEIPT');
  }
  return receipt;
}

export function recoveryRequestInputDigest(input: unknown): string {
  const body = z.object({ schema_version: z.literal(1), principal_ref: Ref.refine(v => v.length <= 256, 'REFERENCE_TOO_LONG'), scope_id: Ref, tenant_id: Ref, request: RecoveryRequest }).strict().parse(input);
  return jointDigest('osstack.joint.recovery-request-input.v1', body);
}
