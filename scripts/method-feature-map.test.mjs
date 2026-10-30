import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createScratchDir } from './lib/scratch.mjs';
import { selectFeatureMap } from './method-feature-map.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cliPath = resolve('scripts/method-feature-map.mjs');
const leaf = (id, outcome) => ({ schema_version: 1, feature_id: id, user_outcome: outcome,
  source_revision: 'source-a', driver_version: 'driver-a', entries: [{ id: 'run', surface: 'cli', user_route: 'node fixed-script --output OWNED' }],
  preconditions: [{ id: 'build', kind: 'runtime', description: 'Matching build required.' }], drive_refs: ['fixed-script'],
  observations: [{ predicate_id: 'exit', observable: 'Read raw receipt.', side_effects: [] }], gotchas: [],
  recovery_refs: ['Preserve receipts.'], covered_entry_ids: [], known_gaps: [], last_live_evidence: [] });
async function fixture(t) {
  const root = await createScratchDir('tests', 'feature-map');
  t.after(() => rm(root, { recursive: true, force: true }));
  const features = [];
  for (const [id, outcome, keywords, required] of [
    ['maintenance', 'Maintain expectation map', ['maintenance', '地图'], []],
    ['journey', 'Run live checks', ['journey', '验证'], []],
    ['packet', 'Project evidence', ['packet', '证据'], ['journey']],
  ]) {
    const value = leaf(id, outcome);
    const bytes = JSON.stringify(value);
    await writeFile(join(root, `${id}.json`), bytes);
    features.push({ feature_id: id, user_outcome: outcome, keywords, surfaces: ['cli'], leaf_ref: `${id}.json`, sha256: digest(bytes), required_feature_ids: required, maintenance_owner_ref: null });
  }
  const index = join(root, 'index.json');
  const model = { schema_version: 1, features };
  const save = () => writeFile(index, JSON.stringify(model));
  await save();
  const edit = async (id, fn) => {
    const row = features.find(row => row.feature_id === id);
    const path = join(root, row.leaf_ref);
    const value = JSON.parse(await readFile(path, 'utf8'));
    fn(value);
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes); row.sha256 = digest(bytes); await save();
  };
  return { root, index, model, save, edit };
}
const code = expected => error => error.code === expected;
const call = args => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', timeout: 10000 });

