import { generateKeyPairSync, verify } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createVerificationInstallationProof } from './contained-mission-verification-installation.js';

let home: string; let key: string;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'verification-proof-')); key = join(home, 'fixture-key');
  await writeFile(key, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
});
afterAll(async () => { await rm(home, { recursive: true, force: true }); });
const scope = { repository: 'fixture-owner/fixture-repo', repository_id: 101 };
const query = { app_id: 201, repository_id: 101 };
const options = { signal: new AbortController().signal };
const app = (path: string) => ({ app_id: 201, installation_id: 301, verification_private_key_path: path });
const body = { id: 301, app_id: 201, suspended_at: null, repository_selection: 'selected', permissions: { checks: 'write', metadata: 'read' } };
const now = () => Date.parse('2026-11-16T12:02:00Z');
function harness(response = Response.json(body), path = key) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { fetchImpl, proof: createVerificationInstallationProof(app(path), scope, { fetchImpl, now }) };
}
it('signs one bounded installation GET and returns only the installed id', async () => {
  const { fetchImpl, proof } = harness();
  expect(await proof(query, options)).toEqual({ status: 'installed', installation_id: 301 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0]!;
  expect(url).toBe('https://api.github.com/repos/fixture-owner/fixture-repo/installation');
  expect(init).toMatchObject({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal),
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const [head, payload, signature] = auth.slice(7).split('.');
  expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'RS256' });
  const sec = now() / 1000;
  expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iss: '201', iat: sec - 60, exp: sec + 540 });
  expect(verify('RSA-SHA256', Buffer.from(`${head}.${payload}`), pair.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
});
it.each([{ ...query, app_id: 202 }, { ...query, repository_id: 102 }])('skips key and fetch outside registered scope', async other => {
  const { proof, fetchImpl } = harness(undefined, join(home, 'missing'));
  expect(await proof(other, options)).toEqual({ status: 'not_installed' }); expect(fetchImpl).not.toHaveBeenCalled();
});
it.each([{ id: 302 }, { app_id: 202 }, { suspended_at: 'fixture' }, { repository_selection: 'all' },
  { permissions: { checks: 'write' } }, { permissions: { ...body.permissions, checks: 'read' } },
  { permissions: { ...body.permissions, contents: 'read' } }])('rejects an unregistered installation %j', async edit => {
  expect(await harness(Response.json({ ...body, ...edit })).proof(query, options)).toEqual({ status: 'not_installed' });
});
it('treats 404 as definitive', async () => {
  expect(await harness(new Response(null, { status: 404 })).proof(query, options)).toEqual({ status: 'not_installed' });
});
it.each(['missing', 'mode', 'symlink', 'garbage'])('contains %s key failures', async kind => {
  const path = join(home, kind);
  if (kind === 'mode') { await writeFile(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' })); await chmod(path, 0o644); }
  if (kind === 'symlink') await symlink(key, path);
  if (kind === 'garbage') await writeFile(path, 'fixture', { mode: 0o600 });
  const { proof, fetchImpl } = harness(undefined, path);
  expect(await proof(query, options)).toEqual({ status: 'unavailable', reason: 'key' }); expect(fetchImpl).not.toHaveBeenCalled();
});
it('contains fetch errors and pre-aborts', async () => {
  const { proof, fetchImpl } = harness();
  fetchImpl.mockRejectedValueOnce(Error('fixture'));
  expect(await proof(query, options)).toEqual({ status: 'unavailable', reason: 'network' });
  expect(await proof(query, { signal: AbortSignal.abort() })).toEqual({ status: 'unavailable', reason: 'network' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 500, 301])('contains HTTP %i', async status => {
  const response = new Response(null, { status });
  if (status === 301) Object.defineProperty(response, 'redirected', { value: true });
  expect(await harness(response).proof(query, options)).toEqual({ status: 'unavailable', reason: 'http' });
});
it.each(['fixture', '{}', JSON.stringify({ ...body, permissions: { checks: 1 } })])('contains invalid response', async text => {
  expect(await harness(new Response(text)).proof(query, options)).toEqual({ status: 'unavailable', reason: 'response' });
});
it('stops the stream as soon as it exceeds the byte limit', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(65536)); c.enqueue(new Uint8Array(1)); }, cancel });
  expect(await harness(new Response(stream)).proof(query, options)).toEqual({ status: 'unavailable', reason: 'response' });
  expect(cancel).toHaveBeenCalledOnce();
});
it('rejects invalid factory arguments', () => {
  for (const [identity, target] of [[app('relative'), scope], [{ ...app(key), app_id: 0 }, scope],
    [app(key), { ...scope, repository_id: 2 ** 53 }], [app(key), { ...scope, repository: '../fixture' }]] as const) {
    expect(() => createVerificationInstallationProof(identity, target, { fetchImpl: vi.fn() })).toThrow(/^VERIFICATION_INSTALLATION_PROOF_INVALID$/);
  }
});
