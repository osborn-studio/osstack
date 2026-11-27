import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainedMissionStore, MergerShadowStore, RevisionChainStore } from '@osstack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every file the process reads through fs/promises is recorded; the tests assert on the slice around the merger's own work.
const fsReads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readFile: ((path: unknown, ...rest: unknown[]) => { fsReads.push(String(path)); return (actual.readFile as (...a: unknown[]) => unknown)(path, ...rest); }) as typeof actual.readFile,
    open: ((path: unknown, ...rest: unknown[]) => { fsReads.push(String(path)); return (actual.open as (...a: unknown[]) => unknown)(path, ...rest); }) as typeof actual.open,
  };
});

import * as appE from './contained-mission-sandbox-app-e-github.js';
import { APP_E_SANDBOX } from './contained-mission-sandbox-app-e.js';
import * as bridgeModule from './contained-mission-bridge.js';
import * as githubApp from './contained-mission-github-app.js';
import { handleContainedMissionCommand } from './contained-mission-command.js';
import { ContainedMissionHost } from './contained-mission-host.js';
import { loadMergerConfig } from './contained-mission-merger-config.js';
import { assertRestPathAllowed } from './contained-mission-merger-reader.js';
import { ContainedMissionRunner } from './contained-mission-runner.js';
import { type ContainedMissionService, createContainedMissionService, parseMergerMode } from './contained-mission-rpc.js';
import type { MergerShadowHandle } from './contained-mission-merger-shadow.js';
import { EngineeringAccess } from './engineering-access.js';
import { BOT, IDS, review } from './contained-mission-merger.testkit.js';
import { APP, MIN, OWNER, REPO, HEAD, config, createRigged, ledgerDump, type Rigged } from './contained-mission-merger-shadow.testkit.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).forEach((fn) => { fn(); }); });

const credential = 'c'.repeat(48);
const OUTSIDER = 'd'.repeat(48);
const MERGER_JSON = {
  version: 1, repository: REPO, publisher: { actor_id: BOT.publisher, app_id: APP.publisher }, evidence_app_id: APP.evidence, merger: { actor_id: BOT.merger, app_id: APP.merger },
  base_ref: 'main', inspection_evidence: false, counted_approvers: [{ actor_id: OWNER, app_id: null }],
  required_checks: [{ context: 'check', app_id: APP.actions }, { context: 'build', app_id: APP.actions }],
  main_quality_ruleset_id: IDS.quality, main_update_ruleset_id: IDS.update, mission_ruleset_ids: [IDS.writers, IDS.history],
};

function setup(repository = REPO) {
  const g: Rigged = createRigged(config({ repository }));
  cleanup.push(() => { g.close(); });
  const rig = g.rig;
  const authDir = join(rig.root, 'auth');
  mkdirSync(authDir, { mode: 0o700 });
  const authFile = join(authDir, 'authority.json');
  writeFileSync(authFile, JSON.stringify({ version: 1, principals: [{
    credential_sha256: createHash('sha256').update(credential).digest('hex'), principal_id: 'human', client_session_id: 'cli',
    read_scopes: [rig.scope.scope_id], write_scopes: [rig.scope.scope_id], stop_scopes: [], operator_scopes: [],
  }, {
    credential_sha256: createHash('sha256').update(OUTSIDER).digest('hex'), principal_id: 'outsider', client_session_id: 'cli2',
    read_scopes: ['a'.repeat(64)], write_scopes: [], stop_scopes: [], operator_scopes: [],
  }] }), { mode: 0o600 });
  const home = join(rig.root, 'home');
  mkdirSync(join(home, 'bridge'), { recursive: true });
  const env = {
    OSSTACK_CONTAINED_CODEX_BIN: '/bin/true', OSSTACK_CONTAINED_CODEX_HOME: rig.root, OSSTACK_CONTAINED_DOCKER_SOCKET: join(rig.root, 'd.sock'),
    OSSTACK_CONTAINED_DOCKER_DAEMON_ID: 'd', OSSTACK_CONTAINED_BASE_IMAGE_ID: `sha256:${'0'.repeat(64)}`,
  };
  const logs: string[] = [];
  const restCalls: string[] = [];
  const create = (merger: string | undefined, extra: Partial<Parameters<typeof createContainedMissionService>[0]> = {}) =>
    createContainedMissionService({
      attention: rig.attention, owner: rig.owner, access: new EngineeringAccess(authFile), home, draining: () => false,
      env: merger === undefined ? env : { ...env, OSSTACK_MERGER: merger }, log: (line) => { logs.push(line); },
      merger: { graphql: g.graphql, rest: async (path) => { restCalls.push(path); return g.rest(path); }, now: () => g.clock.now }, ...extra,
    });
  const mergerJson = (value: unknown = MERGER_JSON) => { writeFileSync(join(home, 'bridge', 'merger.json'), typeof value === 'string' ? value : JSON.stringify(value)); };
  const mergerOf = (service: ContainedMissionService) => (service as unknown as { options: { merger?: MergerShadowHandle } }).options.merger;
  return { g, rig, home, env, logs, restCalls, create, mergerJson, mergerOf };
}

