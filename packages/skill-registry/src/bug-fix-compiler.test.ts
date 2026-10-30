import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ArtifactRequirements, CheckBinding, CheckRegistry, MethodInput, MethodProposal, MethodRecipe,
  artifactRequirementsDigest, checkBindingDigest, checkRegistryDigest, intentDigest,
  methodInputDigest, methodProposalDigest, methodRecipeDigest, sourceSnapshotDigest,
} from '@osstack/protocol/joint';
import { compileBugFix } from './bug-fix-compiler.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const roles = ['builder', 'reviewer', 'verifier'] as const;
function fixture() {
  const source_snapshot = { kind: 'source_snapshot' as const, schema_version: 1 as const,
    pin: { kind: 'source_pin' as const, schema_version: 1 as const, repository: 'https://example.invalid/methods',
      commit: 'a'.repeat(40), subdir: 'methods', content_sha256: sha('caller supplied source facts'), license_refs: ['license:MIT'] },
    files: [{ path: 'methods/bug-fix.md', mode: '100644' as const, blob: 'b'.repeat(40) },
      { path: 'methods/evidence.md', mode: '100644' as const, blob: 'c'.repeat(40) }], dependencies: [] };
  const entries = ['reproduce command', 'regression command', 'acceptance command'].map(command => ({
    ref: 'sha256:' + sha(command), command_bytes_sha256: sha(command), pass_codes: [0], fail_codes: [1, 2] }));
  const obligations = [
    ['intent_frame', 'builder'], ['reproduction', 'builder'], ['candidate_checks', 'builder'],
    ['independent_review', 'reviewer'], ['cleanup_receipt', 'verifier'],
  ] as const;
  return {
    schema_version: 1 as const, target_repository: '/owned/repo',
    intent: { kind: 'material:intent_frame' as const, schema_version: 1 as const, task_id: 'task-123', intent_revision: 2,
      goals: ['Fix duplicate event'], non_goals: ['No publication'], observations: ['Two events were observed'],
      hypotheses: ['A retry may bypass deduplication'], unknowns: ['Concurrent callers'], source_refs: ['card:123'] },
    source_snapshot, source_snapshot_digest: sourceSnapshotDigest(source_snapshot),
    materials: roles.map(role => ({ role, text: role + ' method\n', sha256: sha(role + ' method\n') })),
    required_artifacts: { kind: 'artifact_requirements' as const, schema_version: 1 as const, recipe_version: 'bug-fix.v1',
      requirements: obligations.map(([artifact_ref_kind, producer_role]) => ({
        artifact_ref_kind, producer_role, body_schema_digest: sha(artifact_ref_kind),
        verifier_policy_digest: sha('policy:' + artifact_ref_kind), required: true })) },
    required_feature_ids: ['duplicate-event', 'same-key-retry'], available_feature_ids: ['same-key-retry', 'duplicate-event'],
    check_registry: { kind: 'check_registry' as const, schema_version: 1 as const, entries },
    check_binding: { kind: 'check_binding' as const, schema_version: 1 as const, repository: '/owned/repo', primary_id: 'accept',
      checks: [
        { id: 'repro', role: 'reproduce' as const, registry_ref: entries[0]!.ref, required: true },
        { id: 'regress', role: 'regression' as const, registry_ref: entries[1]!.ref, required: true },
        { id: 'accept', role: 'acceptance' as const, registry_ref: entries[2]!.ref, required: true },
      ] },
  };
}
function failure(input: unknown, code: string) {
  try { compileBugFix(input); expect.fail('expected ' + code); }
  catch (error) { expect(error).toMatchObject({ name: 'BugFixCompileError', code }); }
}

