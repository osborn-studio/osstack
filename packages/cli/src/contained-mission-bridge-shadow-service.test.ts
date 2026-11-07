import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainedMissionStore, type SnapshotReview } from '@osstack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bridgeModule from './contained-mission-bridge.js';
import * as githubApp from './contained-mission-github-app.js';
import { handleContainedMissionCommand } from './contained-mission-command.js';
import { ContainedMissionHost } from './contained-mission-host.js';
import { ContainedMissionRunner } from './contained-mission-runner.js';
import { type ContainedMissionService, createContainedMissionService, parseBridgeMode } from './contained-mission-rpc.js';
import type { ShadowHandle } from './contained-mission-bridge-shadow.js';
import { createRig, oid, scriptedTransport, type ScriptedPr } from './contained-mission-bridge-shadow.testkit.js';
import { EngineeringAccess } from './engineering-access.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.splice(0).forEach((fn) => { fn(); });
});

const credential = 'c'.repeat(48);
const PUBLISHER = { actor_id: 501, app_id: 11 };
const REVIEWER = { actor_id: 502, app_id: 12 };
const PRODUCERS = { version: 1, repository: 'o/r', publisher: [PUBLISHER], reviewers: [REVIEWER] };
const T0 = 1_800_000_000_000;

function setup() {
  const rig = createRig();
  cleanup.push(() => { rig.close(); });
  const authDir = join(rig.root, 'auth');
  mkdirSync(authDir, { mode: 0o700 });
  const authFile = join(authDir, 'authority.json');
  writeFileSync(authFile, JSON.stringify({ version: 1, principals: [{
    credential_sha256: createHash('sha256').update(credential).digest('hex'), principal_id: 'human', client_session_id: 'cli',
    read_scopes: [rig.scope.scope_id], write_scopes: [rig.scope.scope_id], stop_scopes: [], operator_scopes: [],
  }] }), { mode: 0o600 });
  const home = join(rig.root, 'home');
  mkdirSync(join(home, 'bridge'), { recursive: true });
  const env = {
    OSSTACK_CONTAINED_CODEX_BIN: '/bin/true', OSSTACK_CONTAINED_CODEX_HOME: rig.root, OSSTACK_CONTAINED_DOCKER_SOCKET: join(rig.root, 'd.sock'),
    OSSTACK_CONTAINED_DOCKER_DAEMON_ID: 'd', OSSTACK_CONTAINED_BASE_IMAGE_ID: `sha256:${'0'.repeat(64)}`,
  };
  const logs: string[] = [];
  const create = (bridge: string | undefined, extra: Partial<Parameters<typeof createContainedMissionService>[0]> = {}) =>
    createContainedMissionService({
      attention: rig.attention, owner: rig.owner, access: new EngineeringAccess(authFile), home, draining: () => false,
      env: bridge === undefined ? env : { ...env, OSSTACK_BRIDGE: bridge }, log: (line) => { logs.push(line); }, ...extra,
    });
  const producers = (value: unknown = PRODUCERS) => { writeFileSync(join(home, 'bridge', 'producers.json'), typeof value === 'string' ? value : JSON.stringify(value)); };
  const shadowOf = (service: ContainedMissionService) => (service as unknown as { options: { shadow?: ShadowHandle } }).options.shadow;
  return { rig, home, logs, create, producers, shadowOf };
}

const review = (id: number, state: SnapshotReview['state'], head: string, at: number): SnapshotReview => ({
  review_id: id, state, submitted_at: at, review_commit: head, reviewer: REVIEWER, has_feedback: state === 'CHANGES_REQUESTED', feedback_digest: state === 'CHANGES_REQUESTED' ? 'f'.repeat(64) : null,
});
const prWith = (over: Partial<ScriptedPr> = {}): ScriptedPr => ({ state: 'OPEN', head: oid('1'), base_sha: oid('a'), base_ref: 'main', author: PUBLISHER, reviews: [], ...over });

// ---------------------------------------------------------------------------------------------------------------------
// (c) switch matrix

