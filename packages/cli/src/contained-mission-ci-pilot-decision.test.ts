import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { DecisionProbes, DecisionQueries } from '@osstack/core';
import { afterEach, expect, it, vi } from 'vitest';
import { buildAttentionWebhookNotice } from './attention-webhook-delivery.js';
import { createRig, oid } from './contained-mission-bridge-shadow.testkit.js';
import { pilotDecisionReason, ProductionCiPilot } from './contained-mission-ci-pilot.js';
import { handleContainedMissionCommand } from './contained-mission-command.js';
import { ContainedMissionService } from './contained-mission-rpc.js';
import type { ContainedMissionHost } from './contained-mission-host.js';
import { EngineeringAccess } from './engineering-access.js';
import { answerDecision } from './decisions/answer.js';
import { listDecisions } from './decisions/list.js';
import { createDecisionNoticeSource } from './decisions/notices.js';

const hour = 3_600_000;
const now = 100 * hour;
const credential = 'c'.repeat(32);
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(live = true, draining = false) {
  const rig = createRig();
  const dir = join(rig.root, 'bridge');
  fs.mkdirSync(dir, { mode: 0o700 });
  const profile = join(dir, 'ci-pilot.json');
  fs.writeFileSync(profile, JSON.stringify({ version: 1, scope_id: rig.scope.scope_id, paths: ['packages/cli/src/example.ts'],
    merger_key_path: join(dir, 'fixture-key'), publisher_installation_id: 1, merger_installation_id: 2,
    main_quality_ruleset_id: 3, main_update_ruleset_id: 4, mission_writers_ruleset_id: 5, mission_history_ruleset_id: 6 }), { mode: 0o600 });
  const pilot = new ProductionCiPilot(rig.root, live, () => draining);
  const releasePath = join(dir, 'ci-pilot-release.json');
  const write = (over = {}) => {
    const raw = JSON.stringify({ version: 1, profile_sha256: pilot.profileDigest, issued_at: now, expires_at: now + 72 * hour,
      principal_id: 'private-owner', client_session_id: 'private-client', ...over });
    fs.writeFileSync(releasePath, raw, { mode: 0o600 });
    return hash(raw);
  };
  const root = (n: number) => {
    const id = rig.seedMission({ pr_number: n, head: oid('b'), base_head: oid('a') });
    rig.missions.record(id, 'ci_pilot_root_bound', {}, now);
    return id;
  };
  const row = (at = now) => pilot.decisionRow(rig.missions, at);
  return { ...rig, pilot, profile, releasePath, write, rootMission: root, row };
}

