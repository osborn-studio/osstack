import { chmod, link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createScratchDir } from '@osstack/core';
import { createUpgradePlan, upgradeCanonical, upgradeDigest } from './upgrade-plan.js';
import { UpgradeJournal } from './upgrade-journal.js';
import { upgradeFixture } from './upgrade-test-fixture.js';

const roots: string[] = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await createScratchDir('tests', 'upgrade-journal'); roots.push(root); await chmod(root, 0o700);
  const f = upgradeFixture(); const plan = createUpgradePlan(f.request, f.observations, f.now); const journal = new UpgradeJournal(root); await journal.create(plan);
  return { ...f, root, plan, journal };
}
const record = { at_ms: 100000, phase: 'planned' as const, status: 'confirmed' as const, home_id: null, evidence_digest: null, evidence_ref: null, reason: null };
it('persists a read-only reopenable plan and chained phases without opening a database', async () => {
  const f = await fixture(); const writer = await f.journal.claim(f.plan.digest, 'group');
  await writer.append(record); await writer.append({ ...record, phase: 'draining', status: 'started' });
  const result = await new UpgradeJournal(f.root).status(f.plan.digest, 'group');
  expect(result.phase).toBe('draining'); expect(result.resume_allowed).toBe(false); expect(result.records[1]!.previous).toMatch(/^[a-f0-9]{64}$/);
  await expect(new UpgradeJournal(f.root).claim(f.plan.digest, 'group')).rejects.toThrow('recovery_required');
  await expect(writer.releaseVerified()).rejects.toThrow('requires_verified');
});
it('serializes competing operators across different plans for one shared installation', async () => {
  const f = await fixture(); const next = createUpgradePlan({ ...f.request, expires_at_ms: f.request.expires_at_ms + 1 }, f.observations, f.now);
  await f.journal.create(next);
  const results = await Promise.allSettled([f.journal.claim(f.plan.digest, 'group'), new UpgradeJournal(f.root).claim(next.digest, 'group')]);
  expect(results.filter(v => v.status === 'fulfilled')).toHaveLength(1); expect(results.filter(v => v.status === 'rejected')).toHaveLength(1);
});
it('detects hash-chain corruption and does not accept a copied plan under a new digest', async () => {
  const f = await fixture(); const writer = await f.journal.claim(f.plan.digest, 'group'); await writer.append(record); await writer.append({ ...record, phase: 'draining' });
  const path = join(f.root, f.plan.digest); const first = (await readdir(path)).filter(p => p.endsWith('.0000.json'))[0]!;
  const raw = JSON.parse(await readFile(join(path, first), 'utf8')); raw.phase = 'installing'; await writeFile(join(path, first), JSON.stringify(raw));
  await expect(f.journal.status(f.plan.digest, 'group')).rejects.toThrow('chain_broken');
  const fake = 'e'.repeat(64); await mkdir(join(f.root, fake), { mode: 0o700 }); await writeFile(join(f.root, fake, 'plan.json'), upgradeCanonical(f.plan.plan), { mode: 0o600 });
  await expect(f.journal.plan(fake)).rejects.toThrow('digest_mismatch');
});
it('rejects symlink and shared-permission roots and leaves the original record intact', async () => {
  const f = await fixture(); const alias = join(f.root, 'alias'); await symlink(join(f.root, f.plan.digest), alias);
  await expect(new UpgradeJournal(alias).create(f.plan)).rejects.toThrow('unsafe_directory');
  await chmod(f.root, 0o755); await expect(f.journal.plan(f.plan.digest)).rejects.toThrow('unsafe_directory'); await chmod(f.root, 0o700);
  expect((await f.journal.plan(f.plan.digest)).digest).toBe(f.plan.digest);
});

it('does not turn an unconfirmed verified phase into completion', async () => {
  const f = await fixture(); const writer = await f.journal.claim(f.plan.digest, 'group');
  await writer.append({ ...record, phase: 'verified', status: 'started' });
  expect((await f.journal.status(f.plan.digest, 'group')).completed).toBe(false);
  await expect(writer.releaseVerified()).rejects.toThrow('requires_verified');
});

