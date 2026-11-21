import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RevisionChainStore, signRevisionGrant, type RevisionChain } from '@osstack/core';
import { diagnosisFixture } from '@osstack/core/dist/state/diagnosis-fixtures.js';
import { verificationDedupKey } from '@osstack/core/verification-intake';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalFailureScan, LocalFailureScanService, scanLocalFailureChain, type LocalFailureScanPorts } from './contained-mission-local-failure-scan.js';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.useRealTimers(); });
function fixture() {
  const f = diagnosisFixture();
  cleanups.push(f.close);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const chain = chains.listOpen('live')[0]!;
  let now = f.facts.now;
  // The fixture seeds a source. Give this pass its own repository ID, result ID and ledger sequence.
  const stamp = new Date(now).toISOString();
  const contract = { ...f.v, result_id: '00000000-0000-4000-8000-000000007001', repository_id: 9001,
    started_at: stamp, finished_at: stamp, generated_at: stamp };
  contract.dedup_key = verificationDedupKey(contract);
  const run = { id: 7001, name: 'osstack/verify-intake/' + contract.skill_id, app: { id: contract.producer.app_id },
    head_sha: chain.published_head, check_suite: { id: 6001 }, status: 'completed', conclusion: 'failure',
    external_id: contract.result_id, started_at: stamp, completed_at: stamp, output: { text: JSON.stringify(contract) } };
  const runs = [run];
  const repo = { full_name: chain.repository, id: contract.repository_id };
  const pr = { number: chain.pr_number, state: 'open', head: { sha: chain.published_head, ref: chain.branch, repo },
    base: { sha: chain.published_base, ref: chain.base_ref, repo } };
  const root = 'repos/' + chain.repository;
  const pull = root + '/pulls/' + pr.number;
  const suites = root + '/commits/' + chain.published_head + '/check-suites?per_page=100&page=1';
  const listed = root + '/check-suites/6001/check-runs?filter=all&per_page=100&page=1';
  const detail = root + '/check-runs/';
  const paths: string[] = [];
  const request = async (path: string, opts: { signal: AbortSignal; method?: string }) => {
    paths.push(path);
    if (opts.method !== undefined && opts.method !== 'GET') throw Error('unexpected_method');
    if (path === pull) return { ok: true as const, body: pr };
    if (path === suites) return { ok: true as const, body: { total_count: 1, check_suites: [{ id: 6001, head_sha: run.head_sha }] } };
    if (path === listed) return { ok: true as const, body: { total_count: runs.length, check_runs: runs } };
    const match = runs.find(item => detail + item.id === path);
    if (!match) throw Error('unexpected_path');
    return { ok: true as const, body: match };
  };
  const rest = vi.fn<LocalFailureScanPorts['rest']>(request);
  const proof = vi.fn<ReturnType<NonNullable<LocalFailureScanPorts['installationFor']>>>(
    async () => ({ status: 'installed', installation_id: contract.producer.installation_id }));
  const policy = { ...f.input.policy, producers: f.input.policy.producers.map(p => ({ ...p, repository_id: repo.id })) };
  const ports: LocalFailureScanPorts = { sources: f.source, diagnosis: f.store, policy, rest, installationFor: () => proof,
    keys: () => new Map([[f.facts.grant.key_id, { public_key: f.keys.publicKey, max_validity_ms: Infinity }]]),
    repositories: new Map([[chain.repository, repo.id]]), access: { refresh: () => f.principal }, now: () => now };
  const controller = new AbortController();
  const scan = (c = chain) => scanLocalFailureChain(ports, c, controller.signal);
  const counts = () => f.db.prepare('SELECT (SELECT count(*) FROM engineering_verification_sources) AS sources, (SELECT count(*) FROM engineering_diagnosis_requests) AS diagnoses').get();
  const detailPath = detail + run.id;
  function changeReread(changed: boolean) {
    let details = 0;
    rest.mockImplementation(async (path, opts) => {
      const reply = await request(path, opts);
      if (path === detailPath && ++details === 2) return changed
        ? { ok: true, body: { ...run, output: { text: 'EXTERNAL_MARKER' } } } : { ok: false };
      return reply;
    });
  }
  const log = vi.fn();
  const options = { chains, ports, enabled: () => true, log };
  const factory = { home: f.root, attention: f.attention, owner: f.owner, chains, access: { refresh: () => f.principal },
    enabled: options.enabled, now: ports.now, log, rest };
  return { f, chain, contract, run, runs, pr, detailPath, paths, ports, rest, scan, counts, controller, proof,
    setNow: (n: number) => { now = n; }, request, changeReread, options, factory, sequence: [pull, suites, listed, detailPath, suites, listed, pull] };
}

