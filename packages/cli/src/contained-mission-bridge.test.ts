import { generateKeyPairSync } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryCommandResult, DeliveryCommandRunner } from '@osstack/github';
import { createScratchDir, type ContainedMission } from '@osstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appCredentialRunner, createBridgeKit, type BridgeExec, type DeliveryEvidenceFacts } from './contained-mission-bridge.js';
import type { BridgeConfig } from './contained-mission-github-app.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = 1_800_000_000_000;
const PUBLISHER_TOKEN = 'ghs_PUBLISHERTOKEN0001';
const EVIDENCE_TOKEN = 'ghs_EVIDENCETOKEN0002';
const HEAD = 'b'.repeat(40);
const MID = 'cm_00000000-0000-4000-8000-000000000000';

let dir: string;
let config: BridgeConfig;
beforeEach(async () => {
  dir = await createScratchDir('tests', 'bridge-kit');
  const key = join(dir, 'key.pem');
  await writeFile(key, PEM, { mode: 0o600 });
  config = {
    repository: 'acme/widgets',
    publisher: { app_id: 11, installation_id: 21, private_key_path: key },
    evidence: { app_id: 12, installation_id: 22, private_key_path: key },
    mission_ruleset_ids: [5, 6],
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

interface FakeRun { id: number; name: string; head_sha: string; external_id: string; app: { id: number }; status: string; conclusion: string; output: { title: string; summary: string } }
/** In-memory GitHub: token minting plus the check-runs REST surface. */
function fakeGitHub(opts: { failWith?: number; loseReceipt?: boolean; barrier?: number } = {}) {
  let arrived = 0; let open: () => void = () => {}; const gate = new Promise<void>(resolve => { open = resolve; });
  const runs: FakeRun[] = [];
  const log: Array<{ method: string; path: string; auth: string; body: unknown }> = [];
  let nextId = 100;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const auth = headers['authorization'] ?? '';
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const tokens = /\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname);
    if (tokens) {
      const evidence = tokens[1] === '22';
      return json(201, { token: evidence ? EVIDENCE_TOKEN : PUBLISHER_TOKEN, expires_at: new Date(NOW + 3_600_000).toISOString(),
        permissions: { ...body.permissions, metadata: 'read' }, repositories: [{ full_name: 'acme/widgets' }] });
    }
    log.push({ method, path: u.pathname + u.search, auth, body });
    if (opts.failWith) return json(opts.failWith, { message: `denied ${EVIDENCE_TOKEN}` });
    if (method === 'GET' && /\/commits\/[0-9a-f]+\/check-runs$/.test(u.pathname)) {
      const name = u.searchParams.get('check_name'); const app = Number(u.searchParams.get('app_id'));
      const sha = /commits\/([0-9a-f]+)\//.exec(u.pathname)![1];
      // The first `barrier` lookups all answer before any POST can land: the race the design names.
      if (opts.barrier && arrived < opts.barrier) { arrived++; if (arrived === opts.barrier) open(); await gate; }
      // GitHub's app_id filter is honoured here; other Apps' checks are added by tests with their own ids.
      const all = runs.filter(r => r.head_sha === sha && r.name === name && (app === 0 || true));
      const perPage = Number(u.searchParams.get('per_page') ?? 30); const page = Number(u.searchParams.get('page') ?? 1);
      return json(200, { total_count: all.length, check_runs: all.slice((page - 1) * perPage, page * perPage) });
    }
    if (method === 'POST' && u.pathname.endsWith('/check-runs')) {
      const run: FakeRun = { id: nextId++, name: body.name, head_sha: body.head_sha, external_id: body.external_id, app: { id: 12 }, status: body.status, conclusion: body.conclusion, output: body.output };
      runs.push(run);
      if (opts.loseReceipt) { opts.loseReceipt = false; throw new Error('socket hang up'); }
      return json(201, run);
    }
    const patch = /\/check-runs\/(\d+)$/.exec(u.pathname);
    if (method === 'PATCH' && patch) {
      const run = runs.find(r => r.id === Number(patch[1]))!;
      Object.assign(run, { status: body.status, conclusion: body.conclusion, output: body.output });
      return json(200, run);
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { runs, log, fetchImpl };
}

const mission = (over: Partial<ContainedMission> = {}) => ({ mission_id: MID, state: 'pr_opened', candidate_head: HEAD, ...over }) as unknown as ContainedMission;
const facts = (over: Partial<DeliveryEvidenceFacts> = {}): DeliveryEvidenceFacts => ({ head: HEAD, repository: 'Acme/Widgets', evidence_digest: 'd'.repeat(64),
  verify: { argv: ['node', 'check.mjs'], exit_code: 0 }, ...over });
const kit = (gh: ReturnType<typeof fakeGitHub>) => createBridgeKit({ config, fetchImpl: gh.fetchImpl, now: () => NOW });
const errorOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } throw new Error('expected rejection'); };

describe('verify check (App B)', () => {
  it('creates a completed success check bound to mission and head', async () => {
    const gh = fakeGitHub();
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 100, created: true });
    expect(gh.runs).toHaveLength(1);
    expect(gh.runs[0]).toMatchObject({ name: 'osstack/verify', head_sha: HEAD, external_id: `${MID}:${HEAD}`, status: 'completed', conclusion: 'success' });
    expect(gh.runs[0]!.output.summary).toContain(MID);
    expect(gh.runs[0]!.output.summary).toContain('d'.repeat(64));
    expect(gh.runs[0]!.output.summary).toContain('node check.mjs');
    expect(gh.runs[0]!.output.summary).toContain('authoritative');
    const lookup = gh.log.find(l => l.method === 'GET')!;
    expect(lookup.path).toBe(`/repos/acme/widgets/commits/${HEAD}/check-runs?check_name=osstack%2Fverify&app_id=12&filter=all&per_page=100&page=1`);
    expect(gh.log.every(l => l.auth === `Bearer ${EVIDENCE_TOKEN}`)).toBe(true);
  });

  it('retry updates the existing check instead of creating another', async () => {
    const gh = fakeGitHub(); const k = kit(gh);
    await k.publishVerifyCheck(mission(), facts());
    const again = await k.publishVerifyCheck(mission(), facts());
    expect(again).toEqual({ check_run_id: 100, created: false });
    expect(gh.runs).toHaveLength(1);
    expect(gh.log.filter(l => l.method === 'POST')).toHaveLength(1);
    expect(gh.log.filter(l => l.method === 'PATCH')).toHaveLength(1);
  });

  it('a lost receipt (POST succeeded, caller failed) does not create a second check on retry', async () => {
    const gh = fakeGitHub({ loseReceipt: true }); const k = kit(gh);
    expect(await errorOf(k.publishVerifyCheck(mission(), facts()))).toBe('CONTAINED_VERIFY_CHECK_NETWORK');
    expect(gh.runs).toHaveLength(1);
    const retry = await k.publishVerifyCheck(mission(), facts());
    expect(retry).toEqual({ check_run_id: 100, created: false });
    expect(gh.runs).toHaveLength(1);
  });

  it('two concurrent calls end with one success and the duplicate neutralised', async () => {
    const gh = fakeGitHub({ barrier: 2 });
    const [a, b] = await Promise.all([kit(gh).publishVerifyCheck(mission(), facts()), kit(gh).publishVerifyCheck(mission(), facts())]);
    expect(a.check_run_id).toBe(100); expect(b.check_run_id).toBe(100);
    expect(gh.runs.filter(r => r.conclusion === 'success')).toHaveLength(1);
    const duplicate = gh.runs.find(r => r.id === 101);
    expect(duplicate?.conclusion).toBe('neutral');
    expect(duplicate?.output.summary).toContain('Duplicate of check run 100');
    expect(gh.runs.find(r => r.id === 100)?.conclusion).toBe('success');
  });

  const seedRun = (gh: ReturnType<typeof fakeGitHub>, id: number, external = `${MID}:${HEAD}`) =>
    gh.runs.push({ id, name: 'osstack/verify', head_sha: HEAD, external_id: external, app: { id: 12 }, status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } });

  it('follows pagination: matching runs on page 2, lowest id included, are found and duplicates neutralised', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 100; i++) seedRun(gh, 1000 + i, `other:${i}`);
    seedRun(gh, 500); seedRun(gh, 501);
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 500, created: false });
    expect(gh.runs.find(r => r.id === 501)?.conclusion).toBe('neutral');
    expect(gh.runs.find(r => r.id === 500)?.conclusion).toBe('success');
    expect(gh.runs).toHaveLength(102);
    expect(gh.log.filter(l => l.method === 'GET').map(l => /[&?]page=(\d+)/.exec(l.path)?.[1])).toEqual(['1', '2']);
  });

  it('more than 10 full pages of check runs fails with CONTAINED_VERIFY_CHECK_LIMIT and writes nothing', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 1001; i++) seedRun(gh, 1000 + i, `other:${i}`);
    expect(await errorOf(kit(gh).publishVerifyCheck(mission(), facts()))).toContain('CONTAINED_VERIFY_CHECK_LIMIT');
    expect(gh.log.filter(l => l.method !== 'GET')).toEqual([]);
    expect(gh.log.filter(l => l.method === 'GET')).toHaveLength(10);
  });

  it('ignores a same-named check from another App', async () => {
    const gh = fakeGitHub();
    gh.runs.push({ id: 7, name: 'osstack/verify', head_sha: HEAD, external_id: `${MID}:${HEAD}`, app: { id: 999 }, status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } });
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 100, created: true });
    expect(gh.runs.find(r => r.id === 7)?.output.title).toBe('t');
  });

  it('ignores a check with another external id or head', async () => {
    const gh = fakeGitHub();
    gh.runs.push({ id: 7, name: 'osstack/verify', head_sha: HEAD, external_id: 'cm_other:' + HEAD, app: { id: 12 }, status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } });
    expect((await kit(gh).publishVerifyCheck(mission(), facts())).created).toBe(true);
  });

  it('rejects a head, repository, state or evidence that does not match', async () => {
    const gh = fakeGitHub(); const k = kit(gh);
    expect(await errorOf(k.publishVerifyCheck(mission(), facts({ head: 'c'.repeat(40) })))).toBe('CONTAINED_VERIFY_CHECK_HEAD');
    expect(await errorOf(k.publishVerifyCheck(mission({ candidate_head: 'c'.repeat(40) }), facts()))).toBe('CONTAINED_VERIFY_CHECK_HEAD');
    expect(await errorOf(k.publishVerifyCheck(mission(), facts({ repository: 'acme/other' })))).toBe('CONTAINED_VERIFY_CHECK_REPOSITORY');
    expect(await errorOf(k.publishVerifyCheck(mission({ state: 'delivering' } as Partial<ContainedMission>), facts()))).toBe('CONTAINED_VERIFY_CHECK_STATE');
    expect(await errorOf(k.publishVerifyCheck(mission(), undefined))).toBe('CONTAINED_VERIFY_CHECK_EVIDENCE');
    expect(await errorOf(k.publishVerifyCheck(mission(), facts({ verify: { argv: ['x'], exit_code: 1 } })))).toBe('CONTAINED_VERIFY_CHECK_EVIDENCE');
    expect(gh.log).toEqual([]);
  });

  it('turns an HTTP error into a code without the token', async () => {
    const gh = fakeGitHub({ failWith: 403 });
    const message = await errorOf(kit(gh).publishVerifyCheck(mission(), facts()));
    expect(message).toBe('CONTAINED_VERIFY_CHECK_HTTP:403');
    expect(message).not.toContain(EVIDENCE_TOKEN);
  });
});

