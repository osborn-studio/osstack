import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { LocalFailureIntakeStore } from '@osstack/core/dist/state/engineering-local-failure-intake-store.js';
import { canonicalJson, localFailurePreviewDigest, parseLocalFailureGrantPreview,
  parseRevisionGrantPreview, previewDigest, signRevisionGrant, signLocalFailureRevisionGrant } from '@osstack/core';
import { expect, it, vi } from 'vitest';
import { readPullRequest } from './contained-mission-bridge-reader.js';
import { issuerKeyPath, readIssuerPrivateKey } from './contained-mission-grant.js';
import { cred, granted, PUBLISHER, runCommand, serviceFor, setup, type Fixture } from './contained-mission-grant.testkit.js';
import { mergeLocalFailureTerms, type LocalFailureRenewInput } from './contained-mission-grant-terms.js';
import { ContainedMissionRpcRequests } from './contained-mission-rpc.js';

const pins = { profile_id: 'unit-test', profile_digest: 'f'.repeat(64), diagnostic_timeout_seconds: 60,
  trusted_source: { repository: 'o/source', commit: 'b'.repeat(40), artifact_digest: 'c'.repeat(64) } };
const enabled = { grantOptions: { localFailureEnabled: () => true } };

async function fixture(options: Parameters<typeof setup>[0] = enabled) {
  const f = await setup(options);
  const actor = f.actor('a');
  const key = await readIssuerPrivateKey(f.home, (await f.ctx()).keys.get('k1')!);
  const first = await f.service.preview(actor, { mission_id: f.mission(), local_failure: pins, budget: { max_container_seconds: 200 } });
  const { nonce, preview_sha256, signature } = signLocalFailureRevisionGrant(first.preview, key);
  const { chain_id } = await f.service.grant(actor, { nonce, preview_sha256, signature });
  const preview = (local_failure?: LocalFailureRenewInput) => f.service.renewPreview(actor, { chain_id, local_failure });
  const renew = async (terms?: LocalFailureRenewInput) => {
    const reply = await preview(terms);
    const p = parseLocalFailureGrantPreview(reply.preview);
    const signed = signLocalFailureRevisionGrant(p, key);
    const accept = (signature = signed.signature, who = 'a') => f.service.grant(f.actor(who), {
      nonce: reply.nonce, preview_sha256: reply.preview_sha256, signature });
    return { reply, p, signed, accept };
  };
  return { f, chain_id, key, preview, renew, old: first.preview.local_failure };
}
function snapshot(f: Fixture, chainId: string) {
  return { row: f.rig.chains.get(chainId), events: f.rig.chains.events(chainId).length };
}
async function refused(f: Fixture, chainId: string, act: () => Promise<unknown>, code: string) {
  const before = snapshot(f, chainId);
  await expect(act()).rejects.toThrow(code);
  expect(snapshot(f, chainId)).toEqual(before);
}

it('inherits every opt-in term and stores exactly the signed V2 renewal', async () => {
  const { f, chain_id, renew, old } = await fixture();
  const before = snapshot(f, chain_id);
  const { reply, p, signed, accept } = await renew();
  expect(p.renews).toEqual({ chain_id, revision: before.row.revision });
  expect(reply.previous_local_failure).toEqual(old);
  expect(canonicalJson(p.local_failure)).toBe(canonicalJson(old));
  expect(await accept()).toMatchObject({ chain_id, renewed: true, head_consumed: false });
  expect(JSON.parse(f.rig.chains.get(chain_id).grant_json)).toEqual(signed);
  const event = f.rig.chains.events(chain_id).at(-1)!;
  expect(event.kind).toBe('grant_replaced');
  expect(JSON.parse(event.payload_json)).toMatchObject({ version: 2, local_failure: { changed: [] } });
});

