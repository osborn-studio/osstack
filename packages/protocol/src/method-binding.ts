import { z } from 'zod';
import * as shapes from './joint-shapes.js';
import { Digest, Ref, Role, issue, unique, portableGitPath } from './joint-primitives.js';
import { jointDigest } from './joint-json.js';

export const SourcePin = shapes.SourcePinShape.superRefine((v, ctx) => {
  if (!portableGitPath(v.subdir, true)) issue(ctx, 'NONCANONICAL_SOURCE_PATH');
});
export const MethodBinding = shapes.MethodBindingShape.superRefine((v, ctx) => {
  if ((v.mode === 'trial') !== (v.trial_permit_id !== undefined)) issue(ctx, 'TRIAL_PERMIT_MODE_MISMATCH');
  if (!unique(v.role_materials.map(r => r.role))) issue(ctx, 'DUPLICATE_ROLE');
});
export type MethodBinding = z.infer<typeof MethodBinding>;
export const MethodRecipe = shapes.MethodRecipeShape.superRefine((v, ctx) => {
  if (!unique(v.role_materials.map(r => r.role)) || !unique(v.logical_check_roles)) issue(ctx, 'DUPLICATE_ROLE');
  if (Digest.safeParse(v.required_artifacts_digest).success && v.role_materials.some(r => r.role_required_artifacts_digest !== roleRequirementsDigest(r.role, v.required_artifacts_digest))) issue(ctx, 'ROLE_REQUIREMENTS_DIGEST_MISMATCH');
});
export type MethodRecipe = z.infer<typeof MethodRecipe>;
export const MethodProposal = shapes.MethodProposalShape;
export type MethodProposal = z.infer<typeof MethodProposal>;
export const ArtifactRequirements = shapes.ArtifactRequirementsShape.superRefine((v, ctx) => {
  if (v.requirements.some(r => r.artifact_ref_kind === 'independent_review' && (r.producer_role !== 'reviewer' || !r.required))) issue(ctx, 'INVALID_REVIEW_REQUIREMENT');
  if (!unique(v.requirements.map(r => `${r.artifact_ref_kind}:${r.producer_role}`))) issue(ctx, 'DUPLICATE_ARTIFACT_REQUIREMENT');
});
export type ArtifactRequirements = z.infer<typeof ArtifactRequirements>;
export const CheckBinding = shapes.CheckBindingShape.superRefine((v, ctx) => {
  if (!unique(v.checks.map(c => c.id))) issue(ctx, 'DUPLICATE_CHECK');
  if (!v.checks.some(c => c.id === v.primary_id && c.required && c.role === 'acceptance')) issue(ctx, 'INVALID_PRIMARY_CHECK');
});
export const TrialPermit = shapes.TrialPermitShape.superRefine((v, ctx) => {
  const ttl = v.expires_at_ms - v.issued_at_ms;
  if (ttl <= 0 || ttl > 86_400_000 || v.max_wall_ms > ttl) issue(ctx, 'INVALID_TRIAL_TTL');
});
export type TrialPermit = z.infer<typeof TrialPermit>;
export const SupportProfile = shapes.SupportProfileShape.superRefine((v, ctx) => {
  if (v.stop_proof_level === 'contained' && (v.containment_domain === null || !v.can_request_stop)) issue(ctx, 'INVALID_CONTAINMENT_PROFILE');
  if (v.profile_class === 'measured_qualified' && !v.measurement_refs.length) issue(ctx, 'MISSING_MEASUREMENTS');
  if (v.start_identity === 'idempotent_effect_derived_run' && (!v.query_by_start_identity || !v.can_query || v.containment_domain === null)) issue(ctx, 'INVALID_START_IDENTITY');
});
export type SupportProfile = z.infer<typeof SupportProfile>;
export const MethodArtifact = shapes.ArtifactShape.superRefine((v, ctx) => {
  const phase = { intent_frame: 'intent', reproduction: 'baseline', candidate_checks: 'candidate', independent_review: 'candidate', cleanup_receipt: 'cleanup' }[v.artifact_kind];
  if (v.artifact_phase !== phase) issue(ctx, 'ARTIFACT_PHASE_MISMATCH');
  if (phase === 'intent' || phase === 'cleanup') {
    if (v.candidate !== undefined) issue(ctx, 'UNEXPECTED_CANDIDATE');
  } else if (!v.candidate || !v.scenario_digest || !v.environment_digest || !v.check_registry_digest) issue(ctx, 'MISSING_CANDIDATE_BINDING');
  if (phase === 'candidate' && !v.baseline_artifact_ref) issue(ctx, 'MISSING_BASELINE');
  if (phase === 'cleanup' && !v.resource_ledger_ref) issue(ctx, 'MISSING_RESOURCE_LEDGER');
});
export const ContextReceipt = shapes.ContextReceiptShape.superRefine((v, ctx) => {
  if (v.method_bytes > v.prompt_bytes) issue(ctx, 'METHOD_EXCEEDS_PROMPT');
});
export type ContextReceipt = z.infer<typeof ContextReceipt>;

