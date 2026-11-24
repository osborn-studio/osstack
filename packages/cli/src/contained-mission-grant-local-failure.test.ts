import { LiveReconciler } from './contained-mission-bridge-live.js';
import { readPullRequest } from './contained-mission-bridge-reader.js';
import { changesRequested, PUBLISHER, REVIEWER } from './contained-mission-revision.testkit.js';
import * as revision from './contained-mission-revision.js';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, parseLocalFailureRevisionGrant, verifyLocalFailureRevisionGrantSignature, localFailurePreviewDigest,
  previewDigest, parseRevisionGrantPreview, signLocalFailureRevisionGrant, type LocalFailureGrantPreview } from '@osstack/core';
import { expect, it, vi } from 'vitest';
import { assertGrantLive, enforceGrantLive, issuerConfigPath, issuerKeyPath, loadRevisionIssuer, readIssuerPrivateKey } from './contained-mission-grant.js';
import { ContainedMissionRpcRequests } from './contained-mission-rpc.js';
import { setup, cred, runCommand, serviceFor, type Fixture } from './contained-mission-grant.testkit.js';

const pins = {
  profile_id: 'unit-test', profile_digest: 'f'.repeat(64),
  trusted_source: { repository: 'o/trusted', commit: 'b'.repeat(40), artifact_digest: 'c'.repeat(64) },
  diagnostic_timeout_seconds: 60,
};
const flags = ['--local-failure-profile', pins.profile_id, '--profile-digest', pins.profile_digest,
  '--trusted-source-repository', pins.trusted_source.repository, '--trusted-source-commit', pins.trusted_source.commit,
  '--trusted-source-artifact', pins.trusted_source.artifact_digest, '--diagnostic-timeout-seconds', '60'];
const enabled = { grantOptions: { localFailureEnabled: () => true } };
const keyFor = async (f: Fixture) => readIssuerPrivateKey(f.home, (await loadRevisionIssuer(f.home))!.keys.get('k1')!);
const counts = (f: Fixture) => f.rig.db.prepare('SELECT (SELECT count(*) FROM engineering_revision_chains) chains, (SELECT count(*) FROM engineering_revision_chain_events) events').get();
async function issue(f: Fixture, recheck?: number, mission = f.mission()) {
  const local_failure = { ...pins, ...(recheck === undefined ? {} : { recheck_timeout_seconds: recheck }) };
  const reply = await f.service.preview(f.actor('a'), { mission_id: mission, local_failure });
  expect(reply.preview.version).toBe(2);
  const key = await keyFor(f);
  const signed = signLocalFailureRevisionGrant(reply.preview, key);
  const input = { nonce: reply.nonce, preview_sha256: reply.preview_sha256, signature: signed.signature };
  const grant = (over = {}, who = 'a') => f.service.grant(f.actor(who), { ...input, ...over });
  return { reply, key, signed, grant };
}

it.each([undefined, 30])('stores the exact signed V2 grant, baseline and event (recheck %s)', async timeout => {
  const f = await setup(enabled);
  const { reply, signed, grant } = await issue(f, timeout);
  expect(reply.preview_sha256).toBe(localFailurePreviewDigest(reply.preview));
  const result = await grant();
  expect(result.renewed).toBe(false);
  const chain = f.rig.chains.get(result.chain_id);
  const stored = parseLocalFailureRevisionGrant(chain.grant_json);
  expect(stored).toEqual({ ...signed, kind: 'live' });
  expect(verifyLocalFailureRevisionGrantSignature(stored, (await f.ctx()).keys.get('k1')!.public_key)).toBe(true);
  expect(stored.local_failure).toEqual({ ...pins, enabled: true, max_diagnostics_per_head: 1,
    ...(timeout === undefined ? {} : { recheck: { enabled: true, timeout_seconds: timeout } }) });
  expect(f.rig.chains.intents(chain.chain_id)).toMatchObject([{ kind: 'open_pr', state: 'confirmed' }]);
  const events = f.rig.chains.events(chain.chain_id);
  expect(JSON.parse(events.find(e => e.kind === 'grant_issued')!.payload_json)).toEqual({
    version: 2, grant_id: signed.grant_id, key_id: 'k1', expires_at: signed.expires_at, rounds: 1,
    local_failure: { profile_id: pins.profile_id, profile_digest: pins.profile_digest, recheck: timeout !== undefined },
  });
  await expect(grant()).rejects.toThrow('grant_refused');
  expect(f.rig.chains.events(chain.chain_id)).toEqual(events);
  await expect(f.service.renewPreview(f.actor('a'), { chain_id: chain.chain_id })).resolves.toMatchObject({ preview: { version: 2 }, previous_local_failure: stored.local_failure });
  const ctx = await f.ctx();
  expect(assertGrantLive(chain, ctx)).toEqual(stored);
});