test('metadata ranking reads no unrelated body and reports unknown execution separately', async t => {
  const f = await fixture(t); const reads = [];
  await rm(join(f.root, 'packet.json'));
  await f.edit('journey', x => { x.gotchas = ['maintenance '.repeat(200)]; });
  const result = await selectFeatureMap({ index: f.index, query: 'maintenance' }, { onRead: x => reads.push(x) });
  assert.deepEqual(result.selected.map(x => x.feature_id), ['maintenance']);
  assert.deepEqual(reads.filter(x => x.kind === 'leaf').map(x => x.path), [join(f.root, 'maintenance.json')]);
  assert.equal(result.selection_status, 'complete');
  assert.equal(result.selected[0].availability, 'unknown');
  assert.equal(result.selected[0].execution_status, 'not_run');
  assert.deepEqual(result.selected[0].unverified_entry_ids, ['run']);
  assert.equal(result.selected[0].evidence_status, 'draft');
});
test('required low-ranking journey is loaded, correction produces a fresh narrower selection', async t => {
  const f = await fixture(t);
  const result = await selectFeatureMap({ index: f.index, query: '证据', limit: 1 });
  assert.deepEqual(result.selected.map(x => x.feature_id), ['packet', 'journey']);
  assert.equal(result.selected[1].reasons[0].required_by, 'packet');
  assert.deepEqual(result.omitted.map(x => x.feature_id), ['maintenance']);
  assert.deepEqual((await selectFeatureMap({ index: f.index, query: '地图' })).selected.map(x => x.feature_id), ['maintenance']);
});
test('no match never falls back to all materials', async t => {
  const f = await fixture(t);
  const result = await selectFeatureMap({ index: f.index, query: 'unmatched' });
  assert.equal(result.selection_status, 'no_match'); assert.deepEqual(result.selected, []);
  const run = call(['--index', f.index, '--query', 'unmatched']);
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).selection_status, 'no_match');
});
for (const [name, mutate, expected] of [
  ['missing dependency body', async f => rm(join(f.root, 'journey.json')), 'required_material_missing'],
  ['same-length material drift', async f => { const p = join(f.root, 'journey.json'); await writeFile(p, (await readFile(p, 'utf8')).replace('source-a', 'source-b')); }, 'content_drift'],
  ['unknown dependency', async f => { f.model.features[2].required_feature_ids = ['absent']; await f.save(); }, 'unknown_dependency'],
  ['cycle outside ranked feature', async f => { f.model.features[0].required_feature_ids = ['maintenance']; await f.save(); }, 'dependency_cycle'],
  ['duplicate IDs', async f => { f.model.features.push(f.model.features[0]); await f.save(); }, 'invalid_index'],
  ['escaping path', async f => { f.model.features[1].leaf_ref = '../foreign.json'; await f.save(); }, 'path_escape'],
  ['terminal symlink', async f => { await rm(join(f.root, 'journey.json')); await symlink('maintenance.json', join(f.root, 'journey.json')); }, 'symlink'],
  ['ancestor symlink', async f => { await mkdir(join(f.root, 'actual')); await symlink('actual', join(f.root, 'link')); f.model.features[1].leaf_ref = 'link/journey.json'; await f.save(); }, 'symlink'],
  ['nonregular', async f => { await rm(join(f.root, 'journey.json')); await mkdir(join(f.root, 'journey.json')); }, 'not_regular'],
  ['leaf oversized', async f => { await writeFile(join(f.root, 'journey.json'), 'x'.repeat(32769)); }, 'file_too_large'],
  ['closed leaf', async f => f.edit('journey', x => { x.verified = true; }), 'invalid_leaf'],
  ['identity mismatch', async f => f.edit('journey', x => { x.feature_id = 'elsewhere'; }), 'leaf_identity_mismatch'],
  ['coverage unknown entry', async f => f.edit('journey', x => { x.covered_entry_ids = ['other']; }), 'invalid_leaf'],
]) test(`fails closed: ${name}`, async t => {
  const f = await fixture(t); await mutate(f);
  await assert.rejects(selectFeatureMap({ index: f.index, query: 'packet' }), code(expected));
});
test('caller observations distinguish blocked, unknown and drift without certifying entries or evidence', async t => {
  const f = await fixture(t);
  await f.edit('maintenance', x => { x.entries.push({ id: 'inspect', surface: 'cli', user_route: 'node inspect' }); x.covered_entry_ids = ['run']; x.last_live_evidence = [{ ref: 'historical', sha256: 'a'.repeat(64) }]; });
  const path = join(f.root, 'observed.json');
  const observed = { schema_version: 1, features: [{ feature_id: 'maintenance', source_revision: 'source-a', driver_version: 'changed', preconditions: [{ id: 'build', status: 'missing' }], observed_entry_ids: ['run'] }] };
  await writeFile(path, JSON.stringify(observed));
  const result = await selectFeatureMap({ index: f.index, query: 'maintenance', observations: path });
  const selected = result.selected[0];
  assert.equal(selected.freshness.source, 'matches_reported'); assert.equal(selected.freshness.driver, 'drift');
  assert.equal(selected.preconditions[0].status, 'blocked'); assert.equal(selected.availability, 'drift');
  assert.equal(selected.evidence_status, 'unverified'); assert.deepEqual(selected.unverified_entry_ids, ['run', 'inspect']);
  assert.deepEqual(selected.caller_observed_entry_ids, ['run']); assert.equal(result.selection_status, 'complete');
  observed.features[0].driver_version = 'driver-a'; await writeFile(path, JSON.stringify(observed));
  assert.equal((await selectFeatureMap({ index: f.index, query: 'maintenance', observations: path })).selected[0].availability, 'blocked');
  observed.features[0].preconditions[0].status = 'met'; await writeFile(path, JSON.stringify(observed));
  assert.equal((await selectFeatureMap({ index: f.index, query: 'maintenance', observations: path })).selected[0].availability, 'reported_available');
  observed.features[0].observed_entry_ids = ['missing']; await writeFile(path, JSON.stringify(observed));
  await assert.rejects(selectFeatureMap({ index: f.index, query: 'maintenance', observations: path }), code('invalid_observations'));
});
test('closure count rejects rather than silently omitting required leaves', async t => {
  const f = await fixture(t);
  for (let n = 0; n < 7; n++) f.model.features.push({ ...f.model.features[0], feature_id: `extra-${n}`, required_feature_ids: [] });
  f.model.features[2].required_feature_ids = f.model.features.filter(x => x.feature_id !== 'packet').map(x => x.feature_id);
  await f.save(); const reads = [];
  await assert.rejects(selectFeatureMap({ index: f.index, query: 'packet' }, { onRead: x => reads.push(x) }), code('selection_budget'));
  assert.equal(reads.filter(x => x.kind === 'leaf').length, 0);
});
test('aggregate leaf bytes reject instead of truncating required material', async t => {
  const f = await fixture(t);
  f.model.features[2].required_feature_ids = ['journey', 'maintenance'];
  for (let n = 0; n < 2; n++) {
    const id = `extra-${n}`, row = { ...f.model.features[0], feature_id: id, leaf_ref: `${id}.json`, required_feature_ids: [] };
    await writeFile(join(f.root, row.leaf_ref), JSON.stringify(leaf(id, row.user_outcome))); f.model.features.push(row); f.model.features[2].required_feature_ids.push(id);
  }
  for (const row of f.model.features) await f.edit(row.feature_id, x => { x.gotchas = Array.from({ length: 7 }, (_, i) => `${i}${'x'.repeat(3900)}`); });
  const reads = [];
  await assert.rejects(selectFeatureMap({ index: f.index, query: 'packet' }, { onRead: x => reads.push(x) }), code('selection_budget'));
  assert.equal(reads.filter(x => x.kind === 'leaf').length, 4, 'over-budget fifth body must not be read');
});
test('CLI JSON and help are bounded, bad arguments do not read input', async t => {
  const f = await fixture(t);
  const ok = call(['--index', f.index, '--query', 'packet']); assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).selected.length, 2); assert.equal(ok.stderr, '');
  const help = call(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /not product/);
  for (const args of [[], ['--index', f.index, '--query', 'packet', '--limit', '0'], ['--index', f.index, '--query', 'packet', '--query', 'journey']]) {
    const bad = call(args); assert.equal(bad.status, 2); assert.equal(bad.stdout, ''); assert.equal(JSON.parse(bad.stderr).error, 'invalid_arguments');
  }
});