describe('pure bug_fix compiler', () => {
  it('returns protocol-compatible non-executable documents with recomputable bindings', () => {
    const input = fixture(), before = JSON.stringify(input), out = compileBugFix(input);
    expect(out.kind).toBe('compiled_bug_fix'); expect(out.executable).toBe(false);
    expect(MethodRecipe.parse(out.recipe).intent_kind).toBe('bug_fix');
    expect(MethodProposal.parse(out.proposal).executable).toBe(false);
    expect(out.recipe_digest).toBe(methodRecipeDigest(out.recipe));
    expect(out.proposal_digest).toBe(methodProposalDigest(out.proposal));
    expect(out.check_binding_digest).toBe(checkBindingDigest(CheckBinding.parse(out.check_binding)));
    expect(out.check_registry_digest).toBe(checkRegistryDigest(CheckRegistry.parse(out.check_registry)));
    expect(out.required_artifacts_digest).toBe(artifactRequirementsDigest(ArtifactRequirements.parse(out.required_artifacts)));
    expect(out.proposal.intent_digest).toBe(intentDigest(input.intent));
    expect(out.proposal.source_snapshot_digest).toBe(sourceSnapshotDigest(input.source_snapshot));
    expect(out.recipe.publication).toBe('none'); expect(out.recipe.allowed_completion).toBe('local_verified');
    expect(out.role_inputs.map(r => r.input.role)).toEqual(roles);
    for (const role of out.role_inputs) expect(role.digest).toBe(methodInputDigest(MethodInput.parse(role.input)));
    expect(out.proposal.method_input_digest).toBe(out.role_inputs[0]!.digest);
    expect(out.intent.observations).toEqual(input.intent.observations);
    expect(out.intent.hypotheses).toEqual(input.intent.hypotheses);
    expect(out.source_assurance).toBe('caller_supplied_structural_facts');
    expect(out.check_assurance).toBe('caller_supplied_registry');
    expect(out).not.toHaveProperty('binding'); expect(out).not.toHaveProperty('authorization_ref');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('canonicalizes set-like input order without changing ordered intent arrays', () => {
    const input = fixture(), first = compileBugFix(input);
    input.materials.reverse(); input.check_binding.checks.reverse(); input.check_registry.entries.reverse();
    input.required_artifacts.requirements.reverse(); input.source_snapshot.files.reverse();
    input.required_feature_ids.reverse(); input.available_feature_ids.reverse();
    expect(compileBugFix(input)).toEqual(first);
  });
  it.each(['material', 'feature', 'repository', 'intent', 'registry', 'obligation'] as const)(
    'binds a meaningful %s change into proposal digest', change => {
      const x = fixture(), old = compileBugFix(x);
      if (change === 'material') { x.materials[1]!.text += 'changed'; x.materials[1]!.sha256 = sha(x.materials[1]!.text); }
      if (change === 'feature') { x.required_feature_ids.push('new-feature'); x.available_feature_ids.push('new-feature'); }
      if (change === 'repository') { x.target_repository = '/owned/other'; x.check_binding.repository = '/owned/other'; }
      if (change === 'intent') x.intent.hypotheses.push('Second hypothesis');
      if (change === 'registry') x.check_registry.entries[0]!.fail_codes = [3];
      if (change === 'obligation') x.required_artifacts.requirements[0]!.body_schema_digest = sha('new schema');
      expect(compileBugFix(x).proposal_digest).not.toBe(old.proposal_digest);
    });
  it('preserves exact UTF8 material bytes including CRLF and binds their hash', () => {
    const x = fixture(); x.materials[0]!.text = '修复\r\n'; x.materials[0]!.sha256 = sha(x.materials[0]!.text);
    const out = compileBugFix(x); expect(out.materials[0]!.text).toBe('修复\r\n');
    expect(out.recipe.role_materials[0]!.method_text_sha256).toBe(sha('修复\r\n'));
  });
  it('rejects an adoption-candidate digest offered as snapshot digest', () => {
    const x = fixture(); x.source_snapshot_digest = sha('declared-adoption-candidate');
    failure(x, 'SOURCE_DIGEST_MISMATCH');
  });
  it('rejects an adoption-candidate object in place of a SourceSnapshot', () => {
    failure({ ...fixture(), source_snapshot: { kind: 'declared_adoption_candidate', candidate_digest: sha('x') } }, 'INVALID_INPUT');
  });
  it('rejects source facts changed under an old snapshot digest', () => {
    const x = fixture(); x.source_snapshot.files[0]!.blob = 'd'.repeat(40); failure(x, 'SOURCE_DIGEST_MISMATCH');
  });
  it('rejects source path case collisions', () => {
    const x = fixture(); x.source_snapshot.files[1]!.path = 'methods/BUG-FIX.md'; failure(x, 'INVALID_INPUT');
  });
  it.each(['missing', 'duplicate', 'drift', 'empty', 'oversized', 'surrogate'] as const)('rejects %s role material', defect => {
    const x = fixture();
    if (defect === 'missing') x.materials.pop();
    if (defect === 'duplicate') x.materials[1]!.role = 'builder';
    if (defect === 'drift') x.materials[0]!.text += 'unbound';
    if (defect === 'empty') { x.materials[0]!.text = ''; x.materials[0]!.sha256 = sha(''); }
    if (defect === 'oversized') { x.materials[0]!.text = '界'.repeat(10923); x.materials[0]!.sha256 = sha(x.materials[0]!.text); }
    if (defect === 'surrogate') { x.materials[0]!.text = '\ud800'; x.materials[0]!.sha256 = sha(x.materials[0]!.text); }
    failure(x, defect === 'drift' ? 'MATERIAL_DRIFT' : defect === 'oversized' ? 'RESOURCE_LIMIT' : 'INVALID_INPUT');
  });
  it.each(['absent', 'optional', 'wrong-producer'] as const)('rejects %s mandatory artifact obligation', defect => {
    const x = fixture();
    if (defect === 'absent') x.required_artifacts.requirements.splice(1, 1);
    if (defect === 'optional') x.required_artifacts.requirements[1]!.required = false;
    if (defect === 'wrong-producer') x.required_artifacts.requirements[1]!.producer_role = 'verifier';
    failure(x, 'MISSING_OBLIGATION');
  });
  it('rejects missing required feature without claiming live feature coverage', () => {
    const x = fixture(); x.available_feature_ids.pop(); failure(x, 'MISSING_FEATURE');
  });
  it('rejects duplicate required features as ambiguous input', () => {
    const x = fixture(); x.required_feature_ids.push(x.required_feature_ids[0]!); failure(x, 'INVALID_INPUT');
  });
  it('rejects a referenced check absent from the caller registry', () => {
    const x = fixture(); x.check_registry.entries.pop(); failure(x, 'CHECK_NOT_REGISTERED');
  });
  it('rejects repository mismatch', () => {
    const x = fixture(); x.check_binding.repository = '/another/repo'; failure(x, 'REPOSITORY_MISMATCH');
  });
  it.each(['duplicate-role', 'shared-ref', 'optional', 'missing-role'] as const)('rejects ambiguous %s check mapping', defect => {
    const x = fixture();
    if (defect === 'duplicate-role') x.check_binding.checks[1]!.role = 'reproduce';
    if (defect === 'shared-ref') x.check_binding.checks[1]!.registry_ref = x.check_binding.checks[0]!.registry_ref;
    if (defect === 'optional') x.check_binding.checks[0]!.required = false;
    if (defect === 'missing-role') x.check_binding.checks.splice(1, 1);
    failure(x, 'AMBIGUOUS_CHECK');
  });
  it('rejects a primary ID that is not a required acceptance check', () => {
    const x = fixture(); x.check_binding.primary_id = 'repro'; failure(x, 'INVALID_INPUT');
  });
  it('rejects unregistered execution fields instead of copying them into a proposal', () => {
    failure({ ...fixture(), execute: 'arbitrary command' }, 'INVALID_INPUT');
  });
  it('rejects duplicate registry identities and overlapping exit codes', () => {
    const x = fixture(); x.check_registry.entries[0]!.fail_codes = [0]; failure(x, 'INVALID_INPUT');
    const y = fixture(); y.check_registry.entries.push(y.check_registry.entries[0]!); failure(y, 'INVALID_INPUT');
  });
  it('accepts the 32768-byte material boundary without truncation', () => {
    const x = fixture(); x.materials[0]!.text = 'a'.repeat(32768); x.materials[0]!.sha256 = sha(x.materials[0]!.text);
    expect(compileBugFix(x).materials[0]!.text.length).toBe(32768);
  });
});
