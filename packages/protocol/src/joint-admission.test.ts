import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MethodRecipe, bindingDigest, verifyMethodBinding, trialBudgetIssues, supportProfileDigest } from './method-binding.js';
import { decodeJointContractAs, decodeJointContractBytesAs } from './joint-contracts.js';
import { RecoveryReceipt, verifyRecoveryProofEnvelopes } from './joint-recovery.js';
import { parseJointJson } from './joint-json.js';
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
  it('rejects the wrong profile and repository before budget compatibility', () => {
    const profile = sample('valid-support_profile'); const permit = sample('valid-trial_permit');
    profile.budget_enforceability = {wall:'enforceable',actions:'enforceable',tokens:'enforceable',cost:'enforceable'};
    permit.support_profile_digest = supportProfileDigest(profile); permit.repository = profile.canonical_repo;
    expect(trialBudgetIssues(permit, profile)).toEqual([]);
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
  it('joins proof envelopes to the exact receipt context and content', () => {
    const receipt = sample('valid-recovery_receipt');
    const proof = {record_ref:'proof',type:'invocation_contained',effect_id:receipt.effect_id,subject_digest:receipt.subject_digest,evidence_digest:'a'.repeat(64),producer_ref:'host'};
    Object.assign(receipt,{decision:'proven_stopped',proof_refs:['proof'],proofs:[proof]});
    const envelope = {kind:'recovery_proof',schema_version:1,subject:receipt.subject,proof,record_ref:'proof',authorization_ref:'host-grant',observed_at_ms:receipt.observed_at_ms,owner_generation:receipt.owner_generation,binding_generation:receipt.binding_generation,support_profile_digest:receipt.support_profile_digest,prior_phase:receipt.prior_phase,schema_spec_digest:receipt.schema_spec_digest,recovery_build_digest:receipt.recovery_build_digest};
    expect(verifyRecoveryProofEnvelopes(receipt,[envelope]).decision).toBe('proven_stopped');
    for (const patch of [{owner_generation:2},{binding_generation:2},{support_profile_digest:'b'.repeat(64)},{prior_phase:'reserved'},{schema_spec_digest:'b'.repeat(64)},{recovery_build_digest:'b'.repeat(64)}]) expect(() => verifyRecoveryProofEnvelopes({...receipt,...patch},[envelope])).toThrow();
    expect(() => verifyRecoveryProofEnvelopes(receipt,[{...envelope,proof:{...proof,evidence_digest:'b'.repeat(64)}}])).toThrow('PROOF_CONTENT_MISMATCH');
    expect(() => verifyRecoveryProofEnvelopes(receipt,[{...envelope,observed_at_ms:Number(receipt.observed_at_ms)+1}])).toThrow('PROOF_AFTER_RECEIPT');
    expect(() => verifyRecoveryProofEnvelopes(receipt,[])).toThrow('PROOF_REFERENCE_MISMATCH');
    expect(() => verifyRecoveryProofEnvelopes(receipt,[envelope,envelope])).toThrow('PROOF_REFERENCE_MISMATCH');
  });
  it('keeps root opt-in and blocks the build-only generator package import', () => {
    expect(readFileSync(new URL('./index.ts',import.meta.url),'utf8')).not.toMatch(/joint|method-binding/);
    const code = `await import('@osstack/protocol'); await import('@osstack/protocol/joint'); try { await import('@osstack/protocol/dist/joint-generate.js'); process.exit(2); } catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; console.log('blocked'); }`;
    expect(execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:10000})).toContain('blocked');
  });
});