describe('OSSTACK_BRIDGE switch', () => {
  it('parses the mode strictly', () => {
    expect(parseBridgeMode(undefined)).toBe('off');
    expect(parseBridgeMode('0')).toBe('off');
    expect(parseBridgeMode('shadow')).toBe('shadow');
    expect(() => parseBridgeMode('1')).toThrow('BRIDGE_LIVE_NOT_IMPLEMENTED');
    for (const bad of ['', 'true', 'SHADOW', 'shadow ', 'live', '2']) expect(() => parseBridgeMode(bad)).toThrow('BRIDGE_MODE_INVALID');
  });

  it('is off when unset or 0, even when producers.json exists', async () => {
    const f = setup();
    f.producers();
    for (const value of [undefined, '0']) {
      const service = await f.create(value);
      expect(f.shadowOf(service)).toBeUndefined();
      await service.close();
    }
    expect(f.logs).toEqual([]);
  });

  it('starts the reconciler for shadow with a valid producers.json and stops it on close', async () => {
    const f = setup();
    f.producers();
    const transport = scriptedTransport(() => prWith());
    const service = await f.create('shadow', { shadow: { transport: transport.transport } });
    const shadow = f.shadowOf(service)!;
    expect(shadow).toBeDefined();
    await service.start();
    await service.close();
    // Closed: the reconciler no longer scans and no request was ever made by start/close themselves.
    await shadow.scan();
    expect(transport.queries).toEqual([]);
  });

  it('adds no loadBridgeConfig call for shadow beyond the Mission publication path the service always has', async () => {
    const f = setup();
    f.producers();
    const spy = vi.spyOn(githubApp, 'loadBridgeConfig');
    await (await f.create(undefined)).close();
    const off = spy.mock.calls.length;
    expect(off).toBeGreaterThan(0);
    await (await f.create('shadow', { shadow: { transport: scriptedTransport(() => prWith()).transport } })).close();
    expect(spy.mock.calls.length - off).toBe(off);
  });

  it('is off with a log line when producers.json is missing', async () => {
    const f = setup();
    const service = await f.create('shadow');
    expect(f.shadowOf(service)).toBeUndefined();
    expect(f.logs).toEqual(['osstack: bridge shadow: off (no bridge/producers.json)']);
    await service.close();
  });

  it('fails the service start on an invalid producers.json', async () => {
    const f = setup();
    f.producers('{nope');
    await expect(f.create('shadow')).rejects.toThrow('BRIDGE_CONFIG_INVALID:producers.json:json');
    f.producers({ ...PRODUCERS, publisher: [REVIEWER] });
    await expect(f.create('shadow')).rejects.toThrow('BRIDGE_CONFIG_INVALID:producers.json:publisher_is_reviewer');
  });

  it('refuses live (1) and any other value before building anything', async () => {
    const f = setup();
    f.producers();
    await expect(f.create('1')).rejects.toThrow('BRIDGE_LIVE_NOT_IMPLEMENTED');
    for (const bad of ['garbage', '', 'on', 'true']) await expect(f.create(bad)).rejects.toThrow('BRIDGE_MODE_INVALID');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (e) negative integration test at the real service wiring

const STORE_WRITES = ['authorize', 'transition', 'record', 'recordStopEvidence', 'releaseClaim'] as const;
const RUNNER_CALLS = ['step', 'decide', 'cancel', 'retryVerifyCheck'] as const;
const HOST_CALLS = ['start', 'tick', 'decide', 'cancel', 'publishCheck', 'recover'] as const;

describe('shadow run at the real service wiring', () => {
  it('reads and records only: no token source, no Mission write, no runner, no mutation', async () => {
    const f = setup();
    f.producers();
    const mission = f.rig.seedMission({ pr_number: 13, head: oid('1'), base_head: oid('a') });
    const pr = prWith({ reviews: [review(9001, 'CHANGES_REQUESTED', oid('1'), T0 - 60_000)] });
    const transport = scriptedTransport(() => pr);

    // Every way out of the sandbox is counted from here on.
    const tokenSource = vi.spyOn(githubApp, 'createInstallationTokenSource');
    const bridgeKit = vi.spyOn(bridgeModule, 'createBridgeKit');
    const loadConfig = vi.spyOn(githubApp, 'loadBridgeConfig');
    const writes = STORE_WRITES.map((name) => vi.spyOn(ContainedMissionStore.prototype, name).mockImplementation(() => { throw new Error(`forbidden_${name}`); }));
    const runner = RUNNER_CALLS.map((name) => vi.spyOn(ContainedMissionRunner.prototype, name).mockImplementation(() => { throw new Error(`forbidden_${name}`); }));
    const host = HOST_CALLS.map((name) => vi.spyOn(ContainedMissionHost.prototype, name).mockImplementation(() => { throw new Error(`forbidden_${name}`); }));

    const before = f.rig.ledger();
    const service = await f.create('shadow', { shadow: { transport: transport.transport, now: () => T0 } });
    const shadow = f.shadowOf(service)!;

    // The reconciler holds exactly the documented dependencies; the chain writer has no live API.
    const options = (shadow as unknown as { options: Record<string, unknown> }).options;
    expect(Object.keys(options).sort()).toEqual(['chains', 'log', 'missions', 'now', 'registry', 'transport']);
    expect(Object.keys(options['chains'] as object).sort()).toEqual([
      'appendEvent', 'applyShadowDecision', 'createShadowChain', 'get', 'listOpenShadowChains', 'shadowChainForMission', 'shadowChainForPr', 'shadowDecisions',
    ]);
    expect(Object.keys(options['missions'] as object).sort()).toEqual(['listPrOpened', 'publication']);
    for (const live of ['reserve', 'dispatch', 'voidReservation', 'recordIntent', 'settleIntent', 'createLiveChain', 'applyDecision', 'clearCurrentMission']) {
      expect((options['chains'] as Record<string, unknown>)[live]).toBeUndefined();
    }

    await shadow.scan();

    // The run did happen: a shadow chain exists and a would_reserve was recorded.
    const chain = f.rig.chains.chainForMission(mission, 'shadow')!;
    expect(chain).toMatchObject({ mode: 'shadow', state: 'awaiting_review', rounds_used: 0 });
    expect(f.rig.chains.shadowDecisions(chain.chain_id).map((r) => r.action)).toEqual(['would_reserve']);
    expect(f.rig.chains.reservations(chain.chain_id)).toEqual([]);
    expect(f.rig.chains.intents(chain.chain_id)).toEqual([]);
    expect(transport.counts()).toEqual({ reads: 1, second: 1 });

    // Nothing else did.
    expect(transport.queries.length).toBe(2);
    expect(transport.queries.some((q) => /mutation/iu.test(q))).toBe(false);
    expect(tokenSource).toHaveBeenCalledTimes(0);
    expect(bridgeKit).toHaveBeenCalledTimes(0);
    // The one call is the Mission publication path's own; the shadow path adds none.
    expect(loadConfig).toHaveBeenCalledTimes(1);
    for (const spy of [...writes, ...runner, ...host]) expect(spy).toHaveBeenCalledTimes(0);
    expect(f.rig.ledger()).toBe(before);
    await service.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (f) mission status --json

describe('mission status chain field', () => {
  it('is null without a chain and carries the shadow chain once one exists', async () => {
    const f = setup();
    f.producers();
    const withChain = f.rig.seedMission({ pr_number: 13, head: oid('1'), base_head: oid('a') });
    const without = f.rig.seedMission({ pr_number: 14, head: oid('1'), base_head: oid('a'), repository: 'other/repo' });
    const pr = prWith({ reviews: [review(9001, 'CHANGES_REQUESTED', oid('1'), T0 - 60_000)] });
    const clock = { now: T0 };
    const service = await f.create('shadow', { shadow: { transport: scriptedTransport(() => pr).transport, now: () => clock.now } });
    const rpc = async (method: string, params?: unknown) => ({ ok: true, result: await service.handle(method, params) });
    const status = async (id: string) => {
      const lines: string[] = [];
      const code = await handleContainedMissionCommand(['status', '--mission', id, '--json'], { stdout: (l) => lines.push(l), stderr: () => undefined, rpc, readCredential: () => credential });
      expect(code).toBe(0);
      return JSON.parse(lines.join('\n')) as Record<string, unknown>;
    };

    // Before the first cycle neither Mission has a chain; the rest of the shape is unchanged.
    const first = await status(withChain);
    expect(first['chain']).toBeNull();
    expect(Object.keys(first).sort()).toEqual(['chain', 'claim', 'events', 'mission', 'publication', 'stepping']);

    await f.shadowOf(service)!.scan();
    const chain = (await status(withChain))['chain'] as Record<string, unknown>;
    expect(chain).toMatchObject({
      mode: 'shadow', state: 'awaiting_review', stop_reason: null, repository: 'o/r', pr_number: 13, published_head: oid('1'), published_base: oid('a'),
      shadow_decisions: [{ head_sha: oid('1'), base_sha: oid('a'), action: 'would_reserve', review_ids: [9001] }],
    });
    expect(JSON.stringify(chain)).not.toMatch(/digest|feedback|body/u);
    expect((await status(without))['chain']).toBeNull();

    // The chain's own events are visible: kind, time and allow-listed fields only, bounded to the latest ten.
    const events = chain['events'] as Array<{ kind: string; created_at: number; payload: Record<string, unknown> }>;
    expect(events.map((e) => e.kind)).toEqual(['chain_created', 'observation_cycle', 'observation_cycle']);
    expect(events[1]!.payload).toMatchObject({ action: 'would_reserve', head: oid('1'), review_ids: [9001] });
    expect(events[2]!.payload).toMatchObject({ head: oid('1'), base: oid('a'), decision: expect.any(String) });
    expect(chain['events_total']).toBe(3);
    expect(JSON.stringify(events)).not.toMatch(/feedback|body/u);
    const chainId = chain['chain_id'] as string;
    for (let i = 0; i < 40; i += 1) f.rig.chains.appendEvent(chainId, 'read_failed', { code: 'page_cap', body: 'LEAK' }, T0 + i);
    const many = (await status(withChain))['chain'] as { events: unknown[]; events_total: number };
    expect(many.events).toHaveLength(10);
    expect(many.events_total).toBe(43);
    expect(JSON.stringify(many)).not.toContain('LEAK');

    // A stopped chain reports why.
    pr.head = oid('2');
    clock.now = T0 + 10 * 60_000;
    await f.shadowOf(service)!.scan();
    const stopped = (await status(withChain))['chain'] as { state: string; stop_reason: string; shadow_decisions: Array<{ action: string }> };
    expect(stopped).toMatchObject({ state: 'awaiting_decision', stop_reason: 'attribution_unknown' });
    expect(stopped.shadow_decisions.map((d) => d.action)).toEqual(['would_reserve', 'would_stop']);
    await service.close();
  });
});