/** The self digest is excluded; every authority-bearing field is retained. */
export function bindingDigest(input: unknown): string {
  const { binding_digest: _self, ...body } = MethodBinding.parse(input);
  body.role_materials.sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : 0);
  return jointDigest('osstack.joint.method-binding.v1', body);
}
/** Content integrity only; the host still authenticates grants and resolves referenced objects. */
export function verifyMethodBinding(input: unknown): MethodBinding {
  const binding = MethodBinding.parse(input);
  if (binding.binding_digest !== bindingDigest(binding)) throw Error('BINDING_DIGEST_MISMATCH');
  return binding;
}
export function roleRequirementsDigest(role: z.infer<typeof Role>, requirementsDigest: string): string {
  return jointDigest('osstack.joint.role-artifact-requirements.v1', { schema_version: 1, role: Role.parse(role), requirements_digest: Digest.parse(requirementsDigest) });
}
/** Shape/cap compatibility only. Host grant, profile authenticity and live counters remain mandatory. */
export function trialBudgetIssues(input: unknown, profileInput: unknown): string[] {
  const permit = TrialPermit.parse(input); const profile = SupportProfile.parse(profileInput);
  const issues: string[] = [];
  if (permit.support_profile_digest !== supportProfileDigest(profile)) issues.push('support_profile_digest_mismatch');
  if (permit.repository !== profile.canonical_repo) issues.push('repository_mismatch');
  for (const axis of ['wall', 'actions', 'tokens', 'cost'] as const) {
    const required = axis === 'wall' || axis === 'actions' || (axis === 'tokens' ? permit.max_tokens !== undefined : permit.max_cost_microusd !== undefined);
    if (required && profile.budget_enforceability[axis] !== 'enforceable') issues.push(`${axis}_not_enforceable`);
  }
  return issues;
}
export const methodProposalDigest = (input: unknown): string => jointDigest('osstack.joint.method-proposal.v1', MethodProposal.parse(input));
export const methodRecipeDigest = (input: unknown): string => jointDigest('osstack.joint.method-recipe.v1', MethodRecipe.parse(input));
export const artifactRequirementsDigest = (input: unknown): string => jointDigest('osstack.joint.artifact-requirements.v1', ArtifactRequirements.parse(input));
export const checkBindingDigest = (input: unknown): string => jointDigest('osstack.joint.check-binding.v1', CheckBinding.parse(input));
export const supportProfileDigest = (input: unknown): string => jointDigest('osstack.joint.support-profile.v2', SupportProfile.parse(input));

export function trialRootEffectId(input: unknown): string {
  const v = z.object({scope: Ref, idempotency_key: Ref, permit_id: Ref.refine(v => v.length <= 256, 'REFERENCE_TOO_LONG')}).strict().parse(input);
  return 'trial-' + jointDigest('osstack.joint.trial-root.v1', v);
}
export function trialConsumptionInputDigest(input: unknown): string {
  const v = z.object({schema_version:z.literal(1), principal_ref:Ref, scope_id:Ref, tenant_id:Ref, idempotency_key:Ref, permit:TrialPermit, program_digest:Digest, input_digest:Digest}).strict().parse(input);
  if (v.permit.root_effect_id !== trialRootEffectId({scope:v.scope_id,idempotency_key:v.idempotency_key,permit_id:v.permit.permit_id})) throw Error('TRIAL_ROOT_ID_MISMATCH');
  return jointDigest('osstack.joint.trial-consumption-input.v1', v);
}