test('no preconditions plus no observations is unknown, and blank coverage never certifies a run', async t => {
  const f = await fixture(t); await f.edit('maintenance', x => { x.preconditions = []; });
  const selected = (await selectFeatureMap({ index: f.index, query: 'maintenance' })).selected[0];
  assert.equal(selected.availability, 'unknown'); assert.deepEqual(selected.preconditions, []);
  assert.deepEqual(selected.declared_covered_entry_ids, []); assert.deepEqual(selected.unverified_entry_ids, ['run']);
});
for (const [name, mutate, expected] of [
  ['index unknown field', async f => { f.model.authorized = true; await f.save(); }, 'invalid_index'],
  ['surface mismatch', async f => { f.model.features[0].surfaces = ['rpc']; await f.save(); }, 'leaf_identity_mismatch'],
  ['invalid leaf UTF8', async f => { const bytes = Buffer.from([0xff]); await writeFile(join(f.root, 'maintenance.json'), bytes); f.model.features[0].sha256 = digest(bytes); await f.save(); }, 'invalid_utf8'],
  ['invalid leaf JSON', async f => { const bytes = '{broken'; await writeFile(join(f.root, 'maintenance.json'), bytes); f.model.features[0].sha256 = digest(bytes); await f.save(); }, 'invalid_json'],
  ['oversize index', async f => writeFile(f.index, ' '.repeat(65537)), 'file_too_large'],
  ['index symlink', async f => { await rm(f.index); await symlink('maintenance.json', f.index); }, 'symlink'],
]) test(`input boundary: ${name}`, async t => {
  const f = await fixture(t); await mutate(f);
  await assert.rejects(selectFeatureMap({ index: f.index, query: 'maintenance' }), code(expected));
});
for (const [name, mutate] of [
  ['unknown key', x => { x.features[0].verified = true; }],
  ['unknown feature', x => { x.features[0].feature_id = 'absent'; }],
  ['unknown prerequisite', x => { x.features[0].preconditions[0].id = 'absent'; }],
  ['duplicate prerequisite', x => { x.features[0].preconditions.push(x.features[0].preconditions[0]); }],
  ['unapproved not-applicable', x => { x.features[0].preconditions[0].status = 'not_applicable'; }],
  ['duplicate feature', x => { x.features.push(x.features[0]); }],
]) test(`caller observations reject ${name}`, async t => {
  const f = await fixture(t), path = join(f.root, 'observations.json');
  const data = { schema_version: 1, features: [{ feature_id: 'maintenance', source_revision: null, driver_version: null, preconditions: [{ id: 'build', status: 'unknown' }], observed_entry_ids: [] }] };
  mutate(data); await writeFile(path, JSON.stringify(data));
  await assert.rejects(selectFeatureMap({ index: f.index, query: 'maintenance', observations: path }), code('invalid_observations'));
});
test('CLI distinguishes unavailable required material from invalid input without partial stdout', async t => {
  const f = await fixture(t); await rm(join(f.root, 'journey.json'));
  const missing = call(['--index', f.index, '--query', 'packet']);
  assert.equal(missing.status, 3); assert.equal(missing.stdout, '');
  assert.deepEqual(JSON.parse(missing.stderr), { schema_version: 1, error: 'required_material_missing', details: { feature_id: 'journey' } });
  await assert.rejects(selectFeatureMap({ index: f.index, query: '界'.repeat(1366) }), code('invalid_arguments'));
  const observed = join(f.root, 'observed.json'); await writeFile(observed, ' '.repeat(65537));
  await assert.rejects(selectFeatureMap({ index: f.index, query: 'maintenance', observations: observed }), code('file_too_large'));
});
test('reading is byte-preserving and does not modify any source', async t => {
  const f = await fixture(t);
  const before = await Promise.all(['index', 'maintenance', 'journey', 'packet'].map(id => readFile(join(f.root, `${id}.json`))));
  const result = await selectFeatureMap({ index: f.index, query: 'packet' });
  assert.equal(result.index_sha256, digest(before[0]));
  for (const selected of result.selected) {
    const raw = await readFile(join(f.root, selected.leaf_ref));
    assert.equal(selected.sha256, digest(raw)); assert.equal(selected.bytes, raw.length); assert.deepEqual(selected.leaf, JSON.parse(raw));
  }
  const after = await Promise.all(['index', 'maintenance', 'journey', 'packet'].map(id => readFile(join(f.root, `${id}.json`))));
  assert.deepEqual(after, before);
});

for (const [query, expected] of [
  ['maintain expectation map', ['maintenance']],
  ['full journey drive', ['journey']],
  ['project retained packet', ['packet', 'journey']],
]) test(`repository feature index is usable through CLI: ${query}`, async () => {
  const indexPath = resolve('docs/verification/features/index.json');
  const run = call(['--index', indexPath, '--query', query, '--limit', '1']);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.selected.map(x => x.feature_id), expected);
  assert.equal(result.index_sha256, digest(await readFile(indexPath)));
  for (const row of result.selected) {
    const raw = await readFile(resolve('docs/verification/features', row.leaf_ref));
    assert.equal(row.sha256, digest(raw)); assert.equal(row.bytes, raw.length);
    assert.equal(row.execution_status, 'not_run'); assert.equal(row.availability, 'unknown');
    assert.equal(row.evidence_status, 'draft'); assert.equal(row.maintenance_owner_ref, null);
    assert.deepEqual(row.unverified_entry_ids, row.leaf.entries.map(x => x.id));
  }
});
