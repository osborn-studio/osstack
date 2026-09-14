import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createGraphTestEnv } from '../graph-test-env.mjs';
import { JournalSaver } from './graph-c2-runtime.mjs';
test('restart via public calls preserves full tuple, errors, and duplicate write semantics', async () => {
  const env = createGraphTestEnv();
  try {
    const path = join(env.home, 'journal.wire');
    const saver = await JournalSaver.open(path);
    const config = { configurable: { thread_id: 't' } };
    const checkpoint = { v: 4, id: '0001', ts: '2026-09-13T00:00:00Z', channel_values: {}, channel_versions: {}, versions_seen: {} };
    const next = await saver.put(config, checkpoint, { source: 'input', step: -1, parents: {} }, {});
    await saver.putWrites(next, [['results', ['completed']]], 'task');
    await saver.putWrites(next, [['__error__', { name: 'AbortError', message: 'cancel' }]], 'task');
    await saver.putWrites(next, [['results', ['duplicate ignored']]], 'task');
    const restored = await JournalSaver.open(path);
    assert.deepEqual(await restored.getTuple(config), await saver.getTuple(config));
    assert.deepEqual((await restored.getTuple(config)).pendingWrites.map((w) => w.slice(1)), [
      ['results', ['completed']], ['__error__', { name: 'AbortError', message: 'cancel' }],
    ]);
  } finally { env.cleanup(); }
});
test('invalid persisted method and argument shapes are refused before replay', async () => {
  const { persist } = await import('./graph-c2-runtime.mjs');
  const env = createGraphTestEnv();
  try {
    const file = join(env.home, 'invalid.wire');
    for (const row of [
      { method: 'toString', args: [] },
      { method: 'deleteThread', args: [42] },
      { method: 'putWrites', args: [{ configurable: { thread_id: 't' } }, [['results']], 'task'] },
    ]) {
      persist(file, [row]);
      await assert.rejects(JournalSaver.open(file), /invalid journal/);
    }
  } finally { env.cleanup(); }
});
test('failed persistence does not resurrect an uncommitted request on later append', async () => {
  const { mkdirSync } = await import('node:fs');
  const env = createGraphTestEnv();
  try {
    const file = join(env.home, 'missing', 'journal.wire');
    const saver = await JournalSaver.open(file);
    await assert.rejects(saver.deleteThread('failed'), /ENOENT/);
    mkdirSync(join(env.home, 'missing'));
    await saver.deleteThread('successful');
    assert.deepEqual((await JournalSaver.open(file)).records.map((r) => r.args), [['successful']]);
  } finally { env.cleanup(); }
});
