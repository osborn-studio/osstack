import { expect, it } from 'vitest';
import { upgradeFixture } from './upgrade-test-fixture.js';
import { createUpgradePlan, freezeUpgradePlan, upgradeCanonical } from './upgrade-plan.js';


it('makes an immutable exact-version plan, never apply authority from inventory', () => {
  const f = upgradeFixture(); const plan = createUpgradePlan(f.request, f.observations, f.now);
  expect(plan.plan.authority).toBe('none'); expect(plan.plan.groups[0]!.qualification).toBe('qualification_pending');
  expect(plan.plan.groups[0]!.reasons).toContain('shared_consumers_not_attested'); expect(Object.isFrozen(plan.plan.groups[0]!.homes)).toBe(true);
  expect(freezeUpgradePlan(plan.plan)).toEqual(plan);
  expect(createUpgradePlan({ ...f.request, target: { ...f.request.target, build_digest: 'c'.repeat(64) } }, f.observations, f.now).digest).not.toBe(plan.digest);
});
it.each(['latest', '^2.0.0', '2', '2.0', ' 2.0.0', '02.0.0', '2.0.0-01'])('rejects non-exact version %s', version => {
  const f = upgradeFixture(); expect(() => createUpgradePlan({ ...f.request, target: { ...f.request.target, version } }, f.observations, f.now)).toThrow();
});
it('does not treat an unreachable consumer, checkout or incompatible schema as qualified', () => {
  const f = upgradeFixture(); f.observations[1]!.observed = null; f.observations[1]!.status = 'unreachable';
  f.request.groups[0]!.deployment_kind = 'checkout'; f.request.target.readable_schema_min = 41;
  const plan = createUpgradePlan(f.request, f.observations, f.now);
  expect(plan.plan.groups[0]!.reasons).toEqual(expect.arrayContaining(['checkout_updater_unsupported', `home_unavailable:${f.observations[1]!.desired.home_id}`, `schema_incompatible:${f.observations[0]!.desired.home_id}`]));
});
it('rejects duplicate or missing consumers and expired plans', () => {
  const f = upgradeFixture(); f.request.groups[0]!.home_ids.push(f.request.groups[0]!.home_ids[0]!);
  expect(() => createUpgradePlan(f.request, f.observations, f.now)).toThrow(); f.request.groups[0]!.home_ids.pop();
  expect(() => createUpgradePlan(f.request, f.observations.slice(0, 1), f.now)).toThrow('not_in_inventory');
  expect(() => createUpgradePlan(f.request, f.observations, f.request.expires_at_ms)).toThrow('expiry');
});

it('rejects non-JSON hash inputs and uses deterministic code-unit key ordering', () => {
  expect(upgradeCanonical({ z: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"z":1}');
  for (const value of [undefined, NaN, Infinity, { key: undefined }, new Date(), new Array(1)]) expect(() => upgradeCanonical(value)).toThrow('non_json');
  const cycle: unknown[] = []; cycle.push(cycle); expect(() => upgradeCanonical(cycle)).toThrow('non_json');
});
it('flags insufficient step budget before an updater can drain a consumer', () => {
  const f = upgradeFixture(); const plan = createUpgradePlan({ ...f.request, budget: { ...f.request.budget, max_steps: 11 } }, f.observations, f.now);
  expect(plan.plan.groups[0]!.reasons).toContain('insufficient_step_budget');
});

it('rejects a plan larger than its bounded persistence reader', () => {
  const f = upgradeFixture(); const original = createUpgradePlan(f.request, f.observations, f.now).plan; const sample = original.groups[0]!;
  const groups = Array.from({ length: 32 }, (_, index) => {
    const home = structuredClone(sample.homes[0]!); home.home_id = `home_${String(index).padStart(32, '0')}`; home.socket = `/socket-${index}`;
    home.identity!.home_id = home.home_id;
    return { ...sample, group_id: `group-${index}`, installation_id: `installation-${index}`, homes: [home], reasons: Array(160).fill('x'.repeat(128)) as string[] };
  });
  expect(() => freezeUpgradePlan({ ...original, groups })).toThrow('upgrade_plan_size');
});

it('does not plan a database schema downgrade even if a caller declares it readable', () => {
  const f = upgradeFixture(); const target = { ...f.request.target, database_schema: 39, readable_schema_min: 39, readable_schema_max: 41 };
  const plan = createUpgradePlan({ ...f.request, target }, f.observations, f.now);
  expect(plan.plan.groups[0]!.reasons.some(reason => reason.startsWith('schema_downgrade_unsupported:'))).toBe(true);
});