it('skips each ineligible chain before all reads and writes', async () => {
  const h = fixture();
  const { grant } = h.f.facts;
  const { local_failure: _opt, signature: _sig, preview_sha256: _hash, ...preview } = grant;
  const v1 = signRevisionGrant({ ...preview, version: 1 }, h.f.keys.privateKey);
  const before = h.counts();
  const skip = async (code: string, change: Partial<RevisionChain> = {}) => {
    expect(await h.scan({ ...h.chain, ...change })).toMatchObject({ code });
    expect(h.rest).not.toHaveBeenCalled();
    expect(h.counts()).toEqual(before);
  };
  await skip('chain_not_live', { mode: 'shadow' });
  await skip('chain_not_live', { state: 'closed' });
  await skip('grant_not_local_failure', { grant_json: JSON.stringify(v1) });
  await skip('grant_invalid', { grant_json: JSON.stringify({ ...grant, signature: Buffer.alloc(64).toString('base64') }) });
  for (const edit of [{ repository: 'fixture/other' }, { branch: 'other' }, { base_ref: 'other' }, { pr_number: 9 }, { root_mission_id: 'other' }])
    await skip('grant_invalid', edit);
  h.setNow(grant.expires_at); await skip('grant_invalid');
  h.setNow(grant.issued_at - 1); await skip('grant_invalid');
  h.setNow(grant.issued_at);
  h.ports.repositories = new Map(); await skip('repository_unlisted');
  h.ports.access.refresh = () => ({ ...h.f.principal, write_scopes: [] }); await skip('grant_invalid');
  h.ports.access.refresh = () => { throw Error('fixture'); }; await skip('grant_invalid');
  h.ports.access.refresh = () => h.f.principal;
  h.ports.keys = () => new Map(); await skip('grant_invalid');
});

