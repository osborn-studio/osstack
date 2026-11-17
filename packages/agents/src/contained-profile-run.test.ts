import { createHash, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProfileOutputCapture, verifyTrustedNamespaceArchive } from './contained-profile-run.js';
import { ContainedCommandExecutor } from './contained-command.js';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function frame(stream: number, text: string) { const h = Buffer.alloc(8); h[0] = stream; h.writeUInt32BE(Buffer.byteLength(text), 4); return Buffer.concat([h, Buffer.from(text)]); }
it('demultiplexes every split, including single-byte chunks', () => {
  const bytes = Buffer.concat([frame(1, 'abc'), frame(2, 'def'), frame(1, 'ghi')]);
  for (let at = 0; at <= bytes.length; at++) {
    const c = createProfileOutputCapture({ stdoutBytes: 6, stderrBytes: 3 }); c.push(bytes.subarray(0, at)); c.push(bytes.subarray(at));
    expect(c.snapshot()).toMatchObject({ state: 'ok', incompleteFrame: false, stdout: { bytes: Buffer.from('abcghi'), sha256: sha('abcghi'), observedBytes: 6 }, stderr: { bytes: Buffer.from('def'), observedBytes: 3 } });
  }
  const c = createProfileOutputCapture({ stdoutBytes: 6, stderrBytes: 3 }); for (const byte of bytes) c.push(Buffer.from([byte]));
  expect(c.snapshot().stdout.bytes.toString()).toBe('abcghi');
});
it.each([1, 2])('caps stream %s independently and ignores 64 MiB after overflow', stream => {
  const c = createProfileOutputCapture({ stdoutBytes: 3, stderrBytes: 3 }); c.push(frame(stream, 'abc')); expect(c.snapshot().state).toBe('ok');
  c.push(frame(stream, 'd')); const before = c.snapshot();
  expect(before).toMatchObject({ state: 'exceeded', exceededStream: stream === 1 ? 'stdout' : 'stderr' });
  const megabyte = Buffer.alloc(1048576); for (let n = 0; n < 64; n++) c.push(megabyte);
  expect(c.snapshot()).toEqual(before); expect(before.stdout.bytes.length + before.stderr.bytes.length).toBeLessThanOrEqual(6);
});
it('does not allocate a declared 4 GiB frame; detects truncated tails', () => {
  const c = createProfileOutputCapture({ stdoutBytes: 3, stderrBytes: 3 }); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(0xffffffff, 4);
  c.push(h); expect(c.snapshot()).toMatchObject({ state: 'ok', incompleteFrame: true }); c.push(Buffer.alloc(4)); expect(c.snapshot().state).toBe('exceeded');
  const partial = createProfileOutputCapture({ stdoutBytes: 3, stderrBytes: 3 }); partial.push(Buffer.from([1])); expect(partial.snapshot().incompleteFrame).toBe(true);
});
it.each([Buffer.from([0,0,0,0,0,0,0,0]), Buffer.from([3,0,0,0,0,0,0,0]), Buffer.from([1,1,0,0,0,0,0,0])])('rejects malformed headers %j', h => {
  const c = createProfileOutputCapture({ stdoutBytes: 3, stderrBytes: 3 }); c.push(h); c.push(frame(1, 'a')); expect(c.snapshot().state).toBe('invalid');
});
type Entry = { name: string; type?: string; text?: string; mode?: number; uid?: number; gid?: number; size?: number };
function tar(entries: Entry[]) {
  return Buffer.concat([...entries.map(e => {
    const h = Buffer.alloc(512); const bytes = Buffer.from(e.text ?? ''); h.write(e.name, 0, 100);
    const oct = (v: number, at: number, len: number) => h.write(v.toString(8).padStart(len - 1, '0') + '\0', at, len);
    oct(e.mode ?? (e.type === '5' ? 0o755 : 0o444), 100, 8); oct(e.uid ?? 0, 108, 8); oct(e.gid ?? 0, 116, 8); oct(e.size ?? bytes.length, 124, 12); oct(0, 136, 12);
    h.fill(32, 148, 156); h.write(e.type ?? '0', 156); h.write('ustar\0', 257); h.write('00', 263); oct(h.reduce((a,b) => a+b, 0), 148, 8);
    return Buffer.concat([h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
  }), Buffer.alloc(1024)]);
}
const tree: Entry[] = [{ name: 'osstack-trusted/', type: '5' }, { name: 'osstack-trusted/fixtures/', type: '5' }, { name: 'osstack-trusted/fixtures/a', text: 'ok' }];
const expected = [{ path: 'fixtures/a', sha256: sha('ok'), size: 2 }];
const stat = { name: 'osstack-trusted', mode: 0x80000000 | 0o755, linkTarget: '' };
it('accepts only the exact trusted tree', () => { expect(() => verifyTrustedNamespaceArchive(tar(tree), stat, expected)).not.toThrow(); });
it.each(['symlink','hardlink','extra','missing','changed','size','uid','gid','group-write','world-write','pax','parent','outside','duplicate','extra-dir','bad-checksum','truncated','fifo','device','long-name','global-pax','setuid','sticky','dir-write','absolute'])('rejects namespace %s', mode => {
  const entries = structuredClone(tree); const file = entries[2]!;
  if (mode === 'symlink') file.type = '2'; if (mode === 'hardlink') file.type = '1'; if (mode === 'pax') file.type = 'x';
  if (mode === 'extra') entries.push({ name: 'osstack-trusted/extra' }); if (mode === 'missing') entries.pop(); if (mode === 'changed') file.text = 'no';
  if (mode === 'size') file.size = 1; if (mode === 'uid') file.uid = 1; if (mode === 'gid') file.gid = 1;
  if (mode === 'group-write') file.mode = 0o464; if (mode === 'world-write') file.mode = 0o446;
  if (mode === 'parent') file.name = 'osstack-trusted/../a'; if (mode === 'outside') file.name = 'elsewhere/a'; if (mode === 'duplicate') entries.push({ ...file });
  if (mode === 'fifo') file.type = '6'; if (mode === 'device') file.type = '3'; if (mode === 'long-name') file.type = 'L'; if (mode === 'global-pax') file.type = 'g';
  if (mode === 'setuid') file.mode = 0o4444; if (mode === 'sticky') file.mode = 0o1444; if (mode === 'dir-write') entries[1]!.mode = 0o777; if (mode === 'absolute') file.name = '/osstack-trusted/fixtures/a';
  if (mode === 'extra-dir') entries.push({ name: 'osstack-trusted/extra/', type: '5' });
  let bytes = tar(entries); if (mode === 'bad-checksum') bytes[0] = 0; if (mode === 'truncated') bytes = bytes.subarray(0, bytes.length - 513);
  expect(() => verifyTrustedNamespaceArchive(bytes, stat, expected)).toThrow('CONTAINED_PROFILE_NAMESPACE_UNTRUSTED');
});
it.each([{ ...stat, linkTarget: '/elsewhere' }, { ...stat, mode: 0x880001ed }, { ...stat, mode: 0o755 }])('rejects path stat %j', s => {
  expect(() => verifyTrustedNamespaceArchive(tar(tree), s, expected)).toThrow('CONTAINED_PROFILE_NAMESPACE_UNTRUSTED');
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { delete process.env.OSSTACK_B3_SENTINEL_SECRET; for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(mode = 'happy', lostDelete = false) {
  const directory = mkdtempSync(join(tmpdir(), 'profile-run-')); const root = realpathSync(directory); const socketPath = join(directory, 'd.sock');
  const controller = new AbortController(); const calls: string[] = []; const requests: string[] = []; const configs: Record<string, unknown>[] = [];
  const imageId = `sha256:${'b'.repeat(64)}`; const workingDirectory = '/osstack-candidate-00000000-0000-4000-8000-000000000000';
  const trustedProfile = { profileDigest: 'c'.repeat(64), artifactDigest: 'd'.repeat(64), contentDigest: 'e'.repeat(64), baseImageReference: `example@sha256:${'f'.repeat(64)}` };
  let removed = false; let started = false; let attach: ServerResponse | undefined; let attachClosed = false; let timer: ReturnType<typeof setInterval> | undefined;
  let resolveStart!: () => void; const didStart = new Promise<void>(r => { resolveStart = r; });
  const server = createServer(async (req, res) => {
    const path = req.url!.replace('/v1.47', ''); calls.push(`${req.method} ${path}`); let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.stringify([req.method, req.url, req.headers, body]));
    if (path === '/info') { res.end(JSON.stringify({ ID: 'daemon', OSType: 'linux' })); return; }
    if (path.startsWith('/images/')) { res.end(JSON.stringify({ Id: mode === 'image-id' ? 'other' : imageId, Config: { WorkingDir: mode === 'image-cwd' ? '/tmp' : workingDirectory, Labels: {
      'osstack.profile.digest': mode === 'image-label' ? 'wrong' : trustedProfile.profileDigest, 'osstack.profile.artifact': trustedProfile.artifactDigest,
      'osstack.profile.content': trustedProfile.contentDigest, 'osstack.profile.base-reference': trustedProfile.baseImageReference,
    } } })); return; }
    if (path === '/containers/create') { configs.push(JSON.parse(body)); if (mode === 'cancel-before') controller.abort(); res.writeHead(mode === 'create-error' ? 500 : 201).end(JSON.stringify({ Id: 'a'.repeat(64) })); return; }
    if (req.method === 'DELETE') { removed = true; attach?.end(); if (timer) clearInterval(timer); res.writeHead(lostDelete ? 500 : 204).end(); return; }
    if (removed) { res.writeHead(404).end(); return; }
    if (path.includes('/archive?')) {
      const s = req.method === 'HEAD' ? { ...stat, name: workingDirectory.slice(1), linkTarget: mode === 'cwd-link' ? '/elsewhere' : '' } : stat;
      res.setHeader('X-Docker-Container-Path-Stat', Buffer.from(JSON.stringify(s)).toString('base64'));
      res.end(req.method === 'HEAD' ? undefined : tar(mode === 'symlink' ? [...tree, { name: 'osstack-trusted/link', type: '2' }] : tree)); return;
    }
    if (path.includes('/attach?')) { attach = res; res.writeHead(200); res.flushHeaders(); res.on('close', () => { attachClosed = true; if (timer) clearInterval(timer); }); return; }
    if (path.endsWith('/start')) {
      started = true; res.writeHead(204).end(); resolveStart();
      if (mode === 'overflow') { timer = setInterval(() => attach?.write(frame(2, 'xxxxxxxx')), 5); }
      else if (mode === 'broken') setTimeout(() => attach?.destroy(), 5);
      else if (mode === 'malformed') attach?.write(Buffer.alloc(8));
      else if (mode === 'cancel') controller.abort();
      else if (mode === 'incomplete') attach?.end(Buffer.from([1, 0]));
      else if (!['timeout','abandoned'].includes(mode)) { attach?.write(frame(1, 'out')); attach?.end(frame(2, 'err')); }
      return;
    }
    if (path.includes('/logs?')) { res.end(frame(1, 'legacy')); return; }
    const running = started && ['overflow','timeout','cancel','broken','malformed','abandoned'].includes(mode);
    const config = configs.at(-1)!;
    res.end(JSON.stringify({ Id: 'a'.repeat(64), Image: imageId, Config: config, HostConfig: { ...(config['HostConfig'] as object), CapAdd: null }, Mounts: [],
      State: { Status: started ? running ? 'running' : 'exited' : 'created', Running: running, ExitCode: mode === 'oom' ? 137 : 7, OOMKilled: mode === 'oom' } }));
  });
  cleanups.push(async () => { if (timer) clearInterval(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const options = { socketPath, journalRoot: root, daemonId: 'daemon', imageId, workingDirectory, bindingData: '{}', bindingRef: sha('{}'), command: 'trusted command', timeoutMs: mode === 'timeout' ? 20 : 1000, authorize: () => {} };
  const profile = { stdoutBytes: 4, stderrBytes: 4, trustedFiles: expected, trustedProfile };
  return { options, profile, controller, calls, requests, configs, didStart, closed: () => attachClosed, executor: new ContainedCommandExecutor(options), receipt: join(root, sha('run'), 'stopped.json') };
}
it('runs with separate captures, a fresh stop proof, ordered preflight and no logs or secrets', async () => {
  const f = await fixture(); const secret = randomUUID(); process.env.OSSTACK_B3_SENTINEL_SECRET = secret;
  const result = await f.executor.executeProfile('run', f.controller.signal, f.profile);
  expect(result).toMatchObject({ status: 'stopped', termination: 'exited', started: true, exitCode: 7, stdout: { bytes: Buffer.from('out'), sha256: sha('out') }, stderr: { bytes: Buffer.from('err'), sha256: sha('err') } });
  expect((await new ContainedCommandExecutor(f.options).confirmStopped('run')).stopped).toBe(true);
  const ordered = ['/images/', '/containers/create', '/archive?', '/attach?', '/start'].map(part => f.calls.findIndex(c => c.includes(part)));
  expect(ordered).toEqual([...ordered].sort((a,b) => a-b)); expect(ordered.every(n => n >= 0)).toBe(true);
  expect(f.calls.some(c => c.includes('/logs'))).toBe(false); expect(f.requests.join('')).not.toContain(secret);
  const config = f.configs[0]!; for (const key of ['Env','Binds','Mounts']) expect(config).not.toHaveProperty(key);
  expect(config).toMatchObject({ NetworkDisabled: true, HostConfig: { NetworkMode: 'none' } }); expect(config['HostConfig']).not.toHaveProperty('Binds');
});
it.each(['image-id','image-cwd','image-label'])('refuses %s before create', async mode => { const f = await fixture(mode); await expect(f.executor.executeProfile('run', f.controller.signal, f.profile)).rejects.toThrow('CONTAINED_PROFILE_IMAGE_UNTRUSTED'); expect(f.configs).toHaveLength(0); });
it.each(['symlink','cwd-link'])('rejects namespace %s before start and proves stop', async mode => {
  const f = await fixture(mode); expect(await f.executor.executeProfile('run', f.controller.signal, f.profile)).toMatchObject({ status: 'stopped', termination: 'namespace_rejected', started: false, reason: 'CONTAINED_PROFILE_NAMESPACE_UNTRUSTED' });
  expect(f.calls.some(c => c.endsWith('/start'))).toBe(false); expect((await f.executor.confirmStopped('run')).stopped).toBe(true);
});
it.each([['overflow','output_limit'],['timeout','timeout'],['cancel-before','cancelled'],['cancel','cancelled'],['oom','exited'],['broken','runtime_error'],['malformed','runtime_error'],['incomplete','runtime_error']])('proves stop for %s', async (mode, termination) => {
  const f = await fixture(mode); const result = await f.executor.executeProfile('run', f.controller.signal, f.profile);
  expect(result).toMatchObject({ status: 'stopped', termination, stopReceipt: { kind: 'docker_removed' } }); expect((await f.executor.confirmStopped('run')).stopped).toBe(true);
  if (result.status !== 'stopped') throw Error('missing proof');
  if (mode === 'overflow') { expect(result.reason).toBe('stderr'); expect(result.stderr.bytes.length).toBeLessThanOrEqual(4); expect(f.closed()).toBe(true); }
  if (mode === 'incomplete') expect(result.reason).toBe('CONTAINED_PROFILE_OUTPUT_INCOMPLETE');
  if (mode === 'oom') expect(result).toMatchObject({ exitCode: 137, oomKilled: true });
  if (mode === 'cancel-before') expect(result.started).toBe(false);
  if (['broken','malformed'].includes(mode!)) expect(result.reason).toBe('CONTAINED_PROFILE_OUTPUT_STREAM');
});
it.each(['happy','timeout','cancel'])('lost DELETE acknowledgement keeps %s unknown', async mode => {
  const f = await fixture(mode, true); expect(await f.executor.executeProfile('run', f.controller.signal, f.profile)).toEqual({ status: 'stop_unknown', reason: 'CONTAINED_DELETE_UNCONFIRMED' });
  expect(existsSync(f.receipt)).toBe(false); expect(await f.executor.confirmStopped('run')).toEqual({ stopped: false });
});
it('unconfirmed create stays unknown', async () => { const f = await fixture('create-error'); expect(await f.executor.executeProfile('run', f.controller.signal, f.profile)).toEqual({ status: 'stop_unknown', reason: 'CONTAINED_CREATE_UNCONFIRMED' }); });
it('fresh executor stops an abandoned execution and cannot replay it', async () => {
  const f = await fixture('abandoned'); const pending = f.executor.executeProfile('run', f.controller.signal, f.profile); await f.didStart;
  const fresh = new ContainedCommandExecutor(f.options); expect((await fresh.stop('run')).stopped).toBe(true);
  await expect(fresh.executeProfile('run', f.controller.signal, f.profile)).rejects.toThrow('EEXIST'); expect(f.configs).toHaveLength(1); await pending;
});
it('legacy execute still requests logs and uses identical create configuration except nonce', async () => {
  const a = await fixture(); await a.executor.executeProfile('run', a.controller.signal, a.profile);
  const b = await fixture(); const result = await b.executor.execute('legacy', b.controller.signal);
  expect(result).toMatchObject({ exitCode: 7, output: 'legacy', cancelled: false }); expect(result).not.toHaveProperty('status'); expect(b.calls.some(c => c.includes('/logs?'))).toBe(true);
  const normalize = (v: Record<string, unknown>) => ({ ...v, Labels: { ...(v['Labels'] as object), 'osstack.contained.nonce': 'nonce' } });
  expect(normalize(a.configs[0]!)).toEqual(normalize(b.configs[0]!));
});
it('validates caps, file count, working directory and binding before any API call', async () => {
  const f = await fixture();
  for (const stdoutBytes of [0, -1, 1.5, 1048577, NaN]) await expect(f.executor.executeProfile('run', f.controller.signal, { ...f.profile, stdoutBytes })).rejects.toThrow('CONTAINED_CONFIG_INVALID');
  for (const trustedFiles of [[], Array.from({ length: 130 }, () => expected[0]!)]) await expect(f.executor.executeProfile('run', f.controller.signal, { ...f.profile, trustedFiles })).rejects.toThrow('CONTAINED_CONFIG_INVALID');
  const { workingDirectory: _cwd, bindingData: _data, ...options } = f.options;
  await expect(new ContainedCommandExecutor(options).executeProfile('run', f.controller.signal, f.profile)).rejects.toThrow('CONTAINED_CONFIG_INVALID'); expect(f.calls).toHaveLength(0);
});
