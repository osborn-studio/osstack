import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createScratchDir } from './lib/scratch.mjs';
import { loadBridgeRuntime } from './lib/bridge-installed-runtime.mjs';

const scratchEnv = process.env;
const commit = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const installedPaths = {
  runtime: 'lib/node_modules/@osstack/cli/dist/bridge-production.js',
  core: 'lib/node_modules/@osstack/core/dist/index.js',
  agents: 'lib/node_modules/@osstack/agents/dist/index.js',
  governance: 'lib/node_modules/@osstack/governance/dist/index.js',
  appModule: 'lib/node_modules/@osstack/cli/dist/bridge-github-app.js',
};
const checkoutPaths = {
  runtime: 'packages/cli/dist/bridge-production.js',
  core: 'packages/core/dist/index.js',
  agents: 'packages/agents/dist/index.js',
  governance: 'packages/governance/dist/index.js',
  appModule: 'packages/cli/dist/bridge-github-app.js',
};

async function fixture(t, mode = 'installed') {
  const root = await realpath(await createScratchDir('tests', 'bridge-installed-runtime', scratchEnv));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, 'prefix');
  const counter = `bridge-imports:${root}`;
  t.after(() => { delete globalThis[counter]; });
  await mkdir(prefix);
  await writeFile(join(prefix, 'package.json'), '{"type":"module"}\n');
  const paths = mode === 'installed' ? installedPaths : checkoutPaths;
  for (const [key, path] of Object.entries(paths)) {
    const target = join(prefix, path);
    await mkdir(join(target, '..'), { recursive: true });
    const reader = key === 'agents' ? 'export function readCodexProxyPatch() { throw Error("reader must not be called by loader"); }\n' : '';
    const grammar = key === 'governance' ? 'export function parseMissionPatch() { throw Error("parser must not be called by loader"); }\nexport function classifyMissionPatch() { throw Error("classifier must not be called by loader"); }\n' : '';
    await writeFile(target, `globalThis[${JSON.stringify(counter)}] = (globalThis[${JSON.stringify(counter)}] ?? 0) + 1;\nexport const selected = ${JSON.stringify(`${mode}:${key}`)};\n${reader}${grammar}`);
  }
  if (mode === 'installed') await writeFile(join(prefix, 'candidate-manifest.json'), JSON.stringify({ source_commit: commit, kind: 'unactivated-local-candidate' }) + '\n');
  return { root, prefix, counter, paths };
}

async function rejectsWithoutImport(f, options, pattern) {
  await assert.rejects(loadBridgeRuntime(options), pattern);
  assert.equal(globalThis[f.counter], undefined, 'validation must complete before any entry executes');
}

test('installed selection imports exactly five entries and binds their bytes and marker', async t => {
  const f = await fixture(t);
  assert.equal(globalThis[f.counter], undefined);
  const result = await loadBridgeRuntime({ runtimePrefix: f.prefix, expectedSourceCommit: commit });
  assert.equal(globalThis[f.counter], 5);
  for (const key of Object.keys(installedPaths)) {
    assert.equal(result[key].selected, `installed:${key}`);
    assert.deepEqual(result.provenance.entries[key], { path: join(f.prefix, installedPaths[key]), sha256: hash(await readFile(join(f.prefix, installedPaths[key]))) });
  }
  assert.equal(result.provenance.mode, 'installed');
  assert.equal(result.provenance.root, f.prefix);
  assert.equal(result.provenance.sourceCommit, commit);
  assert.deepEqual(result.provenance.sourceMarker, { path: join(f.prefix, 'candidate-manifest.json'), sha256: hash(await readFile(join(f.prefix, 'candidate-manifest.json'))) });
});

test('checkout selection uses checkout entries without requiring a candidate manifest', async t => {
  const f = await fixture(t, 'checkout');
  const result = await loadBridgeRuntime({ checkoutRoot: f.prefix });
  for (const key of Object.keys(checkoutPaths)) {
    assert.equal(result[key].selected, `checkout:${key}`);
    assert.deepEqual(result.provenance.entries[key], { path: join(f.prefix, checkoutPaths[key]), sha256: hash(await readFile(join(f.prefix, checkoutPaths[key]))) });
  }
  assert.equal(typeof result.agents.readCodexProxyPatch, 'function');
  assert.equal(typeof result.governance.parseMissionPatch, 'function');
  assert.equal(typeof result.governance.classifyMissionPatch, 'function');
  assert.equal(result.provenance.mode, 'checkout');
  assert.equal(result.provenance.sourceCommit, null);
  assert.equal(result.provenance.sourceMarker, null);
  assert.equal(globalThis[f.counter], 5);
});