it('reads crash-after-link records only when the second hard link is its private temporary', async () => {
  const f = await fixture(); const writer = await f.journal.claim(f.plan.digest, 'group'); await writer.append(record);
  const path = join(f.root, f.plan.digest); const name = (await readdir(path)).find(p => p.endsWith('.0000.json'))!;
  const temp = join(path, `.tmp-${'a'.repeat(32)}`); await link(join(path, name), temp);
  expect((await new UpgradeJournal(f.root).status(f.plan.digest, 'group')).records).toHaveLength(1);
  expect(await readFile(temp, 'utf8')).toEqual(await readFile(join(path, name), 'utf8'));
  await rm(temp); await link(join(path, name), join(f.root, 'foreign-link'));
  await expect(f.journal.status(f.plan.digest, 'group')).rejects.toThrow('unsafe_file');
});
it('claims individual homes as well as installations across different plans', async () => {
  const f = await fixture(); await f.journal.claim(f.plan.digest, 'group');
  const next = createUpgradePlan({ ...f.request, groups: [{ ...f.request.groups[0]!, installation_id: 'different-alias' }] }, f.observations, f.now);
  await f.journal.create(next); await expect(f.journal.claim(next.digest, 'group')).rejects.toThrow('recovery_required');
  const status = await f.journal.status(next.digest, 'group'); expect(status.phase).toBe('qualification_pending'); expect(status.recovery.claims_held).toBe(0);
});

it('rejects direct replay of a started journal even if claim files were manually removed', async () => {
  const f = await fixture(); const writer = await f.journal.claim(f.plan.digest, 'group'); await writer.append({ ...record, phase: 'draining', status: 'started' });
  for (const name of (await readdir(f.root)).filter(name => name.includes('claim-'))) await rm(join(f.root, name));
  await expect(new UpgradeJournal(f.root).claim(f.plan.digest, 'group')).rejects.toThrow('recovery_required');
});
it('rejects noncanonical record bytes instead of silently normalizing an immutable journal', async () => {
  const f = await fixture(); const writer = await f.journal.claim(f.plan.digest, 'group'); await writer.append(record);
  const path = join(f.root, f.plan.digest); const name = (await readdir(path)).find(name => name.endsWith('.0000.json'))!;
  const value = JSON.parse(await readFile(join(path, name), 'utf8')); await writeFile(join(path, name), JSON.stringify(value, null, 2));
  await expect(f.journal.status(f.plan.digest, 'group')).rejects.toThrow('non_canonical');
});

it('reports an incomplete claim set left by process loss before a writer was returned', async () => {
  const f = await fixture(); const claim = { plan_digest: f.plan.digest, group_id: 'group', token: 'c'.repeat(64) };
  await writeFile(join(f.root, `claim-${upgradeDigest('shared-npm-global')}.json`), upgradeCanonical(claim), { mode: 0o600 });
  const status = await f.journal.status(f.plan.digest, 'group'); expect(status.phase).toBe('recovery_required');
  expect(status.recovery).toMatchObject({ claims_held: 1, claims_expected: 3, partial_claim: true });
  await expect(f.journal.claim(f.plan.digest, 'group')).rejects.toThrow('recovery_required');
});

it('cleans its fresh claims if the post-publication journal re-read fails', async () => {
  const f = await fixture(); const status = f.journal.status.bind(f.journal); let reads = 0;
  f.journal.status = async (...args) => { if (++reads === 2) throw Error('upgrade_injected_read_failure'); return status(...args); };
  await expect(f.journal.claim(f.plan.digest, 'group')).rejects.toThrow('upgrade_injected_read_failure');
  expect((await readdir(f.root)).filter(name => name.includes('claim-'))).toEqual([]);
  expect((await new UpgradeJournal(f.root).status(f.plan.digest, 'group')).phase).toBe('qualification_pending');
});
it('maps missing claim files to the stable claim-changed error', async () => {
  const f = await fixture(); const writer = await f.journal.claim(f.plan.digest, 'group');
  await rm(join(f.root, `claim-${upgradeDigest('shared-npm-global')}.json`));
  await expect(writer.append(record)).rejects.toThrow('upgrade_claim_changed');
});
