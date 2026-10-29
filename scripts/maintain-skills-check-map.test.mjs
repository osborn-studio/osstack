import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, realpath, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createScratchDir } from './lib/scratch.mjs';
import { sha256 } from './lib/skills-check-verification.mjs';
import { parseOptions, runMaintenance } from './maintain-skills-check-map.mjs';

const ids = ['healthy', 'missing-ref', 'drift', 'mixed', 'empty'];
const exits = [0, 1, 2, 1, 0];
const statuses = ['healthy', 'failed', 'drift', 'failed', 'empty'];
const makeMap = () => ({ schema_version: 1, target: 'skills-check-full', features: ids.map((case_id, i) => ({ case_id, expected_product_exit: exits[i], expected_product_status: statuses[i] })) });
async function setup(t, map = makeMap()) {
  const root = await realpath(await createScratchDir('tests', 'skills-map-maintenance'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'map.json'); await writeFile(file, JSON.stringify(map, null, 2) + '\n');
  return { root, map: file, output: join(root, 'output') };
}
// Unit seams exercise comparison/closeout. Real five-case runs are separate release evidence, not this suite.
async function passedJourney({ output, scope }) {
  assert.equal(scope, 'full'); await mkdir(output);
  const result = { status: 'passed', features: ids.map((case_id, i) => ({ case_id, verification: 'passed', product_exit: exits[i], product_status: statuses[i], driver_exit: 0, evidence_state: 'sealed', bindings: { source_digest: 'a'.repeat(64), build_digest: 'b'.repeat(64) }, cleanup: { status: 'passed', fixture_removed: true, descendant_termination: 'not_attested' } })), limitations: ['test seam, not actual product evidence'] };
  await writeFile(join(output, 'journey.json'), JSON.stringify(result));
  await writeFile(join(output, 'journey-manifest.json'), JSON.stringify({ files: [] }));
  return result;
}
const seam = { journey: passedJourney };
test('fixed CLI accepts only two absolute paths, without arbitrary scope or command', () => {
  assert.deepEqual(parseOptions(['--map', '/m', '--output', '/o']), { map: '/m', output: '/o' });
  for (const argv of [[], ['--map', '/m'], ['--map', 'relative', '--output', '/o'], ['--map', '/m', '--output', '/o', '--scope', 'full'], ['--map', '/m', '--map', '/x', '--output', '/o']]) assert.throws(() => parseOptions(argv));
});
test('valid five-row map keeps empty distinct from healthy and preserves input bytes', async t => {
  const f = await setup(t); const before = await readFile(f.map); const result = await runMaintenance(f, seam);
  assert.equal(result.exit_code, 0); assert.equal(result.status, 'consistent'); assert.equal(result.rows.length, 5);
  assert.equal(result.rows.at(-1).actual.product_status, 'empty'); assert.equal(result.map.unchanged, true);
  assert.equal(result.map.before_sha256, sha256(before)); assert.deepEqual(await readFile(join(f.output, 'map-before.json')), before);
  assert.deepEqual(await readFile(f.map), before); assert.equal(result.formal_gate_pass, false);
  assert.equal(result.journey.limitations[0], 'test seam, not actual product evidence');
});
test('legal stale expectation fails comparison, then only map correction succeeds with fresh output', async t => {
  const map = makeMap(); map.features[1].expected_product_exit = 0; const f = await setup(t, map);
  const red = await runMaintenance(f, seam); assert.equal(red.exit_code, 1); assert.equal(red.status, 'mismatch');
  assert.deepEqual(red.rows.filter(r => !r.matches).map(r => r.case_id), ['missing-ref']);
  const original = await readFile(join(f.output, 'map-before.json'));
  map.features[1].expected_product_exit = 1; await writeFile(f.map, JSON.stringify(map));
  const green = await runMaintenance({ map: f.map, output: join(f.root, 'corrected') }, seam);
  assert.equal(green.exit_code, 0); assert.deepEqual(await readFile(join(f.output, 'map-before.json')), original);
});
test('correct exits with wrong legal source status remain mismatch', async t => {
  const m = makeMap(); m.features[4].expected_product_status = 'healthy'; const f = await setup(t, m);
  const result = await runMaintenance(f, seam); assert.equal(result.exit_code, 1); assert.equal(result.rows.at(-1).matches, false);
});
test('row order does not change stable-ID correspondence', async t => {
  const m = makeMap(); m.features.reverse(); const f = await setup(t, m);
  assert.equal((await runMaintenance(f, seam)).exit_code, 0);
});
for (const [name, change] of Object.entries({
  missing: m => m.features.pop(), duplicate: m => { m.features[4] = m.features[0]; }, unknown: m => { m.features[4].case_id = 'custom'; },
  extra: m => { m.command = 'echo anything'; }, extraRow: m => { m.features[0].command = 'anything'; },
  type: m => { m.features[0].expected_product_exit = '0'; }, status: m => { m.features[0].expected_product_status = 'passed'; },
})) test(`invalid ${name} map refuses before output acquisition or driving`, async t => {
  const m = makeMap(); change(m); const f = await setup(t, m); let calls = 0;
  await assert.rejects(runMaintenance(f, { journey: async () => { calls++; } }), /map_/);
  assert.equal(calls, 0); assert.deepEqual((await readdir(f.root)).sort(), ['map.json']);
});
test('oversized, invalid UTF-8, symlink and directory maps refuse before driving', async t => {
  const f = await setup(t); let calls = 0; const noDrive = { journey: async () => { calls++; } };
  await writeFile(f.map, Buffer.alloc(65537, 32)); await assert.rejects(runMaintenance(f, noDrive), /map_size/);
  await writeFile(f.map, Buffer.from([0xff])); await assert.rejects(runMaintenance(f, noDrive));
  await rm(f.map); await mkdir(f.map); await assert.rejects(runMaintenance(f, noDrive), /map_regular/);
  await rm(f.map, { recursive: true }); await writeFile(join(f.root, 'actual.json'), JSON.stringify(makeMap())); await symlink('actual.json', f.map);
  await assert.rejects(runMaintenance(f, noDrive)); assert.equal(calls, 0);
});
test('existing output is not reused or overwritten', async t => {
  const f = await setup(t); await mkdir(f.output); await writeFile(join(f.output, 'sentinel'), 'keep');
  await assert.rejects(runMaintenance(f, seam), /EEXIST/); assert.equal(await readFile(join(f.output, 'sentinel'), 'utf8'), 'keep');
});
test('map changed during drive blocks otherwise valid observations', async t => {
  const f = await setup(t); const before = await readFile(f.map);
  const result = await runMaintenance(f, { journey: async args => { const j = await passedJourney(args); await writeFile(f.map, Buffer.concat([before, Buffer.from(' ')])); return j; } });
  assert.equal(result.exit_code, 2); assert.equal(result.status, 'blocked'); assert.equal(result.failure, 'map_changed');
  assert.equal(result.map.unchanged, false); assert.deepEqual(await readFile(join(f.output, 'map-before.json')), before);
});
test('failed journey cannot become maintenance success despite matching earlier rows', async t => {
  const f = await setup(t);
  const result = await runMaintenance(f, { journey: async args => { const j = await passedJourney(args); j.status = 'failed'; j.failure = 'cross_case_bindings_changed'; await writeFile(join(args.output, 'journey.json'), JSON.stringify(j)); return j; } });
  assert.equal(result.exit_code, 2); assert.equal(result.status, 'blocked'); assert.equal(result.journey.failure, 'cross_case_bindings_changed');
});
test('not_run and unknown cleanup are never promoted to complete coverage', async t => {
  const f = await setup(t);
  const result = await runMaintenance(f, { journey: async args => { const j = await passedJourney(args); j.features[4].verification = 'not_run'; j.features[0].cleanup.status = 'unknown'; await writeFile(join(args.output, 'journey.json'), JSON.stringify(j)); return j; } });
  assert.equal(result.exit_code, 2); assert.equal(result.failure, 'journey_incomplete');
});
test('real runJourney with a stubbed driver retains doctor failure and later not_run states', async t => {
  const f = await setup(t);
  const result = await runMaintenance(f, { invoke: async () => ({ stdout: '', stderr: 'test prerequisite absent', exit_code: 1, signal: null }) });
  assert.equal(result.exit_code, 2); assert.equal(result.journey.status, 'failed');
  const j = JSON.parse(await readFile(join(f.output, 'journey/journey.json')));
  assert.equal(j.failure, 'doctor_execution_failed'); assert.equal(j.features[0].verification, 'failed'); assert.ok(j.features.slice(1).every(x => x.verification === 'not_run'));
});
test('CLI invalid input exits 2 with no output directory', async t => {
  const f = await setup(t, {}); const p = spawnSync(process.execPath, ['scripts/maintain-skills-check-map.mjs', '--map', f.map, '--output', f.output], { encoding: 'utf8', env: process.env });
  assert.equal(p.status, 2); assert.equal(JSON.parse(p.stderr).status, 'blocked'); assert.deepEqual(await readdir(f.root), ['map.json']);
});

test('journey failure stays primary when the input map disappears at closeout', async t => {
  const f = await setup(t);
  const result = await runMaintenance(f, { journey: async args => {
    const j = await passedJourney(args); j.status = 'failed'; j.failure = 'doctor_execution_failed';
    await writeFile(join(args.output, 'journey.json'), JSON.stringify(j)); await rm(f.map); return j;
  } });
  assert.equal(result.exit_code, 2); assert.equal(result.failure, 'journey_failed');
  assert.deepEqual(result.subsequent_failures, ['map_after:ENOENT']);
  assert.equal(result.journey.failure, 'doctor_execution_failed');
});
test('map change and its snapshot write failure do not erase the earlier journey failure', async t => {
  const f = await setup(t);
  const result = await runMaintenance(f, { journey: async args => {
    const j = await passedJourney(args); j.status = 'failed'; j.failure = 'drive_execution_failed';
    await writeFile(join(args.output, 'journey.json'), JSON.stringify(j));
    await writeFile(f.map, '{}'); await writeFile(join(f.output, 'map-after.json'), 'owned collision'); return j;
  } });
  assert.equal(result.failure, 'journey_failed'); assert.equal(result.exit_code, 2);
  assert.deepEqual(result.subsequent_failures, ['map_changed', 'map_after:EEXIST']);
  assert.equal(await readFile(join(f.output, 'map-after.json'), 'utf8'), 'owned collision');
});
test('missing manifest retains partial journey metadata and later map-change diagnosis', async t => {
  const f = await setup(t);
  const result = await runMaintenance(f, { journey: async args => {
    const j = await passedJourney(args); await rm(join(args.output, 'journey-manifest.json'));
    await writeFile(f.map, '{}'); return j;
  } });
  assert.equal(result.exit_code, 2); assert.equal(result.failure, 'ENOENT');
  assert.deepEqual(result.subsequent_failures, ['map_changed']);
  assert.equal(result.journey.features.length, 5); assert.equal(result.journey.status, 'passed');
  assert.match(result.journey.receipt_sha256, /^[a-f0-9]{64}$/); assert.equal(result.journey.manifest_sha256, null);
  assert.equal(result.journey.receipt_matches_returned, true);
});
test('receipt identity failure remains primary and labels partial metadata as unconfirmed', async t => {
  const f = await setup(t);
  const result = await runMaintenance(f, { journey: async args => {
    const j = await passedJourney(args); await writeFile(join(args.output, 'journey.json'), '{}');
    await writeFile(f.map, '{}'); return j;
  } });
  assert.equal(result.failure, 'journey_result_identity'); assert.equal(result.exit_code, 2);
  assert.deepEqual(result.subsequent_failures, ['map_changed']);
  assert.equal(result.journey.receipt_matches_returned, false); assert.equal(result.journey.features.length, 5);
});
test('programmatic test seams are declared, not represented as normal CLI execution', async t => {
  const f = await setup(t); const result = await runMaintenance(f, seam);
  assert.equal(result.execution_path, 'injected_journey'); assert.equal(result.formal_gate_pass, false);
  const next = await runMaintenance({ map: f.map, output: join(f.root, 'injected-driver') }, { invoke: async () => ({ stdout: '', stderr: '', exit_code: 1 }) });
  assert.equal(next.execution_path, 'runJourney_with_injected_driver');
});
