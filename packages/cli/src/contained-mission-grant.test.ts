import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RevisionGrantError, signRevisionGrant, type EngineeringPrincipal, type RevisionGrant } from '@osstack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { readPullRequest } from './contained-mission-bridge-reader.js';
import { createRig, oid, scriptedTransport, type ScriptedPr } from './contained-mission-bridge-shadow.testkit.js';
import {
  RevisionGrantService, assertGrantLive, createGrantMissionView, enforceGrantLive, generateRevisionIssuerKey, issuerConfigPath, issuerKeyPath, loadRevisionIssuer,
  readIssuerPrivateKey, type GrantLiveContext,
} from './contained-mission-grant.js';
import { EngineeringAccess } from './engineering-access.js';
import { handleContainedMissionCommand } from './contained-mission-command.js';
import type { ContainedMissionHost } from './contained-mission-host.js';
import { ContainedMissionService, createContainedMissionService } from './contained-mission-rpc.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const T0 = 1_800_000_000_000;
const H = 3_600_000;
const PUBLISHER = { actor_id: 501, app_id: 11 };
const cred = (who: string) => who.repeat(48).slice(0, 48);
const sha = (c: string) => createHash('sha256').update(c).digest('hex');
const prWith = (over: Partial<ScriptedPr> = {}): ScriptedPr => ({ state: 'OPEN', head: oid('1'), base_sha: oid('a'), base_ref: 'main', author: PUBLISHER, reviews: [], ...over });
const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try { await (typeof p === 'function' ? p() : p); } catch (e) { return e instanceof Error ? e.message : String(e); }
  return 'no_error';
};

const codeSync = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); } return 'no_error'; };