it('updates only the named terms across successive renewals', async () => {
  const { f, chain_id, renew, old } = await fixture();
  let previous = old;
  const raised = { ...old, diagnostic_timeout_seconds: 61 };
  const recheck = { ...raised, recheck: { enabled: true as const, timeout_seconds: 30 } };
  const longer = { ...recheck, recheck: { ...recheck.recheck, timeout_seconds: 31 } };
  const commit = 'e'.repeat(40);
  for (const [terms, expected] of [
    [{ diagnostic_timeout_seconds: 61 }, raised], [{ recheck_timeout_seconds: 30 }, recheck],
    [{ recheck_timeout_seconds: 31 }, longer], [{ trusted_source: { commit } }, { ...longer, trusted_source: { ...longer.trusted_source, commit } }],
  ] as const) {
    const { reply, p, accept } = await renew(terms);
    expect(reply.previous_local_failure).toEqual(previous);
    expect(mergeLocalFailureTerms(previous, terms)).toEqual(expected);
    previous = expected;
    expect(p.local_failure).toEqual(expected);
    await accept();
    expect(JSON.parse(f.rig.chains.get(chain_id).grant_json).local_failure).toEqual(previous);
  }
});

it('refuses lowered timeouts, malformed terms and terms above budget at preview', async () => {
  const { f, chain_id, renew, preview } = await fixture();
  await (await renew({ recheck_timeout_seconds: 30 })).accept();
  for (const [terms, code] of [
    [{ diagnostic_timeout_seconds: 59 }, 'grant_not_monotonic'], [{ recheck_timeout_seconds: 29 }, 'grant_not_monotonic'],
    [{ profile_digest: 'bad' }, 'grant_terms_invalid'], [{ diagnostic_timeout_seconds: 201 }, 'grant_terms_invalid'],
  ] as const) await refused(f, chain_id, () => preview(terms), code);
});

it('requires a trusted V2 signature bound to the nonce, principal and exact preview', async () => {
  const { f, chain_id, renew, key } = await fixture();
  for (const variant of ['random', 'untrusted', 'domain', 'terms', 'principal', 'replay']) {
    const { accept, p, signed } = await renew();
    let signature = signed.signature;
    if (variant === 'random') signature = randomBytes(64).toString('base64');
    if (variant === 'untrusted') signature = signLocalFailureRevisionGrant(p, generateKeyPairSync('ed25519').privateKey).signature;
    if (variant === 'domain') signature = sign(null, Buffer.from(canonicalJson({ domain: 'osstack.revision-grant.v1',
      preview: p, preview_sha256: signed.preview_sha256 })), key).toString('base64');
    if (variant === 'terms') signature = signLocalFailureRevisionGrant({ ...p, local_failure: { ...p.local_failure, profile_id: 'other' } }, key).signature;
    if (variant === 'replay') await accept();
    await refused(f, chain_id, () => accept(signature, variant === 'principal' ? 'c' : 'a'), 'grant_refused');
    if (variant === 'principal') expect(await accept()).toMatchObject({ renewed: true });
  }
});

it('checks the live and local switches on V2 preview and acceptance', async () => {
  let on = true;
  const { f, chain_id, renew, preview } = await fixture({ grantOptions: { localFailureEnabled: () => on } });
  const { accept } = await renew();
  on = false;
  for (const terms of [undefined, {}, { profile_id: 'bad/id' }]) {
    await refused(f, chain_id, () => preview(terms), 'local_failure_repair_disabled');
  }
  await refused(f, chain_id, accept, 'local_failure_repair_disabled');
  f.flags.enabled = false;
  await refused(f, chain_id, () => preview({}), 'bridge_live_disabled');
});

it.each(['bridge', 'local'])('checks the %s switch inside the replacement transaction', async which => {
  let allowed = () => true;
  const { f, chain_id, renew } = await fixture({ grantOptions: {
    enabled: () => which !== 'bridge' || allowed(), localFailureEnabled: () => which !== 'local' || allowed(),
  } });
  const { accept } = await renew();
  allowed = () => !f.rig.db.inTransaction;
  await refused(f, chain_id, accept, which === 'bridge' ? 'bridge_live_disabled' : 'local_failure_repair_disabled');
});

