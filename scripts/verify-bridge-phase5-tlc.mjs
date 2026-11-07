#!/usr/bin/env node
// Exhaustive breadth-first TLC only. Model mutants are separate from source mutants.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchDir } from './lib/scratch.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = resolve(root, 'docs/design/specs');
const jar = process.env.TLA2TOOLS_JAR;
if (!jar) throw Error('Set TLA2TOOLS_JAR to the official tla2tools.jar path.');
const java = process.env.JAVA ?? 'java';
const mode = process.argv[2] ?? '--bounded';
const configs = mode === '--mutants' ? readdirSync(resolve(cwd, 'mutants')).filter(p => p.endsWith('.cfg')).sort().map(p => `mutants/${p}`)
  : mode === '--main' ? ['bridge.cfg', 'bridge-shadow.cfg', 'bridge-rounds.cfg']
  : mode === '--bounded' ? ['bridge-bounded.cfg'] : (() => { throw Error('Use --bounded, --main, or --mutants'); })();
const out = await createScratchDir('smoke', 'bridge-phase5-tlc');
const results = [];
for (const config of configs) {
  const name = config.replaceAll('/', '-').replace('.cfg', '');
  const run = spawnSync(java, ['-Xmx6g', '-XX:+UseParallelGC', '-cp', resolve(jar), 'tlc2.TLC', '-workers', '4', '-metadir', resolve(out, name), '-config', config, 'bridge.tla'], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const log = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  writeFileSync(resolve(out, `${name}.log`), log);
  const expectedFailure = mode === '--mutants';
  const passed = expectedFailure ? run.status === 12 && /Error: (Invariant|Action property|Temporal property)/.test(log)
    : run.status === 0 && log.includes('Model checking completed. No error has been found.') && /0 states left on queue/.test(log);
  results.push({ config, status: run.status, passed, kind: 'exhaustive-breadth-first', errors: log.split('\n').filter(line => line.startsWith('Error:')), configText: readFileSync(resolve(cwd, config), 'utf8') });
  writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${config}: ${passed ? 'pass' : 'fail'} (${run.status})`);
}
console.log(`Evidence: ${out}`);
if (results.some(r => !r.passed)) process.exitCode = 1;
