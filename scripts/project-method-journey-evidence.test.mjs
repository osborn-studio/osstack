import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createScratchDir } from './lib/scratch.mjs';
import { sha256, jsonBytes, sealEvidence, evaluateCase } from './lib/skills-check-verification.mjs';
import { parseOptions, projectJourney, checkPacket, validatePacket } from './project-method-journey-evidence.mjs';

async function setup(t) {
  const root = await createScratchDir('tests', 'method-projection');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const put = (path, value) => writeFile(path, jsonBytes(value));
async function sealRoot(input) {
  const files = [];
  for (const name of (await readdir(input)).sort()) if (name !== 'cases' && name !== 'journey-manifest.json') {
    const bytes = await readFile(join(input, name)); files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const case_manifests = []; const journey = JSON.parse(await readFile(join(input, 'journey.json')));
  for (const id of ['healthy', 'missing-ref']) {
    try { case_manifests.push({ case_id: id, sha256: sha256(await readFile(join(input, 'cases', id, 'manifest.json'))), verified: journey.features.find(f => f.case_id === id).verification === 'passed' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await put(join(input, 'journey-manifest.json'), { files, case_manifests });
}
async function fixture(t, { doctorFailure = false } = {}) {
  const root = await setup(t); const input = join(root, 'machine'); await mkdir(input); await mkdir(join(input, 'cases'));
  const journey = { schema_version: 1, status: doctorFailure ? 'failed' : 'passed', failure: doctorFailure ? '/private/secret-canary missing build' : undefined,
    features: [], host_execution: 'not_run', native_skill_selection: 'not_observed', model_calls: 0, provider_qualified: false, formal_gate_pass: false };
  for (const id of ['healthy', 'missing-ref']) {
    if (doctorFailure) { journey.features.push({ case_id: id, verification: id === 'healthy' ? 'failed' : 'not_run', product_exit: null, driver_exit: null, cleanup: { status: 'not_started', descendant_termination: 'not_attested' }, evidence_state: 'not_created', journey_status: 'failed' }); continue; }
    const dir = join(input, 'cases', id); await mkdir(dir);
    const exit = id === 'healthy' ? 0 : 1;
    const expected = { case_id: id, expected_exit: exit, failed: exit, drifted: 0, current_sha: 'a'.repeat(40), sources: [{ id, origin: 'file:///private/secret-canary', ref: id === 'healthy' ? 'refs/heads/main' : 'refs/heads/not-present', blessed_sha: 'a'.repeat(40) }] };
    const stdout = `Checking 1 source(s) against their tracked refs...\n${id === 'healthy' ? '  ✓ healthy  up-to-date (aaaaaaaaaaaa)' : '  ✗ missing-ref  unreachable: no_matching_ref'}\n${exit} source(s) failed to check.\n0 source(s) drifted from blessed_sha.\nsecret-canary /private/source env PATH=/private/bin\n`;
    const command = { exit_code: exit, direct_child_exit_confirmed: true, timed_out: false, output_limited: false, interrupted: false, spawn_error: null, signal: null,
      environment: { HOME: '/private/secret-canary', TOKEN: 'secret-canary' }, argv: ['/private/secret-canary/bin.js', 'skills', 'check'], cwd: '/private/secret-canary',
      stdout_path: `${id}.stdout`, stderr_path: `${id}.stderr`, stdout_sha256: sha256(Buffer.from(stdout)), stderr_sha256: sha256(Buffer.alloc(0)) };
    const observed = evaluateCase(expected, { ...command, stdout, stderr: '' }, true);
    const cleanup = { status: 'passed', fixture_removed: true, fixture_path: '/private/secret-canary', descendant_termination: 'not_attested' };
    const bindingFiles = [{ path: 'private/source', bytes: 1, sha256: 'b'.repeat(64) }]; const digest = sha256(Buffer.from(JSON.stringify(bindingFiles)));
    const bindings = { source: { files: bindingFiles, digest }, build: { files: bindingFiles, digest } };
    const receipt = { run_id: '00000000-0000-4000-8000-000000000000', status: 'passed', behavior: 'passed', failure: null, driver_exit: 0, selected_cases: [id], cases: [observed], cleanup, binding_digests: { source_digest: digest, build_digest: digest }, provider_qualified: false };
    const rawInput = jsonBytes({ version: 1, sources: expected.sources });
    for (const [name, value] of Object.entries({ 'receipt.json': receipt, 'run.json': { run_id: receipt.run_id, status: 'passed', selected_cases: [id], bindings_unchanged: true, bindings: receipt.binding_digests, final_bindings: receipt.binding_digests }, 'cleanup.json': cleanup, 'bindings.json': bindings, 'expectations.json': { definitions: [expected] }, [`${id}.command.json`]: command, [`${id}.json`]: { ...command, ...observed, manifest_before_sha256: sha256(Buffer.from(rawInput)), manifest_after_sha256: sha256(Buffer.from(rawInput)) } })) await put(join(dir, name), value);
    await writeFile(join(dir, `${id}.input.json`), rawInput); await writeFile(join(dir, `${id}.stdout`), stdout); await writeFile(join(dir, `${id}.stderr`), '');
    await sealEvidence(dir, receipt.run_id);
    journey.features.push({ case_id: id, verification: 'passed', product_exit: exit, product_status: id === 'healthy' ? 'healthy' : 'failed', driver_exit: 0, bindings: receipt.binding_digests, cleanup, evidence: dir, evidence_state: 'sealed', journey_status: 'passed' });
  }
  await put(join(input, 'journey.json'), journey); await sealRoot(input);
  return { root, input, output: join(root, 'packet'), journey };
}
async function readPacket(f) { return JSON.parse(await readFile(join(f.output, 'packet.json'))); }
async function edit(path, change) { const x = JSON.parse(await readFile(path)); change(x); await put(path, x); }
async function resealCase(f, id) { const dir = join(f.input, 'cases', id); await rm(join(dir, 'manifest.json')); await sealEvidence(dir, '00000000-0000-4000-8000-000000000000'); await sealRoot(f.input); }
async function resealPacket(output) {
  const bytes = await readFile(join(output, 'packet.json'));
  await put(join(output, 'manifest.json'), { schema_version: 1, files: [{ path: 'packet.json', bytes: bytes.length, sha256: sha256(bytes) }] });
}

test('fixed interface supports projection and independent check only', () => {
  assert.deepEqual(parseOptions(['--input', '/a', '--output', '/b']), { input: '/a', output: '/b' });
  assert.deepEqual(parseOptions(['--check', '/packet']), { check: '/packet' });
  for (const argv of [[], ['--input', 'relative', '--output', '/b'], ['--check', '/a', '--output', '/b'], ['--input', '/a', '--output', '/b', '--case', 'all']]) assert.throws(() => parseOptions(argv));
});
test('sealed two-case projection retains negative outcome without exposing arbitrary raw text or paths', async t => {
  const f = await fixture(t); const before = await readFile(join(f.input, 'journey.json'));
  await projectJourney(f); const packet = await readPacket(f); await checkPacket(f.output);
  assert.deepEqual(packet.features.map(x => [x.case_id, x.product_exit, x.driver_exit, x.product_status]), [['healthy', 0, 0, 'healthy'], ['missing-ref', 1, 0, 'failed']]);
  assert.equal(packet.features[1].cleanup.descendant_termination, 'not_attested');
  const text = JSON.stringify(packet); assert.doesNotMatch(text, /secret-canary|\/private|environment|"argv"|"cwd"|HOME|PATH/);
  assert.ok(packet.streams.some(x => x.selected_lines.some(line => line.includes('unreachable: no_matching_ref'))));
  assert.ok(packet.streams.some(x => x.omitted_bytes > 0)); assert.deepEqual(await readFile(join(f.input, 'journey.json')), before);
  assert.deepEqual((await readdir(f.output)).sort(), ['manifest.json', 'packet.json']);
});
test('failed doctor and untouched second case remain failed/not_run, never invented receipts', async t => {
  const f = await fixture(t, { doctorFailure: true }); await projectJourney(f); const p = await readPacket(f);
  assert.equal(p.journey_status, 'failed'); assert.deepEqual(p.features.map(x => x.verification), ['failed', 'not_run']);
  assert.equal(p.features[0].product_exit, null); assert.equal(p.features[1].cleanup.status, 'not_started');
  assert.equal(p.failure_recorded, true); assert.doesNotMatch(JSON.stringify(p), /secret-canary/);
});
test('failed sealed case preserves reported exit and unknown cleanup without upgrading verified product exit', async t => {
  const f = await fixture(t); const id = 'healthy';
  await edit(join(f.input, 'journey.json'), j => { j.status = 'failed'; Object.assign(j.features[0], { verification: 'failed', product_exit: null, reported_product_exit: 1, product_status: 'unknown', driver_exit: 1, cleanup: { status: 'unknown', descendant_termination: 'not_attested' } }); for (const x of j.features) x.journey_status = 'failed'; });
  await edit(join(f.input, 'cases', id, 'receipt.json'), r => { r.status = 'failed'; r.driver_exit = 1; r.cleanup = { status: 'unknown', descendant_termination: 'not_attested' }; });
  await put(join(f.input, 'cases', id, 'cleanup.json'), { status: 'unknown', descendant_termination: 'not_attested' }); await resealCase(f, id);
  await projectJourney(f); const x = (await readPacket(f)).features[0]; assert.equal(x.product_exit, null); assert.equal(x.reported_product_exit, 1); assert.equal(x.cleanup.status, 'unknown');
});
test('late journey failure does not erase earlier successful rows', async t => {
  const f = await fixture(t); await edit(join(f.input, 'journey.json'), j => { j.status = 'failed'; j.failure = 'late_failure'; for (const x of j.features) x.journey_status = 'failed'; }); await sealRoot(f.input);
  await projectJourney(f); const p = await readPacket(f); assert.equal(p.journey_status, 'failed'); assert.equal(p.features[0].verification, 'passed');
});
for (const mutation of ['hash', 'missing-receipt', 'extra-file', 'traversal', 'symlink']) test(`source ${mutation} is rejected before output creation`, async t => {
  const f = await fixture(t); const dir = join(f.input, 'cases/healthy');
  if (mutation === 'hash') await writeFile(join(dir, 'receipt.json'), '{}');
  if (mutation === 'missing-receipt') { await rm(join(dir, 'receipt.json')); await resealCase(f, 'healthy'); }
  if (mutation === 'extra-file') await writeFile(join(dir, 'unlisted.json'), '{}');
  if (mutation === 'traversal') await edit(join(dir, 'manifest.json'), m => { m.files[0].path = '../outside'; });
  if (mutation === 'symlink') { await rm(join(dir, 'receipt.json')); await symlink(join(f.input, 'journey.json'), join(dir, 'receipt.json')); }
  await assert.rejects(projectJourney(f)); assert.equal((await readdir(f.root)).includes('packet'), false);
});
test('resealed contradictory raw behavior cannot retain a passed verification', async t => {
  const f = await fixture(t); const dir = join(f.input, 'cases/missing-ref'); await writeFile(join(dir, 'missing-ref.stdout'), 'all healthy');
  await edit(join(dir, 'missing-ref.command.json'), c => { c.stdout_sha256 = sha256(Buffer.from('all healthy')); });
  await edit(join(dir, 'missing-ref.json'), c => { c.stdout_sha256 = sha256(Buffer.from('all healthy')); }); await resealCase(f, 'missing-ref');
  await assert.rejects(projectJourney(f), /behavior/);
});
test('existing output and output inside source never overwrite or modify inputs', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'unchanged');
  await assert.rejects(projectJourney(f)); assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'unchanged');
  await assert.rejects(projectJourney({ input: f.input, output: join(f.input, 'new') }));
});
for (const injection of ['nested-env', 'raw-path', 'unsafe-snippet', 'unexpected-case', 'extra-root-key']) test(`packet validator rejects resealed ${injection}`, async t => {
  const f = await fixture(t); await projectJourney(f);
  await edit(join(f.output, 'packet.json'), p => {
    if (injection === 'nested-env') p.features[0].cleanup.environment = { HOME: '/secret' };
    if (injection === 'raw-path') p.references[0].id = '/private/original.json';
    if (injection === 'unsafe-snippet') p.streams[0].selected_lines = ['PATH=/secret'];
    if (injection === 'unexpected-case') p.features[0].case_id = 'drift';
    if (injection === 'extra-root-key') p.environment = { TOKEN: 'private' };
  }); await resealPacket(f.output); await assert.rejects(checkPacket(f.output));
});
test('packet directory refuses extra raw files and hash mismatches', async t => {
  const f = await fixture(t); await projectJourney(f); await writeFile(join(f.output, 'raw.json'), '{"environment":{}}');
  await assert.rejects(checkPacket(f.output)); await rm(join(f.output, 'raw.json')); await writeFile(join(f.output, 'packet.json'), '{}'); await assert.rejects(checkPacket(f.output));
});
test('independent validator rejects overly large snippet lists and malformed hashes', async t => {
  const f = await fixture(t); await projectJourney(f); const p = await readPacket(f);
  p.streams[0].selected_lines = Array(100).fill('0 source(s) failed to check.'); assert.throws(() => validatePacket(p));
  const q = await readPacket(f); q.references[0].sha256 = 'not-a-digest'; assert.throws(() => validatePacket(q));
});
test('real CLI projection then check have nonempty receipts and invalid usage is exit2', async t => {
  const f = await fixture(t); const entry = new URL('./project-method-journey-evidence.mjs', import.meta.url).pathname;
  const stdout = execFileSync(process.execPath, [entry, '--input', f.input, '--output', f.output], { encoding: 'utf8' }); assert.equal(JSON.parse(stdout).status, 'projected');
  assert.equal(JSON.parse(execFileSync(process.execPath, [entry, '--check', f.output], { encoding: 'utf8' })).status, 'valid');
  assert.throws(() => execFileSync(process.execPath, [entry, '--arbitrary'], { stdio: 'pipe' }), e => e.status === 2);
});
test('duplicate JSON keys cannot hide raw environment fields behind a valid parsed value', async t => {
  const f = await fixture(t); await projectJourney(f);
  const path = join(f.output, 'packet.json'); const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('{', '{"scope":{"environment":{"TOKEN":"secret-canary"}},'));
  await resealPacket(f.output); await assert.rejects(checkPacket(f.output), /canonical/);
});
test('symlink packet files and source directory are refused', async t => {
  const f = await fixture(t); const linked = join(f.root, 'source-link'); await symlink(f.input, linked);
  await assert.rejects(projectJourney({ input: linked, output: f.output })); await projectJourney(f);
  await rm(join(f.output, 'packet.json')); await symlink(join(f.input, 'journey.json'), join(f.output, 'packet.json')); await assert.rejects(checkPacket(f.output));
});
test('failed receipt conflict stays visible as unverified reported cleanup, not rejected or upgraded', async t => {
  const f = await fixture(t);
  await edit(join(f.input, 'journey.json'), j => { j.status = 'failed'; Object.assign(j.features[0], { verification: 'failed', product_exit: null, reported_product_exit: 0, product_status: 'unknown', driver_exit: 1, cleanup: { status: 'unknown', descendant_termination: 'not_attested' } }); for (const x of j.features) x.journey_status = 'failed'; });
  await edit(join(f.input, 'cases/healthy/receipt.json'), r => { r.status = 'failed'; r.driver_exit = 1; r.cleanup.status = 'failed'; }); await resealCase(f, 'healthy');
  await projectJourney(f); const x = (await readPacket(f)).features[0];
  assert.equal(x.cleanup.status, 'unknown'); assert.equal(x.reported_cleanup.status, 'failed'); assert.equal(x.receipt_cleanup_consistent, false); assert.equal(x.product_exit, null);
});
test('not-run cleanup cannot claim fixture removal even after packet resealing', async t => {
  const f = await fixture(t, { doctorFailure: true }); await projectJourney(f);
  await edit(join(f.output, 'packet.json'), p => { p.features[1].cleanup.fixture_removed = true; });
  await resealPacket(f.output); await assert.rejects(checkPacket(f.output), /^Error: not_started_removed$/);
});
test('passed healthy stream cannot carry a failure-count contradiction after resealing', async t => {
  const f = await fixture(t); await projectJourney(f);
  await edit(join(f.output, 'packet.json'), p => {
    const s = p.streams.find(x => x.id === 'healthy.product.stdout'); s.selected_lines = ['1 source(s) failed to check.'];
    s.omitted_bytes = p.references.find(x => x.id === s.id).bytes - Buffer.byteLength(s.selected_lines[0]);
  });
  await resealPacket(f.output); await assert.rejects(checkPacket(f.output), /^Error: passed_snippet_conflict$/);
});
test('passed missing-ref stream cannot claim healthy or zero failed checks', async t => {
  for (const line of ['0 source(s) failed to check.', '  ✓ healthy  up-to-date (aaaaaaaaaaaa)']) {
    const f = await fixture(t); await projectJourney(f);
    await edit(join(f.output, 'packet.json'), p => {
      const s = p.streams.find(x => x.id === 'missing-ref.product.stdout'); s.selected_lines = [line];
      s.omitted_bytes = p.references.find(x => x.id === s.id).bytes - Buffer.byteLength(line);
    });
    await resealPacket(f.output); await assert.rejects(checkPacket(f.output), /^Error: passed_snippet_conflict$/);
  }
});
for (const mutation of ['passed-cleanup-on-failed', 'bindings-without-evidence', 'consistency-without-evidence', 'reported-exit-without-evidence', 'reported-cleanup-without-evidence']) test(`unverified packet cannot manufacture ${mutation}`, async t => {
  const f = await fixture(t, { doctorFailure: true }); await projectJourney(f);
  await edit(join(f.output, 'packet.json'), p => {
    const x = p.features[0];
    if (mutation === 'passed-cleanup-on-failed') x.cleanup = { status: 'passed', fixture_removed: true, descendant_termination: 'not_attested' };
    if (mutation === 'bindings-without-evidence') x.bindings.source_digest = 'b'.repeat(64);
    if (mutation === 'consistency-without-evidence') x.receipt_cleanup_consistent = true;
    if (mutation === 'reported-exit-without-evidence') x.reported_product_exit = 1;
    if (mutation === 'reported-cleanup-without-evidence') x.reported_cleanup = { status: 'unknown', fixture_removed: null, descendant_termination: 'not_attested' };
  }); await resealPacket(f.output); await assert.rejects(checkPacket(f.output), /unverified_cleanup_claim|not_created_claim/);
});
test('passed verification cannot also expose an unverified reported product exit', async t => {
  const f = await fixture(t); await projectJourney(f); await edit(join(f.output, 'packet.json'), p => { p.features[0].reported_product_exit = 1; });
  await resealPacket(f.output); await assert.rejects(checkPacket(f.output), /packet_passed_claim/);
});
test('source driver-pass followed by verifier-fail preserves failed, unknown and reported claims', async t => {
  const f = await fixture(t);
  await edit(join(f.input, 'journey.json'), j => { j.status = 'failed'; j.failure = 'scratch_residue'; Object.assign(j.features[0], { verification: 'failed', product_exit: null, product_status: 'unknown', reported_product_exit: 0, cleanup: { status: 'unknown', descendant_termination: 'not_attested' } }); for (const x of j.features) x.journey_status = 'failed'; }); await sealRoot(f.input);
  await projectJourney(f); const x = (await readPacket(f)).features[0];
  assert.equal(x.verification, 'failed'); assert.equal(x.product_exit, null); assert.equal(x.reported_product_exit, 0); assert.equal(x.cleanup.status, 'unknown'); assert.equal(x.reported_cleanup.status, 'passed');
});
for (const mutation of ['missing-run', 'run-status', 'run-bindings', 'run-id', 'receipt-failure', 'receipt-behavior', 'input-identity', 'detail-conflict']) test(`passed input rejects retained ${mutation} contradiction after resealing`, async t => {
  const f = await fixture(t); const dir = join(f.input, 'cases/healthy');
  if (mutation === 'missing-run') await rm(join(dir, 'run.json'));
  if (mutation === 'run-status') await edit(join(dir, 'run.json'), r => { r.status = 'failed'; });
  if (mutation === 'run-bindings') await edit(join(dir, 'run.json'), r => { r.bindings_unchanged = false; });
  if (mutation === 'run-id') await edit(join(dir, 'run.json'), r => { r.run_id = '11111111-1111-4111-8111-111111111111'; });
  if (mutation === 'receipt-failure') await edit(join(dir, 'receipt.json'), r => { r.failure = 'error'; });
  if (mutation === 'receipt-behavior') await edit(join(dir, 'receipt.json'), r => { r.behavior = 'failed'; });
  if (mutation === 'input-identity') { const changed = jsonBytes({ version: 1, sources: [] }); await writeFile(join(dir, 'healthy.input.json'), changed); await edit(join(dir, 'healthy.json'), r => { r.manifest_before_sha256 = sha256(Buffer.from(changed)); r.manifest_after_sha256 = sha256(Buffer.from(changed)); }); }
  if (mutation === 'detail-conflict') await edit(join(dir, 'healthy.json'), r => { r.exit_code = 1; });
  await resealCase(f, 'healthy'); await assert.rejects(projectJourney(f), /required_evidence|run_identity|run_state|run_bindings|receipt_result|input_identity|command_detail_conflict/);
});
async function changeBindings(f) {
  const dir = join(f.input, 'cases/missing-ref'); let digest;
  await edit(join(dir, 'bindings.json'), b => { b.source.files[0].sha256 = 'c'.repeat(64); digest = b.source.digest = sha256(Buffer.from(JSON.stringify(b.source.files))); });
  await edit(join(dir, 'receipt.json'), r => { r.binding_digests.source_digest = digest; });
  await edit(join(dir, 'run.json'), r => { r.bindings.source_digest = digest; r.final_bindings.source_digest = digest; });
  await edit(join(f.input, 'journey.json'), j => { j.features[1].bindings.source_digest = digest; }); await resealCase(f, 'missing-ref');
}
test('successful journey cannot hide differing cross-case binding digests', async t => {
  const f = await fixture(t); await changeBindings(f); await assert.rejects(projectJourney(f), /cross_case_bindings/);
});
test('late cross-case binding failure retains both individual rows and the failed journey', async t => {
  const f = await fixture(t); await changeBindings(f); await edit(join(f.input, 'journey.json'), j => { j.status = 'failed'; j.failure = 'cross_case_bindings_changed'; for (const x of j.features) x.journey_status = 'failed'; }); await sealRoot(f.input);
  await projectJourney(f); const p = await readPacket(f); assert.equal(p.journey_status, 'failed'); assert.ok(p.features.every(x => x.verification === 'passed')); assert.notEqual(p.features[0].bindings.source_digest, p.features[1].bindings.source_digest);
});
test('created input cannot smuggle a verified cleanup into a failed row', async t => {
  const f = await fixture(t); await edit(join(f.input, 'journey.json'), j => { j.status = 'failed'; Object.assign(j.features[0], { verification: 'failed', product_exit: null, product_status: 'unknown' }); for (const x of j.features) x.journey_status = 'failed'; }); await sealRoot(f.input);
  await assert.rejects(projectJourney(f), /unverified_cleanup_claim/);
});
for (const key of ['bindings', 'reported_cleanup', 'reported_product_exit']) test(`not-created source cannot contain ${key} evidence claims`, async t => {
  const f = await fixture(t, { doctorFailure: true });
  await edit(join(f.input, 'journey.json'), j => { j.features[0][key] = key === 'bindings' ? { source_digest: 'b'.repeat(64), build_digest: 'b'.repeat(64) } : key === 'reported_cleanup' ? { status: 'passed', fixture_removed: true, descendant_termination: 'not_attested' } : 0; }); await sealRoot(f.input);
  await assert.rejects(projectJourney(f), /not_created_claim/);
});
test('directory enumeration rejects a source that exceeds the fixed member budget', async t => {
  const f = await fixture(t, { doctorFailure: true });
  for (let i = 0; i < 133; i++) await writeFile(join(f.input, `extra-${i}`), '');
  await assert.rejects(projectJourney(f), /directory_entry_limit/);
});
test('CLI error code is fixed and path-free for rejected packet inventory', async t => {
  const f = await fixture(t); await projectJourney(f); await writeFile(join(f.output, 'extra-secret-canary'), '{}');
  const entry = new URL('./project-method-journey-evidence.mjs', import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [entry, '--check', f.output], { stdio: 'pipe' }), e => e.status === 1 && JSON.parse(e.stderr).error === 'directory_entry_limit' && !e.stderr.includes('secret-canary'));
});