it.each(['random', 'untrusted', 'domain', 'v1 digest', 'other digest', 'expired', 'rotated', 'head', 'protected', 'write scope'])('refuses V2 %s and burns the nonce', async reason => {
  let protectedDigest = 'd'.repeat(64);
  const f = await setup({ grantOptions: { ...enabled.grantOptions, protectedSetDigest: () => protectedDigest } });
  const { reply, key, grant } = await issue(f);
  const over: { signature?: string; preview_sha256?: string } = {};
  if (reason === 'random') over.signature = randomBytes(64).toString('base64');
  if (reason === 'untrusted') over.signature = signLocalFailureRevisionGrant(reply.preview, generateKeyPairSync('ed25519').privateKey).signature;
  if (reason === 'domain') over.signature = sign(null, Buffer.from(canonicalJson({ domain: 'osstack.revision-grant.v1', preview: reply.preview, preview_sha256: reply.preview_sha256 })), key).toString('base64');
  if (reason === 'v1 digest') {
    const { local_failure: _optIn, ...base } = reply.preview;
    over.preview_sha256 = previewDigest(parseRevisionGrantPreview({ ...base, version: 1 }));
  }
  if (reason === 'other digest') over.preview_sha256 = (await issue(f)).reply.preview_sha256;
  if (reason === 'expired') f.clock.now += 60_001;
  if (reason === 'rotated') {
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    writeFileSync(issuerConfigPath(f.home), JSON.stringify({ version: 1, keys: [{ key_id: 'k1', public_key_spki_b64: publicKey, max_validity_ms: 86_400_000 }] }));
  }
  if (reason === 'head') f.pr.head = '2'.repeat(40);
  if (reason === 'protected') protectedDigest = 'e'.repeat(64);
  if (reason === 'write scope') f.writeAuthority(f.principals.map(p => ({ ...p, write_scopes: [] })));
  await expect(grant(over)).rejects.toThrow('grant_refused');
  await expect(grant()).rejects.toThrow('grant_refused');
  expect(counts(f)).toEqual({ chains: 0, events: 0 });
});

it('keeps a foreign nonce usable by its owner and rejects a V2-domain signature on V1', async () => {
  const f = await setup(enabled);
  const { grant, key } = await issue(f);
  await expect(grant({}, 'c')).rejects.toThrow('grant_refused');
  expect(counts(f)).toEqual({ chains: 0, events: 0 });
  await grant();
  const v1 = await f.issue('a', f.mission());
  const before = counts(f);
  const signature = sign(null, Buffer.from(canonicalJson({ domain: 'osstack.revision-grant.v2', preview: v1.reply.preview, preview_sha256: v1.reply.preview_sha256 })), key).toString('base64');
  await expect(f.service.grant(f.actor('a'), { nonce: v1.reply.nonce, preview_sha256: v1.reply.preview_sha256, signature })).rejects.toThrow('grant_refused');
  expect(counts(f)).toEqual(before);
});