async function setup(opts: { issuer?: boolean; enabled?: boolean; maxValidity?: number } = {}) {
  const rig = createRig();
  cleanup.push(() => { rig.close(); });
  const scope = rig.scope.scope_id;
  const authDir = join(rig.root, 'auth'); mkdirSync(authDir, { mode: 0o700 });
  const authFile = join(authDir, 'authority.json');
  const principals: Array<Record<string, unknown>> = [
    { credential_sha256: sha(cred('a')), principal_id: 'human', client_session_id: 'cli', read_scopes: [scope], write_scopes: [scope], stop_scopes: [], operator_scopes: [] },
    { credential_sha256: sha(cred('b')), principal_id: 'reader', client_session_id: 'cli', read_scopes: [scope], write_scopes: [], stop_scopes: [], operator_scopes: [] },
    { credential_sha256: sha(cred('c')), principal_id: 'other', client_session_id: 'cli', read_scopes: [scope], write_scopes: [scope], stop_scopes: [], operator_scopes: [] },
    { credential_sha256: sha(cred('d')), principal_id: 'elsewhere', client_session_id: 'cli', read_scopes: ['9'.repeat(64)], write_scopes: ['9'.repeat(64)], stop_scopes: [], operator_scopes: [] },
  ];
  const writeAuthority = (list = principals) => { writeFileSync(authFile, JSON.stringify({ version: 1, principals: list }), { mode: 0o600 }); };
  writeAuthority();
  const access = new EngineeringAccess(authFile);
  const home = join(rig.root, 'home'); mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  if (opts.issuer !== false) await generateRevisionIssuerKey(home, 'k1', opts.maxValidity);
  const pr = prWith();
  const scripted = scriptedTransport(() => pr);
  const clock = { now: T0 };
  const cancelled: string[] = [];
  const flags = { enabled: opts.enabled !== false };
  const service = new RevisionGrantService({
    chains: rig.chains, missions: await createGrantMissionView(rig.missions), access,
    registry: { repository: 'o/r', publisher: [PUBLISHER] }, readPr: ref => readPullRequest(scripted.transport, ref),
    loadIssuer: () => loadRevisionIssuer(home), protectedSetDigest: () => 'd'.repeat(64), now: () => clock.now, enabled: () => flags.enabled,
    cancelChild: async (_actor, id) => { cancelled.push(id); },
  });
  const actor = (who: string): EngineeringPrincipal => access.authenticate(cred(who));
  let nextPr = 7;
  const mission = (over: Record<string, unknown> = {}) => rig.seedMission({ pr_number: nextPr++, head: oid('1'), base_head: oid('a'), branch: 'topic', ...over } as never);
  /** What `grant-revisions` does on the operator's side, minus the terminal. */
  const issue = async (who: string, missionId: string, terms: Record<string, unknown> = {}, signWith?: ReturnType<typeof generateKeyPairSync>['privateKey']) => {
    const issuer = (await loadRevisionIssuer(home))!;
    const reply = await service.preview(actor(who), { mission_id: missionId, ...terms } as never);
    const key = signWith ?? await readIssuerPrivateKey(home, issuer.keys.get('k1')!);
    const signed = signRevisionGrant(reply.preview, key);
    return { reply, signed, grant: () => service.grant(actor(who), { nonce: reply.nonce, preview_sha256: reply.preview_sha256, signature: signed.signature }) };
  };
  const renew = async (who: string, chainId: string, terms: Record<string, unknown> = {}) => {
    const issuer = (await loadRevisionIssuer(home))!;
    const reply = await service.renewPreview(actor(who), { chain_id: chainId, ...terms } as never);
    const signed = signRevisionGrant(reply.preview, await readIssuerPrivateKey(home, issuer.keys.get('k1')!));
    return { reply, signed, grant: () => service.grant(actor(who), { nonce: reply.nonce, preview_sha256: reply.preview_sha256, signature: signed.signature }) };
  };
  const ctx = async (): Promise<GrantLiveContext> => ({ access, keys: (await loadRevisionIssuer(home))!.keys, now: clock.now });
  return { rig, scope, home, access, pr, clock, flags, service, cancelled, actor, mission, issue, renew, ctx, writeAuthority, principals, scripted };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const liveChainOf = (f: Fixture, missionId: string) => f.rig.chains.chainForMission(missionId, 'live');
async function granted(f: Fixture, terms: Record<string, unknown> = {}) {
  const missionId = f.mission();
  const { grant } = await f.issue('a', missionId, terms);
  const result = await grant();
  return { missionId, result, chain: f.rig.chains.get(result.chain_id) };
}

describe('issuer key handling', () => {
  it('generates a 0600 private key and a public-only config, and refuses to overwrite a key id', async () => {
    const f = await setup({ issuer: false });
    expect(await loadRevisionIssuer(f.home)).toBeUndefined();
    const created = await generateRevisionIssuerKey(f.home, 'k1', 2 * H);
    expect(statSync(issuerKeyPath(f.home, 'k1')).mode & 0o777).toBe(0o600);
    expect(statSync(issuerConfigPath(f.home)).mode & 0o777).toBe(0o600);
    const configText = readFileSync(issuerConfigPath(f.home), 'utf8');
    expect(configText).toContain(created.public_key_spki_b64);
    expect(configText).not.toContain('PRIVATE');
    const issuer = (await loadRevisionIssuer(f.home))!;
    expect(issuer.keys.get('k1')!.max_validity_ms).toBe(2 * H);
    expect(await readIssuerPrivateKey(f.home, issuer.keys.get('k1')!)).toBeTruthy();
    expect(await code(generateRevisionIssuerKey(f.home, 'k1'))).toBe('grant_key_exists');
    expect(await code(generateRevisionIssuerKey(f.home, '../x'))).toBe('grant_key_invalid');
    await generateRevisionIssuerKey(f.home, 'k2');
    expect([...(await loadRevisionIssuer(f.home))!.keys.keys()].sort()).toEqual(['k1', 'k2']);
  });

  it('refuses an insecure or mismatched key file and an insecure or invalid config', async () => {
    const f = await setup();
    const issuer = (await loadRevisionIssuer(f.home))!;
    chmodSync(issuerKeyPath(f.home, 'k1'), 0o644);
    expect(await code(readIssuerPrivateKey(f.home, issuer.keys.get('k1')!))).toBe('grant_key_unreadable');
    chmodSync(issuerKeyPath(f.home, 'k1'), 0o600);
    writeFileSync(issuerKeyPath(f.home, 'k1'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    expect(await code(readIssuerPrivateKey(f.home, issuer.keys.get('k1')!))).toBe('grant_key_mismatch');
    chmodSync(issuerConfigPath(f.home), 0o644);
    expect(await code(loadRevisionIssuer(f.home))).toMatch(/^BRIDGE_CONFIG_INVALID:revision-issuer\.json:unreadable/);
    chmodSync(issuerConfigPath(f.home), 0o600);
    writeFileSync(issuerConfigPath(f.home), '{"version":1,"keys":[{"key_id":"k1","public_key_spki_b64":"x","max_validity_ms":1000,"extra":1}]}');
    expect(await code(loadRevisionIssuer(f.home))).toMatch(/^BRIDGE_CONFIG_INVALID:revision-issuer\.json:/);
    writeFileSync(issuerConfigPath(f.home), '{');
    expect(await code(loadRevisionIssuer(f.home))).toBe('BRIDGE_CONFIG_INVALID:revision-issuer.json:json');
  });
});

describe('grant-revisions preview and grant', () => {
  it('issues a signed grant bound to principal, session, scope, repository, base, head and root, and creates the live chain', async () => {
    const f = await setup();
    const missionId = f.mission();
    const issued = await f.issue('a', missionId);
    expect(issued.reply.preview).toMatchObject({
      principal_id: 'human', client_session_id: 'cli', scope_id: f.scope, root_mission_id: missionId, repository: 'o/r', pr_number: 7, branch: 'topic', base_ref: 'main',
      base_sha: oid('a'), head_sha: oid('1'), rounds: 1, issued_at: T0, expires_at: T0 + 24 * H, review_deadline_ms: 24 * H, key_id: 'k1',
      budget: { max_executor_seconds: 3600, max_container_seconds: 3600, max_wall_clock_hours: 48 }, protected_set_digest: 'd'.repeat(64),
    });
    expect(issued.reply.valid_for_ms).toBe(60_000);
    f.clock.now = T0 + 5_000;
    const result = await issued.grant();
    const chain = f.rig.chains.get(result.chain_id);
    expect(chain).toMatchObject({ mode: 'live', state: 'awaiting_review', root_mission_id: missionId, published_head: oid('1'), published_base: oid('a'), rounds_used: 0,
      review_deadline: T0 + 24 * H, repository: 'o/r', pr_number: 7, branch: 'topic', base_ref: 'main' });
    expect(JSON.parse(chain.budget_json!)).toEqual({ origin: T0 + 5_000 - 5_000 });
    expect(JSON.parse(chain.grant_json)).toMatchObject({ kind: 'live', rounds: 1, signature: issued.signed.signature });
    expect(f.rig.chains.events(chain.chain_id).map(e => e.kind)).toEqual(['chain_created', 'grant_issued']);
    expect(JSON.stringify(f.rig.chains.events(chain.chain_id))).not.toContain(issued.signed.signature);
    expect(assertGrantLive(chain, await f.ctx()).grant_id).toBe(issued.signed.grant_id);
  });

  it('refuses everything while live is off, before anything else is read', async () => {
    const f = await setup({ enabled: false });
    const missionId = f.mission();
    expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId }))).toBe('bridge_live_disabled');
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: 'rc_00000000-0000-4000-8000-000000000000' }))).toBe('bridge_live_disabled');
    expect(await code(f.service.grant(f.actor('a'), { nonce: '0'.repeat(32), preview_sha256: '0'.repeat(64), signature: `${'A'.repeat(86)}==` }))).toBe('bridge_live_disabled');
    expect(await code(f.service.chainDecide(f.actor('a'), { chain_id: 'rc_00000000-0000-4000-8000-000000000000', decision: 'abandon' }))).toBe('bridge_live_disabled');
    expect(f.scripted.counts().reads).toBe(0);
  });

  it('refuses preview when the host is not configured, the key is unknown or ambiguous, or the terms are out of bounds', async () => {
    const f = await setup({ issuer: false });
    const missionId = f.mission();
    expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId }))).toBe('bridge_grant_not_configured');
    await generateRevisionIssuerKey(f.home, 'k1', 7 * 24 * H);
    await generateRevisionIssuerKey(f.home, 'k2', H);
    expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId }))).toBe('grant_key_required');
    expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId, key_id: 'nope' }))).toBe('grant_key_unknown');
    expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId, key_id: 'k2', expires_ms: 2 * H }))).toBe('grant_terms_invalid');
    for (const bad of [{ rounds: 3 }, { rounds: 0 }, { expires_ms: 7 * 24 * H + 1 }, { review_deadline_ms: 5 }, { budget: { max_executor_seconds: 0 } }]) {
      expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId, key_id: 'k1', ...bad } as never)), JSON.stringify(bad)).toBe('grant_terms_invalid');
    }
    const ok = await f.service.preview(f.actor('a'), { mission_id: missionId, key_id: 'k1', rounds: 2, expires_ms: 7 * 24 * H });
    expect(ok.preview).toMatchObject({ rounds: 2, expires_at: T0 + 7 * 24 * H });
  });

  it('refuses a principal without write on the Mission scope, and one with write on another scope', async () => {
    const f = await setup();
    const missionId = f.mission();
    expect(await code(f.service.preview(f.actor('b'), { mission_id: missionId }))).toBe('permission_denied');
    expect(await code(f.service.preview(f.actor('d'), { mission_id: missionId }))).toMatch(/permission_denied|not_found/);
    expect(f.scripted.counts().reads).toBe(0);
  });

  it('refuses a Mission that did not open a PR on the registered repository, or lacks a base head', async () => {
    const f = await setup();
    expect(await code(f.service.preview(f.actor('a'), { mission_id: f.mission({ repository: 'other/repo' }) }))).toBe('grant_repository_not_registered');
    expect(await code(f.service.preview(f.actor('a'), { mission_id: f.mission({ base_head: null }) }))).toBe('grant_base_missing');
    const unopened = f.rig.missions.authorize(f.rig.principal, { scope_id: f.scope, spec: { goal: 'x' }, claim: { repo_identity: 'rx', branch: 'bx', worktree_identity: 'wx' } }, 5).mission_id;
    expect(await code(f.service.preview(f.actor('a'), { mission_id: unopened }))).toBe('grant_mission_not_opened');
  });

  it('checks the live PR: open, authored by the publisher, on the head repository, branch, head and base that were published', async () => {
    const f = await setup();
    const missionId = f.mission();
    const cases: Array<[string, Partial<ScriptedPr>, string]> = [
      ['closed', { state: 'CLOSED' }, 'grant_pr_not_open'],
      ['merged', { state: 'MERGED' }, 'grant_pr_not_open'],
      ['stranger author', { author: { actor_id: 777, app_id: null } }, 'grant_pr_author_mismatch'],
      ['publisher id without its app', { author: { actor_id: 501, app_id: null } }, 'grant_pr_author_mismatch'],
      ['head moved', { head: oid('2') }, 'grant_pr_mismatch'],
      ['base sha moved', { base_sha: oid('b') }, 'grant_pr_mismatch'],
      ['base ref changed', { base_ref: 'release' }, 'grant_pr_mismatch'],
    ];
    for (const [name, change, expected] of cases) {
      Object.assign(f.pr, prWith(), change);
      expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId })), name).toBe(expected);
    }
    Object.assign(f.pr, prWith());
    const read = f.scripted.counts().reads;
    await f.service.preview(f.actor('a'), { mission_id: missionId });
    expect(f.scripted.counts().reads).toBe(read + 1);
    // An unreadable PR is a refusal, not a grant on stale facts.
    const broken = await setup();
    const brokenMission = broken.mission();
    (broken.service as unknown as { options: { readPr: unknown } }).options.readPr = async () => ({ complete: false, reason: 'request_cap' });
    expect(await code(broken.service.preview(broken.actor('a'), { mission_id: brokenMission }))).toBe('grant_pr_read_failed');
  });

  it('refuses a second chain for the same Mission or PR', async () => {
    const f = await setup();
    const { missionId } = await granted(f);
    expect(await code(f.service.preview(f.actor('a'), { mission_id: missionId }))).toBe('chain_exists');
    const samePr = f.mission({ pr_number: 7 });
    expect(await code(f.service.preview(f.actor('a'), { mission_id: samePr }))).toBe('chain_exists');
  });

  it('refuses a forged signature, a signature by an untrusted key and a replay, writing nothing', async () => {
    const f = await setup();
    const missionId = f.mission();
    const forged = await f.issue('a', missionId, {}, generateKeyPairSync('ed25519').privateKey);
    expect(await code(forged.grant())).toBe('grant_refused');
    expect(liveChainOf(f, missionId)).toBeUndefined();
    // The nonce is burned by the failed attempt.
    expect(await code(f.service.grant(f.actor('a'), { nonce: forged.reply.nonce, preview_sha256: forged.reply.preview_sha256, signature: forged.signed.signature }))).toBe('grant_refused');
    const good = await f.issue('a', missionId);
    expect(await code(good.grant())).toBe('no_error');
    const replay = await code(f.service.grant(f.actor('a'), { nonce: good.reply.nonce, preview_sha256: good.reply.preview_sha256, signature: good.signed.signature }));
    expect(replay).toBe('grant_refused');
    expect(f.rig.db.prepare("SELECT COUNT(*) n FROM engineering_revision_chains WHERE mode='live'").get()).toEqual({ n: 1 });
  });

  it('refuses a signature over a different preview, a swapped digest and a malformed signature', async () => {
    const f = await setup();
    const missionId = f.mission();
    const a = await f.issue('a', missionId);
    const other = signRevisionGrant({ ...a.reply.preview, rounds: 2 }, await readIssuerPrivateKey(f.home, (await loadRevisionIssuer(f.home))!.keys.get('k1')!));
    expect(await code(f.service.grant(f.actor('a'), { nonce: a.reply.nonce, preview_sha256: a.reply.preview_sha256, signature: other.signature }))).toBe('grant_refused');
    const b = await f.issue('a', missionId);
    expect(await code(f.service.grant(f.actor('a'), { nonce: b.reply.nonce, preview_sha256: '0'.repeat(64), signature: b.signed.signature }))).toBe('grant_refused');
    const c = await f.issue('a', missionId);
    expect(await code(f.service.grant(f.actor('a'), { nonce: c.reply.nonce, preview_sha256: c.reply.preview_sha256, signature: `${'A'.repeat(86)}==` }))).toBe('grant_refused');
    expect(await code(f.service.grant(f.actor('a'), { nonce: 'f'.repeat(32), preview_sha256: c.reply.preview_sha256, signature: c.signed.signature }))).toBe('grant_refused');
    expect(liveChainOf(f, missionId)).toBeUndefined();
  });

  it('refuses an expired nonce, a different principal and a signature after the issuer key was rotated away', async () => {
    const f = await setup();
    const missionId = f.mission();
    const late = await f.issue('a', missionId);
    f.clock.now = T0 + 60_001;
    expect(await code(late.grant())).toBe('grant_refused');
    f.clock.now = T0;
    const mine = await f.issue('a', missionId);
    // Another writer on the same scope cannot spend my nonce, and does not burn it.
    expect(await code(f.service.grant(f.actor('c'), { nonce: mine.reply.nonce, preview_sha256: mine.reply.preview_sha256, signature: mine.signed.signature }))).toBe('grant_refused');
    expect(await code(mine.grant())).toBe('no_error');
    const rotated = await setup();
    const rotatedMission = rotated.mission();
    const stale = await rotated.issue('a', rotatedMission);
    writeFileSync(issuerConfigPath(rotated.home), JSON.stringify({ version: 1, keys: [{ key_id: 'k9', public_key_spki_b64: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), max_validity_ms: 24 * H }] }));
    expect(await code(stale.grant())).toBe('grant_refused');
  });

  it('refuses when the facts moved between preview and grant, or the grantor lost write on the scope', async () => {
    const f = await setup();
    const missionId = f.mission();
    const moved = await f.issue('a', missionId);
    f.pr.head = oid('2');
    expect(await code(moved.grant())).toBe('grant_refused');
    f.pr.head = oid('1');
    const closed = await f.issue('a', missionId);
    f.pr.state = 'CLOSED';
    expect(await code(closed.grant())).toBe('grant_refused');
    f.pr.state = 'OPEN';
    const revoked = await f.issue('a', missionId);
    f.writeAuthority(f.principals.map(p => (p['principal_id'] === 'human' ? { ...p, write_scopes: [] } : p)));
    expect(await code(revoked.grant())).toMatch(/grant_refused|permission_denied/);
    expect(liveChainOf(f, missionId)).toBeUndefined();
  });

  it('refuses a daemon whose protected set changed after the preview', async () => {
    const f = await setup();
    const missionId = f.mission();
    const issued = await f.issue('a', missionId);
    (f.service as unknown as { options: { protectedSetDigest: () => string } }).options.protectedSetDigest = () => 'e'.repeat(64);
    expect(await code(issued.grant())).toBe('grant_refused');
  });

  it('caps a pending preview table and forgets entries after their ttl', async () => {
    const f = await setup();
    const missionId = f.mission();
    const first = await f.issue('a', missionId);
    for (let i = 0; i < 40; i += 1) await f.service.preview(f.actor('a'), { mission_id: missionId });
    expect(await code(first.grant())).toBe('grant_refused');
    expect((f.service as unknown as { pending: Map<string, unknown> }).pending.size).toBeLessThanOrEqual(32);
  });
});