it.each(['failure', 'abort', 'head'])('discards the whole read on %s', async kind => {
  const h = fixture(), before = h.counts();
  if (kind === 'head') h.pr.head.sha = 'f'.repeat(40);
  else h.rest.mockImplementation(async (path, opts) => {
    const response = await h.request(path, opts);
    if (h.paths.length === 5) {
      if (kind === 'abort') h.controller.abort();
      else throw Error('EXTERNAL_MARKER');
    }
    return response;
  });
  expect(await h.scan()).toMatchObject({ code: kind === 'head' ? 'target_changed' : 'waiting_source' });
  expect(h.counts()).toEqual(before);
});
it('records a passing check without registration', async () => {
  const h = fixture();
  h.run.conclusion = 'success';
  h.run.output.text = JSON.stringify({ ...h.contract, outcome: 'passed', failure_code: null, checks: [] });
  expect(await h.scan()).toEqual({ code: 'read', pending: 0, recorded: 1, registered: 0, register_failed: 0 });
  expect(h.f.source.registration(h.contract.result_id)?.registered.outcome).toBe('passed');
  expect(h.paths).toEqual(h.sequence);
});
it('registers one bound request and skips its re-read on the next pass', async () => {
  const h = fixture();
  expect(await h.scan()).toEqual({ code: 'read', pending: 0, recorded: 1, registered: 1, register_failed: 0 });
  expect(h.paths).toEqual([...h.sequence, h.detailPath]);
  const source = h.f.source.registration(h.contract.result_id)!.registered;
  expect(h.f.store.byResult(h.contract.result_id)).toMatchObject({ state: 'registered', chain_id: h.chain.chain_id,
    root_mission_id: h.chain.root_mission_id, source_seq: source.seq });
  const before = h.counts(); h.paths.length = 0;
  expect(await h.scan()).toMatchObject({ registered: 0, register_failed: 0 });
  expect(h.counts()).toEqual(before); expect(h.paths).toEqual(h.sequence);
});
it.each(['retry', 'expired', 'changed digest', 'different object'])('checks a recorded failure again on %s', async kind => {
  const h = fixture(); h.changeReread(false);
  expect(await h.scan()).toMatchObject({ registered: 0, register_failed: 1 });
  expect(h.f.source.registration(h.contract.result_id)?.registered.decision).toBe('accepted');
  expect(h.f.store.byResult(h.contract.result_id)).toBeUndefined();
  h.paths.length = 0;
  if (kind === 'expired') h.setNow(h.f.facts.now + 1001);
  if (kind === 'changed digest') h.run.output.text += ' ';
  if (kind === 'different object') h.run.id++;
  const record = vi.spyOn(h.f.source, 'record');
  expect(await h.scan()).toMatchObject({ registered: kind === 'retry' ? 1 : 0, register_failed: 0 });
  if (kind === 'expired') expect(record.mock.calls[0]?.[0][0]?.verdict).toEqual({ ok: false, code: 'verify_result_expired' });
  expect(h.paths.filter(p => p.includes('/check-runs/'))).toHaveLength(kind === 'retry' ? 2 : 1);
  expect(!!h.f.store.byResult(h.contract.result_id)).toBe(kind === 'retry');
});
it('continues registration after one detail GET fails', async () => {
  const h = fixture(); h.changeReread(false);
  const second = { ...h.contract, result_id: '00000000-0000-4000-8000-000000007002',
    skill_id: 'second', skill_manifest_digest: '8'.repeat(64) };
  second.dedup_key = verificationDedupKey(second);
  h.ports.policy.producers.push({ ...h.ports.policy.producers[0]!, skill_id: second.skill_id,
    skill_manifest_digest: second.skill_manifest_digest });
  h.runs.push({ ...h.run, id: 7002, name: 'osstack/verify-intake/second', external_id: second.result_id,
    output: { text: JSON.stringify(second) } });
  expect(await h.scan()).toMatchObject({ registered: 1, register_failed: 1 });
  expect(h.f.store.byResult(h.contract.result_id)).toBeUndefined();
  expect(h.f.store.byResult(second.result_id)?.state).toBe('registered');
});
it('keeps changed contract text out of the diagnosis and logs', async () => {
  const h = fixture(); h.changeReread(true);
  await new LocalFailureScanService(h.options).runOnce();
  expect(h.f.store.byResult(h.contract.result_id)).toBeUndefined();
  expect(h.options.log.mock.calls).toEqual([['osstack: local-failure scan: chains=1 pending=0 recorded=1 registered=0 register_failed=1']]);
});
it.each(['unknown App', 'not_installed', 'unavailable'] as const)('handles producer proof %s', async kind => {
  const h = fixture(), before = h.counts();
  if (kind === 'unknown App') h.run.app.id++;
  else h.proof.mockResolvedValue({ status: kind });
  const result = await h.scan();
  if (kind === 'unavailable') { expect(result.code).toBe('waiting_source'); expect(h.counts()).toEqual(before); }
  else {
    expect(result).toMatchObject({ registered: 0 });
    expect(h.f.source.history(9001, h.chain.pr_number)).toMatchObject([{ decision: 'rejected', reason_code: 'verify_producer_untrusted' }]);
  }
});
it('registers the withdrawn failure as closed', async () => {
  const h = fixture();
  const withdrawal = { ...h.contract, result_id: '00000000-0000-4000-8000-000000007002', attempt: 2, outcome: 'cancelled',
    failure_code: null, checks: [], withdraws_result_id: h.contract.result_id, withdraw_reason_code: 'source_invalid' };
  h.runs.push({ ...h.run, id: 7002, external_id: withdrawal.result_id, conclusion: 'cancelled', output: { text: JSON.stringify(withdrawal) } });
  expect(await h.scan()).toMatchObject({ registered: 1 });
  expect(h.f.store.byResult(h.contract.result_id)).toMatchObject({ state: 'diagnostic_closed', reason: 'verify_withdrawn' });
});
it('runs one timer, waits for a slow pass, and stops during the read', async () => {
  const h = fixture(), before = h.counts(); vi.useFakeTimers();
  let enabled = false;
  let release!: () => void;
  h.rest.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: false }; });
  const service = new LocalFailureScanService({ ...h.options, enabled: () => enabled, initialDelayMs: 5, intervalMs: 20 });
  service.start(); service.start(); expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(5); expect(h.rest).not.toHaveBeenCalled();
  enabled = true; await vi.advanceTimersByTimeAsync(20); expect(h.rest).toHaveBeenCalledTimes(1);
  const concurrent = service.runOnce(); await vi.advanceTimersByTimeAsync(100); expect(h.rest).toHaveBeenCalledTimes(1);
  await service.stop(); await concurrent;
  expect(h.rest.mock.calls[0]![1].signal.aborted).toBe(true);
  release(); await service.stop(); await service.runOnce(); await vi.advanceTimersByTimeAsync(100);
  expect(h.counts()).toEqual(before); expect(h.rest).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
