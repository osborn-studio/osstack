import { expect, it } from 'vitest';
import { RemoteCheckpointSaver } from './remote-checkpointer.js';
it('rejects cross-run access and destructive deletion before transport', async () => {
  const saver = new RemoteCheckpointSaver('run', async () => { throw new Error('transport must not run'); });
  await expect(saver.getTuple({ configurable: { thread_id: 'other' } })).rejects.toThrow('CHECKPOINT_THREAD_MISMATCH');
  await expect(saver.deleteThread('run')).rejects.toThrow('CHECKPOINT_DELETE_UNSUPPORTED');
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { WRITES_IDX_MAP, type Checkpoint } from '@langchain/langgraph-checkpoint';
import { entrypoint, task, interrupt, Command } from './worker-entry.js';
import { checkpointServer } from './checkpoint-ipc-fixture.js';
import type { GraphCheckpointRequest } from '@osstack/protocol';
const directories: string[] = [];
const servers: Awaited<ReturnType<typeof checkpointServer>>[] = [];
async function start(path?: string) {
  if (!path) { const dir = mkdtempSync(join(tmpdir(), 'checkpoint-ipc-')); directories.push(dir); path = join(dir, 'state.db'); }
  const server = await checkpointServer(path); servers.push(server);
  return { ...server, path, saver: new RemoteCheckpointSaver(server.threadId, server.transport),
    config: { configurable: { thread_id: server.threadId }, durability: 'sync' as const } };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.stop())); directories.splice(0).forEach((d) => { rmSync(d, { recursive: true, force: true }); }); });
const checkpoint = (id: string): Checkpoint => ({ v: 4, id, ts: new Date(0).toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} });
const metadata = { source: 'loop' as const, step: 0, parents: {} };

it('preserves parent, versions, namespaces, before/filter and complete pagination through real asynchronous SQLite IPC', async () => {
  const s = await start();
  let parent: import('@langchain/core/runnables').RunnableConfig = s.config;
  for (let i = 0; i < 20; i++) {
    const meta = { ...metadata, step: i, details: { tags: [i] } };
    const config = await s.saver.put(parent, checkpoint(String(i).padStart(3, '0')), meta, { a: i });
    parent = { ...s.config, ...config };
  }
  await s.saver.put({ configurable: { thread_id: s.threadId, checkpoint_ns: 'other' } }, checkpoint('020'), metadata, {});
  const all = []; for await (const tuple of s.saver.list(s.config)) all.push(tuple);
  expect(all).toHaveLength(21);
  const last = await s.saver.getTuple(s.config);
  expect(last?.checkpoint.id).toBe('019');
  expect(last?.parentConfig?.configurable?.['checkpoint_id']).toBe('018');
  const filtered = [];
  for await (const tuple of s.saver.list(s.config, { before: { configurable: { checkpoint_id: '019' } }, filter: { details: { tags: [1] } }, limit: 1 })) filtered.push(tuple);
  expect(filtered.map((t) => t.checkpoint.id)).toEqual(['001']);
  const ns = [];
  for await (const tuple of s.saver.list({ configurable: { checkpoint_ns: '' } })) ns.push(tuple);
  expect(ns).toHaveLength(20);
  const wire = await s.transport({ kind: 'get', threadId: s.threadId, namespace: '', checkpointId: '019' });
  expect(wire.kind === 'get' && wire.tuple?.newVersions).toContain('19');
}, 15_000);

it('matches the installed public reserved-index overwrite and ordinary first-write semantics after reopening SQLite', async () => {
  const s = await start();
  const config = await s.saver.put(s.config, checkpoint('001'), metadata, {});
  await s.saver.putWrites(config, [['answer', false], ['__error__', { message: 'first' }]], 'task');
  await s.saver.putWrites(config, [['answer', true], ['__error__', { message: 'second' }], ['extra', new Uint8Array([1, 2])]], 'task');
  expect(WRITES_IDX_MAP['__error__']).toBe(-1);
  await s.stop();
  const restored = await start(s.path);
  expect((await restored.saver.getTuple(config))?.pendingWrites).toEqual(expect.arrayContaining([
    ['task', 'answer', false], ['task', '__error__', { message: 'second' }], ['task', 'extra', new Uint8Array([1, 2])],
  ]));
});