it.each([{}, { localFailureEnabled: () => false }, { enabled: () => false }])('checks the switches before reading or remembering', async grantOptions => {
  const f = await setup({ grantOptions });
  const id = f.mission();
  const readable = vi.spyOn(f.rig.missions, 'readable');
  await expect(f.service.preview(f.actor('a'), { mission_id: id, local_failure: pins })).rejects.toThrow('enabled' in grantOptions ? 'bridge_live_disabled' : 'local_failure_repair_disabled');
  expect(readable).not.toHaveBeenCalled();
  expect(f.service['pending'].size).toBe(0);
  await expect(f.service.grant(f.actor('a'), { nonce: '0'.repeat(32), signature: '', preview_sha256: '' })).rejects.toThrow('enabled' in grantOptions ? 'bridge_live_disabled' : 'grant_refused');
});
it.each(['before', 'during'])('checks a switch flipped %s grant reads', async when => {
  let on = true;
  const f = await setup({ grantOptions: { localFailureEnabled: () => on } });
  const { grant } = await issue(f);
  if (when === 'before') on = false;
  else f.compare.mockImplementationOnce(async (_, __, head) => { on = false; return [head]; });
  await expect(grant()).rejects.toThrow('local_failure_repair_disabled');
  expect(counts(f)).toEqual({ chains: 0, events: 0 });
});
it.each([{ diagnostic_timeout_seconds: 101 }, { recheck_timeout_seconds: 121 }, { recheck_timeout_seconds: 41 },
  { profile_id: '../id' }, { profile_digest: 'F'.repeat(64) }, { trusted_source: { ...pins.trusted_source, repository: '../repo' } },
  { trusted_source: { ...pins.trusted_source, artifact_digest: 'bad' } }])('refuses invalid V2 terms %j', async change => {
  const f = await setup(enabled);
  await expect(f.service.preview(f.actor('a'), { mission_id: f.mission(), local_failure: { ...pins, ...change },
    budget: { max_container_seconds: 100 } })).rejects.toThrow('grant_terms_invalid');
  expect(f.service['pending'].size).toBe(0);
  expect(counts(f)).toEqual({ chains: 0, events: 0 });
});
it('accepts V2 terms on both previews and keeps the RPC surface fixed', async () => {
  const f = await setup(enabled);
  const rpc = serviceFor(f);
  const params = { credential: cred('a'), mission_id: f.mission(), local_failure: pins };
  expect(Object.keys(ContainedMissionRpcRequests).sort()).toEqual(['mission.start', 'mission.status', 'mission.list', 'mission.cancel',
    'mission.rearm_local_failure_recheck', 'mission.publish_check', 'mission.approve_ci_repair', 'mission.approve_local_failure_repair', 'mission.decide', 'mission.revision_grant_preview', 'mission.revision_grant_renew_preview',
    'mission.grant_revisions', 'mission.chain_decide', 'mission.merger_report'].sort());
  await expect(rpc.handle('mission.revision_grant_preview', params)).resolves.toMatchObject({ preview: { version: 2 } });
  await expect(rpc.handle('mission.revision_grant_preview', { ...params, local_failure: { ...pins, extra: true } })).rejects.toThrow('bad_request');
  await expect(rpc.handle('mission.revision_grant_renew_preview', { credential: params.credential, chain_id: 'rc_' + '0'.repeat(36), local_failure: { ...pins, extra: true } })).rejects.toThrow('bad_request');
  await expect(rpc.handle('mission.revision_grant_renew_preview', { credential: params.credential, chain_id: 'rc_' + '0'.repeat(36), local_failure: pins })).rejects.toThrow(/^not_found$/);
  await expect(rpc.handle('mission.grant_revisions', { credential: params.credential, nonce: '0'.repeat(32), preview_sha256: '0'.repeat(64) })).rejects.toThrow('bad_request');
});

