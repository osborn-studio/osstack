import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, readdir, symlink, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { createScratchDir } from './lib/scratch.mjs';
import { jsonBytes, sha256, sealEvidence, caseDefinition, fixtureEnvironment } from './lib/skills-check-verification.mjs';
import { verifyCaseEvidence, parseOptions, runJourney, invokeDriver } from './method-verification-journey.mjs';

async function setup(t) {
  const root = await realpath(await createScratchDir('tests', 'method-journey'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function evidenceFixture(t, id = 'missing-ref', location = ['smoke', 'skills-check-owned']) {
  const root = await setup(t); const directory = join(root, 'evidence'); await mkdir(directory);
  const scratch = join(root, 'scratch'); await mkdir(join(scratch, 'smoke'), { recursive: true });
  const fixture = join(scratch, ...location);
  const expected = caseDefinition(id, pathToFileURL(join(fixture, 'origin')).href, 'a'.repeat(40), 'b'.repeat(40));
  const input = jsonBytes({ version: 1, sources: expected.sources });
  const rows = {
    healthy: '  ✓ healthy  up-to-date (bbbbbbbbbbbb)',
    'missing-ref': '  ✗ missing-ref  unreachable: no_matching_ref',
    drift: '  ⚠ drift  drift  blessed=aaaaaaaaaaaa  head=bbbbbbbbbbbb  ref=refs/heads/main',
  };
  const stdout = [`Checking ${expected.sources.length} source(s) against their tracked refs...`, ...expected.sources.map(source => rows[source.id]), '', `${expected.failed} source(s) failed to check.`, `${expected.drifted} source(s) drifted from blessed_sha.`, ''].join('\n');
  const environment = fixtureEnvironment(fixture, scratch, process.env.PATH, join(fixture, 'setup-home'));
  const command = { executable: process.execPath, argv: ['/target/packages/cli/dist/bin.js', 'skills', 'check'], cwd: fixture, environment: { ...environment, OSSTACK_HOME: join(fixture, `home-${id}`) },
    exit_code: expected.expected_exit, signal: null, direct_child_exit_confirmed: true, timed_out: false, output_limited: false, interrupted: false, spawn_error: null,
    stdout_path: `${id}.stdout`, stderr_path: `${id}.stderr`, stdout_sha256: sha256(Buffer.from(stdout)), stderr_sha256: sha256(Buffer.alloc(0)) };
  const observed = { case_id: id, verification_status: 'passed', actual_exit: expected.expected_exit, expected_exit: expected.expected_exit,
    source_check_status: { healthy: 'healthy', 'missing-ref': 'failed', drift: 'drift', mixed: 'failed', empty: 'empty' }[id], input_unchanged: true, errors: [] };
  const cleanup = { status: 'passed', fixture_path: fixture, fixture_removed: true, descendant_termination: 'not_attested' };
  const bindings = {};
  for (const [kind, paths] of Object.entries({ source: ['scripts/smoke-skills-check.mjs', 'scripts/lib/skills-check-verification.mjs', 'packages/cli/src/skills-command.ts'], build: ['packages/cli/dist/bin.js', 'packages/core/dist/index.js', 'packages/skill-registry/dist/index.js'] })) {
    const files = paths.map(path => ({ path, bytes: 1, sha256: '0'.repeat(64) })); bindings[kind] = { files, digest: sha256(Buffer.from(JSON.stringify(files))) };
  }
  const receipt = { run_id: randomUUID(), status: 'passed', driver_exit: 0, selected_cases: [id], cases: [observed], behavior: 'passed', cleanup,
    failure: null, provider_qualified: false, evidence: { directory, manifest: 'manifest.json', bindings: 'bindings.json' }, binding_digests: { source_digest: bindings.source.digest, build_digest: bindings.build.digest } };
  const files = { 'receipt.json': receipt, 'cleanup.json': cleanup, 'run.json': { run_id: receipt.run_id, status: 'passed', selected_cases: [id], bindings_unchanged: true,
    bindings: receipt.binding_digests, final_bindings: receipt.binding_digests }, 'bindings.json': bindings, 'environment.json': environment,
    'expectations.json': { definitions: [expected] }, [`${id}.command.json`]: command,
    [`${id}.json`]: { ...command, ...observed, manifest_before_sha256: sha256(input), manifest_after_sha256: sha256(input), input_path: `${id}.input.json` } };
  const labels = ['git-00', 'git-01', 'git-02', 'git-03', 'git-04', 'git-05', id];
  files['run.json'].commands = labels.map(label => ({ label, record: `${label}.command.json`, exit_code: label === id ? expected.expected_exit : 0 }));
  files['run.json'].git_head = 'c'.repeat(40);
  for (const label of labels.slice(0, -1)) {
    const value = label === 'git-00' ? 'c'.repeat(40) : label === 'git-03' ? 'a'.repeat(40) : label === 'git-05' ? 'b'.repeat(40) : 'fixture command';
    const out = Buffer.from(value + '\n');
    files[`${label}.command.json`] = { ...command, executable: '/usr/bin/git', argv: ['rev-parse', 'HEAD'], cwd: label === 'git-00' ? '/target' : join(fixture, 'origin'), environment, exit_code: 0,
      stdout_path: `${label}.stdout`, stderr_path: `${label}.stderr`, stdout_sha256: sha256(out), stderr_sha256: sha256(Buffer.alloc(0)) };
    await writeFile(join(directory, `${label}.stdout`), out); await writeFile(join(directory, `${label}.stderr`), '');
  }
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
  assert.doesNotMatch(await readFile(join(output, 'feature-map.md'), 'utf8'), /cases\/healthy\/manifest.json/);
});

test('duplicate manifest members are rejected', async (t) => {
  const f = await evidenceFixture(t); await mutate(f, 'manifest.json', m => { m.files.push(m.files[0]); });
  await assert.rejects(verifyCaseEvidence(f.args), /manifest_path/);
});
test('foreign cleanup path cannot stand in for owned fixture disappearance', async (t) => {
  // Keep origin, cwd and environment internally consistent so this reaches ownership.
  for (const location of [['other', 'skills-check-owned'], ['smoke', 'not-owned']]) {
    const f = await evidenceFixture(t, 'missing-ref', location);
    await assert.rejects(verifyCaseEvidence(f.args), /^Error: cleanup_ownership$/);
  }
});
test('symlink CLI entry actually executes and rejects unknown usage', async (t) => {
  const root = await setup(t); const entry = join(root, 'journey.mjs'); await symlink(new URL('./method-verification-journey.mjs', import.meta.url).pathname, entry);
  assert.throws(() => execFileSync(process.execPath, [entry, '--unknown'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 2 && error.stderr.includes('usage:'));
});

for (const file of ['git-00.command.json', 'git-00.stdout']) test(`resealing missing ${file} cannot drop a run command`, async (t) => {
  const f = await evidenceFixture(t); await rm(join(f.directory, file)); await rm(join(f.directory, 'manifest.json')); await sealEvidence(f.directory, f.receipt.run_id);
  await assert.rejects(verifyCaseEvidence(f.args), /command_record_required|command_raw_required/);
});
test('external origin is rejected even with matching input hashes and resealed evidence', async (t) => {
  const f = await evidenceFixture(t); const expected = JSON.parse(await readFile(join(f.directory, 'expectations.json'))); expected.definitions[0].sources[0].origin = 'https://example.invalid';
  const bytes = jsonBytes({ version: 1, sources: expected.definitions[0].sources }); await writeFile(join(f.directory, 'expectations.json'), jsonBytes(expected)); await writeFile(join(f.directory, `${f.id}.input.json`), bytes);
  await mutate(f, `${f.id}.json`, d => { d.manifest_before_sha256 = sha256(bytes); d.manifest_after_sha256 = sha256(bytes); }, true);
  await assert.rejects(verifyCaseEvidence(f.args), /fixture_origin/);
});
test('all missing run IDs cannot agree into success', async (t) => {
  const f = await evidenceFixture(t);
  for (const name of ['receipt.json', 'run.json']) await mutate(f, name, d => { delete d.run_id; });
  await rm(join(f.directory, 'manifest.json')); await sealEvidence(f.directory, undefined);
  await assert.rejects(verifyCaseEvidence({ ...f.args, stdout: await readFile(join(f.directory, 'receipt.json')) }), /run_id_required/);
});
test('an extra scratch directory fails cleanup despite claimed fixture absence', async (t) => {
  const f = await evidenceFixture(t); await mkdir(join(f.scratch, 'unexpected'));
  await assert.rejects(verifyCaseEvidence(f.args), /scratch_residue/);
});
test('real timeout sends TERM and confirms direct child exit without claiming descendants', async () => {
  const result = await invokeDriver(['-e', 'setInterval(()=>{}, 1000)'], { PATH: process.env.PATH }, 100, undefined, 100);
  assert.equal(result.timed_out, true); assert.equal(result.direct_child_exit_confirmed, true); assert.equal(result.signal, 'SIGTERM');
  assert.deepEqual(result.signals_sent, ['SIGTERM']);
});
test('a ready child ignoring TERM escalates to KILL for only that child', async (t) => {
  const root = await setup(t); const ready = join(root, 'ready');
  const controller = new AbortController();
  const pending = invokeDriver(['-e', "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(()=>{},1000)", ready], { PATH: process.env.PATH }, 10000, controller.signal, 50);
  try {
    const limit = Date.now() + 5000;
    while ((await readFile(ready, 'utf8').catch(() => null)) !== 'ready') {
      assert.ok(Date.now() < limit, 'child readiness watchdog expired');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    controller.abort();
    const result = await pending;
    assert.equal(result.interrupted, true); assert.equal(result.timed_out, false);
    assert.equal(result.direct_child_exit_confirmed, true); assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(result.signals_sent, ['SIGTERM', 'SIGKILL']);
  } finally { controller.abort(); await pending; }
});
test('abort is distinguished from timeout and finalizes an owned child', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
  const result = await invokeDriver(['-e', 'setInterval(()=>{},1000)'], { PATH: process.env.PATH }, 2000, controller.signal, 100); clearTimeout(timer);
  assert.equal(result.interrupted, true); assert.equal(result.timed_out, false); assert.equal(result.direct_child_exit_confirmed, true);
});

test('empty source/build inventories remain invalid after consistent digest resealing', async (t) => {
  const f = await evidenceFixture(t); const digest = sha256(Buffer.from('[]'));
  await mutate(f, 'bindings.json', b => { for (const kind of ['source', 'build']) b[kind] = { files: [], digest }; });
  await mutate(f, 'run.json', r => { r.bindings = r.final_bindings = { source_digest: digest, build_digest: digest }; });
  await mutate(f, 'receipt.json', r => { r.binding_digests = { source_digest: digest, build_digest: digest }; }, true);
  await assert.rejects(verifyCaseEvidence({ ...f.args, stdout: await readFile(join(f.directory, 'receipt.json')) }), /binding_anchors/);
});
test('failed driver keeps its sealed manifest binding and labels reported product result unverified', async (t) => {
  const root = await setup(t); const output = join(root, 'journey'); let calls = 0;
  const result = await runJourney({ output }, { invoke: async (argv) => {
    calls++;
    if (argv.includes('--doctor')) return { exit_code: 0, stdout: Buffer.from('{"ready":true,"executed":false,"cases":["healthy"]}'), stderr: Buffer.alloc(0) };
    const directory = argv[argv.indexOf('--evidence-dir') + 1]; await mkdir(directory);
    await writeFile(join(directory, 'receipt.json'), '{"cases":[{"actual_exit":0}],"cleanup":{"status":"failed"}}');
    await sealEvidence(directory, randomUUID());
    return { exit_code: 1, stdout: await readFile(join(directory, 'receipt.json')), stderr: Buffer.from('cleanup failed') };
  } });
  assert.equal(calls, 2); assert.equal(result.status, 'failed'); assert.equal(result.features[0].reported_product_exit, 0);
  assert.equal(result.features[0].evidence_state, 'sealed'); assert.equal(result.features[1].verification, 'not_run');
  const manifest = JSON.parse(await readFile(join(output, 'journey-manifest.json')));
  assert.deepEqual(manifest.case_manifests, [{ case_id: 'healthy', sha256: sha256(await readFile(join(output, 'cases/healthy/manifest.json'))), verified: false }]);
  assert.match(await readFile(join(output, 'feature-map.md'), 'utf8'), /reported:0 \(unverified\)/);
});

test('an interruption after doctor prevents the next drive from starting', async (t) => {
  const root = await setup(t); let calls = 0;
  const result = await runJourney({ output: join(root, 'interrupted') }, { invoke: async () => {
    calls++; process.emit('SIGTERM');
    return { exit_code: 0, stdout: Buffer.from('{"ready":true,"executed":false,"cases":["healthy"]}'), stderr: Buffer.alloc(0) };
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'failed'); assert.equal(result.failure, 'interrupted');
  assert.equal(result.features[1].verification, 'not_run');
});


test('full scope is explicit and omission retains the original API object', () => {
  assert.deepEqual(parseOptions(['--output', '/scratch/new']), { output: '/scratch/new' });
  assert.deepEqual(parseOptions(['--output', '/scratch/new', '--scope', 'full']), { output: '/scratch/new', scope: 'full' });
  assert.deepEqual(parseOptions(['--scope', 'full', '--output', '/scratch/new']), { output: '/scratch/new', scope: 'full' });
  for (const args of [['--output', '/a', '--scope'], ['--output', '/a', '--scope', 'all'], ['--output', '/a', '--scope', 'full', '--scope', 'full']]) assert.throws(() => parseOptions(args), /usage:/);
});
for (const [id, code, status] of [['drift', 2, 'drift'], ['mixed', 1, 'failed'], ['empty', 0, 'empty']]) test(`${id}: verifies semantic evidence independently of zero driver exit`, async t => {
  const f = await evidenceFixture(t, id);
  const result = await verifyCaseEvidence(f.args);
  assert.deepEqual([result.product_exit, result.product_status, result.driver_exit, result.verification], [code, status, 0, 'passed']);
});
test('direct API rejects unknown scope before creating output', async t => {
  const root = await setup(t); const output = join(root, 'not-created');
  let calls = 0;
  await assert.rejects(runJourney({ output, scope: 'unknown' }, { invoke: async () => { calls++; throw Error('unexpected_driver'); } }), /invalid_scope/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});
test('full doctor failure keeps five rows and four later not_run rows', async t => {
  const root = await setup(t); let calls = 0;
  const result = await runJourney({ output: join(root, 'failed'), scope: 'full' }, { invoke: async () => {
    calls++; return { exit_code: 1, stdout: Buffer.from('{"ready":false,"executed":false}'), stderr: Buffer.from('build missing') };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.features.map(f => f.case_id), ['healthy', 'missing-ref', 'drift', 'mixed', 'empty']);
  assert.deepEqual(result.features.map(f => f.verification), ['failed', 'not_run', 'not_run', 'not_run', 'not_run']);
  assert.ok(result.features.every(f => f.cleanup.status === 'not_started'));
  assert.equal(result.formal_gate_pass, false);
});
for (const [id, change, reason] of [
  ['drift', e => { e.sources[0].blessed_sha = e.current_sha; }, /fixed_source/],
  ['drift', e => { e.sources[0].blessed_sha = 'd'.repeat(40); }, /fixed_source/],
  ['mixed', e => { e.sources.splice(2, 1); }, /fixed_source/],
  ['mixed', e => { e.sources[1].ref = 'refs/heads/main'; }, /fixed_source/],
  ['empty', e => { e.sources.push({ id: 'healthy' }); }, /fixed_source/],
  ['mixed', e => { e.drifted = 0; }, /fixed_expectation/],
]) test(`${id}: resealed changed fixed expectation is rejected (${change.toString()})`, async t => {
  const f = await evidenceFixture(t, id);
  await mutate(f, 'expectations.json', data => change(data.definitions[0]), true);
  await assert.rejects(verifyCaseEvidence(f.args), reason);
});
for (const [id, transform] of [
  ['mixed', text => text.replace('Checking 3', 'Checking 1')],
  ['mixed', text => text.replace('  ⚠ drift  drift  blessed=aaaaaaaaaaaa  head=bbbbbbbbbbbb  ref=refs/heads/main\n', '')],
  ['empty', text => text.replace('\n\n', '\n  ✓ healthy  up-to-date (bbbbbbbbbbbb)\n\n')],
  ['drift', text => text.replace('head=bbbbbbbbbbbb', 'head=aaaaaaaaaaaa')],
]) test(`${id}: resealed raw output cannot contradict the selected sources`, async t => {
  const f = await evidenceFixture(t, id);
  const raw = transform(await readFile(join(f.directory, `${id}.stdout`), 'utf8'));
  await writeFile(join(f.directory, `${id}.stdout`), raw);
  await mutate(f, `${id}.command.json`, data => { data.stdout_sha256 = sha256(Buffer.from(raw)); });
  await mutate(f, `${id}.json`, data => { data.stdout_sha256 = sha256(Buffer.from(raw)); }, true);
  await assert.rejects(verifyCaseEvidence(f.args), /behavior|raw_semantics/);
});

test('full failed drive retains unknown cleanup and four unexecuted rows', async t => {
  const root = await setup(t); let calls = 0;
  const result = await runJourney({ output: join(root, 'drive-failed'), scope: 'full' }, { invoke: async argv => {
    calls++;
    if (argv.includes('--doctor')) return { exit_code: 0, stdout: Buffer.from('{"ready":true,"executed":false,"cases":["healthy"]}'), stderr: Buffer.alloc(0) };
    return { exit_code: 1, stdout: Buffer.from('{"cases":[{"actual_exit":0}],"cleanup":{"status":"failed"}}'), stderr: Buffer.from('failed before sealing') };
  } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.features[0].reported_product_exit, 0);
  assert.equal(result.features[0].product_exit, null);
  assert.equal(result.features[0].cleanup.status, 'unknown');
  assert.equal(result.features[0].evidence_state, 'not_created');
  assert.deepEqual(result.features.slice(1).map(f => [f.verification, f.cleanup.status]), Array.from({ length: 4 }, () => ['not_run', 'not_started']));
});

test('drift current SHA must also match the recorded Git head, not just expectation/output agreement', async t => {
  const f = await evidenceFixture(t, 'drift');
  const replacement = Buffer.from('d'.repeat(40) + '\n');
  await writeFile(join(f.directory, 'git-05.stdout'), replacement);
  await mutate(f, 'git-05.command.json', data => { data.stdout_sha256 = sha256(replacement); }, true);
  await assert.rejects(verifyCaseEvidence(f.args), /git_sha_identity/);
});