it('derives the release reason, priority and revision from private files without writes or network', () => {
  const f = setup();
  try {
    const counts = () => (f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as {name: string}[])
      .map(({ name }) => f.db.prepare('SELECT count(*) FROM "' + name + '"').pluck().get());
    const before = counts();
    f.db.pragma('query_only=ON');
    const fetch = vi.fn(() => { throw Error('unexpected_network'); });
    vi.stubGlobal('fetch', fetch);
    expect(f.row()).toMatchObject({ reason: 'release_missing', waiting_since: null });
    expect(f.row()?.revision).toBe(hash(JSON.stringify(['release_missing', f.pilot.profileDigest, 'none'])));
    f.write();
    expect(f.row()).toBeNull();
    expect(f.row(now - 1)?.reason).toBe('release_invalid');
    expect(f.row(now + 72 * hour)).toMatchObject({ reason: 'release_expired', waiting_since: now + 72 * hour });
    const releaseDigest = f.write({ expires_at: now + 72 * hour + 1 });
    expect(f.row()).toMatchObject({ reason: 'release_invalid', waiting_since: null,
      revision: hash(JSON.stringify(['release_invalid', f.pilot.profileDigest, releaseDigest])) });
    f.write({ profile_sha256: oid('f') + 'f'.repeat(24) });
    expect(f.row()?.reason).toBe('release_invalid');
    expect(f.row(now + 72 * hour)?.reason).toBe('release_expired');
    fs.writeFileSync(f.releasePath, '{');
    expect(f.row()?.reason).toBe('release_invalid');
    f.write();
    fs.chmodSync(f.releasePath, 0o644);
    expect(f.row()?.reason).toBe('release_invalid');
    fs.chmodSync(f.releasePath, 0o600);
    fs.appendFileSync(f.profile, '\n');
    expect(f.row()?.reason).toBe('release_invalid');
    fs.unlinkSync(f.profile);
    expect(f.row()?.reason).toBe('release_invalid');
    vi.spyOn(f.db, 'prepare').mockImplementationOnce(() => { throw Error('unavailable'); });
    expect(f.row()?.reason).toBe('release_invalid');
    expect(counts()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it('prioritizes a missing or expired release over profile drift and closed slots', () => {
  const roots = { roots_bound: 5, roots_open: 0, latest_close: now };
  const facts = { grant: null, profileMatches: false, releaseDigest: null, missing: true };
  expect(pilotDecisionReason(facts, roots, 'expected', now)).toBe('release_missing');
  const grant = { issued_at: now - hour, expires_at: now, profile_sha256: 'other' };
  expect(pilotDecisionReason({ ...facts, missing: false, grant }, roots, 'expected', now)).toBe('release_expired');
});

it('counts bound roots, detects the 24-hour boundary and uses the latest close time', () => {
  const f = setup();
  try {
    f.write();
    const id = f.rootMission(1);
    expect(f.row(now + 48 * hour - 1)).toBeNull();
    expect(f.row(now + 48 * hour)).toMatchObject({ reason: 'release_expiring', waiting_since: now + 48 * hour });
    f.missions.record(id, 'ci_closed_unmerged', {}, now + 10);
    expect(f.row(now + 48 * hour)).toBeNull();
    for (let n = 2; n <= 5; n++) f.missions.record(f.rootMission(n), 'ci_pr_merged_observed', {}, now + n);
    expect(f.row(now + 48 * hour)).toMatchObject({ reason: 'slots_exhausted', waiting_since: now + 10 });
  } finally { f.close(); }
});

it.each([['shadow', false, false], ['bridge killed', false, false], ['draining', true, true]] as const)(
  'skips all private-file and ledger reads when %s', (_label, live, draining) => {
    const f = setup(live, draining);
    try {
      const file = vi.spyOn(fs, 'realpathSync');
      const query = vi.spyOn(f.db, 'prepare');
      expect(f.row()).toBeNull();
      expect(file).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

it('pages from probe to the scoped pilot and routes every answer and notice locally', async () => {
  const f = setup();
  try {
    const queries = new DecisionQueries(f.db, () => now, { ciPilot: f.row });
    const scope = f.scope.scope_id;
    new DecisionProbes(f.db).create({ now, created_by: 'tester' });
    f.db.pragma('query_only=ON');
    const authenticate = (value: unknown) => { if (value !== credential) throw Error('permission_denied'); return f.principal; };
    const list = (params = {}) => listDecisions(queries, { credential, ...params }, authenticate);
    expect((await listDecisions(queries, {}, authenticate)).failures).toContainEqual({ source: 'ci_pilot', code: 'permission_denied' });
    expect((await list({ scope_id: 'f'.repeat(64) })).items).toEqual([]);
    const page = await list({ limit: 1 });
    expect(page.items[0]?.source).toBe('probe');
    const last = await list({ cursor: page.next_cursor, limit: 1 });
    expect(last.items).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
    const item = last.items[0]!;
    expect(item).toMatchObject({ source: 'ci_pilot', source_id: 'ci_pilot:' + scope, scope_id: scope, waiting_since: null,
      requires_local_signature: true, allowed_answers: [], answer_command: { name: 'mission ci-pilot-status', required_params: [] } });
    const query = { after: item.source_id, limit: 1, read_scopes: [scope] };
    expect(queries.ci_pilot(query)).toEqual([]);
    expect(queries.ci_pilot({ ...query, inclusive: true })).toEqual([f.row()]);
    expect(queries.ci_pilot({ ...query, inclusive: true, read_scopes: [] })).toEqual([]);
    expect(new DecisionQueries(f.db).ci_pilot({ ...query, inclusive: true })).toEqual([]);
    const ports = { db: f.db, queries, authenticate, forward: vi.fn(), resolveHermes: vi.fn() };
    const params = { source: 'ci_pilot', source_id: item.source_id, source_revision: item.source_revision, credential, answer_id: 'test' };
    for (const answer of ['approve', 'abandon', 'grant_revisions', 'free_text']) {
      expect(await answerDecision(ports, { ...params, answer })).toMatchObject({ accepted: false, outcome: 'local_only', local_command: 'mission ci-pilot-status' });
    }
    for (const revoked of [{ write_scopes: [] }, { read_scopes: [] }]) {
      expect(await answerDecision({ ...ports, authenticate: () => ({ ...f.principal, ...revoked }) }, { ...params, answer: 'approve' }))
        .toMatchObject({ code: 'permission_denied', current: { item: null } });
    }
    expect(ports.forward).not.toHaveBeenCalled();
    expect(ports.resolveHermes).not.toHaveBeenCalled();
    const notices = createDecisionNoticeSource(queries, () => [scope], () => now);
    const pending = () => notices.pending().filter(n => n.source === 'ci_pilot');
    const [notice] = pending();
    expect(pending()).toEqual([notice]);
    expect(buildAttentionWebhookNotice({ decision: notice!, delivery_id: notice!.item_id + ':1', item_id: notice!.item_id,
      scope_id: scope, state: 'open', question: notice!.reference }).reason_code).toBe('decision_pending_local');
    f.write({ expires_at: now });
    expect(pending()[0]?.item_id).not.toBe(notice!.item_id);
  } finally { f.close(); }
});

it('renders the public pilot status fields as JSON or individual lines with ISO expiry', async () => {
  const f = setup();
  try {
    f.write();
    f.rootMission(1);
    f.db.pragma('query_only=ON');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const authority = join(f.root, 'authority.json');
    const setScopes = (read_scopes: string[]) => fs.writeFileSync(authority, JSON.stringify({ version: 1, principals: [
      { ...f.principal, credential_sha256: hash(credential), read_scopes, write_scopes: [] },
    ] }), { mode: 0o600 });
    setScopes([f.scope.scope_id]);
    const options = { host: { store: f.missions } as ContainedMissionHost, access: new EngineeringAccess(authority), draining: () => false };
    const service = new ContainedMissionService({ ...options, pilot: f.pilot });
    const unconfigured = new ContainedMissionService(options);
    expect(unconfigured.ciPilotDecision()).toBeNull();
    await expect(unconfigured.handle('mission.ci_pilot_status', { credential })).rejects.toThrow('ci_pilot_not_configured');
    const status = await service.handle('mission.ci_pilot_status', { credential });
    expect(status).toEqual({ mode: 'live', reason: null, expires_at: now + 72 * hour, roots_bound: 1, roots_open: 1, slots: 5,
      release_fields: ['version', 'profile_sha256', 'issued_at', 'expires_at', 'principal_id', 'client_session_id'] });
    for (const json of [false, true]) {
      const lines: string[] = [];
      const rpc = vi.fn(async (method: string, params?: unknown) => ({ ok: true, result: await service.handle(method, params) }));
      expect(await handleContainedMissionCommand(['ci-pilot-status', ...(json ? ['--json'] : [])],
        { stdout: s => lines.push(s), rpc, readCredential: () => credential })).toBe(0);
      expect(rpc).toHaveBeenCalledWith('mission.ci_pilot_status', { credential }, 120000);
      const output = lines.join('\n');
      if (json) expect(JSON.parse(output)).toEqual(status);
      else {
        expect(output.split('\n')).toHaveLength(7);
        expect(output).toContain(new Date(now + 72 * hour).toISOString());
      }
      for (const privateValue of [f.root, 'private-owner', 'private-client', f.pilot.profileDigest]) expect(output).not.toContain(privateValue);
    }
    setScopes([]);
    const read = vi.spyOn(f.pilot, 'status');
    await expect(service.handle('mission.ci_pilot_status', { credential })).rejects.toThrow('permission_denied');
    await expect(service.handle('mission.ci_pilot_status', { credential: 'x'.repeat(32) })).rejects.toThrow('permission_denied');
    expect(read).not.toHaveBeenCalled();
  } finally { f.close(); }
});
