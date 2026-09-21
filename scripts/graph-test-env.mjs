#!/usr/bin/env node
// Always allocate a new home for a command; never open the inherited control DB.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function canonical(path) {
  let probe = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  const suffix = [];
  while (!existsSync(probe)) {
    suffix.unshift(basename(probe));
    const parent = dirname(probe);
    if (parent === probe) throw new Error('Cannot resolve test home');
    probe = parent;
  }
  return resolve(realpathSync(probe), ...suffix);
}

export function assertIsolatedHome(home) {
  if (typeof home !== 'string' || !home.trim()) throw new Error('Test home must be explicit');
  const path = canonical(home);
  const stable = canonical(join(homedir(), '.osstack'));
  for (let probe = path; ; probe = dirname(probe)) {
    if (probe === stable) throw new Error('Refusing default serving home');
    if (existsSync(join(probe, 'control-plane-reserved.json'))) throw new Error('Refusing reserved serving home');
    if (probe === dirname(probe)) break;
  }
  return path;
}

export function createGraphTestEnv() {
  const home = assertIsolatedHome(mkdtempSync(join(tmpdir(), 'osstack-graph-test-')));
  return {
    home,
    env: { ...process.env, OSSTACK_HOME: home },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (!args.length) {
    console.error('Usage: node scripts/graph-test-env.mjs -- COMMAND [ARGS...]');
    process.exitCode = 1;
  } else {
    const fixture = createGraphTestEnv();
    try {
      const result = spawnSync(args[0], args.slice(1), { env: fixture.env, stdio: 'inherit' });
      if (result.error) console.error(result.error.message);
      process.exitCode = result.status ?? 1;
    } finally { fixture.cleanup(); }
  }
}
