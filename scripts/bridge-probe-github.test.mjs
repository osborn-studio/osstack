import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, parseArgs } from './bridge-probe-github.mjs';
import { APP_KEYS, ProbeError, appJwt, assertSandbox, classify, parseRegistry, reason, record } from './lib/bridge-probe.mjs';
import { createScratchDir } from './lib/scratch.mjs';

const ADR = fileURLToPath(new URL('../docs/decisions/ADR-006-bridge-s0-decisions.md', import.meta.url));
const registry = parseRegistry(await readFile(ADR, 'utf8'));

test('the allowlist and App registry come from ADR-006', () => {
  assert.deepEqual(registry.sandbox, { repo: 'osborn-studio/osstack-bridge-sandbox', id: 1446327922 });
  assert.deepEqual(Object.keys(registry.apps).sort(), [...APP_KEYS].sort());
  assert.deepEqual(registry.apps['osstack-publisher'], { slug: 'osstack-publisher', appId: 5620012, installationId: 178741375 });
  assert.equal(registry.apps['grok-pr-watcher'].slug, 'osborn-grok-pr-watcher');
  assert.throws(() => parseRegistry('no registry here'), e => e.code === 'REGISTRY_INVALID');
});

test('only the registered sandbox, with its registered id, is accepted', () => {
  const ok = { id: 1446327922, private: true };
  assert.doesNotThrow(() => assertSandbox('osborn-studio/osstack-bridge-sandbox', registry, ok));
  for (const [repo, live] of [['osborn-studio/osstack', ok], ['osborn-studio/osstack-bridge-sandbox', { id: 1, private: true }],
    ['osborn-studio/osstack-bridge-sandbox', null]]) {
    assert.throws(() => assertSandbox(repo, registry, live), e => e.code === 'NOT_SANDBOX', repo);
  }
});

test('outcomes: 2xx allowed, refusals rejected, anything else is an error and never a refusal', () => {
  assert.equal(classify({ status: 200 }), 'allowed');
  assert.equal(classify({ status: 201 }), 'allowed');
  for (const s of [401, 403, 404, 405, 409, 422]) assert.equal(classify({ status: s }), 'rejected');
  for (const s of [500, 502, 0]) assert.equal(classify({ status: s }), 'error');
  assert.equal(record('P-3', 'x', 'rejected', { status: 503, body: {} }).pass, false);
  assert.equal(record('P-5', 'x', 'record', { status: 422, body: {} }).pass, true);
});

test('reasons never carry tokens', () => {
  assert.equal(reason({ body: { message: 'bad ghs_abcDEF123 and ghp_x9' } }), 'bad [token] and [token]');
  assert.equal(reason({ body: { message: 'Validation Failed', errors: [{ message: 'Can not approve your own pull request' }] } }), 'Validation Failed; Can not approve your own pull request');
});

test('App JWTs are RS256-signed for the App id', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = appJwt(42, privateKey.export({ type: 'pkcs1', format: 'pem' }), 1_000_000);
  const [h, p, s] = jwt.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, s, 'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iat: 999_940, exp: 1_000_540, iss: '42' });
});

test('argument parsing', () => {
  assert.deepEqual(parseArgs(['--repo', 'o/r', '--apps-dir', '/k'], {}), { humanApprover: false, repo: 'o/r', appsDir: '/k' });
  assert.equal(parseArgs(['--repo', 'o/r'], { OSSTACK_BRIDGE_APPS_DIR: '/env' }).appsDir, '/env');
  assert.equal(parseArgs(['--repo', 'o/r', '--apps-dir', '/k', '--human-approver'], {}).humanApprover, true);
  for (const argv of [[], ['--repo', 'o/r'], ['--repo'], ['--bogus'], ['--repo', 'a/b', '--repo', 'c/d', '--apps-dir', '/k']]) {
    assert.throws(() => parseArgs(argv, {}), e => e instanceof ProbeError && e.code === 'USAGE', argv.join(' '));
  }
});

async function keysDir() {
  const dir = join(await createScratchDir('tests', 'bridge-probe'), 'apps'); await mkdir(dir);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const app of Object.values(registry.apps)) await writeFile(join(dir, `${app.slug}.pem`), privateKey.export({ type: 'pkcs1', format: 'pem' }));
  return dir;
}

test('a repository other than the sandbox is refused before any GitHub call', async () => {
  let calls = 0;
  const makeClient = () => { calls += 1; return { request: async () => ({ status: 500 }) }; };
  await assert.rejects(main(['--repo', 'osborn-studio/osstack', '--apps-dir', '/nonexistent'], { env: {}, makeClient }), e => e.code === 'NOT_SANDBOX');
  assert.equal(calls, 0);
});

test('a sandbox name whose live id differs is refused before any write', async () => {
  const writes = [];
  const makeClient = auth => ({
    request: async (method, path) => {
      if (method !== 'GET' && !(auth.startsWith('Bearer') && /^app\/installations\/\d+\/access_tokens$/.test(path))) writes.push(`${method} ${path}`);
      if (method === 'POST') return { status: 201, body: { token: 'ghs_fake' } };
      if (path === 'repos/osborn-studio/osstack-bridge-sandbox') return { status: 200, body: { id: 999, private: true } };
      return { status: 404, body: {} };
    },
  });
  await assert.rejects(main(['--repo', 'osborn-studio/osstack-bridge-sandbox', '--apps-dir', await keysDir()], { env: {}, makeClient }), e => e.code === 'NOT_SANDBOX');
  assert.deepEqual(writes, []);
});