it('awaits a delayed commit ACK and propagates failed writes without reporting success', async () => {
  const s = await start();
  await s.arm({ phase: 'delay', kind: 'put', delayMs: 80 });
  let acknowledged = false;
  const pending = s.saver.put(s.config, checkpoint('001'), metadata, {}).then(() => { acknowledged = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(acknowledged).toBe(false);
  await pending;
  await s.arm({ phase: 'fail', kind: 'writes' });
  await expect(s.saver.putWrites({ configurable: { thread_id: s.threadId, checkpoint_id: '001' } }, [['__return__', 42]], 'task')).rejects.toThrow('injected transport failure');
  expect((await s.saver.getTuple(s.config))?.pendingWrites).toEqual([]);
});

it.each(['before', 'after'] as const)('survives child kill %s commit with stable-ID retry and explicit lost-ACK outcome', async (phase) => {
  const s = await start();
  let request: GraphCheckpointRequest | undefined;
  const saver = new RemoteCheckpointSaver(s.threadId, async (value) => { request = value; return s.transport(value); });
  await s.arm({ phase, kind: 'put' });
  const pending = saver.put(s.config, checkpoint('001'), metadata, {}).catch((error: unknown) => error);
  await s.event(`${phase}-commit`);
  await s.stop();
  expect(String(await pending)).toContain('ACK unknown');
  const restored = await start(s.path);
  expect(Boolean(await restored.saver.getTuple(restored.config))).toBe(phase === 'after');
  const response = await restored.transport(request!);
  expect(response).toEqual({ kind: 'put', checkpointId: '001' });
  expect(await restored.transport(request!)).toEqual(response);
  const list = []; for await (const tuple of restored.saver.list(restored.config)) list.push(tuple);
  expect(list).toHaveLength(1);
});

it('public Functional tasks persist RETURN/error and resume only incomplete work over delayed transport', async () => {
  const s = await start();
  const calls = { left: 0, right: 0 };
  let fail = true;
  const left = task('remote.left', () => { calls.left++; return 20; });
  const right = task({ name: 'remote.right', retry: { maxAttempts: 1 } }, () => { calls.right++; if (fail) throw new Error('branch failed'); return 22; });
  const graph = entrypoint({ name: 'remote', checkpointer: s.saver }, async (_input: object) => {
    const values = await Promise.all([left(), right()]); return values[0] + values[1];
  });
  await expect(graph.invoke({}, s.config)).rejects.toThrow('branch failed');
  const failed = await s.saver.getTuple(s.config);
  expect(failed?.pendingWrites?.some(([, channel, value]) => channel === '__return__' && value === 20)).toBe(true);
  expect(failed?.pendingWrites?.some(([, channel]) => channel === '__error__')).toBe(true);
  fail = false;
  expect(await graph.invoke(null, s.config)).toBe(42);
  expect(calls).toEqual({ left: 1, right: 2 });
  expect(await graph.invoke(null, s.config)).toBe(42);
  expect(calls).toEqual({ left: 1, right: 2 });
});

it('public Functional interrupt preserves resume false through SQLite and asynchronous ACK', async () => {
  const s = await start();
  const ask = task('remote.ask', () => interrupt('approve?'));
  const graph = entrypoint({ name: 'resume', checkpointer: s.saver }, async (_input: object) => ask());
  await graph.invoke({}, s.config);
  const pause = (await s.saver.getTuple(s.config))?.pendingWrites?.find(([, channel]) => channel === '__interrupt__')?.[2] as { id: string };
  expect(pause.id).toBeTruthy();
  expect(await graph.invoke(new Command({ resume: { [pause.id]: false } }), s.config)).toBe(false);
  expect(await graph.invoke(null, s.config)).toBe(false);
});

it.each(['__return__', '__end__'])('public Functional rejects transport failure at %s and recovers without inventing task completion', async (channel) => {
  const s = await start();
  let calls = 0;
  const work = task('remote.work', () => { calls++; return 42; });
  const graph = entrypoint({ name: 'failure', checkpointer: s.saver }, async (_input: object) => work());
  await s.arm({ phase: 'fail', kind: 'writes', channel });
  await expect(graph.invoke({}, s.config)).rejects.toThrow('injected transport failure');
  expect(await graph.invoke(null, s.config)).toBe(42);
  // The SDK can persist a later completed batch even when one earlier ACK fails.
  // invoke rejection alone does not imply that every checkpoint write rolled back.
  expect(calls).toBe(1);
});

it.each([
  ['before', '__return__', 2], ['after', '__return__', 1],
  ['before', '__end__', 1], ['after', '__end__', 1],
] as const)('public Functional recovers when persistence process is killed %s commit of %s', async (phase, channel, expectedCalls) => {
  const s = await start();
  let calls = 0;
  const work = task('crash.work', () => { calls++; return { value: 42 }; });
  const build = (saver: RemoteCheckpointSaver) => entrypoint({ name: 'crash', checkpointer: saver }, async (_input: object) => work());
  await s.arm({ phase, kind: 'writes', channel });
  const pending = build(s.saver).invoke({}, s.config).catch((error: unknown) => error);
  await s.event(`${phase}-commit`); await s.stop();
  expect(String(await pending)).toContain('ACK unknown');
  const restored = await start(s.path);
  expect(await build(restored.saver).invoke(null, restored.config)).toEqual({ value: 42 });
  expect(calls).toBe(expectedCalls);
});

it('validates all reserved pending-write indexes against the installed public map and permits writes before put', async () => {
  const s = await start();
  const config = { configurable: { thread_id: s.threadId, checkpoint_id: '001' } };
  const channels = Object.keys(WRITES_IDX_MAP);
  await s.saver.putWrites(config, channels.map((channel) => [channel, { data: false }]), 'task');
  await s.saver.put(s.config, checkpoint('001'), metadata, {});
  const response = await s.transport({ kind: 'get', threadId: s.threadId, namespace: '', checkpointId: '001' });
  if (response.kind !== 'get' || !response.tuple) throw new Error('missing tuple');
  expect(Object.fromEntries(response.tuple.pendingWrites.map((w) => [w.channel, w.index]))).toEqual(WRITES_IDX_MAP);
  await expect(s.saver.put(s.config, { ...checkpoint('002'), v: 3 }, metadata, {})).rejects.toThrow('unsupported checkpoint version');
});
it('rejects cursor-only pages that could silently skip public list history', async () => {
  const saver = new RemoteCheckpointSaver('run', async () => ({ kind: 'list', tuples: [], cursor: { namespace: '', checkpointId: '001' } }));
  await expect(saver.list({}).next()).rejects.toThrow('CHECKPOINT_CURSOR_INVALID');
});
it('serializes concurrent RPC write batches with a refreshed host fence', async () => {
  const s = await start();
  const config = await s.saver.put(s.config, checkpoint('001'), metadata, {});
  await Promise.all(Array.from({ length: 12 }, (_, index) => s.saver.putWrites(config, [['value', index]], `task-${index}`)));
  expect((await s.saver.getTuple(config))?.pendingWrites).toHaveLength(12);
});
it('bounds aggregate encoding before visiting later values in an oversized pending-write batch', async () => {
  const saver = new RemoteCheckpointSaver('run', async () => { throw new Error('transport must not run'); });
  const values: [string, unknown][] = Array.from({ length: 36 }, () => ['value', 'x'.repeat(262_144)]);
  values.push(['late unsupported value', new Date()]);
  await expect(saver.putWrites({ configurable: { checkpoint_id: '001' } }, values, 'task')).rejects.toThrow('CHECKPOINT_FRAME_LIMIT');
});