describe('OSSTACK_MERGER switch', () => {
  it('parses the mode strictly', () => {
    expect(parseMergerMode(undefined)).toBe('off');
    expect(parseMergerMode('0')).toBe('off');
    expect(parseMergerMode('shadow')).toBe('shadow');
    expect(parseMergerMode('1')).toBe('live');
    expect(() => parseMergerMode('live')).toThrow('MERGER_MODE_INVALID');
    for (const bad of ['', 'true', 'SHADOW', 'shadow ', '2', 'on']) expect(() => parseMergerMode(bad)).toThrow('MERGER_MODE_INVALID');
  });

  it('is off when unset or 0, even when merger.json exists', async () => {
    const f = setup();
    f.mergerJson();
    for (const value of [undefined, '0']) {
      const service = await f.create(value);
      expect(f.mergerOf(service)).toBeUndefined();
      await service.close();
    }
    expect(f.logs).toEqual([]);
  });

  it('starts for shadow with a valid merger.json, independent of OSSTACK_BRIDGE, and stops on close', async () => {
    const f = setup();
    f.mergerJson();
    const service = await f.create('shadow');
    const merger = f.mergerOf(service)!;
    expect(merger).toBeDefined();
    await service.start();
    await service.close();
    await merger.scan();
    expect(f.restCalls).toEqual([]);
    expect(f.g.calls.gql).toEqual([]);
  });

  it('is off with a log line when merger.json is missing', async () => {
    const f = setup();
    const service = await f.create('shadow');
    expect(f.mergerOf(service)).toBeUndefined();
    expect(f.logs).toEqual(['osstack: merger shadow: off (no bridge/merger.json)']);
    await service.close();
  });

  it('fails the service start on an invalid merger.json', async () => {
    const f = setup();
    f.mergerJson('{nope');
    await expect(f.create('shadow')).rejects.toThrow('MERGER_CONFIG_INVALID:merger.json:json');
    f.mergerJson({ ...MERGER_JSON, private_key_path: '/x' });
    await expect(f.create('shadow')).rejects.toThrow('MERGER_CONFIG_INVALID:merger.json:credential_field');
  });

  it('checks live repository and settings before opening a key or constructing ports', async () => {
    const f = setup();
    const live = { merger_key_path: join(f.home, 'absent-key'), merger_installation_id: 123 };
    f.mergerJson({ ...MERGER_JSON, live });
    await expect(f.create('1')).rejects.toThrow('MERGER_LIVE_SANDBOX_ONLY:repository');
    const sandbox = { ...MERGER_JSON, repository: 'Osborn-Studio/OSStack-Bridge-Sandbox' };
    f.mergerJson(sandbox);
    await expect(f.create('1')).rejects.toThrow('MERGER_CONFIG_INVALID:merger.json:live');
    f.mergerJson({ ...sandbox, live });
    const service = await f.create('1');
    expect(f.mergerOf(service)).toBeDefined();
    await service.close();
    expect(fsReads).not.toContain(live.merger_key_path);
  });

  it('a producers.json that disagrees with merger.json stops the start', async () => {
    const f = setup();
    f.mergerJson();
    const producers = (publisher: Array<{ actor_id: number; app_id: number }>, repository = REPO) => {
      writeFileSync(join(f.home, 'bridge', 'producers.json'), JSON.stringify({ version: 1, repository, publisher, reviewers: [{ actor_id: 502, app_id: 12 }] }));
    };
    producers([{ actor_id: 7, app_id: 11 }]);
    // The bridge switch is off: the two files are still checked against each other once both exist.
    await expect(f.create('shadow')).rejects.toThrow('MERGER_CONFIG_INVALID:merger.json:producers_mismatch');
    producers([{ actor_id: BOT.publisher, app_id: 11 }]);
    await (await f.create('shadow')).close();
    producers([{ actor_id: 7, app_id: 11 }]);
    await expect(createContainedMissionService({
      attention: f.rig.attention, owner: f.rig.owner, access: new EngineeringAccess(join(f.rig.root, 'auth', 'authority.json')), home: f.home, draining: () => false,
      env: { OSSTACK_CONTAINED_CODEX_BIN: '/bin/true', OSSTACK_CONTAINED_CODEX_HOME: f.rig.root, OSSTACK_CONTAINED_DOCKER_SOCKET: join(f.rig.root, 'd.sock'),
        OSSTACK_CONTAINED_DOCKER_DAEMON_ID: 'd', OSSTACK_CONTAINED_BASE_IMAGE_ID: `sha256:${'0'.repeat(64)}`, OSSTACK_BRIDGE: 'shadow', OSSTACK_MERGER: 'shadow' },
      log: () => undefined,
    })).rejects.toThrow('MERGER_CONFIG_INVALID:merger.json:producers_mismatch');
  });
});

