#!/usr/bin/env node
// Repeatable fault-regression evidence, not a production/recovery admission gate.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, readdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = { seed: 250915, repeat: 2, output: undefined };
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]; const value = args[index + 1];
  if (!['--seed', '--repeat', '--output'].includes(name) || !value) throw Error('Usage: verify-graph-runtime.mjs [--seed UINT32] [--repeat 1..10] [--output ABSOLUTE_JSON_PATH]');
  if (name === '--output') options.output = value;
  else options[name.slice(2)] = Number(value);
}
if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff
  || !Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 10) throw Error('INVALID_SEED_OR_REPEAT');
const home = process.env.OSSTACK_HOME;
if (!home || !isAbsolute(home)) throw Error('EXPLICIT_ISOLATED_OSSTACK_HOME_REQUIRED');
mkdirSync(home, { recursive: true });
if (realpathSync(home) === resolve(homedir(), '.osstack')) throw Error('DEFAULT_OSSTACK_HOME_FORBIDDEN');
const output = options.output ?? join(home, 'graph-fault-validation.json');
if (!isAbsolute(output)) throw Error('ABSOLUTE_OUTPUT_REQUIRED');
mkdirSync(dirname(output), { recursive: true });
const evidence = `${output}.evidence`; mkdirSync(evidence, { recursive: true });
const groups = [
  { package: 'loop', files: ['src/executor.test.ts'] },
  { package: 'core', files: ['src/state/graph-checkpoints.test.ts', 'src/state/graph-recovery.test.ts', 'src/graph/artifact-store.test.ts'] },
  { package: 'cli', files: ['src/graph-process-identity.test.ts', 'src/graph-process-journal.test.ts',
    'src/graph-faults.integration.test.ts', 'src/graph-chain.integration.test.ts', 'src/graph-worker-manager.test.ts',
    'src/graph-checkpoint-service.test.ts', 'src/graph-action-broker.test.ts', 'src/graph-action-broker-boundary.test.ts',
    'src/graph-verification.test.ts', 'src/graph-verification-join.test.ts', 'src/graph-rpc.test.ts',
    'src/graph-concurrency.integration.test.ts', 'src/graph-review-findings.test.ts'] },
];
const coverage = {
  F01: ['loop/src/executor.test.ts'],
  F02: ['cli/src/graph-action-broker.test.ts', 'cli/src/graph-chain.integration.test.ts'],
  F03: ['cli/src/graph-chain.integration.test.ts'],
  F04: ['cli/src/graph-chain.integration.test.ts'],
  F05: ['core/src/state/graph-checkpoints.test.ts', 'cli/src/graph-chain.integration.test.ts'],
  F06: ['cli/src/graph-checkpoint-service.test.ts', 'cli/src/graph-action-broker-boundary.test.ts'],
  F07: ['core/src/graph/artifact-store.test.ts'],
  F08: ['cli/src/graph-review-findings.test.ts', 'cli/src/graph-concurrency.integration.test.ts'],
  F09: ['cli/src/graph-concurrency.integration.test.ts'],
  F10: ['cli/src/graph-verification.test.ts', 'cli/src/graph-verification-join.test.ts'],
  F11: ['loop/src/executor.test.ts', 'cli/src/graph-chain.integration.test.ts', 'cli/src/graph-concurrency.integration.test.ts'],
  F12: ['cli/src/graph-faults.integration.test.ts', 'cli/src/graph-rpc.test.ts', 'core/src/graph/artifact-store.test.ts'],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const listSources = () => execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages', 'scripts', 'pnpm-lock.yaml', 'package.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const sourceFiles = listSources();
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(join(root, file)))]));
const report = { schemaVersion: 1, scope: 'G25 fault regression diagnostics; no recovery or release authorization',
  platform: process.platform, node: process.version, seed: options.seed, repeat: options.repeat,
  startedAt: new Date().toISOString(), coverage, sourceHashes, runs: [], passed: false,
  limitations: ['Coverage lists regression suites, not proof that every F01–F12 subcase or production platform is admitted.',
    'Opaque executor quiescence and fresh-supervisor recovery remain separate requirements.',
    'A stale artifact lock is retained, not automatically removed.'] };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