it.each([true, false])('shows all V2 authority and requires the local phrase (recheck %s)', async recheck => {
  const f = await setup(enabled);
  let preview!: LocalFailureGrantPreview;
  let digest = '';
  const run = await runCommand(f, ['grant-revisions', '--mission', f.mission(), ...flags, ...(recheck ? ['--recheck-timeout-seconds', '30'] : [])], {
    interactive: true, tamper: (_, r) => { if (r['preview']) { preview = r['preview'] as LocalFailureGrantPreview; digest = String(r['preview_sha256']); } return r; },
    confirm: async (text, phrase) => {
      expect(phrase).toBe('GRANT LOCAL-FAILURE ' + digest);
      expect(text).toMatch(/^Grant same-PR revisions AND local-failure repair/);
      for (const value of [preview.grant_id, preview.nonce, preview.root_mission_id, preview.scope_id, preview.repository, preview.branch, preview.base_ref,
        preview.base_sha, preview.head_sha, preview.key_id, preview.principal_id, preview.client_session_id, preview.protected_set_digest, digest,
        ...Object.values(pins.trusted_source), pins.profile_id, pins.profile_digest, '60 s', 'per PR head', 'trusted verification failure',
        'one automatic repair Mission', 'separate operator approval of the exact candidate', recheck ? '30 s' : 'NOT authorised', 'never merge']) expect(text).toContain(value);
      return true;
    },
  });
  expect(run.code, run.err).toBe(0);
  expect(run.calls).toEqual(['mission.revision_grant_preview', 'mission.grant_revisions']);
  expect(run.out + run.err).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
});
it('refuses partial, chain and malformed flags before credential or RPC', async () => {
  const f = await setup({ issuer: false });
  const mission = ['--mission', f.mission()];
  for (const [args, expected] of [
    [[...mission, '--recheck-timeout-seconds', '12'], 'required:local_failure_flags'],
    ...[1, 3, 5, 7, 9, 11].map(i => [[...mission, ...flags.map((v, j) => j === i ? '!invalid' : v)], 'invalid:']),
    [[...mission, ...flags, '--recheck-timeout-seconds', '121'], 'invalid:'],
  ] as Array<[string[], string]>) {
    const run = await runCommand(f, ['grant-revisions', ...args], { interactive: true });
    expect(run).toMatchObject({ code: 1, calls: [], credentialReads: 0 });
    expect(run.err).toContain(expected);
    expect(run.out + run.err).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
  }
});
it('declines V2 before opening the private key', async () => {
  const f = await setup(enabled);
  chmodSync(issuerKeyPath(f.home, 'k1'), 0o644);
  const run = await runCommand(f, ['grant-revisions', '--mission', f.mission(), ...flags], { interactive: true, confirm: async () => false });
  expect(run.calls).toEqual(['mission.revision_grant_preview']);
  expect(run.err).toContain('grant_not_confirmed');
  expect(run.out + run.err).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
});
it.each(['v1', 'v2', 'profile', 'timeout', 'recheck', 'root', 'renewal'])('rejects a self-consistent substituted %s preview before confirmation', async change => {
  const f = await setup(enabled);
  const confirm = vi.fn(async () => true);
  const run = await runCommand(f, ['grant-revisions', '--mission', f.mission(), ...(change === 'v2' ? [] : flags)], { interactive: true, confirm,
    tamper: (_, r) => {
      const p = r['preview'] as LocalFailureGrantPreview;
      if (change === 'v1') {
        const { local_failure: _optIn, ...shared } = p;
        const preview = parseRevisionGrantPreview({ ...shared, version: 1 });
        return { ...r, preview, preview_sha256: previewDigest(preview) };
      }
      const preview = { ...p, version: 2 as const,
        ...(change === 'root' ? { root_mission_id: 'cm_' + '0'.repeat(36) } : {}),
        ...(change === 'renewal' ? { renews: { chain_id: 'rc_' + '0'.repeat(36), revision: 1 } } : {}),
        local_failure: { ...pins, enabled: true as const, max_diagnostics_per_head: 1 as const,
        ...(change === 'profile' ? { profile_digest: '0'.repeat(64) } : change === 'timeout' ? { diagnostic_timeout_seconds: 10 }
          : change === 'recheck' ? { recheck: { enabled: true as const, timeout_seconds: 10 } } : {}) } };
      return { ...r, preview, preview_sha256: localFailurePreviewDigest(preview) };
    } });
  expect(run.err).toContain('grant_preview_mismatch');
  expect(confirm).not.toHaveBeenCalled();
  expect(run.out + run.err).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
});
it('limits the V2 signer, switch and forwarded methods to their owners', () => {
  const packages = fileURLToPath(new URL('../../', import.meta.url));
  const signers = []; const switches = [];
  for (const pkg of readdirSync(packages)) {
    const dir = join(packages, pkg, 'src');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      if (/\bsignLocalFailureRevisionGrant\b/.test(text)) signers.push(pkg + '/' + file);
      if (/\blocalFailureEnabled\b/.test(text)) switches.push(pkg + '/' + file);
      if (file === 'contained-mission-grant.ts') expect(text).not.toMatch(/\bsign(?:LocalFailure)?RevisionGrant\b/);
      if (file === 'decisions/answer.ts') {
        expect([...text.matchAll(/ports\.forward\(([^)]+)\)/g)].map(m => m[1])).toEqual(['method, params']);
        const assignments = [...text.matchAll(/\bmethod = ([^;]+);/g)].map(m => m[1]);
        expect(assignments).toEqual(['"attention.answer"', 'ci ? "mission.approve_ci_repair" : "mission.decide"']);
      }
    }
  }
  expect(signers.sort()).toEqual(['cli/contained-mission-grant-command.ts', 'core/bridge/revision-local-failure-grant.ts', 'core/index.ts', 'core/state/diagnosis-fixtures.ts']);
  expect(switches).toEqual(['cli/contained-mission-bridge-assembly.ts', 'cli/contained-mission-grant.ts']);
});

