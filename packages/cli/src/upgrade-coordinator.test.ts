import { chmod, readdir, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createScratchDir } from '@osstack/core';
import { createUpgradePlan, freezeUpgradePlan } from './upgrade-plan.js';
import { UpgradeJournal } from './upgrade-journal.js';
import { coordinateUpgrade, type NativeUpgradePort } from './upgrade-coordinator.js';
import { upgradeFixture } from './upgrade-test-fixture.js';

const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const f = upgradeFixture(); const root = await createScratchDir('tests', 'upgrade-coordinator'); await chmod(root, 0o700); roots.push(root);
  const plan = createUpgradePlan(f.request, f.observations, f.now); const journal = new UpgradeJournal(root);
  const calls: string[] = []; const restarted = new Set<string>(); let revoked = false;
  const port: NativeUpgradePort = {
    resolveAuthority: async (p, group) => ({ plan_digest: p.digest, group_id: group.group_id, installation_id: group.installation_id,
      consumer_home_ids: group.homes.map(h => h.home_id), expires_at_ms: p.plan.expires_at_ms,
      completeness_evidence_ref: 'fake-exclusive-installation-registration', qualification_ref: 'fake-updater-qualification', authorization_ref: 'fake-exact-plan-approval',
      assertCurrent: () => { if (revoked) throw Error('upgrade_revoked'); } }),
    observe: async home => { calls.push(`observe:${home.home_id}`); return { receipt_ref: `fake-observed:${home.home_id}`, healthy: true,
      identity: restarted.has(home.home_id) ? { ...home.identity!, generation: `instance_${'9'.repeat(32)}`, version: plan.plan.target.version,
        protocol_version: plan.plan.target.protocol_version, database_schema: plan.plan.target.database_schema, build_digest: plan.plan.target.build_digest,
        started_at_ms: f.now } : home.identity! }; },
    drain: async home => { calls.push(`drain:${home.home_id}`); return { receipt: { home_id: home.home_id, generation: home.identity!.generation,
      stopped: true, graph_holds: 0, unknown_actions: 0, receipt_ref: `fake-stopped:${home.home_id}` }, assertHeld: () => {} }; },
    snapshot: async home => { calls.push(`snapshot:${home.home_id}`); return { home_id: home.home_id, source_generation: home.identity!.generation, receipt_ref: `fake-consistent-snapshot:${home.home_id}` }; },
    install: async (_plan, group) => { calls.push('install'); return { plan_digest: _plan.digest, installation_id: group.installation_id, version: plan.plan.target.version, build_digest: plan.plan.target.build_digest, receipt_ref: 'fake-install' }; },
    restart: async home => { calls.push(`restart:${home.home_id}`); restarted.add(home.home_id); return { home_id: home.home_id, source_generation: home.identity!.generation, receipt_ref: `fake-restart:${home.home_id}` }; },
  };
  const run = (selectedPort: NativeUpgradePort | undefined = port) => coordinateUpgrade({ journal, plan, groupId: 'group', nowMs: () => f.now,
    ...(selectedPort ? { port: selectedPort } : {}) });
  return { ...f, root, plan, journal, calls, port, run, revoke: () => { revoked = true; } };
}
it('without a qualified host port persists only a plan and never installs, drains or restarts', async () => {
  const f = await fixture(); const result = await coordinateUpgrade({ journal: f.journal, plan: f.plan, groupId: 'group' });
  expect(result.state).toBe('qualification_pending'); expect(f.calls).toEqual([]);
  expect((await new UpgradeJournal(f.root).status(f.plan.digest, 'group')).phase).toBe('qualification_pending');
});
it('requires the exact complete consumer set from trusted authority, not registry completeness', async () => {
  const f = await fixture(); const resolve = f.port.resolveAuthority;
  f.port.resolveAuthority = async (...args) => ({ ...(await resolve(...args))!, consumer_home_ids: [f.observations[0]!.desired.home_id] });
  expect((await f.run()).state).toBe('qualification_pending'); expect(f.calls).toEqual([]);
});
it('stops every shared consumer before any snapshot/install and records exact verified identities', async () => {
  const f = await fixture(); expect((await f.run()).state).toBe('verified');
  expect(f.calls.map(c => c.split(':')[0])).toEqual(['observe', 'observe', 'drain', 'drain', 'snapshot', 'snapshot', 'install', 'restart', 'restart', 'observe', 'observe']);
  const status = await new UpgradeJournal(f.root).status(f.plan.digest, 'group'); expect(status.completed).toBe(true);
  expect(status.records[0]!.evidence_ref).toBe('fake-exact-plan-approval'); expect(status.records[0]!.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(status.records.filter(r => r.phase === 'installing' && r.status === 'started')).toHaveLength(1);
  const count = f.calls.length; expect((await f.run()).state).toBe('verified'); expect(f.calls).toHaveLength(count);
  expect((await readdir(f.root)).filter(name => name.startsWith('claim-'))).toHaveLength(0);
});
it.each(['second_drain', 'graph_hold', 'unknown_action', 'lease_lost'] as const)('never installs with %s', async failure => {
  const f = await fixture(); const drain = f.port.drain; let drained = 0;
  f.port.drain = async (...args) => {
    const lease = await drain(...args); drained += 1;
    if (failure === 'second_drain' && drained === 2) throw Error('upgrade_stop_unknown');
    if (failure === 'graph_hold') return { ...lease, receipt: { ...lease.receipt, graph_holds: 1 } } as unknown as Awaited<ReturnType<NativeUpgradePort['drain']>>;
    if (failure === 'unknown_action') return { ...lease, receipt: { ...lease.receipt, unknown_actions: 1 } } as unknown as Awaited<ReturnType<NativeUpgradePort['drain']>>;
    return failure === 'lease_lost' ? { ...lease, assertHeld: () => { if (drained === 2) throw Error('upgrade_stop_lease_lost'); } } : lease;
  };
  expect((await f.run()).state).toBe('recovery_required'); expect(f.calls).not.toContain('install');
  expect(f.calls.some(c => c.startsWith('restart:'))).toBe(false);
});
it.each(['observe', 'drain', 'snapshot', 'install', 'restart'] as const)('retains a journal and never blindly replays %s after a fault', async method => {
  const f = await fixture(); let attempted = 0;
  f.port[method] = (async () => { attempted += 1; throw Error('simulated lost receipt'); }) as never;
  const first = await f.run(); expect(first.state).not.toBe('verified'); expect(attempted).toBe(1);
  const second = await coordinateUpgrade({ journal: new UpgradeJournal(f.root), plan: f.plan, groupId: 'group', port: f.port, nowMs: () => f.now });
  expect(second.state).toBe('recovery_required'); expect(attempted).toBe(1);
});
it('treats an install timeout and late successful receipt as unknown without another install', async () => {
  const f = await fixture(); const request = { ...f.request, budget: { ...f.request.budget, max_step_ms: 20 } };
  const plan = createUpgradePlan(request, f.observations, f.now); let finish!: (value: Awaited<ReturnType<NativeUpgradePort['install']>>) => void; let calls = 0;
  f.port.install = async () => { calls += 1; return new Promise(resolve => { finish = resolve; }); };
  const run = () => coordinateUpgrade({ journal: f.journal, plan, groupId: 'group', port: f.port, nowMs: () => f.now });
  expect((await run()).state).toBe('recovery_required');
  const before = await f.journal.status(plan.digest, 'group');
  finish({ plan_digest: plan.digest, installation_id: 'shared-npm-global', version: plan.plan.target.version, build_digest: plan.plan.target.build_digest, receipt_ref: 'late' });
  await Promise.resolve(); expect(await f.journal.status(plan.digest, 'group')).toEqual(before);
  expect((await run()).state).toBe('recovery_required'); expect(calls).toBe(1);
});
it.each(['home', 'generation', 'version', 'build', 'schema', 'health'] as const)('rejects wrong post-restart %s even if software reports target version', async changed => {
  const f = await fixture(); const observe = f.port.observe; let count = 0;
  f.port.observe = async (...args) => {
    const value = await observe(...args); if (++count <= 2) return value;
    if (changed === 'home') value.identity.home_id = `home_${'f'.repeat(32)}`;
    if (changed === 'generation') value.identity.generation = args[0].identity!.generation;
    if (changed === 'version') value.identity.version = '1.0.0';
    if (changed === 'build') value.identity.build_digest = 'c'.repeat(64);
    if (changed === 'schema') value.identity.database_schema = 42;
    if (changed === 'health') value.healthy = false;
    return value;
  };
  expect((await f.run()).state).toBe('version_mismatch'); expect(f.calls.filter(c => c === 'install')).toHaveLength(1);
  expect((await f.run()).state).toBe('recovery_required');
});
it('does not race two operators into a shared install', async () => {
  const f = await fixture(); const install = f.port.install; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  f.port.install = async (...args) => { await barrier; return install(...args); };
  const pending = [f.run(), f.run()]; expect((await Promise.race(pending)).state).toBe('recovery_required'); release();
  const results = await Promise.all(pending);
  expect(results.map(r => r.state).sort()).toEqual(['recovery_required', 'verified']); expect(f.calls.filter(c => c === 'install')).toHaveLength(1);
});
it('checks revocation after drain await before any snapshot or install', async () => {
  const f = await fixture(); const drain = f.port.drain;
  f.port.drain = async (...args) => { const value = await drain(...args); f.revoke(); return value; };
  expect((await f.run()).state).toBe('recovery_required'); expect(f.calls.some(c => c.startsWith('snapshot:'))).toBe(false); expect(f.calls).not.toContain('install');
});
it('enforces step budget and refuses a changed generation before drain', async () => {
  const f = await fixture(); const observe = f.port.observe;
  f.port.observe = async (...args) => { const value = await observe(...args); return { ...value, identity: { ...value.identity, generation: `instance_${'f'.repeat(32)}` } }; };
  expect((await f.run()).state).toBe('aborted_before_install'); expect(f.calls.some(c => c.startsWith('drain:'))).toBe(false);
  const g = await fixture(); const plan = createUpgradePlan({ ...g.request, budget: { ...g.request.budget, max_steps: 1 } }, g.observations, g.now);
  expect((await coordinateUpgrade({ journal: g.journal, plan, groupId: 'group', port: g.port, nowMs: () => g.now })).state).toBe('qualification_pending');
  expect(g.calls).toEqual([]);
});

it.each(['preflight', 'draining', 'quiescent', 'snapshotting', 'installing', 'installed', 'restarting', 'verifying'] as const)(
  'reopens an abrupt process-loss journal at %s for reconciliation without invoking any updater port', async phase => {
    const f = await fixture(); await f.journal.create(f.plan); const writer = await f.journal.claim(f.plan.digest, 'group');
    await writer.append({ at_ms: f.now, phase, status: 'started', home_id: null, evidence_digest: null, evidence_ref: null, reason: null });
    expect((await coordinateUpgrade({ journal: new UpgradeJournal(f.root), plan: f.plan, groupId: 'group', port: f.port, nowMs: () => f.now })).state).toBe('recovery_required');
    expect(f.calls).toEqual([]);
  });

it.each(['snapshot', 'restart', 'install'] as const)('rejects a foreign %s receipt without replaying a native action', async method => {
  const f = await fixture();
  if (method === 'install') { const original = f.port.install; f.port.install = async (...args) => ({ ...await original(...args), plan_digest: 'e'.repeat(64) }); }
  else { const original = f.port[method]; f.port[method] = async (...args) => ({ ...await original(...args), home_id: `home_${'e'.repeat(32)}` }); }
  expect((await f.run()).state).not.toBe('verified');
  if (method === 'snapshot') expect(f.calls).not.toContain('install');
  const count = f.calls.length; expect((await f.run()).state).toBe('recovery_required'); expect(f.calls).toHaveLength(count);
});
it('keeps missing shared-consumer proof pending even with an injected updater', async () => {
  const f = await fixture(); f.port.resolveAuthority = async () => null;
  expect((await f.run()).state).toBe('qualification_pending'); expect(f.calls).toEqual([]);
});

it('rechecks the remaining home maintenance fence before each restart', async () => {
  const f = await fixture(); let firstRestarted = false; const drain = f.port.drain; const restart = f.port.restart;
  f.port.drain = async (...args) => { const lease = await drain(...args); return { ...lease, assertHeld: () => {
    if (firstRestarted && args[0].home_id === f.observations[1]!.desired.home_id) throw Error('upgrade_stop_lease_lost');
  } }; };
  f.port.restart = async (...args) => { const receipt = await restart(...args); firstRestarted = true; return receipt; };
  expect((await f.run()).state).not.toBe('verified'); expect(f.calls.filter(c => c.startsWith('restart:'))).toHaveLength(1);
});

it('does not trust caller-edited qualification reasons to bypass checkout or schema constraints', async () => {
  const f = await fixture(); const raw = structuredClone(f.plan.plan); raw.groups[0]!.homes[0]!.identity!.deployment_kind = 'checkout';
  const plan = freezeUpgradePlan(raw);
  expect((await coordinateUpgrade({ journal: f.journal, plan, groupId: 'group', port: f.port, nowMs: () => f.now })).state).toBe('qualification_pending');
  expect(f.calls).toEqual([]);
});

it('cancels a physically pending install without waiting for its full step timeout or accepting a late receipt', async () => {
  const f = await fixture(); const controller = new AbortController(); let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  f.port.install = async () => { began(); return new Promise(() => {}); };
  const pending = coordinateUpgrade({ journal: f.journal, plan: f.plan, groupId: 'group', port: f.port, nowMs: () => f.now, signal: controller.signal });
  await started; controller.abort(); const result = await pending;
  expect(result.state).toBe('recovery_required'); expect(result.reason).toBe('upgrade_cancelled');
  expect(f.calls.filter(c => c.startsWith('restart:'))).toHaveLength(0);
});

it('preserves verified facts and exposes a claim cleanup failure for manual reconciliation', async () => {
  const f = await fixture(); const claim = f.journal.claim.bind(f.journal);
  f.journal.claim = async (...args) => { const writer = await claim(...args); return { ...writer, releaseVerified: async () => { throw Error('simulated fs failure'); } }; };
  expect(await f.run()).toMatchObject({ state: 'verified', reason: 'claim_release_requires_reconciliation' });
  const status = await new UpgradeJournal(f.root).status(f.plan.digest, 'group'); expect(status.completed).toBe(true);
  expect(status.recovery.claim_cleanup_pending).toBe(true);
  const count = f.calls.length; expect((await f.run()).state).toBe('verified'); expect(f.calls).toHaveLength(count);
});

it('does not erase already-confirmed verification when cancellation arrives during its journal write', async () => {
  const f = await fixture(); const controller = new AbortController(); const claim = f.journal.claim.bind(f.journal);
  f.journal.claim = async (...args) => { const writer = await claim(...args); return { ...writer, append: async value => {
    const record = await writer.append(value); if (value.phase === 'verified' && value.status === 'confirmed') controller.abort(); return record;
  } }; };
  expect((await coordinateUpgrade({ journal: f.journal, plan: f.plan, groupId: 'group', port: f.port, nowMs: () => f.now, signal: controller.signal })).state).toBe('verified');
  const status = await f.journal.status(f.plan.digest, 'group'); expect(status.completed).toBe(true); expect(status.records.at(-1)!.status).toBe('confirmed');
});

it('preserves the frozen deployment-group order before any native port call', async () => {
  const f = await fixture(); const base = f.request.groups[0]!;
  const plan = createUpgradePlan({ ...f.request, groups: [
    { ...base, group_id: 'first', installation_id: 'one', home_ids: [f.observations[0]!.desired.home_id] },
    { ...base, group_id: 'second', installation_id: 'two', home_ids: [f.observations[1]!.desired.home_id] },
  ] }, f.observations, f.now);
  const run = (groupId: string) => coordinateUpgrade({ journal: f.journal, plan, groupId, port: f.port, nowMs: () => f.now });
  expect(await run('second')).toMatchObject({ state: 'qualification_pending', reason: 'preceding_group_not_verified' }); expect(f.calls).toEqual([]);
  expect((await run('first')).state).toBe('verified'); expect((await run('second')).state).toBe('verified');
});

it('checks exact claims synchronously before the native mutating call after its started record', async () => {
  const f = await fixture(); const claim = f.journal.claim.bind(f.journal);
  f.journal.claim = async (...args) => { const writer = await claim(...args); return { ...writer, append: async value => {
    const record = await writer.append(value);
    if (value.phase === 'draining' && value.status === 'started') for (const name of (await readdir(f.root)).filter(name => name.includes('claim-'))) await rm(`${f.root}/${name}`);
    return record;
  } }; };
  expect(await f.run()).toMatchObject({ state: 'recovery_required', reason: 'upgrade_claim_changed' });
  expect(f.calls.some(call => call.startsWith('drain:'))).toBe(false);
});
