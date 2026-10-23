import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedResult } from './graph-c2-ledger.mjs';
const identity = { run: 'fixture-run', effect: 'completed', attempt: 1 };
const row = { ...identity, status: 'confirmed', result: { results: ['completed'] } };
test('only an independently confirmed matching result permits replay', () => {
  assert.deepEqual(trustedResult(row, identity), row.result);
  for (const status of ['unknown', 'started', 'failed', 'cancelled']) {
    assert.throws(() => trustedResult({ ...row, status }, identity), /reconcile/);
  }
  assert.throws(() => trustedResult(undefined, identity), /reconcile/);
});
test('receipt for another run, effect or attempt does not authorize replay', () => {
  for (const changed of [{ run: 'other' }, { effect: 'flaky' }, { attempt: 2 }]) {
    assert.throws(() => trustedResult({ ...row, ...changed }, identity), /identity/);
  }
});
test('malformed result is refused and returned data has no shared references', () => {
  assert.throws(() => trustedResult({ ...row, result: null }, identity), /result/);
  const result = trustedResult(row, identity);
  result.results.push('untrusted');
  assert.deepEqual(row.result, { results: ['completed'] });
});
test('unresolved effect blocks new effects across the fixture run', async () => {
  const { assertCanStart } = await import('./graph-c2-ledger.mjs');
  for (const status of ['started', 'unknown', 'failed', 'cancelled']) {
    assert.throws(() => assertCanStart({ completed: { ...row, status } }, identity.run), /reconcile/);
  }
  assert.doesNotThrow(() => assertCanStart({ completed: row }, identity.run));
  assert.doesNotThrow(() => assertCanStart({}, identity.run));
  assert.throws(() => assertCanStart({ completed: row }, 'other'), /identity/);
});