test('installed mode does not read or use checkoutRoot', async t => {
  const f = await fixture(t);
  assert.equal((await loadBridgeRuntime({ runtimePrefix: f.prefix, checkoutRoot: '/nonexistent/checkout' })).runtime.selected, 'installed:runtime');
});

test('relative, empty and non-string installed prefixes fail closed', async t => {
  const f = await fixture(t);
  for (const runtimePrefix of ['relative', '', null, 7]) await rejectsWithoutImport(f, { runtimePrefix }, /bridge_runtime_prefix_absolute_required/);
});

test('expected source uses full commit equality before imports', async t => {
  const f = await fixture(t);
  await rejectsWithoutImport(f, { runtimePrefix: f.prefix, expectedSourceCommit: 'b'.repeat(40) }, /bridge_runtime_source_mismatch/);
  for (const expectedSourceCommit of ['aaaa', '', null, 7]) await rejectsWithoutImport(f, { runtimePrefix: f.prefix, expectedSourceCommit }, /bridge_runtime_expected_source_invalid/);
});

test('checkout cannot silently ignore an expected installed commit', async t => {
  const f = await fixture(t, 'checkout');
  await rejectsWithoutImport(f, { checkoutRoot: f.prefix, expectedSourceCommit: commit }, /bridge_runtime_expected_source_requires_installed/);
});

test('missing, malformed and invalid source markers reject before imports', async t => {
  const f = await fixture(t);
  const marker = join(f.prefix, 'candidate-manifest.json');
  await rm(marker);
  await rejectsWithoutImport(f, { runtimePrefix: f.prefix }, /ENOENT/);
  for (const body of ['{', 'null', '[]', '{}', '{"source_commit":"short"}', '{"source_commit":1}']) {
    await writeFile(marker, body);
    await rejectsWithoutImport(f, { runtimePrefix: f.prefix }, /bridge_runtime_manifest_invalid/);
  }
});

test('SHA256 source commits are accepted without abbreviation', async t => {
  const f = await fixture(t);
  const sha256Commit = 'c'.repeat(64);
  await writeFile(join(f.prefix, 'candidate-manifest.json'), JSON.stringify({ source_commit: sha256Commit }));
  assert.equal((await loadBridgeRuntime({ runtimePrefix: f.prefix, expectedSourceCommit: sha256Commit })).provenance.sourceCommit, sha256Commit);
});

test('every selected entry rejects symlinks into a sibling prefix', async t => {
  for (const key of Object.keys(installedPaths)) {
    const f = await fixture(t);
    const outside = join(f.root, 'prefix-escape.js');
    await writeFile(outside, 'throw Error("escaped module executed");');
    await rm(join(f.prefix, installedPaths[key]));
    await symlink(outside, join(f.prefix, installedPaths[key]));
    await rejectsWithoutImport(f, { runtimePrefix: f.prefix }, /bridge_runtime_path_escape/);
  }
});

test('source marker symlink cannot escape the selected prefix', async t => {
  const f = await fixture(t);
  const marker = join(f.prefix, 'candidate-manifest.json');
  const outside = join(f.root, 'manifest.json');
  await writeFile(outside, JSON.stringify({ source_commit: commit }));
  await rm(marker);
  await symlink(outside, marker);
  await rejectsWithoutImport(f, { runtimePrefix: f.prefix }, /bridge_runtime_path_escape/);
});

test('symlinks within a canonical prefix are allowed and provenance uses real paths', async t => {
  const f = await fixture(t);
  const path = join(f.prefix, installedPaths.runtime);
  const real = join(f.prefix, 'runtime-entry.js');
  await writeFile(real, await readFile(path));
  await rm(path);
  await symlink(real, path);
  const alias = join(f.root, 'prefix-alias');
  await symlink(f.prefix, alias);
  const result = await loadBridgeRuntime({ runtimePrefix: alias });
  assert.equal(result.provenance.root, f.prefix);
  assert.equal(result.provenance.entries.runtime.path, real);
});

