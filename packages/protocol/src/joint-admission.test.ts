import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MethodRecipe, methodRecipeDigest, methodProposalDigest, verifyBindingAgainst, bindingDigest, verifyMethodBinding, trialBudgetIssues, supportProfileDigest } from './method-binding.js';
import { JointContract, decodeJointContractAs, decodeJointContractBytesAs } from './joint-contracts.js';
import { recoverySubjectDigest, RecoveryProofEnvelope, RecoveryReceipt, verifyRecoveryProofEnvelopes } from './joint-recovery.js';
import { canonicalJointJson, parseJointJson } from './joint-json.js';
import { createHash } from 'node:crypto';
const cases = (parseJointJson(readFileSync(new URL('../fixtures/joint/contracts.json', import.meta.url), 'utf8')) as unknown as { fixtures: Array<{ id: string; payload: Record<string, unknown> }> }).fixtures;
const sample = (id: string) => structuredClone(cases.find(f => f.id === id)!.payload);
describe('joint integrity boundaries', () => {
  it('checks recipe role digests against the aggregate', () => {
    const recipe = sample('valid-method_recipe');
    expect(MethodRecipe.safeParse(recipe).success).toBe(true);
    expect(MethodRecipe.safeParse({...recipe, required_artifacts_digest:'0'.repeat(64)}).success).toBe(false);
    const roles = recipe.role_materials as Array<{role_required_artifacts_digest:string}>;
    const first = roles[0]!.role_required_artifacts_digest;
    roles[0]!.role_required_artifacts_digest = roles[1]!.role_required_artifacts_digest;
    roles[1]!.role_required_artifacts_digest = first;
    expect(MethodRecipe.safeParse(recipe).success).toBe(false);
  });
  it('verifies a supplied binding digest independently of constructing one', () => {
    const binding = sample('valid-method_binding'); binding.binding_digest = bindingDigest(binding);
    expect(verifyMethodBinding(binding).binding_digest).toBe(binding.binding_digest);
    expect(() => verifyMethodBinding({...binding, binding_digest:'f'.repeat(64)})).toThrow('BINDING_DIGEST_MISMATCH');
    expect(() => verifyMethodBinding({...binding, authorization_ref:'different'})).toThrow('BINDING_DIGEST_MISMATCH');
  });
  it('joins a binding to its exact proposal and recipe roles', () => {
    const recipe = MethodRecipe.parse(sample('valid-method_recipe'));
    const proposal = sample('valid-method_proposal');
    Object.assign(proposal,{recipe_digest:methodRecipeDigest(recipe),recipe_version:recipe.recipe_version,source_snapshot_digest:recipe.source_snapshot_digest,required_artifacts_digest:recipe.required_artifacts_digest});
    const binding = sample('valid-method_binding');
    Object.assign(binding,{task_id:proposal.task_id,proposal_digest:methodProposalDigest(proposal),recipe_version:recipe.recipe_version,source_snapshot_digest:recipe.source_snapshot_digest,role_materials:structuredClone(recipe.role_materials)});
    binding.binding_digest = bindingDigest(binding);
    expect(verifyBindingAgainst(binding,proposal,recipe).task_id).toBe(proposal.task_id);
    const swapped = structuredClone(binding);
    const roles = swapped.role_materials as Array<{role_required_artifacts_digest:string}>;
    const first = roles[0]!.role_required_artifacts_digest;
    roles[0]!.role_required_artifacts_digest = roles[1]!.role_required_artifacts_digest;
    roles[1]!.role_required_artifacts_digest = first;
    swapped.binding_digest = bindingDigest(swapped);
    expect(() => verifyBindingAgainst(swapped,proposal,recipe)).toThrow('BINDING_RECIPE_ROLE_MISMATCH');
    expect(() => verifyBindingAgainst(binding,{...proposal,task_id:'different'},recipe)).toThrow('BINDING_PROPOSAL_MISMATCH');
  });
  it('rejects the wrong profile and repository before budget compatibility', () => {
    const profile = sample('valid-support_profile'); const permit = sample('valid-trial_permit');
    profile.budget_enforceability = {wall:'enforceable',actions:'enforceable',tokens:'enforceable',cost:'enforceable'};
    permit.support_profile_digest = supportProfileDigest(profile); permit.repository = profile.canonical_repo;
    expect(trialBudgetIssues(permit, profile)).toEqual(['adapter_invocations_unattested']);
    expect(trialBudgetIssues({...permit,support_profile_digest:'0'.repeat(64)},profile)).toContain('support_profile_digest_mismatch');
    expect(trialBudgetIssues({...permit,repository:'other'},profile)).toContain('repository_mismatch');
  });
  it('rejects trusted-record kinds at a proposal decoder boundary', () => {
    const raw = JSON.stringify(sample('valid-method_proposal'));
    expect(decodeJointContractAs('method_proposal',raw).kind).toBe('method_proposal');
    expect(decodeJointContractBytesAs('method_proposal',Buffer.from(raw)).kind).toBe('method_proposal');
    expect(() => decodeJointContractAs('recovery_request',raw)).toThrow('JOINT_KIND_MISMATCH');
    expect(() => decodeJointContractBytesAs('recovery_request',Buffer.from(raw))).toThrow('JOINT_KIND_MISMATCH');
  });
  it('does not infer new-effect identity from legacy unknown', () => {
    expect(RecoveryReceipt.safeParse({...sample('valid-recovery_receipt'),prior_phase:'legacy_unknown'}).success).toBe(false);
    const legacy = sample('legacy-recovery-null-identities');
    expect(RecoveryReceipt.safeParse(legacy).success).toBe(true);
    expect(RecoveryReceipt.safeParse({...legacy,binding_generation:1}).success).toBe(false);
  });
  it('safeParse returns failure instead of throwing on dirty recovery subjects', () => {
    const receipt = sample('valid-recovery_receipt');
    for (const home_id of ['', '\ud800']) {
      const subject = {kind:'effect',home_id,effect_id:'x'};
      expect(RecoveryReceipt.safeParse({...receipt,subject}).success).toBe(false);
      expect(JointContract.safeParse({...receipt,subject}).success).toBe(false);
      const proof = {record_ref:'proof',type:'invocation_contained',effect_id:'x',subject_digest:'a'.repeat(64),evidence_digest:'a'.repeat(64),producer_ref:'host'};
      const envelope = {kind:'recovery_proof',schema_version:1,subject,proof,record_ref:'proof',authorization_ref:'host',observed_at_ms:1,owner_generation:1,binding_generation:1,support_profile_digest:'a'.repeat(64),prior_phase:'dispatch_committed',schema_spec_digest:'a'.repeat(64),recovery_build_digest:'a'.repeat(64)};
      expect(RecoveryProofEnvelope.safeParse(envelope).success).toBe(false);
      expect(JointContract.safeParse(envelope).success).toBe(false);
    }
  });
  it('joins proof envelopes to the exact receipt context and content', () => {
    const receipt = sample('valid-recovery_receipt');
    const proof = {record_ref:'proof',type:'invocation_contained',effect_id:receipt.effect_id,subject_digest:receipt.subject_digest,evidence_digest:'a'.repeat(64),producer_ref:'host'};
    Object.assign(receipt,{decision:'proven_stopped',proof_refs:['proof'],proofs:[proof]});
    const envelope = {kind:'recovery_proof',schema_version:1,subject:receipt.subject,proof,record_ref:'proof',authorization_ref:'host-grant',observed_at_ms:receipt.observed_at_ms,owner_generation:receipt.owner_generation,binding_generation:receipt.binding_generation,support_profile_digest:receipt.support_profile_digest,prior_phase:receipt.prior_phase,schema_spec_digest:receipt.schema_spec_digest,recovery_build_digest:receipt.recovery_build_digest};
    expect(verifyRecoveryProofEnvelopes(receipt,[envelope]).decision).toBe('proven_stopped');
    for (const patch of [{owner_generation:2},{binding_generation:2},{support_profile_digest:'b'.repeat(64)},{prior_phase:'reserved'},{schema_spec_digest:'b'.repeat(64)},{recovery_build_digest:'b'.repeat(64)}]) expect(() => verifyRecoveryProofEnvelopes(receipt,[{...envelope,...patch}])).toThrow('PROOF_CONTEXT_MISMATCH');
    expect(() => verifyRecoveryProofEnvelopes(receipt,[{...envelope,proof:{...proof,evidence_digest:'b'.repeat(64)}}])).toThrow('PROOF_CONTENT_MISMATCH');
    expect(() => verifyRecoveryProofEnvelopes(receipt,[{...envelope,observed_at_ms:Number(receipt.observed_at_ms)+1}])).toThrow('PROOF_AFTER_RECEIPT');
    const otherSubject = {...(receipt.subject as {kind:'effect';home_id:string;effect_id:string}),effect_id:'different'};
    const otherProof = {...proof,effect_id:'different',subject_digest:recoverySubjectDigest(otherSubject)};
    expect(() => verifyRecoveryProofEnvelopes(receipt,[{...envelope,subject:otherSubject,proof:otherProof}])).toThrow('PROOF_CONTENT_MISMATCH');
    expect(() => verifyRecoveryProofEnvelopes(receipt,[])).toThrow('PROOF_REFERENCE_MISMATCH');
    expect(() => verifyRecoveryProofEnvelopes(receipt,[envelope,envelope])).toThrow('PROOF_REFERENCE_MISMATCH');
  });
  it('keeps root opt-in and blocks the build-only generator package import', () => {
    expect(readFileSync(new URL('./index.ts',import.meta.url),'utf8')).not.toMatch(/joint|method-binding/);
    const code = `await import('@osstack/protocol'); await import('@osstack/protocol/joint'); try { await import('@osstack/protocol/dist/joint-generate.js'); process.exit(2); } catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; console.log('blocked'); }`;
    expect(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:10000})).toContain('blocked');
  });
});

