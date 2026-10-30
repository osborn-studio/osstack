import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createScratchDir } from './lib/scratch.mjs';

const cli = fileURLToPath(new URL('./prepare-bug-fix-method.mjs', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./fixtures/synthetic-bug-fix-compilation.json', import.meta.url), 'utf8'));
async function setup() {
  const root = await realpath(await createScratchDir('tests', 'prepare-method'));
  const compilation = structuredClone(fixture);
  compilation.target_repository = root; compilation.check_binding.repository = root;
  const request = { schema_version: 1, compilation, host: { workspace_path: root, package_version: '0.15.36',
    max_prompt_bytes: 65536, max_knowledge_bytes: 8192,
    capabilities: ['builder', 'reviewer', 'verifier'].map(role => ({ role, capability_id: `test.${role}` })) } };
  return { root, request, output: join(root, 'bundle') };
}
async function run(state, output = state.output) {
  const path = join(state.root, 'request.json'); await writeFile(path, JSON.stringify(state.request));
  return spawnSync(process.execPath, [cli, '--input', path, '--output', output], { encoding: 'utf8' });
}
test('compiles synthetic facts into exact three role bytes and a matching existing-host config', async () => {
  const state = await setup();
  try {
    const result = await run(state); assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout); assert.equal(receipt.executable, false);
    const compiled = JSON.parse(await readFile(join(state.output, 'compiled.json'), 'utf8'));
    const context = JSON.parse(await readFile(join(state.output, 'context.json'), 'utf8'));
    assert.equal(context.methods.task_id, compiled.proposal.task_id);
    assert.equal(context.methods.proposal_digest, compiled.proposal_digest);
    assert.deepEqual(context.methods.compiled, { path: 'bundle/compiled.json',
      sha256: createHash('sha256').update(await readFile(join(state.output, 'compiled.json'))).digest('hex') });
    assert.deepEqual(context.packs, []);
    for (const material of compiled.materials) {
      assert.equal(await readFile(join(state.output, `${material.role}.md`), 'utf8'), material.text);
      const row = context.methods.roles.find(r => r.role === material.role);
      assert.equal(row.materials[0].sha256, material.sha256);
      assert.equal(row.materials[0].path, `bundle/${material.role}.md`);
    }
    const again = await run(state); assert.equal(again.status, 2); assert.equal(JSON.parse(again.stderr).code, 'EEXIST');
    assert.equal(await readFile(join(state.output, 'compiled.json'), 'utf8'), JSON.stringify(compiled));
  } finally { await rm(state.root, { recursive: true, force: true }); }
});
for (const [name, mutate, code] of [
  ['missing required feature', x => { x.compilation.available_feature_ids = ['unrelated']; }, 'MISSING_FEATURE'],
  ['drifted role text', x => { x.compilation.materials[0].text += 'drift'; }, 'MATERIAL_DRIFT'],
  ['wrong source snapshot', x => { x.compilation.source_snapshot_digest = '0'.repeat(64); }, 'SOURCE_DIGEST_MISMATCH'],
  ['unregistered check', x => { x.compilation.check_registry.entries.pop(); }, 'CHECK_NOT_REGISTERED'],
  ['ambiguous capability mapping', x => { x.host.capabilities[1].capability_id = x.host.capabilities[0].capability_id; }, 'INVALID_CAPABILITY_MAPPING'],
  ['missing role', x => { x.host.capabilities.pop(); }, 'INVALID_REQUEST'],
  ['unrecognized request field', x => { x.approved = true; }, 'INVALID_REQUEST'],
  ['bad prompt budget', x => { x.host.max_prompt_bytes = 0; }, 'INVALID_REQUEST'],
  ['different target repository', x => { x.compilation.target_repository = '/another'; x.compilation.check_binding.repository = '/another'; }, 'REPOSITORY_MISMATCH'],
]) test(`rejects ${name} before creating output`, async () => {
  const state = await setup();
  try {
    mutate(state.request); const result = await run(state);
    assert.equal(result.status, 2, result.stdout); assert.equal(JSON.parse(result.stderr).code, code);
    await assert.rejects(readFile(join(state.output, 'compiled.json')), { code: 'ENOENT' });
  } finally { await rm(state.root, { recursive: true, force: true }); }
});
test('rejects parent symlinks even when they resolve inside the workspace', async () => {
  const state = await setup();
  try {
    await symlink(state.root, join(state.root, 'alias'));
    const result = await run(state, join(state.root, 'alias', 'bundle'));
    assert.equal(result.status, 2); assert.equal(JSON.parse(result.stderr).code, 'OUTPUT_ESCAPE_OR_SYMLINK');
  } finally { await rm(state.root, { recursive: true, force: true }); }
});
test('help does not import or invoke product modules', () => {
  assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /Compiles data only/);
});
for (const kind of ['file', 'directory']) test(`CLI ${kind} alias runs preparation instead of silently exiting`, async () => {
  const state = await setup();
  try {
    const alias = join(state.root, 'entry');
    await symlink(kind === 'file' ? cli : fileURLToPath(new URL('.', import.meta.url)), alias);
    const entry = kind === 'file' ? alias : join(alias, 'prepare-bug-fix-method.mjs');
    const input = join(state.root, 'request.json'); await writeFile(input, JSON.stringify(state.request));
    const result = spawnSync(process.execPath, [entry, '--input', input, '--output', state.output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'prepared');
    assert.equal(JSON.parse(await readFile(join(state.output, 'compiled.json'), 'utf8')).kind, 'compiled_bug_fix');
  } finally { await rm(state.root, { recursive: true, force: true }); }
});
test('importing the preparer has no CLI side effects', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./prepare-bug-fix-method.mjs', import.meta.url).href)})`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
test('prepared compiled bytes fit the host bound for escaped material near the compiler limit', async () => {
  const state = await setup();
  try {
    for (const material of state.request.compilation.materials) {
      material.text = '\u0001'.repeat(28600);
      material.sha256 = createHash('sha256').update(material.text).digest('hex');
    }
    const result = await run(state); assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(join(state.output, 'compiled.json'));
    assert.ok(bytes.length <= 524288, `compiled file is ${bytes.length} bytes`);
  } finally { await rm(state.root, { recursive: true, force: true }); }
});