it('continues past a chain error and wraps the list cursor', async () => {
  const h = fixture();
  const broken = { ...h.chain, chain_id: 'fixture-broken', get mode(): RevisionChain['mode'] { throw Error('EXTERNAL_MARKER'); } };
  const listOpen = vi.fn(h.options.chains.listOpen.bind(h.options.chains)).mockReturnValueOnce([broken, h.chain]);
  const service = new LocalFailureScanService({ ...h.options, chains: { listOpen }, batchLimit: 2 });
  await service.runOnce();
  expect(h.options.log).toHaveBeenCalledWith('osstack: local-failure scan: chain fixture-broken: scan_failed');
  expect(h.f.store.byResult(h.contract.result_id)?.state).toBe('registered');
  await service.runOnce(); await service.runOnce();
  expect(listOpen.mock.calls.map(c => c[2])).toEqual([undefined, { chain_id: h.chain.chain_id, created_at: h.chain.created_at }, undefined]);
});
it('validates schedule numbers and allows stop before start', async () => {
  const h = fixture();
  for (const edit of [{ intervalMs: 0 }, { initialDelayMs: -1 }, { batchLimit: NaN }, { batchLimit: Infinity }])
    expect(() => new LocalFailureScanService({ ...h.options, ...edit })).toThrow('invalid_local_failure_scan_schedule');
  const service = new LocalFailureScanService(h.options);
  await service.stop(); await service.stop(); service.start(); await service.runOnce();
  expect(h.rest).not.toHaveBeenCalled();
});
it('requires an issuer and a valid config, and leaves unlisted repositories unread', async () => {
  const h = fixture();
  await expect(createLocalFailureScan(h.factory)).rejects.toThrow('LOCAL_FAILURE_ROUTE_ISSUER_REQUIRED');
  const bridge = join(h.f.root, 'bridge');
  await mkdir(bridge, { mode: 0o700 });
  const write = (name: string, value: unknown) => writeFile(join(bridge, name), JSON.stringify(value), { mode: 0o600 });
  await write('revision-issuer.json', { version: 1, keys: [{ key_id: h.f.facts.grant.key_id,
    max_validity_ms: h.f.facts.grant.expires_at - h.f.facts.grant.issued_at,
    public_key_spki_b64: h.f.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }] });
  await (await createLocalFailureScan(h.factory)).runOnce();
  const config = { version: 1, policy: h.ports.policy, verification_app: { app_id: h.contract.producer.app_id,
    installation_id: h.contract.producer.installation_id, verification_private_key_path: join(bridge, 'fixture') } };
  await write('verification-producers.json', config);
  await (await createLocalFailureScan(h.factory)).runOnce();
  expect(h.rest).not.toHaveBeenCalled();
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await writeFile(config.verification_app.verification_private_key_path, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await write('verification-producers.json', { ...config, repositories: [{ repository: h.chain.repository, repository_id: h.contract.repository_id }] });
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ id: h.contract.producer.installation_id,
    app_id: h.contract.producer.app_id, suspended_at: null, repository_selection: 'selected', permissions: { checks: 'write', metadata: 'read' } }));
  await (await createLocalFailureScan({ ...h.factory, fetchImpl })).runOnce();
  expect(fetchImpl.mock.calls).toMatchObject([[`https://api.github.com/repos/${h.chain.repository}/installation`, { method: 'GET' }]]);
  expect(h.f.store.byResult(h.contract.result_id)?.state).toBe('registered');
  await write('verification-producers.json', {});
  await expect(createLocalFailureScan(h.factory)).rejects.toThrow('VERIFICATION_PRODUCER_CONFIG_INVALID');
});
