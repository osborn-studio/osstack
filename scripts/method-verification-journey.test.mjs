import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createScratchDir } from './lib/scratch.mjs';
import { jsonBytes, sha256, sealEvidence, caseDefinition } from './lib/skills-check-verification.mjs';
import { verifyCaseEvidence, parseOptions, runJourney } from './method-verification-journey.mjs';

async function setup(t) {
  const root = await createScratchDir('tests', 'method-journey');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function evidenceFixture(t, id = 'missing-ref') {
  const root = await setup(t); const directory = join(root, 'evidence'); await mkdir(directory);
  const scratch = join(root, 'scratch'); await mkdir(join(scratch, 'smoke'), { recursive: true });
  const fixture = join(scratch, 'smoke', 'skills-check-owned');
  const expected = caseDefinition(id, 'file:///owned-origin', 'a'.repeat(40), 'b'.repeat(40));
  const input = jsonBytes({ version: 1, sources: expected.sources });
  const stdout = `Checking 1 source(s) against their tracked refs...\n${id === 'healthy' ? '  ✓ healthy  up-to-date (bbbbbbbbbbbb)' : '  ✗ missing-ref  unreachable: no_matching_ref'}\n${expected.failed} source(s) failed to check.\n0 source(s) drifted from blessed_sha.\n`;
  const command = { executable: process.execPath, argv: ['/target/packages/cli/dist/bin.js', 'skills', 'check'], cwd: fixture, environment: { OSSTACK_HOME: join(fixture, `home-${id}`) },
    exit_code: expected.expected_exit, signal: null, direct_child_exit_confirmed: true, timed_out: false, output_limited: false, interrupted: false, spawn_error: null,
    stdout_path: `${id}.stdout`, stderr_path: `${id}.stderr`, stdout_sha256: sha256(Buffer.from(stdout)), stderr_sha256: sha256(Buffer.alloc(0)) };
  const observed = { case_id: id, verification_status: 'passed', actual_exit: expected.expected_exit, expected_exit: expected.expected_exit,
    source_check_status: id === 'healthy' ? 'healthy' : 'failed', input_unchanged: true, errors: [] };
  const cleanup = { status: 'passed', fixture_path: fixture, fixture_removed: true, descendant_termination: 'not_attested' };
  const receipt = { run_id: 'fixture-run', status: 'passed', driver_exit: 0, selected_cases: [id], cases: [observed], behavior: 'passed', cleanup,
    failure: null, provider_qualified: false, evidence: { directory, manifest: 'manifest.json', bindings: 'bindings.json' }, binding_digests: { source_digest: sha256(Buffer.from('[]')), build_digest: sha256(Buffer.from('[]')) } };
  const files = { 'receipt.json': receipt, 'cleanup.json': cleanup, 'run.json': { run_id: receipt.run_id, status: 'passed', selected_cases: [id], bindings_unchanged: true,
    bindings: receipt.binding_digests, final_bindings: receipt.binding_digests }, 'bindings.json': { source: { digest: sha256(Buffer.from('[]')), files: [] }, build: { digest: sha256(Buffer.from('[]')), files: [] } },
    'expectations.json': { definitions: [expected] }, [`${id}.command.json`]: command,
    [`${id}.json`]: { ...command, ...observed, manifest_before_sha256: sha256(input), manifest_after_sha256: sha256(input), input_path: `${id}.input.json` } };
  for (const [name, data] of Object.entries(files)) await writeFile(join(directory, name), jsonBytes(data));
  await writeFile(join(directory, `${id}.input.json`), input);
  await writeFile(join(directory, `${id}.stdout`), stdout); await writeFile(join(directory, `${id}.stderr`), '');
  await sealEvidence(directory, receipt.run_id);
  return { directory, scratch, fixture, receipt, id, args: { directory, scratch, caseId: id, repository: '/target', stdout: jsonBytes(receipt), driverExit: 0 } };
}
async function mutate(f, name, action, reseal = false) {
  const path = join(f.directory, name); const value = JSON.parse(await readFile(path)); action(value); await writeFile(path, jsonBytes(value));
  if (reseal) { await rm(join(f.directory, 'manifest.json')); await sealEvidence(f.directory, f.receipt.run_id); }
}

test('fixed API rejects arbitrary case, repository, relative path and duplicate output', () => {
  assert.deepEqual(parseOptions(['--output', '/scratch/new']), { output: '/scratch/new' });
  for (const args of [[], ['--case', 'all'], ['--output', 'relative'], ['--output', '/a', '--output', '/b'], ['--repository', '/repo']]) assert.throws(() => parseOptions(args));
});
for (const id of ['healthy', 'missing-ref']) test(`${id}: independently verify raw artifacts while retaining product/driver exit distinction`, async (t) => {
  const f = await evidenceFixture(t, id); const result = await verifyCaseEvidence(f.args);
  assert.equal(result.product_exit, id === 'healthy' ? 0 : 1); assert.equal(result.driver_exit, 0);
  assert.equal(result.cleanup.descendant_termination, 'not_attested'); assert.equal(result.verification, 'passed');
});
test('receipt tamper is rejected even if caller stdout is changed to match', async (t) => {
  const f = await evidenceFixture(t); await mutate(f, 'receipt.json', r => { r.driver_exit = 1; });
  await assert.rejects(verifyCaseEvidence({ ...f.args, stdout: await readFile(join(f.directory, 'receipt.json')) }), /manifest_hash/);
});
test('missing raw command cannot be hidden by a freshly resealed manifest', async (t) => {
  const f = await evidenceFixture(t); await rm(join(f.directory, `${f.id}.command.json`)); await rm(join(f.directory, 'manifest.json')); await sealEvidence(f.directory, f.receipt.run_id);
  await assert.rejects(verifyCaseEvidence(f.args), /required_evidence/);
});
test('resealed raw output contradiction fails the actual behavior predicate', async (t) => {
  const f = await evidenceFixture(t); await writeFile(join(f.directory, `${f.id}.stdout`), 'all fine\n');
  await mutate(f, `${f.id}.command.json`, r => { r.stdout_sha256 = sha256(Buffer.from('all fine\n')); }, true);
  await assert.rejects(verifyCaseEvidence(f.args), /behavior/);
});
test('claimed removal is insufficient while owned fixture actually exists', async (t) => {
  const f = await evidenceFixture(t); await mkdir(f.fixture);
  await assert.rejects(verifyCaseEvidence(f.args), /fixture_still_exists/);
});
test('manifest paths cannot escape the evidence directory', async (t) => {
  const f = await evidenceFixture(t); await mutate(f, 'manifest.json', m => { m.files[0].path = '../outside'; });
  await assert.rejects(verifyCaseEvidence(f.args), /manifest_path/);
});
test('stdout must match the saved receipt bytes', async (t) => {
  const f = await evidenceFixture(t); await assert.rejects(verifyCaseEvidence({ ...f.args, stdout: Buffer.from('{}') }), /receipt_stdout/);
});
test('existing output stays untouched; no doctor is invoked', async (t) => {
  const root = await setup(t); const output = join(root, 'existing'); await mkdir(output); await writeFile(join(output, 'keep'), 'original');
  let calls = 0; await assert.rejects(runJourney({ output }, { invoke: async () => { calls++; } }), /EEXIST/);
  assert.equal(calls, 0); assert.deepEqual(await readdir(output), ['keep']);
});
test('failed doctor preserves raw failure and marks second feature not run', async (t) => {
  const root = await setup(t); const output = join(root, 'journey'); let calls = 0;
  const result = await runJourney({ output }, { invoke: async () => { calls++; return { exit_code: 1, signal: null, killed: false, stdout: Buffer.from('{"ready":false,"executed":false}'), stderr: Buffer.from('missing build') }; } });
  assert.equal(calls, 1); assert.equal(result.status, 'failed'); assert.equal(result.features[0].verification, 'failed');
  assert.equal(result.features[1].verification, 'not_run'); assert.match(await readFile(join(output, 'healthy-doctor.stderr'), 'utf8'), /missing build/);
  assert.equal(result.host_execution, 'not_run'); assert.match(await readFile(join(output, 'feature-map.md'), 'utf8'), /not_run/);
});

test('duplicate manifest members are rejected', async (t) => {
  const f = await evidenceFixture(t); await mutate(f, 'manifest.json', m => { m.files.push(m.files[0]); });
  await assert.rejects(verifyCaseEvidence(f.args), /manifest_path/);
});
test('foreign cleanup path cannot stand in for owned fixture disappearance', async (t) => {
  const f = await evidenceFixture(t);
  await mutate(f, 'cleanup.json', c => { c.fixture_path = '/outside/skills-check-owned'; }, true);
  const receipt = JSON.parse(await readFile(join(f.directory, 'receipt.json'))); receipt.cleanup.fixture_path = '/outside/skills-check-owned';
  await writeFile(join(f.directory, 'receipt.json'), jsonBytes(receipt)); await rm(join(f.directory, 'manifest.json')); await sealEvidence(f.directory, receipt.run_id);
  await assert.rejects(verifyCaseEvidence({ ...f.args, stdout: jsonBytes(receipt) }), /cleanup_ownership/);
});
test('symlink CLI entry actually executes and rejects unknown usage', async (t) => {
  const root = await setup(t); const entry = join(root, 'journey.mjs'); await symlink(new URL('./method-verification-journey.mjs', import.meta.url).pathname, entry);
  assert.throws(() => execFileSync(process.execPath, [entry, '--unknown'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 2 && error.stderr.includes('usage:'));
});
