import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratchDir } from '@osstack/core';
import { describe, expect, it } from 'vitest';
import { loadProducerRegistry } from './contained-mission-bridge-registry.js';

const good = {
  version: 1,
  repository: 'o/r',
  publisher: [{ actor_id: 10, app_id: null }],
  reviewers: [{ actor_id: 20, app_id: null }, { actor_id: 21, app_id: 5 }],
};

async function home(files: Record<string, string>): Promise<string> {
  const dir = await createScratchDir('tests', 'bridge-registry');
  await mkdir(join(dir, 'bridge'), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, 'bridge', name), body);
  return dir;
}
const registry = (value: unknown) => home({ 'producers.json': JSON.stringify(value) });

describe('loadProducerRegistry', () => {
  it('returns undefined when producers.json is missing, ignoring other bridge files', async () => {
    expect(await loadProducerRegistry(await home({}))).toBeUndefined();
    expect(await loadProducerRegistry(await home({ 'apps.json': '{broken' }))).toBeUndefined();
  });

  it('loads a valid registry without reading apps.json or rulesets.json', async () => {
    const dir = await home({ 'producers.json': JSON.stringify(good), 'apps.json': '{broken', 'rulesets.json': 'x' });
    const { version: _version, ...rest } = good;
    expect(await loadProducerRegistry(dir)).toEqual(rest);
  });

  it.each([
    ['not json', '{nope', 'json'],
    ['wrong version', JSON.stringify({ ...good, version: 2 }), 'version'],
    ['extra field', JSON.stringify({ ...good, extra: 1 }), 'root'],
    ['bad repository', JSON.stringify({ ...good, repository: 'nope' }), 'repository'],
    ['zero actor id', JSON.stringify({ ...good, reviewers: [{ actor_id: 0, app_id: null }] }), 'reviewers.0.actor_id'],
    ['string id', JSON.stringify({ ...good, publisher: [{ actor_id: '1', app_id: null }] }), 'publisher.0.actor_id'],
    ['missing app_id', JSON.stringify({ ...good, reviewers: [{ actor_id: 3 }] }), 'reviewers.0.app_id'],
    ['empty reviewers', JSON.stringify({ ...good, reviewers: [] }), 'reviewers'],
    ['login field', JSON.stringify({ ...good, reviewers: [{ actor_id: 3, app_id: null, login: 'x' }] }), 'reviewers.0'],
    ['duplicate reviewer', JSON.stringify({ ...good, reviewers: [{ actor_id: 3, app_id: null }, { actor_id: 3, app_id: null }] }), 'duplicate_identity'],
    ['duplicate publisher', JSON.stringify({ ...good, publisher: [{ actor_id: 3, app_id: null }, { actor_id: 3, app_id: null }] }), 'duplicate_identity'],
    ['publisher is reviewer', JSON.stringify({ ...good, reviewers: [{ actor_id: 10, app_id: null }] }), 'publisher_is_reviewer'],
  ])('rejects %s', async (_name, body, reason) => {
    await expect(loadProducerRegistry(await home({ 'producers.json': body }))).rejects.toThrow(`BRIDGE_CONFIG_INVALID:producers.json:${reason}`);
  });

  it('allows the same actor id with a different app id in the two roles', async () => {
    const value = { ...good, reviewers: [{ actor_id: 10, app_id: 7 }] };
    expect((await loadProducerRegistry(await registry(value)))?.reviewers).toEqual([{ actor_id: 10, app_id: 7 }]);
  });
});
