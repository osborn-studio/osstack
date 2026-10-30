/** Pure planning over caller-supplied facts. No I/O, admission, grants or execution. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ArtifactRequirements, CheckBinding, CheckRegistry, MaterialSchemas, MethodInput, MethodProposal,
  MethodRecipe, SourceSnapshot, artifactRequirementsDigest, canonicalJointJson, checkBindingDigest,
  checkRegistryDigest, intentDigest, methodInputDigest, methodProposalDigest, methodRecipeDigest,
  roleRequirementsDigest, sourceSnapshotDigest,
} from '@osstack/protocol/joint';

const RECIPE_VERSION = 'bug-fix.v1';
const ROLE_BYTES = 32 * 1024;
const ALL_MATERIAL_BYTES = 96 * 1024;
const DOCUMENT_BYTES = 512 * 1024;
const Roles = ['builder', 'reviewer', 'verifier'] as const;
const Role = z.enum(Roles);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Label = z.string().min(1).max(512).refine(value =>
  value.trim() === value && Buffer.byteLength(value) <= 512
  && ![...value].some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)));
const Feature = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const Material = z.object({
  role: Role, text: z.string().min(1).refine(value => value.trim().length > 0), sha256: Digest,
}).strict();
const Input = z.object({
  schema_version: z.literal(1), target_repository: Label, intent: MaterialSchemas.MaterialIntentFrame,
  source_snapshot: SourceSnapshot, source_snapshot_digest: Digest,
  materials: z.array(Material).length(3), required_artifacts: ArtifactRequirements,
  required_feature_ids: z.array(Feature).min(1).max(32), available_feature_ids: z.array(Feature).min(1).max(32),
  check_registry: CheckRegistry, check_binding: CheckBinding,
}).strict();

export type BugFixCompileInput = z.infer<typeof Input>;
export type BugFixCompileErrorCode = 'INVALID_INPUT' | 'SOURCE_DIGEST_MISMATCH' | 'MATERIAL_DRIFT'
  | 'MISSING_OBLIGATION' | 'MISSING_FEATURE' | 'CHECK_NOT_REGISTERED' | 'AMBIGUOUS_CHECK'
  | 'REPOSITORY_MISMATCH' | 'RESOURCE_LIMIT';
export class BugFixCompileError extends Error {
  constructor(readonly code: BugFixCompileErrorCode) {
    super(code);
    this.name = 'BugFixCompileError';
  }
}
function requireFact(ok: unknown, code: BugFixCompileErrorCode): asserts ok {
  if (!ok) throw new BugFixCompileError(code);
}
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const requiredObligations = [
  ['intent_frame', 'builder'], ['reproduction', 'builder'], ['candidate_checks', 'builder'],
  ['independent_review', 'reviewer'], ['cleanup_receipt', 'verifier'],
] as const;

/**
 * Compiles exactly one bug_fix proposal. Structural source facts and registry
 * declarations are not authenticated here. Returned material bytes are planning
 * inputs, not context receipts; a host must separately enforce prompt budgets.
 */