type ComponentRow = { kind: JointContract['kind']; sample: Record<string, unknown>; required: string[]; optional: string[] };
const componentMatrix = (JSON.parse(readFileSync(new URL('../fixtures/joint/acceptance-oracle.json', import.meta.url), 'utf8')) as {
  component_matrix: ComponentRow[];
}).component_matrix;

const componentReference = JSON.parse(execFileSync('python3', ['-I', fileURLToPath(new URL('../scripts/joint-acceptance-oracle.py', import.meta.url))], {encoding: 'utf8', timeout: 10_000, maxBuffer: 1_048_576})) as {components: Array<{kind: string; canonical: string; sha256: string}>};

describe('JA70 full kind/field matrix at the real strict decoder', () => {
  it('covers all kinds in the published union, including the ten material bodies', () => {
    type Schema = { properties?: {kind?: {const?: string}}; anyOf?: Schema[] };
    const schema = JSON.parse(readFileSync(new URL('../schemas/joint/joint-contract.schema.json', import.meta.url), 'utf8')) as {definitions: {JointContract: Schema}};
    const collect = (node: Schema): string[] => node.properties?.kind?.const
      ? [node.properties.kind.const] : (node.anyOf ?? []).flatMap(collect);
    expect(componentMatrix.map(row => row.kind).sort()).toEqual([...new Set(collect(schema.definitions.JointContract))].sort());
    expect(componentMatrix.filter(row => row.kind.startsWith('material:'))).toHaveLength(10);
  });
  for (const row of componentMatrix) describe(row.kind, () => {
    const decode = (value: Record<string, unknown>) => decodeJointContractAs(row.kind, JSON.stringify(value));
    it('accepts the declared structure through text and byte entrypoints without granting authority', () => {
      const raw = JSON.stringify(row.sample);
      expect(decodeJointContractAs(row.kind, raw)).toEqual(row.sample);
      expect(decodeJointContractBytesAs(row.kind, Buffer.from(raw))).toEqual(row.sample);
      const canonical = canonicalJointJson(decodeJointContractAs(row.kind, raw));
      const reference = componentReference.components.find(item => item.kind === row.kind)!;
      expect(canonical).toBe(reference.canonical);
      expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(reference.sha256);
    });
    for (const field of row.required) it(`rejects missing ${field}`, () => {
      const missing = structuredClone(row.sample); delete missing[field];
      expect(() => decode(missing)).toThrow();
    });
    it('rejects unknown fields, invalid kind/version and duplicated raw keys', () => {
      expect(() => decode({...row.sample, unregistered_authority: 'run'})).toThrow();
      expect(() => decode({...row.sample, kind: 'unregistered_kind'})).toThrow();
      expect(() => decode({...row.sample, schema_version: -1})).toThrow();
      const duplicated = '{"kind":"ignored",' + JSON.stringify(row.sample).slice(1);
      expect(() => decodeJointContractAs(row.kind, duplicated)).toThrow('INVALID_JOINT_JSON');
      expect(() => decodeJointContractBytesAs(row.kind, Buffer.from(duplicated))).toThrow('INVALID_JOINT_JSON');
    });
    it('rejects an otherwise valid record at the wrong expected-kind boundary', () => {
      const other = row.kind === 'source_pin' ? 'method_proposal' : 'source_pin';
      const raw = JSON.stringify(row.sample);
      expect(() => decodeJointContractAs(other, raw)).toThrow('JOINT_KIND_MISMATCH');
      expect(() => decodeJointContractBytesAs(other, Buffer.from(raw))).toThrow('JOINT_KIND_MISMATCH');
    });
  });
});

