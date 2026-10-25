#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertIsolatedHome } from './graph-test-env.mjs';
const home = assertIsolatedHome(process.env.OSSTACK_HOME);
const output = resolve(process.argv[2] ?? home + '/supervision-active-performance.json');
const result = spawnSync('pnpm', ['--filter', '@osstack/cli', 'exec', 'vitest', 'run',
  'src/supervision-active-qualification.test.ts', '--maxWorkers=1'], {
  stdio: 'inherit', env: { ...process.env, OSSTACK_SUPERVISION_QUALIFICATION_REPORT: output },
});
console.log(JSON.stringify({ output, passed: result.status === 0 }));
process.exitCode = result.status ?? 1;