it('requires full upgrade terms and keeps the V1 reply shape', async () => {
  let on = true;
  const f = await setup({ grantOptions: { localFailureEnabled: () => on } });
  const { chain: { chain_id } } = await granted(f);
  for (const switchEnabled of [true, false]) {
    on = switchEnabled;
    for (const local_failure of [{}, { profile_id: 'new' }]) {
      await refused(f, chain_id, () => f.service.renewPreview(f.actor('a'), { chain_id, local_failure }),
        on ? 'grant_terms_invalid' : 'local_failure_repair_disabled');
    }
  }
  const { reply, grant } = await f.renew('a', chain_id);
  expect(reply).not.toHaveProperty('previous_local_failure');
  expect(reply.preview.version).toBe(1);
  expect(await grant()).toMatchObject({ renewed: true });
});

it('refuses an upgrade for a dot repository component and still renews the V1 grant', async () => {
  const repository = 'o/.';
  const f: Fixture = await setup({ grantOptions: {
    ...enabled.grantOptions,
    registry: { repository, publisher: [PUBLISHER] },
    readPr: async ref => {
      const read = await readPullRequest(f.scripted.transport, ref);
      return read.complete ? { ...read, pr: { ...read.pr, headRepository: repository } } : read;
    },
  } });
  const issued = await f.issue('a', f.mission({ repository }));
  const { chain_id } = await issued.grant();
  await refused(f, chain_id, () => f.service.renewPreview(f.actor('a'), { chain_id, local_failure: pins }), 'grant_terms_invalid');
  expect(f.service['pending'].size).toBe(0);
  const renewal = await f.renew('a', chain_id);
  expect(await renewal.grant()).toMatchObject({ chain_id, renewed: true });
  expect(JSON.parse(f.rig.chains.get(chain_id).grant_json)).toEqual(renewal.signed);
});

async function upgradePreview(f: Fixture, chain_id: string) {
  const reply = await f.service.renewPreview(f.actor('a'), { chain_id, local_failure: pins });
  const preview = parseLocalFailureGrantPreview(reply.preview);
  const key = await readIssuerPrivateKey(f.home, (await f.ctx()).keys.get('k1')!);
  const signed = signLocalFailureRevisionGrant(preview, key);
  const accept = (signature = signed.signature, who = 'a') => f.service.grant(f.actor(who), {
    nonce: reply.nonce, preview_sha256: reply.preview_sha256, signature });
  return { reply, preview, signed, accept, key };
}

it('requires a V2 signature for the exact upgrade and consumes the nonce once', async () => {
  const f = await setup(enabled);
  const { chain, missionId } = await granted(f);
  const id = chain.chain_id;
  const random = await upgradePreview(f, id);
  await refused(f, id, () => random.accept(randomBytes(64).toString('base64')), 'grant_refused');
  const domain = await upgradePreview(f, id);
  const { local_failure: _opt, ...shared } = domain.preview;
  const v1 = signRevisionGrant({ ...shared, version: 1 }, domain.key);
  await refused(f, id, () => domain.accept(v1.signature), 'grant_refused');
  const wrongDomain = await upgradePreview(f, id);
  const signature = sign(null, Buffer.from(canonicalJson({ domain: 'osstack.revision-grant.v1',
    preview: wrongDomain.preview, preview_sha256: wrongDomain.signed.preview_sha256 })), wrongDomain.key).toString('base64');
  await refused(f, id, () => wrongDomain.accept(signature), 'grant_refused');
  const { reply, preview, signed, accept } = await upgradePreview(f, id);
  expect(preview.renews).toEqual({ chain_id: id, revision: chain.revision });
  expect(reply.previous_local_failure).toBeNull();
  expect(reply.carried_forward).toEqual({ eligible_diagnoses: [], waiting_child: null, pending_recheck: null });
  await refused(f, id, () => accept(signed.signature, 'c'), 'grant_refused');
  expect(await accept()).toMatchObject({ chain_id: id, renewed: true });
  const row = f.rig.chains.get(id);
  expect(JSON.parse(row.grant_json)).toEqual(signed);
  for (const key of ['rounds_used', 'budget_json', 'spent_json', 'published_head', 'published_base'] as const) expect(row[key]).toBe(chain[key]);
  const event = f.rig.chains.events(id).at(-1)!;
  expect(event.kind).toBe('grant_replaced');
  expect(JSON.parse(event.payload_json)).toMatchObject({ version: 2, local_failure: { changed: ['upgrade'] } });
  await refused(f, id, accept, 'grant_refused');
  expect((await f.service.renewPreview(f.actor('a'), { chain_id: id })).previous_local_failure).toEqual(preview.local_failure);
  await refused(f, id, () => f.service.preview(f.actor('a'), { mission_id: missionId, local_failure: pins }), 'chain_exists');
});