it('requires a canonical root repository before the V2 PR read', async () => {
  const f = await setup(enabled);
  const mission_id = f.mission({ repository: '../repo' });
  await expect(f.service.preview(f.actor('a'), { mission_id, local_failure: pins })).rejects.toThrow('grant_terms_invalid');
  expect(f.scripted.counts().reads).toBe(0);
  expect(f.service['pending'].size).toBe(0);
});

it('refuses renewal metadata even on a signed pending V2 preview', async () => {
  const f = await setup(enabled);
  const { reply, key, grant } = await issue(f);
  const pending = f.service['pending'].get(reply.nonce)!;
  const preview = { ...reply.preview, renews: { chain_id: 'rc_' + '0'.repeat(36), revision: 1 } };
  pending.preview = preview;
  const signed = signLocalFailureRevisionGrant(preview, key);
  const replace = vi.spyOn(f.rig.chains, 'replaceGrant');
  await expect(grant({ preview_sha256: signed.preview_sha256, signature: signed.signature })).rejects.toThrow('grant_refused');
  expect(replace).not.toHaveBeenCalled();
  expect(counts(f)).toEqual({ chains: 0, events: 0 });
});

it('uses the validity ceiling of the final issuer read', async () => {
  const f = await setup(enabled);
  const { grant } = await issue(f);
  f.compare.mockImplementationOnce(async (_, __, head) => {
    const path = issuerConfigPath(f.home);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.keys[0].max_validity_ms = 1000;
    writeFileSync(path, JSON.stringify(config));
    return [head];
  });
  await expect(grant()).rejects.toThrow('grant_refused');
  expect(counts(f)).toEqual({ chains: 0, events: 0 });
});

async function issuedReaderFixture() {
  let localEnabled = true;
  const f = await setup({ grantOptions: { localFailureEnabled: () => localEnabled } });
  const mission = f.mission({ spec: { start_commit: '0'.repeat(40), repo_path: f.rig.root,
    base_ref: 'main', worktree_path: join(f.rig.root, 'origin'), allowed_paths: ['src/**'], verify: { argv: ['verify'] } } });
  const { signed, grant } = await issue(f, undefined, mission);
  const { chain_id } = await grant();
  localEnabled = false;
  const ctx = await f.ctx();
  const dispatch: revision.DispatchRevisionDeps = {
    chains: f.rig.chains, missions: f.rig.missions, access: f.access, keys: () => ctx.keys, now: () => f.clock.now,
    enabled: () => true, protectedSetDigest: () => signed.protected_set_digest, worktreesRoot: f.rig.root,
    registry: { publisher: [PUBLISHER], reviewers: [REVIEWER] }, launchCaps: { executor_seconds: 600, verify_seconds: 120 },
    readPr: ref => readPullRequest(f.scripted.transport, ref),
  };
  return { f, chain: f.rig.chains.get(chain_id), dispatch, ctx };
}

