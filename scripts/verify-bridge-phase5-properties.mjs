#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createScratchDir, scratchRoot } from './lib/scratch.mjs';

const root = resolve(import.meta.dirname, '..');
const suites = [
  ['linked-range', '@osstack/core', 'src/bridge/revision-chain.property.test.ts'],
  ['exact-spec', '@osstack/cli', 'src/contained-mission-revision.spec-property.test.ts'],
];
const files = [
  ...suites.map(([, pkg, test]) => `packages/${pkg.split('/')[1]}/${test}`),
  'packages/core/src/state/engineering-revision-chain-store.ts',
  'packages/cli/src/contained-mission-revision.ts',
  'pnpm-lock.yaml',
];
const out = await createScratchDir('runtime', 'bridge-final-properties');
const env = {
  OSSTACK_PROPERTY_RUNS: '10000',
  OSSTACK_PROPERTY_SEED: '51007',
  OSSTACK_PROPERTY_COVERAGE: '1',
  OSSTACK_HOME: resolve(out, 'home'),
  OSSTACK_SCRATCH_ROOT: scratchRoot(),
};
mkdirSync(env.OSSTACK_HOME, { mode: 0o700 });

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function snapshot() {
  return {
    head: git('rev-parse', 'HEAD').trim(),
    sha256: Object.fromEntries(files.map(file => [file, fileHash(resolve(root, file))])),
    tracked_status: git('status', '--porcelain', '--untracked-files=no'),
  };
}

const results = [];
for (const [name, pkg, test] of suites) {
  const command = ['pnpm', '--filter', pkg, 'test', test, '--maxWorkers=1', '--minWorkers=1'];
  const log = resolve(out, `${name}.log`);
  const started_at = new Date().toISOString();
  const before = snapshot();
  const fd = openSync(log, 'w');
  let result;
  try {
    result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', fd, fd],
      timeout: 30 * 60 * 1000,
    });
  } finally {
    closeSync(fd);
  }
  const finished_at = new Date().toISOString();
  const after = snapshot();
  const stable = isDeepStrictEqual(before, after);
  const { status, signal, error } = result;
  const verdict = status === 0 && signal === null && !error && stable ? 'pass' : 'fail';
  results.push({
    name, started_at, before, command, env, finished_at, after, stable, status, signal,
    spawn_error: error?.code ?? error?.message ?? null, verdict, log, log_sha256: fileHash(log),
  });
}
const report = resolve(out, 'property-runs.json');
writeFileSync(report, `${JSON.stringify(results, null, 2)}\n`);
console.log(report);
if (results.some(result => result.verdict !== 'pass')) process.exitCode = 1;