it.each(['bridge', 'local'])('checks the %s switch before and inside the upgrade transaction', async which => {
  let allowed = () => true;
  const f = await setup({ grantOptions: { enabled: () => which !== 'bridge' || allowed(), localFailureEnabled: () => which !== 'local' || allowed() } });
  const { chain: { chain_id } } = await granted(f);
  for (const gate of [() => false, () => !f.rig.db.inTransaction]) {
    allowed = () => true;
    const { accept } = await upgradePreview(f, chain_id);
    allowed = gate;
    await refused(f, chain_id, accept, which === 'bridge' ? 'bridge_live_disabled' : 'local_failure_repair_disabled');
  }
});

it('refuses stale previews across V1 renewals and upgrades', async () => {
  const f = await setup(enabled);
  const { chain: { chain_id } } = await granted(f);
  const stale = await upgradePreview(f, chain_id);
  await (await f.renew('a', chain_id)).grant();
  await refused(f, chain_id, stale.accept, 'grant_refused');
  const { preview, nonce, preview_sha256 } = await f.service.renewPreview(f.actor('a'), { chain_id });
  const fresh = await upgradePreview(f, chain_id);
  await fresh.accept();
  const { signature } = signRevisionGrant(parseRevisionGrantPreview(preview), fresh.key);
  await refused(f, chain_id, () => f.service.grant(f.actor('a'), { nonce, preview_sha256, signature }), 'grant_refused');
});

const upgradeFlags = ['--local-failure-profile', pins.profile_id, '--profile-digest', pins.profile_digest,
  '--trusted-source-repository', pins.trusted_source.repository, '--trusted-source-commit', pins.trusted_source.commit,
  '--trusted-source-artifact', pins.trusted_source.artifact_digest, '--diagnostic-timeout-seconds', '60'];

it('shows the upgrade authority and signs only after the upgrade phrase', async () => {
  const f = await setup(enabled);
  const { chain } = await granted(f);
  const run = await runCommand(f, ['grant-revisions', '--chain', chain.chain_id, ...upgradeFlags], {
    interactive: true, confirm: async (text, phrase) => {
      expect(text.split('\n')[0]).toBe(`Upgrade revision grant to local-failure repair on chain ${chain.chain_id} (chain revision ${chain.revision})`);
      expect(text).toContain("This chain's grant is version 1 today. This signature adds local-failure repair to it.");
      expect(text).toContain('profile id: none -> ' + pins.profile_id);
      expect(text).toContain('Work this renewal carries forward (shown for information, not signed):\n  nothing');
      expect(phrase).toBe('UPGRADE LOCAL-FAILURE ' + /preview sha256  ([a-f0-9]{64})/.exec(text)![1]);
      return true;
    } });
  expect(run.code, run.err).toBe(0);
  expect(JSON.parse(f.rig.chains.get(chain.chain_id).grant_json).version).toBe(2);
});

