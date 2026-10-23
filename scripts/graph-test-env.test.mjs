import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { assertIsolatedHome, createGraphTestEnv } from './graph-test-env.mjs';

test('fresh fixtures override inherited state and reject serving homes and aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-env-test-'));
  try {
    assert.throws(() => assertIsolatedHome(join(homedir(), '.osstack')), /default/);
    assert.throws(() => assertIsolatedHome(''), /explicit/);
    writeFileSync(join(root, 'control-plane-reserved.json'), '{}');
    const alias = root + '-alias';
    symlinkSync(root, alias);
    try {
      assert.throws(() => assertIsolatedHome(alias), /reserved/);
      assert.throws(() => assertIsolatedHome(join(alias, 'nested')), /reserved/);
    } finally { rmSync(alias); }
    const fixture = createGraphTestEnv();
    try {
      assert.notEqual(fixture.env.OSSTACK_HOME, process.env.OSSTACK_HOME);
      assert.equal(assertIsolatedHome(fixture.home), fixture.home);
    } finally { fixture.cleanup(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