describe('grant admission after asynchronous checks', () => {
  const hookRead = (f: Fixture, during: () => void) => {
    const options = (f.service as unknown as { options: { readPr: (ref: never) => Promise<unknown> } }).options;
    const original = options.readPr;
    options.readPr = async ref => { const result = await original(ref); during(); return result; };
  };

  it('re-reads authority right before writing: a revocation during the PR read stops both a grant and a re-grant', async () => {
    const f = await setup();
    const missionId = f.mission();
    const issued = await f.issue('a', missionId);
    hookRead(f, () => f.writeAuthority(f.principals.map(p => (p['principal_id'] === 'human' ? { ...p, write_scopes: [] } : p))));
    expect(await code(issued.grant())).toBe('permission_denied');
    expect(liveChainOf(f, missionId)).toBeUndefined();
    const g = await setup();
    const { chain } = await granted(g);
    const again = await g.renew('a', chain.chain_id, { rounds: 2 });
    hookRead(g, () => g.writeAuthority(g.principals.filter(p => p['principal_id'] !== 'human')));
    expect(await code(again.grant())).toBe('permission_denied');
    expect((JSON.parse(g.rig.chains.get(chain.chain_id).grant_json) as RevisionGrant).rounds).toBe(1);
  });

  it('judges time again right before writing: a grant that expired while waiting, or a read that outlived the nonce, is refused', async () => {
    const f = await setup();
    const missionId = f.mission();
    const brief = await f.issue('a', missionId, { expires_ms: 1000 });
    f.clock.now = T0 + 2000;
    expect(await code(brief.grant())).toBe('grant_refused');
    f.clock.now = T0;
    const slow = await f.issue('a', missionId);
    hookRead(f, () => { f.clock.now = T0 + 61_000; });
    expect(await code(slow.grant())).toBe('grant_refused');
    expect(liveChainOf(f, missionId)).toBeUndefined();
    const g = await setup();
    const { chain } = await granted(g);
    g.clock.now = T0 + H;
    const again = await g.renew('a', chain.chain_id, { rounds: 2, expires_ms: 1000 });
    hookRead(g, () => { g.clock.now = T0 + H + 30_000; });
    expect(await code(again.grant())).toBe('grant_refused');
    expect((JSON.parse(g.rig.chains.get(chain.chain_id).grant_json) as RevisionGrant).rounds).toBe(1);
  });

  it('verifies the signature against the issuer file as it is at commit time, and reports a consumed head on re-grant', async () => {
    const f = await setup();
    const missionId = f.mission();
    const issued = await f.issue('a', missionId);
    const options = (f.service as unknown as { options: { loadIssuer: () => Promise<unknown> } }).options;
    const original = options.loadIssuer;
    let loads = 0;
    // The first loads (signature check, preview rebuild) see the old key; the final one sees a replaced key under the same id.
    options.loadIssuer = async () => { loads += 1; if (loads < 3) return original(); return { keys: new Map([['k1', { key_id: 'k1', public_key: generateKeyPairSync('ed25519').publicKey, max_validity_ms: 24 * H }]]) }; };
    expect(await code(issued.grant())).toBe('grant_refused');
    expect(liveChainOf(f, missionId)).toBeUndefined();
    const g = await setup();
    const { chain } = await granted(g, { rounds: 1 });
    const reserved = g.rig.chains.reserve(chain.chain_id, chain.revision, { head: oid('1'), review_ids: [1], feedback_digest: 'd'.repeat(64) }, T0);
    g.rig.chains.voidReservation(chain.chain_id, reserved.chain.revision, oid('1'), 'grant_expired', T0);
    g.clock.now = T0 + H;
    const again = await g.renew('a', chain.chain_id, { rounds: 2 });
    expect(await again.grant()).toMatchObject({ renewed: true, head_consumed: true });
  });

  it('keeps a re-grant inside the registered repository', async () => {
    const f = await setup();
    const { chain } = await granted(f);
    (f.service as unknown as { options: { registry: { repository: string } } }).options.registry = { repository: 'o/other', publisher: [PUBLISHER] } as never;
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id }))).toBe('grant_repository_not_registered');
  });
});

