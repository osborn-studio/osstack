import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openDb } from '@osstack/core';
import { GraphDelegationStatus } from '@osstack/protocol';
import { GraphRpcService } from './graph-rpc.js';
import { graphDeliveryVersion } from './graph-delivery.js';
import { compileGraphSpec } from '@osstack/graph/spec-compiler';
import { graphRpcFixture } from './graph-test-fixture.js';

const seed = Number(process.env['G25_SEED'] ?? 250915);
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw Error('INVALID_G25_SEED');
function shuffle<T>(items: T[]): T[] {
  let state = seed || 1;
  for (let i = items.length - 1; i > 0; i--) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const index = (state >>> 0) % (i + 1);
    [items[i], items[index]] = [items[index]!, items[i]!];
  }
  return items;
}

it(`F09 seed=${seed}: two SQLite connections deduplicate a submit burst and reject changed payloads`, async () => {
  const f = await graphRpcFixture();
  const db = openDb({ path: join(f.root, 'control.sqlite') });
  const peer = new GraphRpcService({ ...f.options, db });
  try {
    const calls = shuffle(Array.from({ length: 24 }, (_, i) => i));
    const responses = await Promise.all(calls.map(i => (i % 2 ? peer : f.service).handle(f.connection, 'graph.submit', f.request)));
    const ids = responses.map(value => GraphDelegationStatus.parse(value).graphRunId);
    expect(new Set(ids).size).toBe(1);
    const changed = { ...f.request, spec: { ...f.request.spec, limits: { ...f.request.spec.limits, maxActionStarts: 15 } } };
    await expect(peer.handle(f.connection, 'graph.submit', changed)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const ready = await f.until(ids[0]!, value => value.status === 'ready');
    expect(f.writes()).toBe(1);
    expect(ready.budget.actionStarts).toBe(7);
    expect(db.prepare('SELECT count(*) n FROM graph_worker_launches').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM graph_verification_joins').get()).toEqual({ n: 1 });
  } finally { await peer.close(); db.close(); await f.close(); }
}, 30000);

it(`F08/F11 seed=${seed}: competing cancellation revisions cannot relaunch a revoked writer`, async () => {
  const f = await graphRpcFixture('cancel');
  try {
    const first = await f.start(); await f.until(first.graphRunId, () => f.writes() === 1);
    f.grant(false);
    const before = await f.status(first.graphRunId);
    const requests = shuffle(Array.from({ length: 12 }, (_, i) => ({ schemaVersion: 1, kind: 'cancel', scope: f.request.scope,
      idempotencyKey: `cancel-${i}`, graphRunId: first.graphRunId, expectedRevision: before.revision })));
    const outcomes = await Promise.allSettled(requests.map(request => f.service.handle(f.connection, 'graph.cancel', request)));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of outcomes) if (result.status === 'rejected') expect(String(result.reason)).toContain('REVISION_CONFLICT');
    const cancelled = await f.until(first.graphRunId, value => value.status === 'cancelled');
    const winner = requests[outcomes.findIndex(result => result.status === 'fulfilled')]!;
    expect(await f.service.handle(f.connection, 'graph.cancel', winner)).toMatchObject({ status: 'cancelled' });
    expect(cancelled.generation).toBe(1); expect(f.writes()).toBe(1); expect(f.abortObserved()).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({ n: 0 });
  } finally { await f.close(); }
}, 30000);

it(`F09/F11 seed=${seed}: resume and cancel race commits one revision without resetting the budget`, async () => {
  const f = await graphRpcFixture('repair');
  try {
    const first = await f.start(); const waiting = await f.until(first.graphRunId, value => value.status === 'waiting_input');
    const common = { schemaVersion: 1, scope: f.request.scope, graphRunId: first.graphRunId, expectedRevision: waiting.revision };
    const requests = shuffle([
      { method: 'graph.resume', request: { ...common, kind: 'resume', idempotencyKey: 'race-resume', interruptId: waiting.interrupt!.interruptId,
        input: { kind: 'data', value: { inputDigest: waiting.inputDigest } } } },
      { method: 'graph.cancel', request: { ...common, kind: 'cancel', idempotencyKey: 'race-cancel' } },
    ]);
    const results = await Promise.allSettled(requests.map(({ method, request }) => f.service.handle(f.connection, method, request)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(result => result.status === 'rejected')!;
    if (loser.status === 'rejected') expect(String(loser.reason)).toContain('REVISION_CONFLICT');
    const final = await f.until(first.graphRunId, value => ['ready', 'cancelled'].includes(value.status));
    expect(final.createdAt).toBe(first.createdAt);
    expect(final.inputDigest).toBe(first.inputDigest);
    expect(final.budget.actionStarts).toBeGreaterThanOrEqual(waiting.budget.actionStarts);
    expect(f.writes()).toBe(final.status === 'ready' ? 2 : 1);
  } finally { await f.close(); }
}, 45000);

it(`F09 seed=${seed}: independent processes race on the same durable key without creating a second run`, async () => {
  const f = await graphRpcFixture();
  const input = join(f.root, 'admission.json');
  await writeFile(input, JSON.stringify({ path: join(f.root, 'control.sqlite'), request: f.request,
    version: graphDeliveryVersion(compileGraphSpec(f.request.spec)) }));
  const children = Array.from({ length: 4 }, () => fork(fileURLToPath(new URL('../../../scripts/fixtures/graph-submit-race.mjs', import.meta.url)), [input], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, OSSTACK_HOME: join(f.root, 'isolated-home') },
  }));
  const exits = children.map(child => once(child, 'exit'));
  try {
    const ready = await Promise.all(children.map(child => once(child, 'message', { signal: AbortSignal.timeout(5000) })));
    for (const [message] of ready) expect(message).toEqual({ kind: 'ready' });
    const replies = children.map(child => once(child, 'message', { signal: AbortSignal.timeout(5000) }));
    for (const child of shuffle([...children])) child.send('go');
    const responses = (await Promise.all(replies)).map(([value]) => value as { kind: string; graphRunId: string });
    expect(responses.every(value => value.kind === 'created')).toBe(true);
    expect(new Set(responses.map(value => value.graphRunId)).size).toBe(1);
    await Promise.all(exits);
    expect(f.db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_requests').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM graph_worker_launches').get()).toEqual({ n: 0 });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(exits); await f.close();
  }
}, 15000);