test('missing entries and directories reject before importing any valid entry', async t => {
  const f = await fixture(t);
  const target = join(f.prefix, installedPaths.appModule);
  await rm(target);
  await rejectsWithoutImport(f, { runtimePrefix: f.prefix }, /ENOENT/);
  await mkdir(target);
  await rejectsWithoutImport(f, { runtimePrefix: f.prefix }, /bridge_runtime_file_required/);
});

test('missing agents never falls back to a valid checkout and rejects before all imports', async t => {
  const installed = await fixture(t);
  const checkout = await fixture(t, 'checkout');
  const target = join(installed.prefix, installedPaths.agents);
  await rm(target);
  const options = { runtimePrefix: installed.prefix, checkoutRoot: checkout.prefix };
  await rejectsWithoutImport(installed, options, /ENOENT/);
  await mkdir(target);
  await rejectsWithoutImport(installed, options, /bridge_runtime_file_required/);
  assert.equal(globalThis[checkout.counter], undefined);
});

test('agents reader must be an exported function in either selected mode', async t => {
  for (const mode of ['installed', 'checkout']) {
    for (const body of ['export const unrelated = true;', 'export const readCodexProxyPatch = "invalid";']) {
      const f = await fixture(t, mode);
      await writeFile(join(f.prefix, f.paths.agents), body);
      const options = mode === 'installed' ? { runtimePrefix: f.prefix } : { checkoutRoot: f.prefix };
      await assert.rejects(loadBridgeRuntime(options), /bridge_runtime_agents_reader_required/);
    }
  }
});

test('agents import failure propagates without using a valid checkout reader', async t => {
  const installed = await fixture(t);
  const checkout = await fixture(t, 'checkout');
  await writeFile(join(installed.prefix, installedPaths.agents), 'throw Error("selected_agents_import_failed");');
  await assert.rejects(loadBridgeRuntime({ runtimePrefix: installed.prefix, checkoutRoot: checkout.prefix }), /selected_agents_import_failed/);
  assert.equal(globalThis[checkout.counter], undefined);
});

test('missing governance never falls back to a valid checkout and rejects before all imports', async t => {
  const installed = await fixture(t);
  const checkout = await fixture(t, 'checkout');
  const target = join(installed.prefix, installedPaths.governance);
  await rm(target);
  const options = { runtimePrefix: installed.prefix, checkoutRoot: checkout.prefix };
  await rejectsWithoutImport(installed, options, /ENOENT/);
  await mkdir(target);
  await rejectsWithoutImport(installed, options, /bridge_runtime_file_required/);
  assert.equal(globalThis[checkout.counter], undefined);
});

test('governance grammar parser must be an exported function in either selected mode', async t => {
  for (const mode of ['installed', 'checkout']) {
    for (const body of ['export const unrelated = true;', 'export const parseMissionPatch = "invalid";']) {
      const f = await fixture(t, mode);
      await writeFile(join(f.prefix, f.paths.governance), body);
      const options = mode === 'installed' ? { runtimePrefix: f.prefix } : { checkoutRoot: f.prefix };
      await assert.rejects(loadBridgeRuntime(options), /bridge_runtime_governance_parser_required/);
    }
  }
});

test('governance import failure propagates without using a valid checkout parser', async t => {
  const installed = await fixture(t);
  const checkout = await fixture(t, 'checkout');
  await writeFile(join(installed.prefix, installedPaths.governance), 'throw Error("selected_governance_import_failed");');
  await assert.rejects(loadBridgeRuntime({ runtimePrefix: installed.prefix, checkoutRoot: checkout.prefix }), /selected_governance_import_failed/);
  assert.equal(globalThis[checkout.counter], undefined);
});

test('governance classifier must be an exported function even when the parser is valid', async t => {
  for (const mode of ['installed', 'checkout']) {
    for (const classifier of ['', 'export const classifyMissionPatch = "invalid";']) {
      const f = await fixture(t, mode);
      const checkout = await fixture(t, 'checkout');
      await writeFile(join(f.prefix, f.paths.governance), `export function parseMissionPatch() { throw Error("parser must not be called"); }\n${classifier}`);
      const options = mode === 'installed' ? { runtimePrefix: f.prefix, checkoutRoot: checkout.prefix } : { checkoutRoot: f.prefix };
      await assert.rejects(loadBridgeRuntime(options), /bridge_runtime_governance_classifier_required/);
      assert.equal(globalThis[checkout.counter], undefined, 'invalid selected classifier must not use another checkout');
    }
  }
});