describe('JA70 identity joins remain mandatory after valid self digests', () => {
  const linked = () => {
    const recipe = MethodRecipe.parse(sample('valid-method_recipe'));
    const proposal = sample('valid-method_proposal');
    Object.assign(proposal, {recipe_digest: methodRecipeDigest(recipe), recipe_version: recipe.recipe_version,
      source_snapshot_digest: recipe.source_snapshot_digest, required_artifacts_digest: recipe.required_artifacts_digest});
    const binding = sample('valid-method_binding');
    Object.assign(binding, {task_id: proposal.task_id, proposal_digest: methodProposalDigest(proposal),
      recipe_version: recipe.recipe_version, source_snapshot_digest: recipe.source_snapshot_digest, role_materials: structuredClone(recipe.role_materials)});
    binding.binding_digest = bindingDigest(binding);
    return {recipe, proposal, binding};
  };
  for (const field of ['task_id', 'proposal_digest', 'recipe_version', 'source_snapshot_digest']) it(`rejects binding ${field} substitution even with a recomputed self digest`, () => {
    const {recipe, proposal, binding} = linked();
    binding[field] = field.endsWith('digest') ? 'f'.repeat(64) : 'substituted';
    binding.binding_digest = bindingDigest(binding);
    expect(() => verifyBindingAgainst(binding, proposal, recipe)).toThrow('BINDING_PROPOSAL_MISMATCH');
  });
  for (const field of ['recipe_digest', 'recipe_version', 'source_snapshot_digest', 'required_artifacts_digest']) it(`rejects proposal ${field} substitution even when the binding names its new digest`, () => {
    const {recipe, proposal, binding} = linked();
    proposal[field] = field.endsWith('digest') ? 'f'.repeat(64) : 'substituted';
    binding.proposal_digest = methodProposalDigest(proposal); binding.binding_digest = bindingDigest(binding);
    expect(() => verifyBindingAgainst(binding, proposal, recipe)).toThrow('BINDING_PROPOSAL_MISMATCH');
  });
  for (const role of ['builder', 'reviewer', 'verifier']) {
    for (const field of ['method_text_sha256', 'role_required_artifacts_digest']) it(`rejects ${role} ${field} substitution with a valid binding self digest`, () => {
      const {recipe, proposal, binding} = linked();
      const materials = binding.role_materials as Array<Record<string, unknown>>;
      materials.find(material => material.role === role)![field] = 'f'.repeat(64);
      binding.binding_digest = bindingDigest(binding);
      expect(() => verifyBindingAgainst(binding, proposal, recipe)).toThrow('BINDING_RECIPE_ROLE_MISMATCH');
    });
  }
});
