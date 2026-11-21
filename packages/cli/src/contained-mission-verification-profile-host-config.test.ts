import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratchDir } from '@osstack/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadVerificationProfileHostConfig } from './contained-mission-verification-profile-host-config.js';

let home: string;
let path: string;
const valid = { version: 1, installed_root: '/fixture/profiles', allowed_argv: [['fixture', 'arg']] };
beforeEach(async () => {
  home = await createScratchDir('tests', 'profile-config');
  await mkdir(join(home, 'bridge'));
  path = join(home, 'bridge', 'verification-profile-host.json');
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const write = (text: string) => writeFile(path, text, { mode: 0o600 });
const reject = (code: string) => expect(loadVerificationProfileHostConfig(home)).rejects.toEqual(Error('VERIFICATION_PROFILE_HOST_CONFIG_INVALID:' + code));
it('loads only the host settings', async () => {
  expect(await loadVerificationProfileHostConfig(home)).toBeNull();
  await write(JSON.stringify(valid));
  expect(await loadVerificationProfileHostConfig(home)).toEqual({ installedRoot: valid.installed_root,
    allowedArgv: valid.allowed_argv, ownerUid: process.getuid!() });
});
it.each([
  { version: 2 }, { extra: 1 }, ...['relative', '/x/../a', '/x/', '/', '/x//y', '/x/./y', '/x\u0000'].map(installed_root => ({ installed_root })),
  ...[[], [[]], Array(17).fill(['x']), [Array(33).fill('x')], [['']], [['a'.repeat(257)]], [['a\nb']], [['\u0085']]].map(allowed_argv => ({ allowed_argv })),
])('rejects invalid settings %#', async patch => { await write(JSON.stringify({ ...valid, ...patch })); await reject('schema'); });
it('rejects invalid JSON and invalid UTF-8', async () => {
  await write('{'); await reject('json');
  await writeFile(path, Buffer.concat([Buffer.from(JSON.stringify(valid).split('arg')[0]!), Buffer.from([255]), Buffer.from(JSON.stringify(valid).split('arg').slice(1).join('arg'))]));
  await reject('json');
});
it('rejects symlinks, oversized files and shared files', async () => {
  await symlink(home, path); await reject('file_mode'); await rm(path);
  await write(' '.repeat(65537)); await reject('too_large');
  await chmod(path, 0o640); await reject('file_mode');
});
it('rejects without a uid', async () => {
  const uid = process.getuid;
  try { vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'getuid' ? undefined : Reflect.get(target, key) }));
    await reject('file_mode');
  } finally { vi.unstubAllGlobals(); expect(process.getuid).toBe(uid); }
});
it('maps an unreadable path to a fixed error', async () => {
  await rm(join(home, 'bridge'), {recursive:true}); await writeFile(join(home,'bridge'), '');
  await reject('unreadable');
});
