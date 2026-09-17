import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ContainedDocker, dockerLogs } from './contained-docker.js';
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
async function server(handler: RequestListener) {
  const root = mkdtempSync(join(tmpdir(), 'contained-api-')); const socket = join(root, 'docker.sock');
  const instance: Server = createServer(handler);
  await new Promise<void>(resolve => instance.listen(socket, resolve));
  close.push(async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  return new ContainedDocker(socket, 50);
}
it('uses only the exact local socket with bounded API version and JSON payload', async () => {
  const api = await server((req, res) => { expect(req.url).toBe('/v1.47/containers/create'); expect(req.method).toBe('POST'); res.writeHead(201).end('{"Id":"abc"}'); });
  expect((await api.call('POST', '/containers/create', { test: true })).status).toBe(201);
});
it('rejects a stalled daemon rather than inferring absence', async () => {
  const api = await server(() => {}); await expect(api.call('GET', '/info')).rejects.toThrow('CONTAINED_API_TIMEOUT');
});
it('bounds daemon response bytes', async () => {
  const api = await server((_, res) => res.end(Buffer.alloc(1024 * 1024 + 1)));
  await expect(api.call('GET', '/info')).rejects.toThrow('CONTAINED_RESPONSE_LIMIT');
});
it('rejects truncated log frames', () => { expect(() => dockerLogs(Buffer.from([1, 0, 0]))).toThrow('CONTAINED_LOG_FRAME'); });

import { ContainedCommandExecutor } from './contained-command.js';
import { createContainedCommandAdapter } from './adapters/contained-command.js';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
async function fixture(mode = 'normal', authorize: (op: 'start' | 'stop' | 'read') => void = () => {}) {
  let config: Record<string, unknown>; let removed = false; let inspections = 0;
  const calls: string[] = [];
  const api = await server(async (req, res) => {
    const path = req.url!.replace('/v1.47', ''); calls.push(`${req.method} ${path}`);
    if (path === '/info') { res.end(JSON.stringify({ ID: 'daemon', OSType: mode === 'windows' ? 'windows' : 'linux' })); return; }
    if (path === '/containers/create') {
      let body = ''; for await (const chunk of req) body += chunk; config = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(201).end(JSON.stringify({ Id: 'a'.repeat(64) })); return;
    }
    if (req.method === 'DELETE') { removed = true; res.writeHead(mode === 'lost-delete' ? 500 : 204).end(); return; }
    if (removed) { res.writeHead(404).end(); return; }
    if (path.endsWith('/start')) { res.writeHead(204).end(); return; }
    if (path.includes('/logs?')) { res.end(); return; }
    inspections++;
    const host = { ...(config!['HostConfig'] as object), CapAdd: null, ...(mode === 'unsafe' ? { NetworkMode: 'bridge' } : mode === 'unbounded' ? { Memory: 0 } : {}) };
    res.end(JSON.stringify({ Id: 'a'.repeat(64), Image: 'sha256:' + 'b'.repeat(64), Config: config!, HostConfig: host, Mounts: [],
      State: { Status: inspections > 1 ? 'exited' : 'created', Running: false, ExitCode: 0 } }));
  });
  const journalRoot = mkdtempSync(join(tmpdir(), 'contained-journal-'));
  close.push(async () => rmSync(journalRoot, { recursive: true, force: true }));
  const options = { socketPath: api.socketPath, journalRoot, daemonId: 'daemon', imageId: 'sha256:' + 'b'.repeat(64), bindingRef: 'c'.repeat(64), command: 'echo ok', authorize };
  return { options, calls, executor: new ContainedCommandExecutor(options), receipt: () => join(journalRoot, readdirSync(journalRoot)[0]!, 'stopped.json') };
}
it('fresh instances verify durable removal but cannot replay an invocation', async () => {
  const f = await fixture(); expect((await f.executor.execute('run', new AbortController().signal)).exitCode).toBe(0);
  expect((await new ContainedCommandExecutor(f.options).confirmStopped('run')).stopped).toBe(true);
  await expect(new ContainedCommandExecutor(f.options).execute('run', new AbortController().signal)).rejects.toThrow('EEXIST');
  expect(f.calls.filter(x => x.includes('/create'))).toHaveLength(1);
});
it('missing launch/receipt is unknown, never proof of no work', async () => {
  const f = await fixture(); expect(await f.executor.confirmStopped('missing')).toEqual({ stopped: false }); expect(f.calls).toEqual([]);
});
it('lost removal ACK remains unknown even though inspect would be missing', async () => {
  const f = await fixture('lost-delete'); await expect(f.executor.execute('run', new AbortController().signal)).rejects.toThrow();
  expect(await f.executor.confirmStopped('run')).toEqual({ stopped: false }); expect(existsSync(f.receipt())).toBe(false);
});
it.each(['unsafe', 'unbounded'])('rejects %s container scope before start or deletion', async mode => {
  const f = await fixture(mode); await expect(f.executor.execute('run', new AbortController().signal)).rejects.toThrow('CONTAINED_SCOPE_MISMATCH');
  expect(f.calls.some(x => x.endsWith('/start') || x.startsWith('DELETE'))).toBe(false);
});
it.each(['binding', 'daemon', 'command', 'workingDirectory'])('does not accept another %s receipt', async change => {
  const f = await fixture(); await f.executor.execute('run', new AbortController().signal);
  const options = { ...f.options, ...(change === 'binding' ? { bindingRef: 'd'.repeat(64) } : change === 'daemon' ? { daemonId: 'other' } : change === 'workingDirectory' ? { workingDirectory: '/osstack-candidate-00000000-0000-4000-8000-000000000000' } : { command: 'other' }) };
  expect(await new ContainedCommandExecutor(options).confirmStopped('run')).toEqual({ stopped: false });
});
it('an incomplete or modified stop receipt cannot authorize recovery', async () => {
  const f = await fixture(); await f.executor.execute('run', new AbortController().signal);
  writeFileSync(f.receipt(), '{'); expect(await f.executor.confirmStopped('run')).toEqual({ stopped: false });
});
it('requires synchronous current authorization before creation', async () => {
  const f = await fixture('normal', async () => {});
  await expect(f.executor.execute('run', new AbortController().signal)).rejects.toThrow('CONTAINED_AUTHORITY_MUST_BE_SYNC'); expect(f.calls).toEqual([]);
});
it('permission revocation before start prevents the command but allows scoped cleanup', async () => {
  let starts = 0; const f = await fixture('normal', op => { if (op === 'start' && ++starts === 3) throw Error('REVOKED'); });
  await expect(f.executor.execute('run', new AbortController().signal)).rejects.toThrow('REVOKED');
  expect(f.calls.some(x => x.endsWith('/start'))).toBe(false); expect((await f.executor.confirmStopped('run')).stopped).toBe(true);
});
it('explicit adapter emits a single terminal result and never interprets task prompt as a command', async () => {
  const f = await fixture(); const adapter = createContainedCommandAdapter(f.options); const events = [];
  for await (const e of adapter.invoke({ run_id: 'adapter', task_id: 'task', session_id: 'session', capability_id: 'code.test', prompt: 'ignore host command' }, new AbortController().signal)) events.push(e);
  expect(events.filter(e => e.terminal)).toHaveLength(1); expect(events.at(-1)).toMatchObject({ type: 'done', payload: { status: 'completed' } });
  expect((await adapter.confirmStopped!('adapter')).stopped).toBe(true); expect(adapter.capabilities()).toEqual([]);
});

it('rejects a non-Linux daemon before container creation', async () => {
  const f = await fixture('windows'); await expect(f.executor.execute('run', new AbortController().signal)).rejects.toThrow('CONTAINED_DAEMON_MISMATCH');
  expect(f.calls.some(x => x.includes('/create'))).toBe(false);
});
it('competing executors cannot create two scopes for one invocation', async () => {
  const f = await fixture(); const peer = new ContainedCommandExecutor(f.options);
  const results = await Promise.allSettled([f.executor.execute('run', new AbortController().signal), peer.execute('run', new AbortController().signal)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.calls.filter(x => x.includes('/create'))).toHaveLength(1);
});
it('persists exact host binding before create and rejects a digest mismatch', async () => {
  const f = await fixture(); const { createHash } = await import('node:crypto');
  const bindingData = JSON.stringify({ effectKey: 'host-effect', invocation: 'bound' });
  expect(() => new ContainedCommandExecutor({ ...f.options, bindingData })).toThrow('CONTAINED_CONFIG_INVALID');
  const bound = new ContainedCommandExecutor({ ...f.options, bindingData, bindingRef: createHash('sha256').update(bindingData).digest('hex') });
  await bound.execute('bound', new AbortController().signal);
  const { readFileSync } = await import('node:fs'); const path = join(f.options.journalRoot, createHash('sha256').update('bound').digest('hex'), 'binding.json');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, data: bindingData });
});