it('rejects incomplete flags and substituted upgrade replies before confirmation or key access', async () => {
  const f = await setup(enabled);
  const { chain: { chain_id } } = await granted(f);
  const { reply } = await upgradePreview(f, chain_id);
  chmodSync(issuerKeyPath(f.home, 'k1'), 0o644);
  const before = snapshot(f, chain_id);
  const args = ['grant-revisions', '--chain', chain_id];
  const confirm = vi.fn(async () => true);
  const partial = await runCommand(f, [...args, ...upgradeFlags.slice(0, -2)], { interactive: true, confirm });
  expect(partial.err).toContain('grant_terms_invalid');
  expect(partial.calls).toEqual(['mission.revision_grant_renew_preview']);
  for (const variant of ['opt-in', 'previous', 'work', 'chain', 'flags']) {
    const run = await runCommand(f, [...args, ...(variant === 'flags' ? [] : upgradeFlags)], { interactive: true, confirm, tamper: (_, r) => {
      if (variant === 'flags') return reply;
      if (variant === 'previous') { const { previous_local_failure: _previous, ...rest } = r; return rest; }
      if (variant === 'work') { const { carried_forward: _work, ...rest } = r; return rest; }
      const p = parseLocalFailureGrantPreview(r['preview']);
      const preview = variant === 'chain' ? { ...p, renews: { ...p.renews!, chain_id: 'rc_' + randomUUID() } }
        : { ...p, local_failure: { ...p.local_failure, profile_id: 'other' } };
      return { ...r, preview, preview_sha256: localFailurePreviewDigest(preview) };
    } });
    expect(run.err).toContain('grant_preview_mismatch');
    expect(run.calls).toEqual(['mission.revision_grant_renew_preview']);
  }
  expect(confirm).not.toHaveBeenCalled();
  expect(snapshot(f, chain_id)).toEqual(before);
});

it('checks real intake activity and pin changes at signed acceptance', async () => {
  const { f, chain_id, renew } = await fixture();
  const unchanged = await renew();
  const changed = await renew({ profile_id: 'other' });
  const { store, intake } = reserveIntake(f, chain_id);
  await refused(f, chain_id, unchanged.accept, 'grant_renewal_busy');
  store.settleNotStarted(intake.intake_id, intake.revision);
  await refused(f, chain_id, changed.accept, 'grant_opt_in_changed');
});

it.each(['revision', 'head'])('refuses changed live %s after preview', async fact => {
  const { f, chain_id, renew } = await fixture();
  const { accept } = await renew();
  if (fact === 'revision') await (await renew()).accept();
  else f.pr.head = 'e'.repeat(40);
  await refused(f, chain_id, accept, 'grant_refused');
});

it('validates partial RPC terms, including nested keys', async () => {
  const { f, chain_id } = await fixture();
  const method = 'mission.revision_grant_renew_preview';
  const params = { chain_id, credential: cred('a'), local_failure: { trusted_source: { repository: 'o/next' } } };
  expect(ContainedMissionRpcRequests[method].safeParse(params).success).toBe(true);
  const service = serviceFor(f);
  await expect(service.handle(method, params)).resolves.toMatchObject({ preview: { version: 2 } });
  for (const local_failure of [{ extra: true }, { trusted_source: { extra: true } }]) {
    await refused(f, chain_id, () => service.handle(method, { ...params, local_failure }), 'bad_request');
  }
});