it.each([
  ['open', 'awaiting_review', null], ['protected', 'awaiting_decision', 'protected_set_changed'],
  ['base', 'awaiting_decision', 'base_changed'], ['MERGED', 'closed', 'pr_merged'], ['CLOSED', 'closed', 'pr_closed'],
  ['deadline', 'awaiting_decision', 'review_deadline'], ['changes_requested', 'revising', null],
] as const)('reconciles a signed V2 grant for %s', async (scenario, state, stop_reason) => {
  const { f, chain, dispatch } = await issuedReaderFixture();
  if (scenario === 'protected') dispatch.protectedSetDigest = () => '0'.repeat(64);
  if (scenario === 'base') f.pr.base_sha = 'b'.repeat(40);
  if (scenario === 'MERGED' || scenario === 'CLOSED') f.pr.state = scenario;
  if (scenario === 'deadline') f.clock.now = chain.review_deadline!;
  if (scenario === 'changes_requested') f.pr.reviews = [changesRequested(77, f.pr.head)];
  const log = vi.fn();
  const launch = vi.spyOn(revision, 'dispatchRevision');
  const readPr = vi.fn(dispatch.readPr);
  const live = new LiveReconciler({ dispatch: { ...dispatch, readPr }, isBusy: () => false, cancelChild: async () => {},
    headIsDescendant: async () => true, log });
  for (let cycle = 1; cycle <= (scenario === 'changes_requested' ? 2 : 1); cycle++) {
    await live.scan();
    expect(readPr).toHaveBeenCalledTimes(cycle + Number(scenario === 'changes_requested'));
    if (scenario === 'changes_requested') {
      expect(launch).toHaveBeenCalledTimes(1);
      await expect(launch.mock.results.at(-1)!.value).resolves.toMatchObject({ status: 'dispatched', round: 1 });
    }
    expect(log).not.toHaveBeenCalled();
    expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state, stop_reason });
    expect(f.rig.chains.reservations(chain.chain_id)).toHaveLength(Number(scenario === 'changes_requested'));
    expect(f.rig.db.prepare('SELECT count(*) n FROM engineering_contained_missions').get()).toEqual({ n: scenario === 'changes_requested' ? 2 : 1 });
    f.clock.now += 60_000;
  }
  launch.mockRestore();
  await live.stop();
});

it.each(['valid', 'grant_expired', 'grant_invalid'])('dispatches or stops a signed V2 review: %s', async reason => {
  const { f, chain, dispatch, ctx } = await issuedReaderFixture();
  if (reason === 'grant_expired') f.clock.now = parseLocalFailureRevisionGrant(chain.grant_json).expires_at;
  f.pr.reviews = [{ ...changesRequested(77, f.pr.head), submitted_at: f.clock.now - 1000 }];
  if (reason === 'grant_invalid') f.writeAuthority(f.principals.map(p => ({ ...p, write_scopes: [] })));
  const outcome = await revision.dispatchRevision(dispatch, chain.chain_id);
  if (reason === 'valid') {
    expect(outcome).toMatchObject({ status: 'dispatched', round: 1 });
    expect(enforceGrantLive(f.rig.chains, chain, ctx).version).toBe(2);
  } else {
    expect(outcome).toEqual({ status: 'stopped', reason });
    expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: reason });
    expect(f.rig.chains.reservations(chain.chain_id)).toEqual([]);
    expect(f.rig.db.prepare('SELECT count(*) n FROM engineering_contained_missions').get()).toEqual({ n: 1 });
  }
});

