import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createScratchDir } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import { redactBridge as viaBridge } from './contained-mission-bridge.js';
import { loadMergerConfig } from './contained-mission-merger-config.js';
import { redactBridge } from './contained-mission-redact.js';

const good = {
  version: 1, repository: 'o/r', publisher: { actor_id: 1001, app_id: 11 }, evidence_app_id: 12, merger: { actor_id: 1005, app_id: 15 }, base_ref: 'main',
  inspection_evidence: false, counted_approvers: [{ actor_id: 269, app_id: null }],
  required_checks: [{ context: 'check', app_id: 15368 }, { context: 'build', app_id: 15368 }],
  main_quality_ruleset_id: 100, main_update_ruleset_id: 200, mission_ruleset_ids: [302, 301],
};
async function home(files: Record<string, string>): Promise<string> {
  const dir = await createScratchDir('tests', 'merger-config');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, 'bridge', name)), { recursive: true });
    await writeFile(join(dir, 'bridge', name), text);
  }
  return dir;
}
const load = async (value: unknown) => loadMergerConfig(await home({ 'merger.json': JSON.stringify(value) }));
const invalid = (reason: string) => `MERGER_CONFIG_INVALID:merger.json:${reason}`;

describe('loadMergerConfig', () => {
  it('missing file is off, even when other bridge files are broken', async () => {
    expect(await loadMergerConfig(await home({}))).toBeUndefined();
    expect(await loadMergerConfig(await home({ 'apps.json': '{broken', 'producers.json': 'x' }))).toBeUndefined();
  });

  it('loads the registry with ids, producers, owner reviewer and sorted mission rulesets', async () => {
    const c = await load(good);
    expect(c).toMatchObject({
      repository: 'o/r', base_ref: 'main', publisher: { actor_id: 1001, app_id: 11 }, merger: { actor_id: 1005, app_id: 15 }, evidence_app_id: 12,
      owner_reviewer_id: 269, producers: [15368], main_quality_ruleset_id: 100, main_update_ruleset_id: 200, mission_ruleset_ids: [301, 302], inspection_evidence: false,
    });
    expect(c?.required_checks).toHaveLength(2);
  });

  it('invalid JSON or schema fails', async () => {
    await expect(loadMergerConfig(await home({ 'merger.json': '{nope' }))).rejects.toThrow(invalid('json'));
    await expect(load({ ...good, version: 2 })).rejects.toThrow(invalid('version'));
    await expect(load({ ...good, base_ref: 'develop' })).rejects.toThrow(invalid('base_ref'));
    await expect(load({ ...good, repository: 'bad' })).rejects.toThrow(invalid('repository'));
    await expect(load({ ...good, mission_ruleset_ids: [1] })).rejects.toThrow(invalid('mission_ruleset_ids'));
    await expect(load({ ...good, required_checks: [] })).rejects.toThrow(invalid('required_checks'));
    await expect(load({ ...good, extra: 1 })).rejects.toThrow(invalid('root'));
    await expect(load({ ...good, publisher: { actor_id: '1001', app_id: 11 } })).rejects.toThrow(invalid('publisher.actor_id'));
  });

  it('rejects any credential-looking field, at any depth', async () => {
    for (const patch of [
      { private_key_path: '/x/a.pem' }, { merger: { ...good.merger, private_key_path: '/k' } }, { merger: { ...good.merger, installation_id: 5 } }, { token: 't' },
      { secret: 1 }, { nested: [{ pem: 'x' }] }, { publisher: { ...good.publisher, key: 'k' } }, { api_key: 'k' },
    ]) {
      await expect(load({ ...good, ...patch }), JSON.stringify(patch)).rejects.toThrow(invalid('credential_field'));
    }
  });

  it('counted approvers: app_id must be null; no duplicates; never an App bot', async () => {
    await expect(load({ ...good, counted_approvers: [{ actor_id: 269, app_id: 5 }] })).rejects.toThrow(invalid('counted_approvers.0.app_id'));
    await expect(load({ ...good, counted_approvers: [] })).rejects.toThrow(invalid('counted_approvers'));
    await expect(load({ ...good, counted_approvers: [{ actor_id: 269, app_id: null }, { actor_id: 269, app_id: null }] })).rejects.toThrow(invalid('duplicate_approver'));
    await expect(load({ ...good, counted_approvers: [{ actor_id: 1001, app_id: null }] })).rejects.toThrow(invalid('approver_is_app'));
  });

  it('the three Apps, the two bots, the required checks and the rulesets must be distinct', async () => {
    await expect(load({ ...good, evidence_app_id: 11 })).rejects.toThrow(invalid('app_ids_overlap'));
    await expect(load({ ...good, merger: { actor_id: 1001, app_id: 15 } })).rejects.toThrow(invalid('bot_ids_overlap'));
    await expect(load({ ...good, required_checks: [good.required_checks[0], good.required_checks[0]] })).rejects.toThrow(invalid('duplicate_required_check'));
    await expect(load({ ...good, main_update_ruleset_id: 100 })).rejects.toThrow(invalid('ruleset_ids_overlap'));
  });

  it('an unreadable file (a directory) fails with a fixed code', async () => {
    const dir = await home({ 'merger.json/x': '' });
    await expect(loadMergerConfig(dir)).rejects.toThrow(/^MERGER_CONFIG_INVALID:merger\.json:unreadable:/u);
  });
});

describe('redactBridge move', () => {
  it('is the same function from both modules and keeps its behaviour', () => {
    expect(viaBridge).toBe(redactBridge);
    expect(redactBridge('x ghp_abc123 y ghs_Z9 gho_a')).toBe('x [REDACTED] y [REDACTED] [REDACTED]');
  });
});