it.each([false, true])('shows the opt-in changes and signs through the real service (add recheck %s)', async add => {
  const { f, chain_id } = await fixture();
  const run = await runCommand(f, ['grant-revisions', '--chain', chain_id, '--json', ...(add ? ['--recheck-timeout-seconds', '30'] : [])], {
    interactive: true, confirm: async (text, phrase) => {
      const revision = f.rig.chains.get(chain_id).revision;
      expect(text.split('\n')[0]).toBe(`Extend revision grant AND local-failure repair on chain ${chain_id} (chain revision ${revision})`);
      expect(text).toContain('Local-failure opt-in, old -> new:');
      for (const [label, value] of [['profile id', pins.profile_id], ['profile digest', pins.profile_digest],
        ['trusted source repository', pins.trusted_source.repository], ['trusted source commit', pins.trusted_source.commit],
        ['trusted source artifact digest', pins.trusted_source.artifact_digest], ['diagnostic timeout', 60]]) {
        expect(text).toContain(`${label}: ${value} (unchanged)`);
      }
      expect(text).toContain('recheck timeout: ' + (add ? 'none -> 30' : 'none (unchanged)'));
      expect(phrase).toBe('RENEW LOCAL-FAILURE ' + /preview sha256  ([a-f0-9]{64})/.exec(text)![1]);
      expect(text).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
      return true;
    } });
  expect(run.code, run.err).toBe(0);
  expect(JSON.parse(run.out)).toMatchObject({ renewed: true, chain_id });
  expect(run.calls).toEqual(['mission.revision_grant_renew_preview', 'mission.grant_revisions']);
  expect(run.out + run.err).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
});

it('refuses before RPC for invalid flags or no terminal, and before reading the key on decline', async () => {
  const { f, chain_id } = await fixture();
  const args = ['grant-revisions', '--chain', chain_id];
  const before = snapshot(f, chain_id);
  chmodSync(issuerKeyPath(f.home, 'k1'), 0o644);
  for (const [flags, interactive, reason] of [[[], false, 'mission_terminal_required'],
    [['--recheck-timeout-seconds', '-1'], true, 'invalid:local_failure_flags'],
    [['--trusted-source-repository', '../source'], true, 'invalid:local_failure_flags'],
    [[], true, 'grant_not_confirmed']] as const) {
    const run = await runCommand(f, [...args, ...flags], { interactive, confirm: async () => false });
    expect(run.code).toBe(1);
    expect(run.err).toContain(reason);
    expect(run.calls).toEqual(reason === 'grant_not_confirmed' ? ['mission.revision_grant_renew_preview'] : []);
    expect(run.credentialReads).toBe(Number(reason === 'grant_not_confirmed'));
    expect(run.out + run.err).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
    expect(snapshot(f, chain_id)).toEqual(before);
  }
});

it.each(['chain', 'opt-in', 'missing previous', 'altered previous', 'v1'])('rejects substituted %s before confirmation', async variant => {
  const { f, chain_id } = await fixture();
  const before = snapshot(f, chain_id);
  const confirm = vi.fn(async () => true);
  const run = await runCommand(f, ['grant-revisions', '--chain', chain_id, '--recheck-timeout-seconds', '30'], {
    interactive: true, confirm, tamper: (_, r) => {
      const p = parseLocalFailureGrantPreview(r['preview']);
      if (variant === 'missing previous') { const { previous_local_failure: _old, ...rest } = r; return rest; }
      if (variant === 'altered previous') return { ...r, previous_local_failure: { ...pins, enabled: true, max_diagnostics_per_head: 1, profile_id: 'other' } };
      if (variant === 'v1') {
        const { local_failure: _opt, ...shared } = p;
        const preview = parseRevisionGrantPreview({ ...shared, version: 1 });
        return { ...r, preview, preview_sha256: previewDigest(preview) };
      }
      const preview = variant === 'chain' ? { ...p, renews: { ...p.renews!, chain_id: 'rc_' + randomUUID() } }
        : { ...p, local_failure: { ...p.local_failure, profile_id: 'other' } };
      return { ...r, preview, preview_sha256: localFailurePreviewDigest(preview) };
    } });
  expect(run.calls).toEqual(['mission.revision_grant_renew_preview']);
  expect(run.err).toContain('grant_preview_mismatch');
  expect(confirm).not.toHaveBeenCalled();
  expect(snapshot(f, chain_id)).toEqual(before);
  expect(run.out + run.err).not.toMatch(new RegExp(cred('a') + '|PRIVATE KEY'));
});