it.each([1, 2, 3])('refuses unreadable version %i before PR reads or writes', async version => {
  const { f, chain, dispatch } = await issuedReaderFixture();
  vi.spyOn(f.rig.chains, 'get').mockReturnValue({ ...chain, grant_json: JSON.stringify({ version }) });
  const readPr = vi.fn(dispatch.readPr);
  const changes = () => f.rig.db.prepare('SELECT total_changes() AS n').get();
  const before = changes();
  expect(await revision.dispatchRevision({ ...dispatch, readPr }, chain.chain_id)).toEqual({ status: 'no_reserve', reason: 'grant_unreadable' });
  expect(readPr).not.toHaveBeenCalled();
  expect(changes()).toEqual(before);
});

it('checks V2 signatures, grant binding, key policy and live scope on each assertion', async () => {
  const { f, chain, ctx } = await issuedReaderFixture();
  const stored = parseLocalFailureRevisionGrant(chain.grant_json);
  const { signature: _signature, preview_sha256, ...preview } = stored;
  expect(assertGrantLive(chain, { ...ctx, now: stored.expires_at - 1 })).toEqual(stored);
  expect(() => assertGrantLive(chain, { ...ctx, now: stored.expires_at })).toThrow('grant_expired');
  const invalid = (body: unknown) => expect(() => assertGrantLive({ ...chain, grant_json: JSON.stringify(body) }, ctx)).toThrow('grant_invalid');
  invalid(signLocalFailureRevisionGrant(preview, generateKeyPairSync('ed25519').privateKey));
  invalid({ ...stored, rounds: 2 });
  invalid({ ...stored, expires_at: stored.expires_at + 1 });
  invalid({ ...stored, local_failure: { ...stored.local_failure, diagnostic_timeout_seconds: 59 } });
  invalid({ ...stored, version: 1 });
  invalid({ ...(await f.issue('a', f.mission())).signed, version: 2 });
  invalid({ ...stored, signature: sign(null, Buffer.from(canonicalJson({ domain: 'osstack.revision-grant.v1', preview, preview_sha256 })), await keyFor(f)).toString('base64') });
  for (const changed of [{ repository: 'o/another' }, { root_mission_id: 'another' }, { branch: 'other' }, { base_ref: 'other' },
    { pr_number: 99 }, { mode: 'shadow' as const }, { grant_json: '{}' }, { budget_json: '{"origin":"x"}' }]) {
    expect(() => assertGrantLive({ ...chain, ...changed }, ctx)).toThrow('grant_invalid');
  }
  const key = ctx.keys.get(stored.key_id)!;
  for (const keys of [new Map(), new Map([[key.key_id, { ...key, max_validity_ms: 1 }]]),
    new Map([[key.key_id, { ...key, public_key: generateKeyPairSync('ed25519').publicKey }]])]) {
    expect(() => assertGrantLive(chain, { ...ctx, keys })).toThrow('grant_invalid');
  }
  f.writeAuthority(f.principals.filter(p => p['principal_id'] !== stored.principal_id));
  expect(() => assertGrantLive(chain, ctx)).toThrow('grant_invalid');
});

it('stops at the V2 wall-clock limit measured from the chain budget origin', async () => {
  const { f, chain, ctx } = await issuedReaderFixture();
  const grant = parseLocalFailureRevisionGrant(chain.grant_json);
  const origin = ctx.now - grant.budget.max_wall_clock_hours * 3_600_000;
  const row = { ...chain, budget_json: JSON.stringify({ origin }) };
  expect(assertGrantLive(row, { ...ctx, now: ctx.now - 1 })).toEqual(grant);
  expect(() => enforceGrantLive(f.rig.chains, row, ctx)).toThrow('budget_exhausted');
  expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state: 'awaiting_decision', stop_reason: 'budget_exhausted' });
});

it('limits the V1-only grant parser to its CLI owners', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const readers = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts') && !/\.(test|testkit)\.ts$/.test(file))
    .filter(file => /\bparseStoredGrant\b/.test(readFileSync(join(root, file), 'utf8')));
  expect(readers.sort()).toEqual(['contained-mission-diagnosis.ts']);
});
