import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMutationResult } from './lib/bridge-mutation-result.mjs';

const assertion = ' FAIL  src/guard.test.ts > refuses a forbidden write\nAssertionError: expected true to be false\n';
const run = overrides => ({ status: 1, signal: null, error: undefined, output: assertion, ...overrides });

test('kills a mutant only for a real failed assertion', () => {
  assert.equal(classifyMutationResult(run()), 'killed');
  assert.equal(classifyMutationResult(run({ output: `\x1b[31m${assertion}\x1b[0m` })), 'killed');
  assert.equal(classifyMutationResult(run({ status: 0, output: 'Tests 1 passed' })), 'survived');
  // A mutant can also trigger a product-domain refusal. The real assertion is
  // still a kill; startup/transport failures are rejected separately.
  assert.equal(classifyMutationResult(run({ output: `${assertion}\nError: resume_refused:child_halted` })), 'killed');
});

for (const [name, overrides] of [
  ['failure header without an assertion', { output: ' FAIL  src/guard.test.ts > guard\n' }],
  ['test timeout with a failure header', { output: ' FAIL  src/guard.test.ts > guard\nError: Test timed out in 5000ms' }],
  ['hook timeout alongside an assertion', { output: `${assertion}\nHook timed out in 10000ms` }],
  ['worker RPC timeout alongside an assertion', { output: `${assertion}\nError: [vitest-worker]: Timeout calling "onTaskUpdate"` }],
  ['unhandled errors alongside an assertion', { output: `${assertion}\nUnhandled Errors` }],
  ['spawn timeout', { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }],
  ['spawn startup failure', { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }],
  ['terminated child', { signal: 'SIGTERM' }],
  ['signal exit code', { status: 137 }],
  ['missing child exit code', { status: null }],
  ['import failure alongside an assertion', { output: `${assertion}\nFailed to load module` }],
  ['missing package alongside an assertion', { output: `${assertion}\nError: Cannot find package missing-dependency` }],
  ['worker startup failure alongside an assertion', { output: `${assertion}\nError: Worker exited unexpectedly` }],
  ['runtime error without an assertion', { output: ' FAIL  src/guard.test.ts > guard\nTypeError: invalid fixture' }],
]) test(`invalidates ${name}`, () => {
  assert.equal(classifyMutationResult(run(overrides)), 'invalid');
});