describe('appCredentialRunner', () => {
  const result = (stdout = ''): DeliveryCommandResult => ({ stdout, stderr: '', exitCode: 0 });
  function setup(execOut: (command: string) => DeliveryCommandResult = () => result('ok')) {
    const inner: Array<[string, readonly string[]]> = [];
    const executed: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const innerRunner: DeliveryCommandRunner = { run: async (command, args) => { inner.push([command, args]); return result('inner'); } };
    const exec: BridgeExec = async (command, args, options) => { executed.push({ command, args, env: options.env }); return execOut(command); };
    return { inner, executed, runner: appCredentialRunner(innerRunner, async () => PUBLISHER_TOKEN, exec) };
  }
  const opts = { cwd: '/', timeoutMs: 1 };

  it('pushes with a cleared credential helper and the token only in the child env', async () => {
    const f = setup();
    const prefix = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.https.allow=always'];
    await f.runner.run('git', [...prefix, 'push', 'origin', 'x:refs/heads/b'], opts);
    expect(f.inner).toEqual([]);
    const call = f.executed[0]!;
    // Both the generic helper list and the github.com-specific one are cleared before ours is set.
    expect(call.args.slice(0, 4)).toEqual(['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=']);
    expect(call.args[4]).toBe('-c');
    expect(call.args[5]).toMatch(/^credential\.helper=!f\(\)/);
    expect(call.args[5]).toContain('OSSTACK_BRIDGE_PUSH_TOKEN');
    expect(call.args.slice(6)).toEqual([...prefix, 'push', 'origin', 'x:refs/heads/b']);
    expect(call.args.join('\n')).not.toContain(PUBLISHER_TOKEN);
    expect(call.env['OSSTACK_BRIDGE_PUSH_TOKEN']).toBe(PUBLISHER_TOKEN);
    expect(call.env['GH_TOKEN']).toBeUndefined();
    expect(call.env['GITHUB_TOKEN']).toBeUndefined();
  });

  it('opens the PR with GH_TOKEN and without the other token variables', async () => {
    const f = setup();
    const saved = { ...process.env };
    process.env['GITHUB_TOKEN'] = 'host-github-token'; process.env['GH_ENTERPRISE_TOKEN'] = 'e'; process.env['GITHUB_ENTERPRISE_TOKEN'] = 'e2'; process.env['GH_TOKEN'] = 'host-gh';
    try { await f.runner.run('gh', ['pr', 'create', '--base', 'main'], opts); } finally { process.env = saved; }
    const env = f.executed[0]!.env;
    expect(env['GH_TOKEN']).toBe(PUBLISHER_TOKEN);
    expect(env['GH_HOST']).toBe('github.com');
    for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) expect(env[key]).toBeUndefined();
    expect(f.executed[0]!.args.join(' ')).not.toContain(PUBLISHER_TOKEN);
  });

  it('sends every read to the inner runner untouched', async () => {
    const f = setup();
    await f.runner.run('gh', ['auth', 'status'], opts);
    await f.runner.run('gh', ['api', 'repos/acme/widgets/branches/main/protection'], opts);
    await f.runner.run('gh', ['pr', 'view', '1'], opts);
    await f.runner.run('git', ['-c', 'a=b', 'remote', 'get-url', 'origin'], opts);
    await f.runner.run('git', ['ls-remote', 'origin'], opts);
    expect(f.inner).toHaveLength(5);
    expect(f.executed).toEqual([]);
  });

  it('redacts tokens from output and from thrown errors', async () => {
    const leaky = setup(() => ({ stdout: `to ${PUBLISHER_TOKEN}`, stderr: `denied ${PUBLISHER_TOKEN}`, exitCode: 1 }));
    const out = await leaky.runner.run('git', ['push', 'origin', 'b'], opts);
    expect(out.stdout + out.stderr).not.toContain(PUBLISHER_TOKEN);
    const throwing = appCredentialRunner({ run: async () => result() }, async () => PUBLISHER_TOKEN, async () => { throw new Error(`boom ${PUBLISHER_TOKEN}`); });
    const message = await errorOf(throwing.run('gh', ['pr', 'create'], opts));
    expect(message).not.toContain(PUBLISHER_TOKEN);
  });
});