export function compileBugFix(input: unknown) {
  const parsed = Input.safeParse(input);
  requireFact(parsed.success, 'INVALID_INPUT');
  const value = parsed.data;
  requireFact(unique(value.materials.map(m => m.role))
    && unique(value.required_feature_ids) && unique(value.available_feature_ids), 'INVALID_INPUT');
  requireFact(value.source_snapshot.files.length > 0, 'INVALID_INPUT');
  let allBytes = 0;
  for (const material of value.materials) {
    const bytes = Buffer.byteLength(material.text, 'utf8');
    requireFact(bytes <= ROLE_BYTES, 'RESOURCE_LIMIT');
    allBytes += bytes;
    requireFact(Buffer.from(material.text, 'utf8').toString('utf8') === material.text, 'INVALID_INPUT');
    requireFact(sha(material.text) === material.sha256, 'MATERIAL_DRIFT');
  }
  requireFact(allBytes <= ALL_MATERIAL_BYTES, 'RESOURCE_LIMIT');
  let inputJson: string;
  try { inputJson = canonicalJointJson(value); }
  catch { throw new BugFixCompileError('INVALID_INPUT'); }
  requireFact(Buffer.byteLength(inputJson) <= DOCUMENT_BYTES, 'RESOURCE_LIMIT');

  const snapshotDigest = sourceSnapshotDigest(value.source_snapshot);
  requireFact(snapshotDigest === value.source_snapshot_digest, 'SOURCE_DIGEST_MISMATCH');
  requireFact(value.required_artifacts.recipe_version === RECIPE_VERSION, 'MISSING_OBLIGATION');
  for (const [kind, role] of requiredObligations) {
    requireFact(value.required_artifacts.requirements.some(r =>
      r.artifact_ref_kind === kind && r.producer_role === role && r.required), 'MISSING_OBLIGATION');
  }
  requireFact(value.required_feature_ids.every(id => value.available_feature_ids.includes(id)), 'MISSING_FEATURE');
  requireFact(value.check_binding.repository === value.target_repository, 'REPOSITORY_MISMATCH');
  const checks = value.check_binding.checks;
  requireFact(checks.length === 3 && checks.every(c => c.required)
    && unique(checks.map(c => c.role)) && unique(checks.map(c => c.registry_ref)), 'AMBIGUOUS_CHECK');
  requireFact(checks.every(c => value.check_registry.entries.some(entry => entry.ref === c.registry_ref)), 'CHECK_NOT_REGISTERED');

  // Parsing above cloned caller data. Sort only declared sets, never intent prose.
  value.materials.sort((a, b) => Roles.indexOf(a.role) - Roles.indexOf(b.role));
  value.required_feature_ids.sort(order);
  value.available_feature_ids.sort(order);
  value.required_artifacts.requirements.sort((a, b) =>
    order(a.artifact_ref_kind, b.artifact_ref_kind) || order(a.producer_role, b.producer_role));
  value.check_binding.checks.sort((a, b) => order(a.id, b.id));
  value.check_registry.entries.sort((a, b) => order(a.ref, b.ref));
  for (const entry of value.check_registry.entries) {
    requireFact(unique(entry.fail_codes.map(String)), 'INVALID_INPUT');
    entry.fail_codes.sort((a, b) => a - b);
  }
  value.source_snapshot.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));

  const registryDigest = checkRegistryDigest(value.check_registry);
  const bindingDigest = checkBindingDigest(value.check_binding);
  const requirementsDigest = artifactRequirementsDigest(value.required_artifacts);
  const intentHash = intentDigest(value.intent);
  const roleInputs = value.materials.map(material => {
    const roleInput = MethodInput.parse({
      kind: 'method_input', schema_version: 1, role: material.role,
      intent_digest: intentHash, source_snapshot_digest: snapshotDigest,
      requested_materials: [
        'sha256:' + material.sha256,
        'check-registry:sha256:' + registryDigest,
        ...value.required_feature_ids.map(id => 'feature:' + id),
      ].sort(order),
    });
    return { input: roleInput, digest: methodInputDigest(roleInput) };
  });
  const recipe = MethodRecipe.parse({
    kind: 'method_recipe', schema_version: 1, recipe_id: 'osstack.bug_fix', recipe_version: RECIPE_VERSION,
    source_snapshot_digest: snapshotDigest, intent_kind: 'bug_fix',
    logical_check_roles: ['reproduce', 'regression', 'acceptance'],
    role_materials: value.materials.map(material => ({
      role: material.role, method_text_sha256: material.sha256,
      role_required_artifacts_digest: roleRequirementsDigest(material.role, requirementsDigest),
    })),
    required_artifacts_digest: requirementsDigest, allowed_completion: 'local_verified', publication: 'none',
  });
  const recipeDigest = methodRecipeDigest(recipe);
  const proposal = MethodProposal.parse({
    kind: 'method_proposal', schema_version: 1, task_id: value.intent.task_id,
    intent_revision: value.intent.intent_revision, intent_digest: intentHash,
    source_snapshot_digest: snapshotDigest, recipe_digest: recipeDigest, recipe_version: RECIPE_VERSION,
    check_binding_digest: bindingDigest, required_artifacts_digest: requirementsDigest,
    // Protocol v1 has one method_input_digest. The builder input carries the
    // required feature and registry bindings; recipe binds all three role texts.
    method_input_digest: roleInputs[0]!.digest, executable: false,
  });
  const result = {
    kind: 'compiled_bug_fix' as const, schema_version: 1 as const, executable: false as const,
    target_repository: value.target_repository, intent: value.intent,
    source_assurance: 'caller_supplied_structural_facts' as const,
    check_assurance: 'caller_supplied_registry' as const,
    feature_assurance: 'caller_supplied_availability' as const,
    source_snapshot: value.source_snapshot, source_snapshot_digest: snapshotDigest,
    materials: value.materials, required_feature_ids: value.required_feature_ids,
    available_feature_ids: value.available_feature_ids,
    check_registry: value.check_registry, check_registry_digest: registryDigest,
    check_binding: value.check_binding, check_binding_digest: bindingDigest,
    required_artifacts: value.required_artifacts, required_artifacts_digest: requirementsDigest,
    role_inputs: roleInputs, recipe, recipe_digest: recipeDigest, proposal, proposal_digest: methodProposalDigest(proposal),
    limitations: [
      'Caller-supplied source facts are structurally checked and rehashed, not authenticated Git contents.',
      'Material hashes check supplied UTF8 bytes, not provenance or actual host delivery.',
      'Registry membership and feature availability are caller declarations, not executed checks.',
      'No admission, qualification, execution permission, installation, publication or merge.',
    ],
  };
  try { requireFact(Buffer.byteLength(canonicalJointJson(result)) <= DOCUMENT_BYTES, 'RESOURCE_LIMIT'); }
  catch { throw new BugFixCompileError('RESOURCE_LIMIT'); }
  return result;
}
export type CompiledBugFix = ReturnType<typeof compileBugFix>;
