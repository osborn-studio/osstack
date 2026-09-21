#!/usr/bin/env node
// Opt-in real measurement; preserves the existing RPC <10ms and Loop <1% budgets.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertIsolatedHome } from './graph-test-env.mjs';
const home = assertIsolatedHome(process.env.OSSTACK_HOME);
const output = resolve(process.argv[2] ?? home + '/graph-performance.json');
const result = spawnSync('pnpm', ['--filter','@osstack/cli','test','src/graph-performance.test.ts',
  'src/graph-worker-manager.test.ts','src/daemon-rpc-latency.test.ts','--maxWorkers=1'], {
  stdio: 'inherit', env: { ...process.env, OSSTACK_GRAPH_BENCH_REPORT: output },
});
console.log(JSON.stringify({ output, passed: result.status === 0 })); process.exitCode = result.status ?? 1;