describe('re-grant', () => {
  it('raises rounds on an awaiting_review chain: signed, bound to the chain revision, restarting the review deadline', async () => {
    const f = await setup();
    const { chain } = await granted(f);
    f.clock.now = T0 + 2 * H;
    const again = await f.renew('a', chain.chain_id, { rounds: 2 });
    expect(again.reply.preview).toMatchObject({ rounds: 2, renews: { chain_id: chain.chain_id, revision: chain.revision }, head_sha: oid('1'), scope_id: f.scope });
    const result = await again.grant();
    expect(result).toMatchObject({ chain_id: chain.chain_id, state: 'awaiting_review', rounds: 2, renewed: true });
    const next = f.rig.chains.get(chain.chain_id);
    expect(next.review_deadline).toBe(T0 + 2 * H + 24 * H);
    expect(JSON.parse(next.budget_json!)).toEqual({ origin: T0 });
    expect(assertGrantLive(next, await f.ctx()).rounds).toBe(2);
  });

  it('keeps unnamed terms at their current values and refuses to lower any', async () => {
    const f = await setup();
    const { chain } = await granted(f, { rounds: 2, budget: { max_executor_seconds: 7200 } });
    const kept = await f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id });
    expect(kept.preview).toMatchObject({ rounds: 2, budget: { max_executor_seconds: 7200, max_container_seconds: 3600, max_wall_clock_hours: 48 } });
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id, rounds: 1 }))).toBe('grant_terms_invalid');
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id, budget: { max_executor_seconds: 60 } }))).toBe('grant_terms_invalid');
  });

  it('refuses an in-flight, closed or shadow chain, a stranger and a PR that is no longer at the published head', async () => {
    const f = await setup();
    const { chain } = await granted(f, { rounds: 2 });
    expect(await code(f.service.renewPreview(f.actor('b'), { chain_id: chain.chain_id }))).toBe('permission_denied');
    expect(await code(f.service.renewPreview(f.actor('d'), { chain_id: chain.chain_id }))).toBe('permission_denied');
    f.pr.head = oid('2');
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id }))).toBe('grant_pr_mismatch');
    f.pr.head = oid('1');
    const reserved = f.rig.chains.reserve(chain.chain_id, chain.revision, { head: oid('1'), review_ids: [1], feedback_digest: 'd'.repeat(64) }, T0);
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id }))).toBe('chain_not_renewable');
    f.rig.chains.voidReservation(chain.chain_id, reserved.chain.revision, oid('1'), 'test', T0);
    const closed = f.rig.chains.closeLive(chain.chain_id, f.rig.chains.get(chain.chain_id).revision, 'abandon', T0);
    expect(closed.state).toBe('closed');
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id }))).toBe('chain_not_renewable');
    const shadow = f.rig.chains.createShadowChain({ root_mission_id: f.mission({ pr_number: 80 }), repository: 'o/r', pr_number: 80, branch: 'topic', base_ref: 'main', published_head: oid('1'), published_base: oid('a'), trace_id: 't' }, 5);
    expect(await code(f.service.renewPreview(f.actor('a'), { chain_id: shadow.chain_id }))).toBe('chain_not_live');
  });

  it('refuses when the chain moved after the preview or the signed grant is replayed', async () => {
    const f = await setup();
    const { chain } = await granted(f, { rounds: 1 });
    const stale = await f.renew('a', chain.chain_id, { rounds: 2 });
    f.rig.chains.stopLive(chain.chain_id, chain.revision, 'grant_expired', T0 + H);
    expect(await code(stale.grant())).toBe('grant_refused');
    const stopped = f.rig.chains.get(chain.chain_id);
    f.clock.now = T0 + 2 * H;
    const fresh = await f.renew('a', chain.chain_id, { rounds: 2 });
    expect(fresh.reply.preview.renews).toEqual({ chain_id: chain.chain_id, revision: stopped.revision });
    expect(await code(fresh.grant())).toBe('no_error');
    expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_review', stop_reason: null });
    expect(await code(f.service.grant(f.actor('a'), { nonce: fresh.reply.nonce, preview_sha256: fresh.reply.preview_sha256, signature: fresh.signed.signature }))).toBe('grant_refused');
  });
});

