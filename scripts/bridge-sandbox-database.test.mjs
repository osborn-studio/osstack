import assert from 'node:assert/strict';
import test from 'node:test';
import { openDurableSandboxDb } from './lib/bridge-sandbox-database.mjs';

test('every opened connection becomes FULL and is read back before the caller may write', () => {
  const calls = [];
  const core = { openDb: input => { calls.push(input.path); return { pragma: (...args) => {
    calls.push(args); return args[0] === 'synchronous' ? 2 : [];
  } }; } };
  for (const path of ['initial', 'reopened', 'worker']) openDurableSandboxDb(core, path);
  assert.deepEqual(calls, ['initial', ['synchronous=FULL'], ['synchronous', { simple: true }],
    'reopened', ['synchronous=FULL'], ['synchronous', { simple: true }],
    'worker', ['synchronous=FULL'], ['synchronous', { simple: true }]]);
});

test('a refused or unconfirmed durability change closes and preserves its primary failure', () => {
  let closes = 0;
  const failure = Error('pragma');
  assert.throws(() => openDurableSandboxDb({ openDb: () => ({ pragma: () => { throw failure; },
    close: () => { closes++; throw Error('close'); } }) }, 'local'), error => error === failure);
  assert.throws(() => openDurableSandboxDb({ openDb: () => ({ pragma: () => 1,
    close: () => { closes++; } }) }, 'local'), /durability_required/);
  assert.equal(closes, 2);
});
