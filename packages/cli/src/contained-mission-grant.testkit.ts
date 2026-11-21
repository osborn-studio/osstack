import { createHash, type generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signRevisionGrant, type EngineeringPrincipal } from '@osstack/core';
import { afterEach, vi } from 'vitest';
import { readPullRequest } from './contained-mission-bridge-reader.js';
import { createRig, oid, scriptedTransport, type ScriptedPr } from './contained-mission-bridge-shadow.testkit.js';
import { RevisionGrantService, createGrantMissionView, generateRevisionIssuerKey, loadRevisionIssuer, readIssuerPrivateKey, type GrantLiveContext, type RevisionGrantServiceOptions } from './contained-mission-grant.js';
import { EngineeringAccess } from './engineering-access.js';
import { handleContainedMissionCommand } from './contained-mission-command.js';
import type { ContainedMissionHost } from './contained-mission-host.js';
import { ContainedMissionService } from './contained-mission-rpc.js';

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

async function setup(opts: { issuer?: boolean; enabled?: boolean; maxValidity?: number; grantOptions?: Partial<RevisionGrantServiceOptions> } = {}) {
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
  const compare = vi.fn(async (_repository: string, _start: string, head: string): Promise<readonly string[]> => [head]);
  const service = new RevisionGrantService({
    chains: rig.chains, missions: await createGrantMissionView(rig.missions), access,
    registry: { repository: 'o/r', publisher: [PUBLISHER] }, readPr: ref => readPullRequest(scripted.transport, ref),
    loadIssuer: () => loadRevisionIssuer(home), protectedSetDigest: () => 'd'.repeat(64), now: () => clock.now, enabled: () => flags.enabled,
    compare,
    ...opts.grantOptions,
    cancelChild: async (_actor, id) => { cancelled.push(id); },
  });
  const actor = (who: string): EngineeringPrincipal => access.authenticate(cred(who));
  let nextPr = 7;
  const mission = (over: Record<string, unknown> = {}) => rig.seedMission({ pr_number: nextPr++, head: oid('1'), base_head: oid('a'), branch: 'topic', spec: { start_commit: oid('0') }, ...over } as never);
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
    if (reply.preview.version !== 1) throw new Error('expected V1 renewal');
    const signed = signRevisionGrant(reply.preview, await readIssuerPrivateKey(home, issuer.keys.get('k1')!));
    return { reply, signed, grant: () => service.grant(actor(who), { nonce: reply.nonce, preview_sha256: reply.preview_sha256, signature: signed.signature }) };
  };
  const ctx = async (): Promise<GrantLiveContext> => ({ access, keys: (await loadRevisionIssuer(home))!.keys, now: clock.now });
  return { rig, scope, home, access, pr, clock, flags, service, cancelled, actor, mission, issue, renew, ctx, writeAuthority, principals, scripted, compare };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const liveChainOf = (f: Fixture, missionId: string) => f.rig.chains.chainForMission(missionId, 'live');
async function granted(f: Fixture, terms: Record<string, unknown> = {}) {
  const missionId = f.mission();
  const { grant } = await f.issue('a', missionId, terms);
  const result = await grant();
  return { missionId, result, chain: f.rig.chains.get(result.chain_id) };
}

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

export { setup, runCommand, serviceFor, cred, liveChainOf, cleanup, code, codeSync, T0, H, PUBLISHER, prWith, granted, type Fixture };