save();
// Tests import both current TS and workspace dist, including real worker entrypoints.
// Rebuild before testing and attest both; a source hash alone cannot attest dist.
const build = spawnSync('pnpm', ['build'], { cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
writeFileSync(join(evidence, 'build.txt'), (build.stdout ?? '') + (build.stderr ?? ''));
report.build = { exitCode: build.status, ...(build.error ? { error: String(build.error) } : {}) };
const unchanged = () => JSON.stringify(listSources()) === JSON.stringify(sourceFiles)
  && sourceFiles.every(file => hash(readFileSync(join(root, file))) === sourceHashes[file]);
if (build.status !== 0 || !unchanged()) { save(); throw Error('BUILD_FAILED_OR_SOURCE_CHANGED'); }
function listArtifacts() {
  const files = [];
  const walk = path => {
    for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isDirectory()) walk(file); else if (item.isFile()) files.push(file);
    }
  };
  for (const item of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    const path = join('packages', item.name, 'dist'); if (item.isDirectory() && existsSync(join(root, path))) walk(path);
  }
  return files.sort();
}
const artifacts = listArtifacts();
if (!artifacts.length) throw Error('BUILD_ARTIFACTS_MISSING');
report.artifactHashes = Object.fromEntries(artifacts.map(file => [file, hash(readFileSync(join(root, file)))]));
save();
for (let iteration = 0; iteration < options.repeat; iteration++) {
  const seed = (options.seed + iteration) >>> 0;
  // Broad matrix once; repeat the seeded races without rerunning unrelated tests.
  const batches = iteration === 0 ? groups : [{ package: 'cli', files: ['src/graph-concurrency.integration.test.ts'] }];
  for (const group of batches) {
    const prefix = `${iteration}-${group.package}`;
    const jsonPath = join(evidence, `${prefix}.json`);
    const command = ['--filter', `@osstack/${group.package}`, 'exec', 'vitest', 'run', ...group.files,
      '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile=${jsonPath}`, '--sequence.shuffle', `--sequence.seed=${seed}`];
    const log = openSync(join(evidence, `${prefix}.txt`), 'w');
    let result;
    try { result = spawnSync('pnpm', command, { cwd: root, env: { ...process.env, G25_SEED: String(seed) }, stdio: ['ignore', log, log] }); }
    finally { closeSync(log); }
    let summary; let parseError;
    try { summary = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch (error) { parseError = String(error); }
    const tests = summary?.testResults?.flatMap(file => file.assertionResults ?? []) ?? [];
    const observedFiles = new Set((summary?.testResults ?? []).map(file => resolve(file.name)));
    const passed = result.status === 0 && summary?.success === true && tests.length > 0
      && tests.every(test => test.status === 'passed')
      && group.files.every(file => observedFiles.has(resolve(root, 'packages', group.package, file))
        && summary.testResults.some(result => resolve(result.name) === resolve(root, 'packages', group.package, file)
          && result.assertionResults?.length > 0));
    report.runs.push({ iteration, seed, package: group.package, command: ['pnpm', ...command], exitCode: result.status,
      passed, tests: tests.map(test => ({ name: test.fullName, status: test.status })), jsonPath, ...(parseError ? { parseError } : {}),
      ...(result.error ? { error: String(result.error) } : {}) });
    save();
    console.log(`${prefix}: ${passed ? 'PASS' : 'FAIL'} (${tests.length} tests), seed=${seed}`);
    if (!passed) { process.exitCode = 1; break; }
  }
  if (process.exitCode) break;
}
report.sourceUnchanged = unchanged();
report.artifactsUnchanged = JSON.stringify(listArtifacts()) === JSON.stringify(artifacts)
  && artifacts.every(file => hash(readFileSync(join(root, file))) === report.artifactHashes[file]);
report.finishedAt = new Date().toISOString();
report.passed = !process.exitCode && report.sourceUnchanged && report.artifactsUnchanged;
save(); console.log(JSON.stringify({ passed: report.passed, output, runs: report.runs.length }));
if (!report.passed) process.exitCode = 1;
