import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScratchDir } from '@osstack/core';
import {
  EVIDENCE_PERMISSIONS,
  PUBLISHER_PERMISSIONS,
  createInstallationTokenSource,
  loadBridgeConfig,
} from './contained-mission-github-app.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_BODY = PEM.split('\n')[1] ?? 'x';

let home: string;
let keyPath: string;

beforeEach(async () => {
  home = await createScratchDir('tests', 'bridge-app');
  await mkdir(join(home, 'bridge'), { recursive: true });
  keyPath = join(home, 'key.pem');
  await writeFile(keyPath, PEM, { mode: 0o600 });
  await chmod(keyPath, 0o600);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const app = (path = keyPath) => ({ app_id: 11, installation_id: 22, private_key_path: path });
const apps = (over: Record<string, unknown> = {}) => ({
  version: 1,
  repository: 'acme/widgets',
  publisher: app(),
  evidence: { ...app(), app_id: 12, installation_id: 23 },
  ...over,
});
const rulesets = (over: Record<string, unknown> = {}) => ({
  version: 1,
  repository: 'Acme/Widgets',
  mission_ruleset_ids: [5],
  ...over,
});
async function write(a: unknown, r: unknown): Promise<void> {
  if (a !== undefined) await writeFile(join(home, 'bridge', 'apps.json'), typeof a === 'string' ? a : JSON.stringify(a));
  if (r !== undefined) await writeFile(join(home, 'bridge', 'rulesets.json'), typeof r === 'string' ? r : JSON.stringify(r));
}
const msg = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected rejection');
};

describe('loadBridgeConfig', () => {
  it('returns undefined when neither file exists', async () => {
    expect(await loadBridgeConfig(home)).toBeUndefined();
  });
  it('loads a valid config', async () => {
    await write(apps(), rulesets());
    const cfg = await loadBridgeConfig(home);
    expect(cfg?.repository).toBe('acme/widgets');
    expect(cfg?.mission_ruleset_ids).toEqual([5]);
    expect(cfg?.publisher.app_id).toBe(11);
  });
  it('throws when only one file exists', async () => {
    await write(apps(), undefined);
    expect(await msg(loadBridgeConfig(home))).toMatch(/^BRIDGE_CONFIG_INVALID:/);
    await rm(join(home, 'bridge', 'apps.json'));
    await write(undefined, rulesets());
    expect(await msg(loadBridgeConfig(home))).toMatch(/^BRIDGE_CONFIG_INVALID:/);
  });
  it('throws on invalid JSON or schema', async () => {
    await write('{nope', rulesets());
    expect(await msg(loadBridgeConfig(home))).toMatch(/^BRIDGE_CONFIG_INVALID:/);
    await write(apps({ extra: 1 }), rulesets());
    expect(await msg(loadBridgeConfig(home))).toMatch(/^BRIDGE_CONFIG_INVALID:/);
    await write(apps(), rulesets({ mission_ruleset_ids: [] }));
    expect(await msg(loadBridgeConfig(home))).toMatch(/^BRIDGE_CONFIG_INVALID:/);
    await write(apps({ publisher: app('relative.pem') }), rulesets());
    expect(await msg(loadBridgeConfig(home))).toMatch(/^BRIDGE_CONFIG_INVALID:/);
  });
  it('throws on repository mismatch', async () => {
    await write(apps(), rulesets({ repository: 'acme/other' }));
    expect(await msg(loadBridgeConfig(home))).toMatch(/^BRIDGE_CONFIG_INVALID:/);
  });
  it('rejects a group/world readable key', async () => {
    await write(apps(), rulesets());
    await chmod(keyPath, 0o644);
    const m = await msg(loadBridgeConfig(home));
    expect(m).toBe('BRIDGE_KEY_PERMISSIONS:publisher');
  });
  it('rejects a symlinked key', async () => {
    const link = join(home, 'link.pem');
    await symlink(keyPath, link);
    await write(apps({ evidence: { ...app(link), app_id: 12 } }), rulesets());
    expect(await msg(loadBridgeConfig(home))).toBe('BRIDGE_KEY_PERMISSIONS:evidence');
  });
});

function fakeFetch(
  respond: (n: number) => { status: number; body: unknown } = () => ({ status: 201, body: ok() }),
  delayMs = 0,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = respond(calls.length);
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
let nowMs = 1_800_000_000_000;
const ok = (extra: Record<string, unknown> = {}) => ({
  token: 'ghs_token' + nowMs,
  expires_at: new Date(nowMs + 3_600_000).toISOString(),
  permissions: { checks: 'write' },
  repositories: [{ full_name: 'acme/widgets' }],
  ...extra,
});
const scope = { repository: 'acme/widgets', permissions: EVIDENCE_PERMISSIONS } as const;

describe('createInstallationTokenSource', () => {
  it('exports role permissions', () => {
    expect(PUBLISHER_PERMISSIONS).toEqual({ contents: 'write', pull_requests: 'write' });
    expect(EVIDENCE_PERMISSIONS).toEqual({ checks: 'write' });
  });
  it('signs a verifiable JWT and scopes the request', async () => {
    const f = fakeFetch();
    const src = createInstallationTokenSource(app(), scope, { fetchImpl: f.fetchImpl, now: () => nowMs });
    expect(await src.token()).toMatch(/^ghs_token/);
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.github.com/app/installations/22/access_tokens');
    expect(JSON.parse(String(call.init.body))).toEqual({ repositories: ['widgets'], permissions: { checks: 'write' } });
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(headers['accept']).toBe('application/vnd.github+json');
    const jwt = (headers['authorization'] ?? '').replace(/^Bearer /, '');
    const [h, p, s] = jwt.split('.');
    expect(cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const sec = Math.floor(nowMs / 1000);
    expect(payload).toEqual({ iat: sec - 60, exp: sec + 540, iss: '11' });
  });
  it('reuses a cached token and refreshes inside the 5 minute window', async () => {
    const f = fakeFetch();
    const src = createInstallationTokenSource(app(), scope, { fetchImpl: f.fetchImpl, now: () => nowMs });
    const a = await src.token();
    nowMs += 30 * 60_000;
    expect(await src.token()).toBe(a);
    expect(f.calls).toHaveLength(1);
    nowMs += 26 * 60_000; // 4 min left
    const b = await src.token();
    expect(f.calls).toHaveLength(2);
    expect(b).not.toBe(a);
  });
  it('shares one in-flight request across concurrent calls', async () => {
    const f = fakeFetch(undefined, 20);
    const src = createInstallationTokenSource(app(), scope, { fetchImpl: f.fetchImpl, now: () => nowMs });
    const r = await Promise.all([src.token(), src.token(), src.token()]);
    expect(new Set(r).size).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
  it('rejects a response with an extra repository', async () => {
    const f = fakeFetch(() => ({ status: 201, body: ok({ repositories: [{ full_name: 'acme/widgets' }, { full_name: 'acme/x' }] }) }));
    const src = createInstallationTokenSource(app(), scope, { fetchImpl: f.fetchImpl, now: () => nowMs });
    expect(await msg(src.token())).toMatch(/^BRIDGE_TOKEN_SCOPE/);
  });
  it('rejects a response with extra permissions', async () => {
    const f = fakeFetch(() => ({ status: 201, body: ok({ permissions: { checks: 'write', contents: 'write' } }) }));
    const src = createInstallationTokenSource(app(), scope, { fetchImpl: f.fetchImpl, now: () => nowMs });
    expect(await msg(src.token())).toMatch(/^BRIDGE_TOKEN_SCOPE/);
  });
  it('accepts the metadata:read GitHub adds to every token, but not metadata:write', async () => {
    const granted = createInstallationTokenSource(app(), scope, { fetchImpl: fakeFetch(() => ({ status: 201, body: ok({ permissions: { checks: 'write', metadata: 'read' } }) })).fetchImpl, now: () => nowMs });
    expect(await granted.token()).toMatch(/^ghs_token/);
    const widened = createInstallationTokenSource(app(), scope, { fetchImpl: fakeFetch(() => ({ status: 201, body: ok({ permissions: { checks: 'write', metadata: 'write' } }) })).fetchImpl, now: () => nowMs });
    expect(await msg(widened.token())).toMatch(/^BRIDGE_TOKEN_SCOPE/);
  });
  it('redacts tokens from non-2xx errors and never leaks the PEM', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { message: 'Bad credentials ghs_abc123 ' + PEM } }));
    const src = createInstallationTokenSource(app(), scope, { fetchImpl: f.fetchImpl, now: () => nowMs });
    const m = await msg(src.token());
    expect(m).toMatch(/^BRIDGE_TOKEN_REQUEST:401:/);
    expect(m).not.toContain('ghs_abc123');
    expect(m).not.toContain(PEM_BODY);
    expect(m).not.toContain('BEGIN');
  });
  it('does not cache failures', async () => {
    const f = fakeFetch((n) => (n === 1 ? { status: 500, body: { message: 'boom' } } : { status: 201, body: ok() }));
    const src = createInstallationTokenSource(app(), scope, { fetchImpl: f.fetchImpl, now: () => nowMs });
    await msg(src.token());
    expect(await src.token()).toMatch(/^ghs_token/);
  });
});