const STORE_WRITES = ['authorize', 'transition', 'record', 'recordStopEvidence', 'releaseClaim'] as const;
const CHAIN_WRITES = ['createShadowChain', 'createLiveChain', 'applyDecision', 'reserve', 'dispatch', 'voidReservation', 'clearCurrentMission', 'recordIntent', 'settleIntent', 'replaceGrant', 'stopLive', 'closeLive', 'appendEvent'] as const;
const RUNNER_CALLS = ['step', 'decide', 'cancel', 'retryVerifyCheck'] as const;
const HOST_CALLS = ['start', 'tick', 'decide', 'cancel', 'publishCheck', 'recover'] as const;
const SHADOW_WRITES = ['beginObservation', 'recordDecision', 'recordOutcome', 'recordCycle', 'beginScan'] as const;

describe('merger run at the real service wiring', () => {
  it.each(['local', 'invalid webhook'] as const)('runs a live merge observation with %s attention configuration', async mode => {
    const repository = APP_E_SANDBOX.repository;
    const f = setup(repository);
    f.mergerJson({ ...MERGER_JSON, repository, live: { merger_key_path: join(f.home, 'missing-key'), merger_installation_id: 123 } });
    vi.stubEnv('OSSTACK_ATTENTION_NOTIFY', mode === 'local' ? 'local' : 'webhook');
    vi.stubEnv('OSSTACK_ATTENTION_WEBHOOK_URL', 'SECRET-invalid-url');
    try {
      const service = await f.create('1');
      f.g.setState('MERGED');
      f.g.outcome.mergedAt = new Date(f.g.clock.now).toISOString();
      f.g.outcome.mergeCommit = HEAD;
      f.g.outcome.mergedBy = { __typename: 'User', databaseId: OWNER };
      try {
        await f.mergerOf(service)!.scan();
      } finally { await service.close(); }
      expect(f.g.store.outcomes(repository, 7)).toHaveLength(1);
      const alerts = f.rig.db.prepare('SELECT status FROM engineering_merger_alerts').pluck().all();
      if (mode === 'local') {
        expect(alerts).toEqual(['sent']);
        expect(readdirSync(join(f.home, 'attention-notifications'))).toHaveLength(1);
      } else {
        expect(alerts).toEqual([]);
        expect(f.logs.filter(line => line.includes('configuration failed'))).toEqual([
          'osstack: merger alert configuration failed code=attention_webhook_url_invalid',
        ]);
        expect(f.logs.join(' ')).not.toContain('SECRET');
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['merged', 'low-risk bot', 'unknown', 'disabled', 'draining', 'changed'] as const)('persists the live outcome for %s', async scenario => {
    const repository = APP_E_SANDBOX.repository;
    const f = setup(repository);
    const live = { merger_key_path: join(f.home, 'missing-key'), merger_installation_id: 123 };
    const bot = 12345;
    f.mergerJson({ ...MERGER_JSON, repository, live, bot_approvers: [{ actor_id: bot, app_id: null }] });
    if (scenario === 'low-risk bot') {
      f.g.world.pr = { additions: 100, deletions: 100 };
      f.g.world.reviews = [review(1, { author: { __typename: 'User', databaseId: bot } })];
    } else {
      f.g.world.pr = { additions: 1000, deletions: 500 };
    }
    const by = { actor_id: APP.publisher, actor_type: 'Integration', bypass_mode: 'always' };
    for (const id of [IDS.quality, IDS.update]) Object.assign(f.g.world.rulesets[id] as object, { enforcement: 'disabled', bypass_actors: [by] });
    f.g.world.baseRules = [];
    f.g.world.pr['reviewDecision'] = null;
    const sha = '9'.repeat(40);
    const put = vi.fn();
    vi.spyOn(appE, 'createSandboxAppEWriteAdapter').mockReturnValue({
      merge: async (request, beforeWrite) => {
        if (scenario === 'changed') f.g.world.threads = [{ isResolved: false, isOutdated: false }];
        await beforeWrite();
        put(request);
        return { merged: true, sha };
      },
      readback: async binding => ({ binding, merged: true, actorAppId: APP.merger, actorType: 'Bot', actorVerified: true,
        actorUserId: BOT.merger, sha, parents: [scenario === 'unknown' ? HEAD : binding.base] }),
    });
    const env = { ...f.env, OSSTACK_MERGER: '1' };
    const service = await f.create('1', { env, draining: () => scenario === 'draining' });
    if (scenario === 'disabled') env.OSSTACK_MERGER = '0';
    await f.mergerOf(service)!.scan();
    await service.close();
    const events = f.rig.db.prepare("SELECT kind,payload_json FROM engineering_contained_events WHERE kind LIKE 'mission_app_e_merge_%' ORDER BY seq")
      .all() as Array<{ kind: string; payload_json: string }>;
    const disabled = scenario === 'disabled' || scenario === 'draining';
    expect(events.filter(row => row.kind === 'mission_app_e_merge_reserved')).toHaveLength(disabled ? 0 : 1);
    expect(put).toHaveBeenCalledTimes(disabled || scenario === 'changed' ? 0 : 1);
    const result = JSON.parse(events.at(-1)!.payload_json);
    expect(result.outcome).toBe(disabled ? 'refused:disabled' : scenario === 'changed' ? 'refused:gate_failed' : scenario === 'low-risk bot' ? 'merged' : scenario);
    expect(result.gates.g8).toEqual({ enforcement: 'disabled', bypass_actors: [by] });
    expect(JSON.parse(f.g.store.decisions(repository, 7)[0]!.gates_json).g6e).toEqual(result.gates.g8);
    if (scenario === 'merged') {
      expect(result.sha).toBe(sha);
      expect(put).toHaveBeenCalledWith(expect.objectContaining({ sha: HEAD, merge_method: 'squash' }));
      const restarted = await f.create('1');
      await f.mergerOf(restarted)!.scan();
      await restarted.close();
      const last = f.rig.db.prepare("SELECT payload_json FROM engineering_contained_events WHERE kind='mission_app_e_merge_result' ORDER BY seq DESC LIMIT 1").get() as { payload_json: string };
      expect(JSON.parse(last.payload_json).outcome).toBe('refused:already_reserved');
      expect(put).toHaveBeenCalledTimes(1);
    }
  });

  it('recovers an interrupted reservation once, without another PUT', async () => {
    const repository = APP_E_SANDBOX.repository;
    const f = setup(repository);
    const binding = { repositoryId: APP_E_SANDBOX.repositoryId, pr: 7, head: HEAD, base: 'b'.repeat(40) };
    const seq = f.g.store.reserveLiveMerge(f.g.mission.missionId, binding, f.g.clock.now);
    expect(seq).not.toBeNull();
    f.mergerJson({ ...MERGER_JSON, repository, live: { merger_key_path: join(f.home, 'missing-key'), merger_installation_id: 123 } });
    for (let restart = 0; restart < 2; restart++) await (await f.create('1')).close();
    const rows = f.rig.db.prepare("SELECT payload_json FROM engineering_contained_events WHERE kind='mission_app_e_merge_result'").all() as { payload_json: string }[];
    expect(rows.map(row => JSON.parse(row.payload_json))).toEqual([{ binding, reservation: seq, outcome: 'unknown' }]);
    expect(f.g.store.reserveLiveMerge(f.g.mission.missionId, binding, f.g.clock.now)).toBeNull();
  });

  it('reads and records only: no token source, no Mission or chain write, no runner, no mutation, only GET paths, no App key path opened', async () => {
    const f = setup();
    f.mergerJson();
    const tokenSource = vi.spyOn(githubApp, 'createInstallationTokenSource');
    const bridgeKit = vi.spyOn(bridgeModule, 'createBridgeKit');
    const loadConfig = vi.spyOn(githubApp, 'loadBridgeConfig');
    const writes = STORE_WRITES.map((n) => vi.spyOn(ContainedMissionStore.prototype, n).mockImplementation(() => { throw new Error(`forbidden_${n}`); }));
    const chain = CHAIN_WRITES.map((n) => vi.spyOn(RevisionChainStore.prototype, n).mockImplementation(() => { throw new Error(`forbidden_${n}`); }));
    const runner = RUNNER_CALLS.map((n) => vi.spyOn(ContainedMissionRunner.prototype, n).mockImplementation(() => { throw new Error(`forbidden_${n}`); }));
    const host = HOST_CALLS.map((n) => vi.spyOn(ContainedMissionHost.prototype, n).mockImplementation(() => { throw new Error(`forbidden_${n}`); }));
    const shadow = SHADOW_WRITES.map((n) => vi.spyOn(MergerShadowStore.prototype, n));

    const before = ledgerDump(f.rig);
    const mark = fsReads.length;
    const service = await f.create('shadow');
    const merger = f.mergerOf(service)!;

    // The merger holds exactly the documented dependencies, and the Mission view has no write method.
    const options = (merger as unknown as { options: Record<string, unknown> }).options;
    expect(Object.keys(options).sort()).toEqual(['config', 'graphql', 'ledger', 'log', 'missions', 'now', 'rest', 'writer']);
    expect(Object.keys(options['writer'] as object).sort()).toEqual(['beginObservation', 'beginScan', 'recordCycle', 'recordDecision', 'recordOutcome']);
    expect(Object.keys(options['missions'] as object).sort()).toEqual(['deliveryEvidence', 'listPrOpened', 'publication']);
    expect(Object.keys(options['ledger'] as object).sort()).toEqual(['lastPollAt', 'latestOutcome']);

    await merger.scan();
    f.g.clock.now += 6 * MIN;
    f.g.world.reviews = [];
    await merger.scan();
    await merger.scan();

    // The run did happen.
    expect(f.g.store.decisions(REPO, 7).map((d) => d.verdict)).toEqual(['would_merge', 'refused']);
    expect(shadow.every((s) => s.mock.calls.length > 0)).toBe(false); // outcome writer is unused here
    for (const s of shadow.slice(0, 2)) expect(s.mock.calls.length).toBeGreaterThan(0);

    // Nothing else did.
    expect(f.g.calls.gql.some((q) => /mutation|subscription/iu.test(q.query))).toBe(false);
    expect(f.g.calls.rest.length).toBeGreaterThan(0);
    for (const p of f.restCalls) expect(() => assertRestPathAllowed(p, { repository: REPO, rulesetIds: [IDS.quality, IDS.update, IDS.writers, IDS.history] })).not.toThrow();
    expect(tokenSource).toHaveBeenCalledTimes(0);
    expect(bridgeKit).toHaveBeenCalledTimes(0);
    // The one call is the Mission publication path's own; the merger path adds none.
    expect(loadConfig).toHaveBeenCalledTimes(1);
    for (const spy of [...writes, ...chain, ...runner, ...host]) expect(spy).toHaveBeenCalledTimes(0);
    expect(ledgerDump(f.rig)).toBe(before);
    expect(f.logs.filter((l) => /forbidden/u.test(l))).toEqual([]);

    // The merger's own file reads (config at service start, nothing while scanning) never touch App credentials. Mission publication's own read of
    // apps.json in the same startup is not the merger's, so the window starts after the service is built.
    expect(fsReads.slice(mark).some((p) => p.endsWith(join('bridge', 'merger.json')))).toBe(true);
    const afterBuild = fsReads.length;
    await merger.scan();
    expect(fsReads.slice(afterBuild)).toEqual([]);
    const mergerOnly = fsReads.length;
    await loadMergerConfig(f.home);
    expect(fsReads.slice(mergerOnly).every((p) => p.endsWith(join('bridge', 'merger.json')))).toBe(true);
    for (const p of fsReads.slice(afterBuild)) expect(p).not.toMatch(/apps\.json|rulesets\.json|\.pem$/u);
    await service.close();
  });

  it('the report goes through the daemon RPC, needs a read scope, and changes nothing', async () => {
    const f = setup();
    f.mergerJson();
    const service = await f.create('shadow');
    await f.mergerOf(service)!.scan();
    const shadow = SHADOW_WRITES.map((n) => vi.spyOn(MergerShadowStore.prototype, n));
    const before = ledgerDump(f.rig);
    const decisions = f.rig.db.prepare('SELECT COUNT(*) AS n FROM engineering_merger_shadow_decisions').get();
    const rpc = async (method: string, params?: unknown) => ({ ok: true, result: await service.handle(method, params) });
    const lines: string[] = [];
    const code = await handleContainedMissionCommand(['merger', 'report', '--json'], { stdout: (l) => lines.push(l), stderr: () => undefined, rpc, readCredential: () => credential });
    expect(code).toBe(0);
    const report = JSON.parse(lines.join('\n')) as { counts: Record<string, number>; open: Array<{ pr_number: number; latest: { verdict: string } }>; prs: unknown[] };
    expect(report.counts['open']).toBe(1);
    expect(report.open[0]).toMatchObject({ pr_number: 7, latest: { verdict: 'would_merge' } });
    expect(lines.join('\n')).not.toContain(credential);
    for (const s of shadow) expect(s).toHaveBeenCalledTimes(0);
    expect(ledgerDump(f.rig)).toBe(before);
    expect(f.rig.db.prepare('SELECT COUNT(*) AS n FROM engineering_merger_shadow_decisions').get()).toEqual(decisions);
    await expect(service.handle('mission.merger_report', { credential: 'x'.repeat(48) })).rejects.toThrow();
    await expect(service.handle('mission.merger_report', { credential, extra: 1 })).rejects.toThrow('bad_request');
    await service.close();
  });

  it('the report lists only PRs of Missions in the caller read scopes', async () => {
    const f = setup();
    f.mergerJson();
    const service = await f.create('shadow');
    await f.mergerOf(service)!.scan();
    const full = await service.handle('mission.merger_report', { credential }) as { open: unknown[]; totals: { decisions: number } };
    expect(full.open.length).toBe(1);
    expect(full.totals.decisions).toBe(1);
    // A caller whose read scopes do not include the Mission's sees none of it.
    const hidden = await service.handle('mission.merger_report', { credential: OUTSIDER }) as { open: unknown[]; prs: unknown[]; totals: { decisions: number } };
    expect(hidden.open).toEqual([]);
    expect(hidden.prs).toEqual([]);
    expect(hidden.totals).toEqual({ decisions: 0, outcomes: 0 });
    await service.close();
  });

  it('the command parses merger report strictly and keeps its credential local', async () => {
    const out: string[] = []; const err: string[] = []; const calls: Array<{ method: string; params: unknown }> = [];
    const run = (args: string[]) => handleContainedMissionCommand(args, { stdout: (l) => out.push(l), stderr: (l) => err.push(l), readCredential: () => credential,
      rpc: async (method, params) => { calls.push({ method, params }); return { ok: true, result: { ok: 1 } }; } });
    expect(await run(['merger', 'report', '--json'])).toBe(0);
    expect(calls).toEqual([{ method: 'mission.merger_report', params: { credential } }]);
    expect(await run(['merger', 'merge'])).toBe(1);
    expect(await run(['merger'])).toBe(1);
    expect(await run(['merger', 'report', '--force', '1'])).toBe(1);
    expect(err.join('\n')).not.toContain(credential);
  });
});