describe('assertGrantLive', () => {
  it('passes while valid and fails closed on expiry, wall clock, revoked authority and a rotated or unknown key', async () => {
    const f = await setup();
    const { chain } = await granted(f, { expires_ms: 7 * 24 * H });
    const keys = (await loadRevisionIssuer(f.home))!.keys;
    const at = (c: typeof chain, now: number, over: Partial<GrantLiveContext> = {}) => codeSync(() => assertGrantLive(c, { access: f.access, keys, now, ...over }));
    expect(at(chain, T0 + H)).toBe('no_error');
    expect(at(chain, T0 + 47 * H)).toBe('no_error');
    expect(at(chain, T0 + 48 * H)).toBe('budget_exhausted');
    expect(at(chain, T0 + 7 * 24 * H)).toBe('grant_expired');
    const short = (await granted(f, { expires_ms: H })).chain;
    expect(at(short, T0 + H - 1)).toBe('no_error');
    expect(at(short, T0 + H)).toBe('grant_expired');
    f.writeAuthority(f.principals.map(p => (p['principal_id'] === 'human' ? { ...p, write_scopes: [] } : p)));
    expect(at(chain, T0 + H)).toBe('grant_invalid');
    f.writeAuthority(f.principals.filter(p => p['principal_id'] !== 'human'));
    expect(at(chain, T0 + H)).toBe('grant_invalid');
    f.writeAuthority();
    expect(at(chain, T0 + H)).toBe('no_error');
    expect(at(chain, T0 + H, { keys: new Map() })).toBe('grant_invalid');
  });

  it('rejects a grant rewritten in the database: forged signature, edited field, other binding, or a shadow chain', async () => {
    const f = await setup();
    const { chain } = await granted(f, { rounds: 1 });
    const stored = JSON.parse(chain.grant_json) as RevisionGrant;
    const ctx = await f.ctx();
    const withGrant = (g: unknown) => ({ ...chain, grant_json: JSON.stringify(g) });
    const attacker = generateKeyPairSync('ed25519').privateKey;
    const { preview_sha256: _d, signature: _s, ...preview } = stored;
    expect(codeSync(() => assertGrantLive(withGrant(signRevisionGrant(preview, attacker)), ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive(withGrant({ ...stored, rounds: 2 }), ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive(withGrant({ ...stored, expires_at: stored.expires_at + 1 }), ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive(withGrant({ ...stored, key_id: 'nope' }), ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive({ ...chain, pr_number: 99 }, ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive({ ...chain, branch: 'other' }, ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive({ ...chain, repository: 'o/other' }, ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive({ ...chain, root_mission_id: 'cm_00000000-0000-4000-8000-000000000000' }, ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive({ ...chain, mode: 'shadow' }, ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive({ ...chain, grant_json: '{"kind":"live","rounds":2}' }, ctx))).toBe('grant_invalid');
    expect(codeSync(() => assertGrantLive({ ...chain, budget_json: '{"origin":"x"}' }, ctx))).toBe('grant_invalid');
  });

  it('refuses a grant that outlives the issuer key policy', async () => {
    const f = await setup({ maxValidity: 2 * H });
    const { chain } = await granted(f, { expires_ms: 2 * H });
    const ctx = await f.ctx();
    expect(codeSync(() => assertGrantLive(chain, ctx))).toBe('no_error');
    const shrunk = new Map([...ctx.keys].map(([id, k]) => [id, { ...k, max_validity_ms: H }]));
    expect(codeSync(() => assertGrantLive(chain, { ...ctx, keys: shrunk }))).toBe('grant_invalid');
  });

  it('enforceGrantLive stops the chain with the matching reason before rethrowing', async () => {
    const f = await setup();
    const { chain } = await granted(f);
    const ctx = await f.ctx();
    expect(codeSync(() => enforceGrantLive(f.rig.chains, chain, ctx))).toBe('no_error');
    expect(codeSync(() => enforceGrantLive(f.rig.chains, chain, { ...ctx, now: T0 + 25 * H }))).toBe('grant_expired');
    expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'grant_expired' });
    const second = await granted(f);
    expect(codeSync(() => enforceGrantLive(f.rig.chains, second.chain, { ...ctx, keys: new Map() }))).toBe('grant_invalid');
    expect(f.rig.chains.get(second.chain.chain_id).stop_reason).toBe('grant_invalid');
    expect(new RevisionGrantError('grant_expired').code).toBe('grant_expired');
  });
});

describe('chain-decide', () => {
  it('abandons or takes over: closes the chain, voids its reservation and asks for the running child to be cancelled', async () => {
    const f = await setup();
    const { chain } = await granted(f, { rounds: 2 });
    const reserved = f.rig.chains.reserve(chain.chain_id, chain.revision, { head: oid('1'), review_ids: [1], feedback_digest: 'd'.repeat(64) }, T0);
    const child = f.rig.missions.authorize(f.rig.principal, { scope_id: f.scope, spec: { goal: 'child' }, claim: { repo_identity: 'rc', branch: 'bc', worktree_identity: 'wc' } }, 5).mission_id;
    f.rig.chains.dispatch(chain.chain_id, reserved.chain.revision, oid('1'), child, T0);
    expect(await code(f.service.chainDecide(f.actor('b'), { chain_id: chain.chain_id, decision: 'abandon' }))).toBe('permission_denied');
    const result = await f.service.chainDecide(f.actor('a'), { chain_id: chain.chain_id, decision: 'takeover' });
    expect(result).toMatchObject({ state: 'closed', decision: 'takeover', child_cancel: 'requested' });
    expect(f.cancelled).toEqual([child]);
    expect(f.rig.chains.reservations(chain.chain_id).map(r => r.state)).toEqual(['void']);
    expect(await code(f.service.chainDecide(f.actor('a'), { chain_id: chain.chain_id, decision: 'abandon' }))).toBe('chain_terminal');
  });

  it('does not ask to cancel a settled or absent child, records a failed cancel and refuses shadow chains', async () => {
    const f = await setup();
    const { chain } = await granted(f);
    expect(await f.service.chainDecide(f.actor('a'), { chain_id: chain.chain_id, decision: 'abandon' })).toMatchObject({ child_cancel: 'not_needed' });
    expect(f.cancelled).toEqual([]);
    const second = await granted(f);
    const shadow = f.rig.chains.createShadowChain({ root_mission_id: f.mission({ pr_number: 90 }), repository: 'o/r', pr_number: 90, branch: 'topic', base_ref: 'main', published_head: oid('1'), published_base: oid('a'), trace_id: 't' }, 5);
    expect(await code(f.service.chainDecide(f.actor('a'), { chain_id: shadow.chain_id, decision: 'abandon' }))).toBe('chain_not_live');
    expect(second.chain.state).toBe('awaiting_review');
  });

  it('reconcile needs an uncertain push intent and a receipt reader, and never settles on its own in 5-A', async () => {
    const f = await setup();
    const { chain } = await granted(f, { rounds: 2 });
    expect(await code(f.service.chainDecide(f.actor('a'), { chain_id: chain.chain_id, decision: 'reconcile' }))).toBe('nothing_to_reconcile');
    const reserved = f.rig.chains.reserve(chain.chain_id, chain.revision, { head: oid('1'), review_ids: [1], feedback_digest: 'd'.repeat(64) }, T0);
    const child = f.rig.missions.authorize(f.rig.principal, { scope_id: f.scope, spec: { goal: 'child' }, claim: { repo_identity: 'rc', branch: 'bc', worktree_identity: 'wc' } }, 5).mission_id;
    const dispatched = f.rig.chains.dispatch(chain.chain_id, reserved.chain.revision, oid('1'), child, T0).chain;
    const intent = f.rig.chains.recordIntent(chain.chain_id, dispatched.revision, { kind: 'push', branch: 'topic', expected_old_head: oid('1'), new_head: oid('2'), expected_base_sha: oid('a'), child_mission_id: child }, T0);
    f.rig.chains.settleIntent(intent.intent.intent_id, 'uncertain', T0);
    expect(await code(f.service.chainDecide(f.actor('a'), { chain_id: chain.chain_id, decision: 'reconcile' }))).toBe('reconcile_unavailable');
    expect(f.rig.chains.intents(chain.chain_id)[0]!.state).toBe('uncertain');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// RPC surface, operator command, status

function rpcOf(service: ContainedMissionService, tamper?: (method: string, result: Record<string, unknown>) => Record<string, unknown>) {
  const calls: string[] = [];
  const rpc = async (method: string, params?: unknown) => {
    calls.push(method);
    try {
      const result = await service.handle(method, params) as Record<string, unknown>;
      return { ok: true, result: tamper ? tamper(method, result) : result };
    } catch (e) { return { ok: false, error: { code: (e instanceof Error ? e.message : String(e)).split(':')[0] } }; }
  };
  return { rpc, calls };
}
const stubHost = { recover: async () => undefined, close: async () => undefined, tick: async () => undefined } as unknown as ContainedMissionHost;
function serviceFor(f: Fixture, over: { grants?: RevisionGrantService | null; draining?: boolean } = {}) {
  const service = new ContainedMissionService({ host: stubHost, access: f.access, draining: () => over.draining === true, tickMs: 60_000,
    ...(over.grants === null ? {} : { grants: over.grants ?? f.service }) });
  cleanup.push(() => { void service.close(); });
  return service;
}
const base = (f: Fixture) => ({ rpc: undefined as never, home: f.home, readCredential: () => cred('a') });
async function runCommand(f: Fixture, args: string[], opts: { interactive?: boolean; confirm?: (preview: string, phrase: string) => Promise<boolean>; tamper?: Parameters<typeof rpcOf>[1]; service?: ContainedMissionService; credential?: () => string } = {}) {
  const service = opts.service ?? serviceFor(f);
  const { rpc, calls } = rpcOf(service, opts.tamper);
  const out: string[] = []; const errs: string[] = []; const credentialReads: number[] = [];
  const code = await handleContainedMissionCommand(args, {
    ...base(f), rpc, readCredential: () => { credentialReads.push(1); return (opts.credential ?? (() => cred('a')))(); }, stdout: l => { out.push(l); }, stderr: l => { errs.push(l); },
    grant: { ...(opts.interactive === undefined ? {} : { interactive: () => opts.interactive! }), ...(opts.confirm ? { confirm: opts.confirm } : {}) },
  });
  return { code, calls, out: out.join('\n'), err: errs.join('\n'), credentialReads: credentialReads.length };
}

describe('mission RPC for grants', () => {
  it('answers bridge_live_disabled until live is wired, after authentication and schema checks', async () => {
    const f = await setup();
    const service = serviceFor(f, { grants: null });
    const missionId = f.mission();
    const chain = 'rc_00000000-0000-4000-8000-000000000000';
    for (const [method, params] of [
      ['mission.revision_grant_preview', { mission_id: missionId }], ['mission.revision_grant_renew_preview', { chain_id: chain }],
      ['mission.grant_revisions', { nonce: '0'.repeat(32), preview_sha256: '0'.repeat(64), signature: `${'A'.repeat(86)}==` }], ['mission.chain_decide', { chain_id: chain, decision: 'abandon' }],
    ] as const) {
      expect(await code(service.handle(method, { credential: cred('a'), ...params })), method).toBe('bridge_live_disabled');
      expect(await code(service.handle(method, { credential: 'x'.repeat(48), ...params })), `${method} bad credential`).toBe('permission_denied');
      expect(await code(service.handle(method, { ...params })), `${method} no credential`).toBe('bad_request');
    }
    expect(f.scripted.counts().reads).toBe(0);
  });

  it('refuses rounds above 2 and unknown fields at the schema, and grant methods while draining', async () => {
    const f = await setup();
    const missionId = f.mission();
    const service = serviceFor(f);
    for (const bad of [{ rounds: 3 }, { rounds: 0 }, { rounds: '1' }, { expires_ms: 7 * 24 * H + 1 }, { extra: true }, { budget: { max_wall_clock_hours: 1000 } }]) {
      expect(await code(service.handle('mission.revision_grant_preview', { credential: cred('a'), mission_id: missionId, ...bad })), JSON.stringify(bad)).toBe('bad_request');
    }
    expect(await code(service.handle('mission.chain_decide', { credential: cred('a'), chain_id: 'rc_00000000-0000-4000-8000-000000000000', decision: 'merge' }))).toBe('bad_request');
    const draining = serviceFor(f, { draining: true });
    expect(await code(draining.handle('mission.revision_grant_preview', { credential: cred('a'), mission_id: missionId }))).toBe('draining');
    expect(await code(service.handle('mission.revision_grant_preview', { credential: cred('a'), mission_id: missionId }))).toBe('no_error');
  });
});

describe('grant-revisions command', () => {
  it('refuses without an interactive terminal: no credential read, no RPC, nothing written', async () => {
    const f = await setup();
    const missionId = f.mission();
    // Default check: vitest runs without a TTY on stdin and stderr.
    const natural = await runCommand(f, ['grant-revisions', '--mission', missionId]);
    expect(natural).toMatchObject({ code: 1, calls: [], credentialReads: 0 });
    expect(natural.err).toContain('mission_terminal_required');
    // A confirm seam alone does not make the session interactive.
    let asked = false;
    const seam = await runCommand(f, ['grant-revisions', '--mission', missionId], { interactive: false, confirm: async () => { asked = true; return true; } });
    expect(seam).toMatchObject({ code: 1, calls: [], credentialReads: 0 });
    expect(asked).toBe(false);
    expect(liveChainOf(f, missionId)).toBeUndefined();
  });

  it('shows the exact grant, requires GRANT plus the whole digest, signs locally and records the chain', async () => {
    const f = await setup();
    const missionId = f.mission();
    let shown = ''; let phrase = '';
    const run = await runCommand(f, ['grant-revisions', '--mission', missionId, '--rounds', '2', '--expires', '12h', '--review-deadline', '6h', '--max-executor-seconds', '1800', '--json'],
      { interactive: true, confirm: async (preview, p) => { shown = preview; phrase = p; return true; } });
    expect(run.code).toBe(0);
    expect(run.calls).toEqual(['mission.revision_grant_preview', 'mission.grant_revisions']);
    expect(phrase).toMatch(/^GRANT [0-9a-f]{64}$/);
    for (const needle of ['o/r', 'PR #7', 'topic', oid('a'), oid('1'), missionId, f.scope, 'human / cli', 'revision rounds 2', 'executor 1800s', phrase.slice(6)]) expect(shown).toContain(needle);
    expect(shown).toContain('never merge');
    const chain = liveChainOf(f, missionId)!;
    const grant = JSON.parse(chain.grant_json) as RevisionGrant;
    expect(grant).toMatchObject({ rounds: 2, expires_at: T0 + 12 * H, review_deadline_ms: 6 * H });
    expect(run.out).not.toContain(grant.signature);
    expect(JSON.parse(run.out)).toMatchObject({ chain_id: chain.chain_id, rounds: 2, renewed: false });
    expect(run.err).toBe('');
  });

  it('does not read the private key, call grant, or write anything when the operator declines or times out', async () => {
    const f = await setup();
    const missionId = f.mission();
    chmodSync(issuerKeyPath(f.home, 'k1'), 0o644);
    const declined = await runCommand(f, ['grant-revisions', '--mission', missionId], { interactive: true, confirm: async () => false });
    expect(declined).toMatchObject({ code: 1, calls: ['mission.revision_grant_preview'] });
    expect(declined.err).toContain('grant_not_confirmed');
    expect(declined.err).not.toContain('grant_key');
    const timedOut = await runCommand(f, ['grant-revisions', '--mission', missionId], { interactive: true, confirm: async () => { throw new Error('The operation was aborted'); } });
    expect(timedOut.calls).toEqual(['mission.revision_grant_preview']);
    expect(liveChainOf(f, missionId)).toBeUndefined();
    // A key the daemon does not trust never reaches the daemon either.
    chmodSync(issuerKeyPath(f.home, 'k1'), 0o600);
    writeFileSync(issuerKeyPath(f.home, 'k1'), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const wrong = await runCommand(f, ['grant-revisions', '--mission', missionId], { interactive: true, confirm: async () => true });
    expect(wrong.err).toContain('grant_key_mismatch');
    expect(wrong.calls).toEqual(['mission.revision_grant_preview']);
  });

  it('signs what it computed, so a daemon that alters the preview or its digest is refused before the prompt', async () => {
    const f = await setup();
    const missionId = f.mission();
    let asked = false;
    const confirm = async () => { asked = true; return true; };
    const lyingDigest = await runCommand(f, ['grant-revisions', '--mission', missionId], { interactive: true, confirm, tamper: (_m, r) => ('preview_sha256' in r ? { ...r, preview_sha256: '0'.repeat(64) } : r) });
    expect(lyingDigest.err).toContain('grant_preview_mismatch');
    const lyingPreview = await runCommand(f, ['grant-revisions', '--mission', missionId], { interactive: true, confirm, tamper: (_m, r) => ('preview' in r ? { ...r, preview: { ...(r['preview'] as object), rounds: 2 } } : r) });
    expect(lyingPreview.err).toContain('grant_preview_mismatch');
    const lyingKey = await runCommand(f, ['grant-revisions', '--mission', missionId, '--key', 'k1'], { interactive: true, confirm, tamper: (_m, r) => ('preview' in r ? { ...r, preview: { ...(r['preview'] as object), key_id: 'k2' } } : r) });
    expect(lyingKey.code).toBe(1);
    expect(asked).toBe(false);
    expect(liveChainOf(f, missionId)).toBeUndefined();
  });

  it('validates flags before anything else and never prints the credential', async () => {
    const f = await setup();
    const missionId = f.mission();
    const bad: string[][] = [['grant-revisions'], ['grant-revisions', '--mission', missionId, '--chain', 'rc_x'], ['grant-revisions', '--mission', missionId, '--rounds', '3'],
      ['grant-revisions', '--mission', missionId, '--rounds', '1', '--rounds', '2'], ['grant-revisions', '--mission', missionId, '--yes', 'true'], ['grant-revisions', '--mission', missionId, '--expires', '30'],
      ['grant-revisions', '--mission', missionId, '--expires'], ['grant-revisions', '--mission', missionId, '--max-wall-clock-hours', '999']];
    for (const args of bad) {
      const run = await runCommand(f, args, { interactive: true, confirm: async () => true });
      expect(run, args.join(' ')).toMatchObject({ code: 1, calls: [] });
    }
    const noConfig = await setup({ issuer: false });
    const run = await runCommand(noConfig, ['grant-revisions', '--mission', noConfig.mission()], { interactive: true, confirm: async () => true });
    expect(run).toMatchObject({ code: 1, calls: [] });
    expect(run.err).toContain('bridge_grant_not_configured');
    const leaky = await runCommand(f, ['grant-revisions', '--mission', missionId], { interactive: true, confirm: async () => true, tamper: () => ({ error: cred('a') }) });
    expect(leaky.err).not.toContain(cred('a'));
  });

  it('extends a chain with --chain, and chain-decide ends one without a terminal', async () => {
    const f = await setup();
    const { chain } = await granted(f);
    const renewed = await runCommand(f, ['grant-revisions', '--chain', chain.chain_id, '--rounds', '2', '--json'], { interactive: true, confirm: async () => true });
    expect(renewed.code).toBe(0);
    expect(renewed.calls).toEqual(['mission.revision_grant_renew_preview', 'mission.grant_revisions']);
    expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_review' });
    expect((JSON.parse(f.rig.chains.get(chain.chain_id).grant_json) as RevisionGrant).rounds).toBe(2);
    const badDecision = await runCommand(f, ['chain-decide', '--chain', chain.chain_id, '--decision', 'merge']);
    expect(badDecision).toMatchObject({ code: 1, calls: [] });
    const decided = await runCommand(f, ['chain-decide', '--chain', chain.chain_id, '--decision', 'abandon', '--json']);
    expect(decided.code).toBe(0);
    expect(JSON.parse(decided.out)).toMatchObject({ state: 'closed', decision: 'abandon' });
    expect(f.rig.chains.get(chain.chain_id).state).toBe('closed');
  });

  it('previews and signs --chain for a halted child while keeping the chain awaiting_decision', async () => {
    const f = await setup();
    const { chain } = await granted(f, { rounds: 1 });
    const reserved = f.rig.chains.reserve(chain.chain_id, chain.revision, { head: oid('1'), review_ids: [1], feedback_digest: 'd'.repeat(64) }, T0);
    const child = f.rig.missions.authorize(f.rig.principal, { scope_id: f.scope, spec: { goal: 'child' },
      claim: { repo_identity: 'rc', branch: 'bc', worktree_identity: 'wc' } }, 5).mission_id;
    const dispatched = f.rig.chains.dispatch(chain.chain_id, reserved.chain.revision, oid('1'), child, T0).chain;
    const stopped = f.rig.chains.stopLive(chain.chain_id, dispatched.revision, 'child_halted', T0);
    const renewed = await runCommand(f, ['grant-revisions', '--chain', chain.chain_id, '--rounds', '2', '--json'],
      { interactive: true, confirm: async () => true });
    expect(renewed).toMatchObject({ code: 0, calls: ['mission.revision_grant_renew_preview', 'mission.grant_revisions'] });
    expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'child_halted',
      current_mission_id: child, revision: stopped.revision + 1 });
    expect((JSON.parse(f.rig.chains.get(chain.chain_id).grant_json) as RevisionGrant).rounds).toBe(2);
  });

  it('creates an issuer key pair on the host with grant-keygen, refusing to reuse an id', async () => {
    const f = await setup({ issuer: false });
    const run = await runCommand(f, ['grant-keygen', '--key', 'ops', '--max-validity', '2d']);
    expect(run.code).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.out).toContain('"key_id": "ops"');
    expect(run.out).not.toContain('PRIVATE');
    expect((await loadRevisionIssuer(f.home))!.keys.get('ops')!.max_validity_ms).toBe(48 * H);
    expect((await runCommand(f, ['grant-keygen', '--key', 'ops'])).err).toContain('grant_key_exists');
    expect((await runCommand(f, ['grant-keygen'])).err).toContain('required:--key');
  });
});

describe('mission status for live chains', () => {
  it('reports the live chain with a grant summary and no secrets; production service still refuses live', async () => {
    const f = await setup();
    const { missionId, chain } = await granted(f, { rounds: 2 });
    const home = join(f.rig.root, 'prod-home'); mkdirSync(join(home, 'bridge'), { recursive: true });
    const env = {
      OSSTACK_CONTAINED_CODEX_BIN: '/bin/true', OSSTACK_CONTAINED_CODEX_HOME: f.rig.root, OSSTACK_CONTAINED_DOCKER_SOCKET: join(f.rig.root, 'd.sock'),
      OSSTACK_CONTAINED_DOCKER_DAEMON_ID: 'd', OSSTACK_CONTAINED_BASE_IMAGE_ID: `sha256:${'0'.repeat(64)}`,
    };
    const create = (bridge?: string) => createContainedMissionService({ attention: f.rig.attention, owner: f.rig.owner, access: f.access, home, draining: () => false,
      env: bridge === undefined ? env : { ...env, OSSTACK_BRIDGE: bridge }, log: () => undefined });
    // OSSTACK_BRIDGE=1 is still refused in 5-A: turning live on is 5-E.
    await expect(create('1')).rejects.toThrow('BRIDGE_LIVE_NOT_IMPLEMENTED');
    const service = await create();
    cleanup.push(() => { void service.close(); });
    expect(await code(service.handle('mission.revision_grant_preview', { credential: cred('a'), mission_id: missionId }))).toBe('bridge_live_disabled');
    const status = await service.handle('mission.status', { credential: cred('a'), mission_id: missionId }) as { chain: Record<string, unknown> };
    expect(status.chain).toMatchObject({
      mode: 'live', state: 'awaiting_review', stop_reason: null, rounds_used: 0, current_mission_id: null, published_head: oid('1'), chain_id: chain.chain_id,
      review_deadline: T0 + 24 * H, grant: { rounds: 2, expires_at: T0 + 24 * H, issued_at: T0, review_deadline_ms: 24 * H, key_id: 'k1', budget: { max_executor_seconds: 3600 } }, shadow_decisions: [],
    });
    const text = JSON.stringify(status.chain);
    const stored = JSON.parse(chain.grant_json) as RevisionGrant;
    for (const secret of [stored.signature, stored.preview_sha256, stored.nonce, 'human', f.scope, stored.protected_set_digest]) expect(text).not.toContain(secret);
    await service.close();
  });
});