function reserveIntake(f: Fixture, chain_id: string) {
  const chain = f.rig.chains.get(chain_id);
  const store = new LocalFailureIntakeStore(f.rig.attention, f.rig.owner, () => f.clock.now);
  const intake = store.reserve({ intake_id: `lfi_${randomUUID()}`, chain_id, chain_revision: chain.revision,
    root_mission_id: chain.root_mission_id, repository: chain.repository, pr_number: chain.pr_number, branch: chain.branch,
    head_sha: chain.published_head, tree_sha: 'd'.repeat(40), base_ref: chain.base_ref, base_sha: chain.published_base!,
    profile_id: pins.profile_id, profile_digest: pins.profile_digest, trusted_source_digest: pins.trusted_source.artifact_digest,
    grant_id: JSON.parse(chain.grant_json).grant_id, grant_digest: createHash('sha256').update(chain.grant_json).digest('hex'),
    invocation_id: randomUUID(), journal_ref: 'test', container_cap_seconds: 60, ci_hint_json: '{}' });
  return { store, intake };
}

it('checks activity and the frozen pin before previewing the unsigned list', async () => {
  const { f, chain_id, preview } = await fixture();
  const { store, intake } = reserveIntake(f, chain_id);
  await refused(f, chain_id, preview, 'grant_renewal_busy');
  store.settleNotStarted(intake.intake_id, intake.revision);
  await refused(f, chain_id, () => preview({ profile_id: 'other' }), 'grant_opt_in_changed');
  const reply = await preview();
  expect(reply.carried_forward).toEqual({ eligible_diagnoses: [], waiting_child: null, pending_recheck: null });
  expect(reply.preview).not.toHaveProperty('carried_forward');
});

it('omits carried work from a V1 renewal reply', async () => {
  const f = await setup();
  const { chain } = await granted(f);
  expect((await f.renew('a', chain.chain_id)).reply).not.toHaveProperty('carried_forward');
});

it.each([
  ['empty', 40, true],
  ['items', 40, true],
  ['SHA-256', 64, true],
  ['41-character diagnosis head', 41, false],
  ['missing', 40, false],
  ['malformed', 40, false],
] as const)('handles a %s carry-forward list before signing', async (variant, headLength, valid) => {
  const { f, chain_id } = await fixture();
  const request_id = 'vdr_' + randomUUID(), head_sha = 'a'.repeat(headLength);
  const candidate_head = 'b'.repeat(variant === 'SHA-256' ? 64 : 40);
  const child_mission_id = 'cm_' + randomUUID(), recheck_id = 'vrc_' + randomUUID();
  const confirm = vi.fn(async (text: string) => {
    expect(text).toContain('Work this renewal carries forward (shown for information, not signed):');
    expect(text).toContain('This renewal does not approve a candidate; the approval stays a separate step.');
    if (variant === 'empty') expect(text).toContain('\n  nothing\n');
    else {
      expect(text).toContain(`eligible diagnosis ${request_id} on head ${head_sha}`);
      expect(text).toContain(`repair candidate waiting for approval: child ${child_mission_id}, candidate ${candidate_head}`);
      expect(text).toContain(`pending recheck ${recheck_id}, attempts so far 2`);
    }
    return false;
  });
  const run = await runCommand(f, ['grant-revisions', '--chain', chain_id], { interactive: true, confirm, tamper: (_, reply) => {
    if (variant === 'empty') return reply;
    if (variant === 'missing') { const { carried_forward: _work, ...rest } = reply; return rest; }
    return { ...reply, carried_forward: { eligible_diagnoses: [{ request_id, head_sha }],
      waiting_child: { child_mission_id, candidate_head }, pending_recheck: { recheck_id, attempts: variant === 'malformed' ? -1 : 2 } } };
  } });
  expect(run.err).toContain(valid ? 'grant_not_confirmed' : 'grant_preview_mismatch');
  expect(confirm).toHaveBeenCalledTimes(valid ? 1 : 0);
  expect(run.calls).toEqual(['mission.revision_grant_renew_preview']);
});
