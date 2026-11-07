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

interface FakeSuite { id: number; head_sha: string; app: { id: number } }
interface FakeRun { suite: number; id: number; name: string; head_sha: string; external_id: string; app: { id: number }; status: string; conclusion: string; output: { title: string; summary: string } }
/** In-memory GitHub: token minting plus the check-runs REST surface. */
function fakeGitHub(opts: { returnForeignSuites?: boolean; failWith?: number; loseReceipt?: boolean; barrier?: number } = {}) {
  let arrived = 0; let open: () => void = () => {}; const gate = new Promise<void>(resolve => { open = resolve; });
  const runs: FakeRun[] = [];
  const suites: FakeSuite[] = [];
  const ensureSuite = (id: number, app = 12, head = HEAD) => { if (!suites.some(x => x.id === id)) suites.push({ id, head_sha: head, app: { id: app } }); };
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
    const paged = <T,>(items: T[]) => {
      const perPage = Number(u.searchParams.get('per_page') ?? 30); const page = Number(u.searchParams.get('page') ?? 1);
      return items.slice((page - 1) * perPage, page * perPage);
    };
    if (method === 'GET' && /\/commits\/[0-9a-f]+\/check-suites$/.test(u.pathname)) {
      const app = Number(u.searchParams.get('app_id')); const sha = /commits\/([0-9a-f]+)\//.exec(u.pathname)![1];
      // The first `barrier` lookups all answer before any POST can land: the race the design names.
      if (opts.barrier && arrived < opts.barrier) { arrived++; if (arrived === opts.barrier) open(); await gate; }
      const all = suites.filter(x => (opts.returnForeignSuites || (x.head_sha === sha && x.app.id === app)));
      return json(200, { total_count: all.length, check_suites: paged(all) });
    }
    const suiteRuns = /\/check-suites\/(\d+)\/check-runs$/.exec(u.pathname);
    if (method === 'GET' && suiteRuns) {
      const name = u.searchParams.get('check_name');
      const all = runs.filter(r => r.suite === Number(suiteRuns[1]) && r.name === name);
      return json(200, { total_count: all.length, check_runs: paged(all) });
    }
    if (method === 'POST' && u.pathname.endsWith('/check-runs')) {
      ensureSuite(5000);
      const run: FakeRun = { suite: 5000, id: nextId++, name: body.name, head_sha: body.head_sha, external_id: body.external_id, app: { id: 12 }, status: body.status, conclusion: body.conclusion, output: body.output };
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
  return { runs, suites, ensureSuite, log, fetchImpl };
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
    const gets = gh.log.filter(l => l.method === 'GET');
    expect(gets[0]!.path).toBe(`/repos/acme/widgets/commits/${HEAD}/check-suites?app_id=12&per_page=100&page=1`);
    expect(gh.log.some(l => l.path.includes('/commits/') && l.path.includes('/check-runs'))).toBe(false);
    expect(gets.find(g => g.path.includes('/check-suites/5000/'))!.path).toBe('/repos/acme/widgets/check-suites/5000/check-runs?check_name=osstack%2Fverify&filter=all&per_page=100&page=1');
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

  const seedRun = (gh: ReturnType<typeof fakeGitHub>, id: number, external = `${MID}:${HEAD}`, suite = 5000) => {
    gh.ensureSuite(suite);
    gh.runs.push({ suite, id, name: 'osstack/verify', head_sha: HEAD, external_id: external, app: { id: 12 }, status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } });
  };

  it('follows pagination: matching runs on page 2, lowest id included, are found and duplicates neutralised', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 100; i++) seedRun(gh, 1000 + i, `other:${i}`);
    seedRun(gh, 500); seedRun(gh, 501);
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 500, created: false });
    expect(gh.runs.find(r => r.id === 501)?.conclusion).toBe('neutral');
    expect(gh.runs.find(r => r.id === 500)?.conclusion).toBe('success');
    expect(gh.runs).toHaveLength(102);
    expect(gh.log.filter(l => l.path.includes('/check-runs?')).map(l => /[&?]page=(\d+)/.exec(l.path)?.[1])).toEqual(['1', '2']);
  });

  it('more than 10 full pages of check runs in a suite fails with CONTAINED_VERIFY_CHECK_LIMIT and writes nothing', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 1001; i++) seedRun(gh, 1000 + i, `other:${i}`);
    expect(await errorOf(kit(gh).publishVerifyCheck(mission(), facts()))).toContain('CONTAINED_VERIFY_CHECK_LIMIT');
    expect(gh.log.filter(l => l.method !== 'GET')).toEqual([]);
    expect(gh.log.filter(l => l.path.includes('/check-runs?'))).toHaveLength(10);
  });

  it('finds an existing check in a non-first suite and does not create another', async () => {
    const gh = fakeGitHub();
    seedRun(gh, 900, 'other:x', 4000);
    seedRun(gh, 700, `${MID}:${HEAD}`, 6000);
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 700, created: false });
    expect(gh.log.filter(l => l.method === 'POST')).toHaveLength(0);
    expect(gh.runs).toHaveLength(2);
  });

  it('pages through check suites (matching suite on page 2)', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 100; i++) gh.ensureSuite(8000 + i);
    seedRun(gh, 600, `${MID}:${HEAD}`, 9000);
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 600, created: false });
    expect(gh.log.filter(l => l.path.includes('/check-suites?')).map(l => /[&?]page=(\d+)/.exec(l.path)?.[1])).toEqual(['1', '2']);
  });

  it('more than 10 full pages of check suites fails with CONTAINED_VERIFY_CHECK_LIMIT and writes nothing', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 1001; i++) gh.ensureSuite(8000 + i);
    expect(await errorOf(kit(gh).publishVerifyCheck(mission(), facts()))).toContain('CONTAINED_VERIFY_CHECK_LIMIT');
    expect(gh.log.filter(l => l.method !== 'GET')).toEqual([]);
    expect(gh.log.filter(l => l.path.includes('/check-suites?'))).toHaveLength(10);
  });

  it('ignores a suite owned by another App even if it holds a matching run', async () => {
    const gh = fakeGitHub();
    gh.ensureSuite(7000, 999); seedRun(gh, 7, `${MID}:${HEAD}`, 7000);
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 100, created: true });
    expect(gh.runs.find(r => r.id === 7)?.output.title).toBe('t');
    expect(gh.log.some(l => l.path.includes('/check-suites/7000/'))).toBe(false);
  });

  it('a retry after create finds the check on a later suite page and does not create a duplicate', async () => {
    const gh = fakeGitHub(); const k = kit(gh);
    for (let i = 0; i < 100; i++) gh.ensureSuite(1 + i);
    expect((await k.publishVerifyCheck(mission(), facts())).created).toBe(true);
    expect((await k.publishVerifyCheck(mission(), facts())).created).toBe(false);
    expect(gh.log.filter(l => l.method === 'POST')).toHaveLength(1);
    expect(gh.runs).toHaveLength(1);
  });

  it('ignores suites of another App or head, or with a non-integer id, even when the API returns them', async () => {
    const gh = fakeGitHub({ returnForeignSuites: true });
    gh.ensureSuite(7000, 999); seedRun(gh, 7, `${MID}:${HEAD}`, 7000);
    gh.ensureSuite(7100, 12, 'c'.repeat(40)); seedRun(gh, 8, `${MID}:${HEAD}`, 7100);
    gh.suites.push({ id: 'x' as unknown as number, head_sha: HEAD, app: { id: 12 } });
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 100, created: true });
    expect(gh.log.filter(l => /\/check-suites\/(7000|7100|x)\//.test(l.path))).toEqual([]);
    expect(gh.runs.find(r => r.id === 7)?.output.title).toBe('t');
    expect(gh.runs.find(r => r.id === 8)?.output.title).toBe('t');
  });

  it('keeps the smallest id across suites and neutralises every other match without creating', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < 100; i++) gh.ensureSuite(1000 + i);
    seedRun(gh, 900, `${MID}:${HEAD}`, 1000); seedRun(gh, 800, `${MID}:${HEAD}`, 1050); seedRun(gh, 300, `${MID}:${HEAD}`, 6000);
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 300, created: false });
    expect(gh.log.filter(l => l.method === 'POST')).toHaveLength(0);
    expect(gh.runs.filter(r => r.conclusion === 'neutral').map(r => r.id).sort()).toEqual([800, 900]);
    expect(gh.runs.find(r => r.id === 300)?.conclusion).toBe('success');
  });

  it('bounds the total run-page requests across suites with CONTAINED_VERIFY_CHECK_LIMIT and writes nothing', async () => {
    const gh = fakeGitHub();
    for (let s = 0; s < 501; s++) for (let r = 0; r < 101; r++) seedRun(gh, 100_000 + s * 1000 + r, `other:${s}:${r}`, 2000 + s);
    expect(await errorOf(kit(gh).publishVerifyCheck(mission(), facts()))).toContain('CONTAINED_VERIFY_CHECK_LIMIT');
    expect(gh.log.filter(l => l.method !== 'GET')).toEqual([]);
    expect(gh.log.filter(l => l.path.includes('/check-runs?'))).toHaveLength(1000);
  }, 60_000);

  it('a full 1,000th page of check suites cannot prove completeness (998 plus the created suite is fine)', async () => {
    const ok = fakeGitHub();
    for (let i = 0; i < 998; i++) ok.ensureSuite(8000 + i);
    expect((await kit(ok).publishVerifyCheck(mission(), facts())).created).toBe(true);
    const full = fakeGitHub();
    for (let i = 0; i < 1000; i++) full.ensureSuite(8000 + i);
    expect(await errorOf(kit(full).publishVerifyCheck(mission(), facts()))).toContain('CONTAINED_VERIFY_CHECK_LIMIT');
  });

  it('ignores a same-named check from another App', async () => {
    const gh = fakeGitHub();
    gh.ensureSuite(5000); gh.runs.push({ suite: 5000, id: 7, name: 'osstack/verify', head_sha: HEAD, external_id: `${MID}:${HEAD}`, app: { id: 999 }, status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } });
    const result = await kit(gh).publishVerifyCheck(mission(), facts());
    expect(result).toEqual({ check_run_id: 100, created: true });
    expect(gh.runs.find(r => r.id === 7)?.output.title).toBe('t');
  });

  it('ignores a check with another external id or head', async () => {
    const gh = fakeGitHub();
    gh.ensureSuite(5000); gh.runs.push({ suite: 5000, id: 7, name: 'osstack/verify', head_sha: HEAD, external_id: 'cm_other:' + HEAD, app: { id: 12 }, status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } });
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
    const exec: BridgeExec = Object.assign(async (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => { executed.push({ command, args, env: options.env }); return execOut(command); }, { gated: true as const });
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

it('rechecks authority after App B token refresh and before every check mutation', async () => {
  const gh = fakeGitHub();
  let allow = true;
  let fences = 0;
  const k = createBridgeKit({ config, fetchImpl: gh.fetchImpl, now: () => NOW,
    beforeCheckMutation: () => { fences++; if (!allow) throw Error('BRIDGE_DISABLED'); } });
  await k.publishVerifyCheck(mission(), facts());
  allow = false;
  const before = gh.log.filter(row => row.method !== 'GET').length;
  await expect(k.publishVerifyCheck(mission(), facts())).rejects.toThrow('BRIDGE_DISABLED');
  expect(gh.log.filter(row => row.method !== 'GET')).toHaveLength(before);
  expect(fences).toBe(2);
});
