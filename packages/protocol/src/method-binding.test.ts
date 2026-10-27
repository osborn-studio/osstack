import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeJointContract, JointContract } from './joint-contracts.js';
import { bindingDigest, roleRequirementsDigest, trialBudgetIssues, supportProfileDigest } from './method-binding.js';
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/joint/contracts.json', import.meta.url), 'utf8')).fixtures as Array<{id: string; valid: boolean; payload: Record<string, unknown>}>;
const payload = (id: string) => structuredClone(fixtures.find(f => f.id === id)!.payload);
describe('joint contracts', () => {
  for (const f of fixtures) it(f.id, () => { expect(JointContract.safeParse(f.payload).success).toBe(f.valid); });
  it('rejects duplicate wire fields before shape validation', () => {
    expect(() => decodeJointContract('{"kind":"method_proposal","kind":"trial_permit"}')).toThrow();
  });
  it('normalizes role order but does not exclude any binding field other than self digest', () => {
    const a = payload('valid-method_binding'); const b = structuredClone(a);
    (b.role_materials as unknown[]).reverse(); expect(bindingDigest(a)).toBe(bindingDigest(b));
    b.authorization_ref = 'different-auth'; expect(bindingDigest(a)).not.toBe(bindingDigest(b));
    a.binding_digest = '0'.repeat(64); expect(bindingDigest(a)).toBe(bindingDigest(payload('valid-method_binding')));
  });
  it('binds required artifacts to the role', () => {
    expect(roleRequirementsDigest('builder', 'a'.repeat(64))).not.toBe(roleRequirementsDigest('reviewer', 'a'.repeat(64)));
  });
  it('refuses unsupported hard finance caps without inventing zero usage', () => {
    const p = payload('valid-trial_permit'); const profile = payload('valid-support_profile');
    profile.budget_enforceability = {wall:'enforceable',actions:'enforceable',tokens:'enforceable',cost:'unavailable'};
    p.support_profile_digest = supportProfileDigest(profile); p.repository = profile.canonical_repo;
    expect(trialBudgetIssues(p, profile)).toContain('cost_not_enforceable');
    delete p.max_cost_microusd; expect(trialBudgetIssues(p, profile)).toEqual([]);
  });
});
