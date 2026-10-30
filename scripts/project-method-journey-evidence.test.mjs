import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createScratchDir } from './lib/scratch.mjs';
import { sha256, jsonBytes, sealEvidence, evaluateCase, caseDefinition } from './lib/skills-check-verification.mjs';
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
  for (const id of journey.features.map(f => f.case_id)) {
    try { case_manifests.push({ case_id: id, sha256: sha256(await readFile(join(input, 'cases', id, 'manifest.json'))), verified: journey.features.find(f => f.case_id === id).verification === 'passed' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await put(join(input, 'journey-manifest.json'), { files, case_manifests });
}
async function fixture(t, { doctorFailure = false, full = false } = {}) {
  const root = await setup(t); const input = join(root, 'machine'); await mkdir(input); await mkdir(join(input, 'cases'));
  const journey = { schema_version: 1, status: doctorFailure ? 'failed' : 'passed', failure: doctorFailure ? '/private/secret-canary missing build' : undefined,
    features: [], host_execution: 'not_run', native_skill_selection: 'not_observed', model_calls: 0, provider_qualified: false, formal_gate_pass: false };
  for (const id of full ? ['healthy', 'missing-ref', 'drift', 'mixed', 'empty'] : ['healthy', 'missing-ref']) {
    if (doctorFailure) { journey.features.push({ case_id: id, verification: id === 'healthy' ? 'failed' : 'not_run', product_exit: null, driver_exit: null, cleanup: { status: 'not_started', descendant_termination: 'not_attested' }, evidence_state: 'not_created', journey_status: 'failed' }); continue; }
    const dir = join(input, 'cases', id); await mkdir(dir);
    const exit = full ? ({ healthy: 0, 'missing-ref': 1, drift: 2, mixed: 1, empty: 0 })[id] : id === 'healthy' ? 0 : 1;
    const expected = full ? caseDefinition(id, 'file:///private/secret-canary/origin', 'b'.repeat(40), 'a'.repeat(40)) : { case_id: id, expected_exit: exit, failed: exit, drifted: 0, current_sha: 'a'.repeat(40), sources: [{ id, origin: 'file:///private/secret-canary', ref: id === 'healthy' ? 'refs/heads/main' : 'refs/heads/not-present', blessed_sha: 'a'.repeat(40) }] };
    const fullRows = { healthy: '  ✓ healthy  up-to-date (aaaaaaaaaaaa)', 'missing-ref': '  ✗ missing-ref  unreachable: no_matching_ref', drift: '  ⚠ drift  drift  blessed=bbbbbbbbbbbb  head=aaaaaaaaaaaa  ref=refs/heads/main' };
    const stdout = full ? [`Checking ${expected.sources.length} source(s) against their tracked refs...`, ...expected.sources.map(source => fullRows[source.id]), '', `${expected.failed} source(s) failed to check.`, `${expected.drifted} source(s) drifted from blessed_sha.`, ''].join('\n') : `Checking 1 source(s) against their tracked refs...\n${id === 'healthy' ? '  ✓ healthy  up-to-date (aaaaaaaaaaaa)' : '  ✗ missing-ref  unreachable: no_matching_ref'}\n${exit} source(s) failed to check.\n0 source(s) drifted from blessed_sha.\nsecret-canary /private/source env PATH=/private/bin\n`;
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
    if (full) {
      const commands = [];
      for (const [label, value] of [['git-03', 'b'.repeat(40)], ['git-05', 'a'.repeat(40)]]) {
        const raw = Buffer.from(value + '\n');
        const record = { ...command, argv: ['rev-parse', 'HEAD'], cwd: '/private/secret-canary/origin', exit_code: 0, stdout_path: `${label}.stdout`, stderr_path: `${label}.stderr`, stdout_sha256: sha256(raw), stderr_sha256: sha256(Buffer.alloc(0)) };
        await put(join(dir, `${label}.command.json`), record); await writeFile(join(dir, `${label}.stdout`), raw); await writeFile(join(dir, `${label}.stderr`), '');
        commands.push({ label, record: `${label}.command.json`, exit_code: 0 });
      }
      await edit(join(dir, 'run.json'), r => { r.commands = commands; });
    }
    await sealEvidence(dir, receipt.run_id);
    journey.features.push({ case_id: id, verification: 'passed', product_exit: exit, product_status: full ? observed.source_check_status : id === 'healthy' ? 'healthy' : 'failed', driver_exit: 0, bindings: receipt.binding_digests, cleanup, evidence: dir, evidence_state: 'sealed', journey_status: 'passed' });
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


test('explicit full projection option is distinct from unchanged default and check', () => {
  assert.deepEqual(parseOptions(['--input', '/a', '--output', '/b', '--scope', 'full']), { input: '/a', output: '/b', scope: 'full' });
  for (const args of [['--input', '/a', '--output', '/b', '--scope', 'all'], ['--input', '/a', '--output', '/b', '--scope', 'full', '--scope', 'full'], ['--check', '/a', '--scope', 'full']]) assert.throws(() => parseOptions(args));
});
test('explicit full packet retains all five semantic outcomes and no private paths', async t => {
  const f = await fixture(t, { full: true }); await projectJourney({ ...f, scope: 'full' });
  const p = await readPacket(f); await checkPacket(f.output);
  assert.equal(p.schema_version, 2); assert.deepEqual(p.scope.omitted, []);
  assert.deepEqual(p.features.map(x => [x.case_id, x.product_exit, x.product_status]), [['healthy', 0, 'healthy'], ['missing-ref', 1, 'failed'], ['drift', 2, 'drift'], ['mixed', 1, 'failed'], ['empty', 0, 'empty']]);
  assert.equal(p.streams.length, 10); assert.equal(p.references.length, 52);
  assert.doesNotMatch(JSON.stringify(p), /secret-canary|private|environment|HOME|TOKEN/);
});
test('full failed doctor keeps all not_run rows without inventing evidence', async t => {
  const f = await fixture(t, { full: true, doctorFailure: true }); await projectJourney({ ...f, scope: 'full' });
  const p = await readPacket(f); assert.equal(p.schema_version, 2); assert.deepEqual(p.features.map(x => x.verification), ['failed', 'not_run', 'not_run', 'not_run', 'not_run']);
  assert.ok(p.features.every(x => x.product_exit === null && x.cleanup.fixture_removed === null));
});
for (const mismatch of ['full-without-option', 'pair-with-full', 'unknown-api-scope']) test(`${mismatch} refuses before output acquisition`, async t => {
  const f = await fixture(t, { full: mismatch === 'full-without-option' });
  const scope = mismatch === 'pair-with-full' ? 'full' : mismatch === 'unknown-api-scope' ? 'unknown' : undefined;
  await assert.rejects(projectJourney({ ...f, scope })); assert.ok(!(await readdir(f.root)).includes('packet'));
});
for (const mutation of ['missing-row', 'duplicate-row', 'order', 'full-version1', 'pair-scope', 'unknown-field', 'wrong-exit', 'empty-healthy', 'mixed-zero-failure', 'last-binding']) test(`full closed packet rejects ${mutation}`, async t => {
  const f = await fixture(t, { full: true }); await projectJourney({ ...f, scope: 'full' });
  const p = await readPacket(f);
  if (mutation === 'missing-row') p.features.pop();
  if (mutation === 'duplicate-row') p.features[4] = p.features[0];
  if (mutation === 'order') p.features.reverse();
  if (mutation === 'full-version1') p.schema_version = 1;
  if (mutation === 'pair-scope') p.scope.cases = ['healthy', 'missing-ref'];
  if (mutation === 'unknown-field') p.features[3].raw_path = '/private/file';
  if (mutation === 'wrong-exit') p.features[2].product_exit = 0;
  if (mutation === 'empty-healthy') p.features[4].product_status = 'healthy';
  if (mutation === 'last-binding') p.features[4].bindings.source_digest = 'd'.repeat(64);
  if (mutation === 'mixed-zero-failure') {
    const s = p.streams.find(s => s.id === 'mixed.product.stdout'); s.selected_lines = ['0 source(s) failed to check.']; s.omitted_bytes = p.references.find(r => r.id === s.id).bytes - Buffer.byteLength(s.selected_lines[0]);
  }
  await put(join(f.output, 'packet.json'), p); await resealPacket(f.output); await assert.rejects(checkPacket(f.output));
});
for (const mutation of ['blessed-current', 'ref', 'cardinality', 'current-git', 'extra-source-output']) test(`full passed source rejects resealed ${mutation}`, async t => {
  const f = await fixture(t, { full: true }); const id = 'drift'; const dir = join(f.input, 'cases', id);
  if (mutation === 'blessed-current') await edit(join(dir, 'expectations.json'), e => { e.definitions[0].sources[0].blessed_sha = e.definitions[0].current_sha; });
  if (mutation === 'ref') await edit(join(dir, 'expectations.json'), e => { e.definitions[0].sources[0].ref = 'refs/heads/other'; });
  if (mutation === 'cardinality') await edit(join(dir, 'expectations.json'), e => { e.definitions[0].sources.push(e.definitions[0].sources[0]); });
  if (mutation === 'current-git') {
    const bytes = Buffer.from('c'.repeat(40) + '\n'); await writeFile(join(dir, 'git-05.stdout'), bytes);
    await edit(join(dir, 'git-05.command.json'), c => { c.stdout_sha256 = sha256(bytes); });
  }
  if (mutation === 'extra-source-output') {
    const bytes = Buffer.from(await readFile(join(dir, `${id}.stdout`), 'utf8') + '  ✓ healthy  up-to-date (aaaaaaaaaaaa)\n'); await writeFile(join(dir, `${id}.stdout`), bytes);
    for (const name of [`${id}.command.json`, `${id}.json`]) await edit(join(dir, name), c => { c.stdout_sha256 = sha256(bytes); });
  }
  await resealCase(f, id); await assert.rejects(projectJourney({ ...f, scope: 'full' })); assert.ok(!(await readdir(f.root)).includes('packet'));
});
test('full late binding failure retains successful individual rows and unequal bindings', async t => {
  const f = await fixture(t, { full: true }); await changeBindings(f);
  await edit(join(f.input, 'journey.json'), j => { j.status = 'failed'; j.failure = 'cross_case_bindings_changed'; for (const x of j.features) x.journey_status = 'failed'; }); await sealRoot(f.input);
  await projectJourney({ ...f, scope: 'full' }); const p = await readPacket(f);
  assert.equal(p.journey_status, 'failed'); assert.ok(p.features.every(x => x.verification === 'passed')); assert.notEqual(p.features[0].bindings.source_digest, p.features[1].bindings.source_digest);
});

test('full verifier failure retains reported driver-pass as unknown, never verified', async t => {
  const f = await fixture(t, { full: true });
  await edit(join(f.input, 'journey.json'), j => {
    j.status = 'failed'; j.failure = 'verification_failed';
    Object.assign(j.features[2], { verification: 'failed', product_exit: null, product_status: 'unknown', reported_product_exit: 2, cleanup: { status: 'unknown', descendant_termination: 'not_attested' } });
    for (const x of j.features) x.journey_status = 'failed';
  }); await sealRoot(f.input);
  await projectJourney({ ...f, scope: 'full' }); const p = await readPacket(f); await checkPacket(f.output);
  assert.deepEqual([p.features[2].product_exit, p.features[2].reported_product_exit, p.features[2].product_status, p.features[2].cleanup.status, p.features[2].reported_cleanup.status], [null, 2, 'unknown', 'unknown', 'passed']);
});
test('full missing sealed receipt is rejected rather than silently omitting a case', async t => {
  const f = await fixture(t, { full: true }); await rm(join(f.input, 'cases/empty/receipt.json')); await resealCase(f, 'empty');
  await assert.rejects(projectJourney({ ...f, scope: 'full' }), /required_evidence/);
  assert.ok(!(await readdir(f.root)).includes('packet'));
});
for (const mutation of ['env', 'unrun-removed', 'version3']) test(`full resealed failed packet rejects ${mutation}`, async t => {
  const f = await fixture(t, { full: true, doctorFailure: true }); await projectJourney({ ...f, scope: 'full' });
  const p = await readPacket(f);
  if (mutation === 'env') p.features[0].bindings.environment = { TOKEN: 'secret' };
  if (mutation === 'unrun-removed') p.features[4].cleanup.fixture_removed = true;
  if (mutation === 'version3') p.schema_version = 3;
  await put(join(f.output, 'packet.json'), p); await resealPacket(f.output); await assert.rejects(checkPacket(f.output));
});

for (const changed of ['receipt', 'feature']) test(`full passed ${changed} cleanup fixture identity must agree before path omission`, async t => {
  const f = await fixture(t, { full: true });
  if (changed === 'receipt') {
    await edit(join(f.input, 'cases/healthy/receipt.json'), r => { r.cleanup.fixture_path = '/foreign/contradictory-fixture'; });
    await resealCase(f, 'healthy');
  } else {
    await edit(join(f.input, 'journey.json'), j => { j.features[0].cleanup.fixture_path = '/foreign/contradictory-fixture'; });
    await sealRoot(f.input);
  }
  await assert.rejects(projectJourney({ ...f, scope: 'full' }), /^Error: cleanup_fixture_identity$/);
  assert.ok(!(await readdir(f.root)).includes('packet'));
});
test('full consistent retained cleanup identity projects without following deleted fixture paths', async t => {
  const f = await fixture(t, { full: true });
  await projectJourney({ ...f, scope: 'full' }); const p = await readPacket(f);
  assert.ok(p.features.every(x => x.cleanup.status === 'passed' && x.cleanup.fixture_removed === true && x.receipt_cleanup_consistent === true));
  assert.doesNotMatch(JSON.stringify(p), /fixture_path|secret-canary/);
});

for (const full of [false, true]) {
  const ids = full ? ['healthy', 'missing-ref', 'drift', 'mixed', 'empty'] : ['healthy', 'missing-ref'];
  for (const id of ids) test(`v${full ? 2 : 1} packet refuses verified ${id} with retained stderr`, async t => {
    const f = await fixture(t, { full });
    await projectJourney({ ...f, ...(full ? { scope: 'full' } : {}) });
    const p = await readPacket(f);
    const stderr = Buffer.from('unexpected diagnostic\n');
    Object.assign(p.references.find(r => r.id === `${id}.product.stderr`), { bytes: stderr.length, sha256: sha256(stderr) });
    p.streams.find(s => s.id === `${id}.product.stderr`).omitted_bytes = stderr.length;
    await put(join(f.output, 'packet.json'), p); await resealPacket(f.output);
    await assert.rejects(checkPacket(f.output), /passed_stderr_conflict/);
  });
  test(`v${full ? 2 : 1} packet retains unverified stderr without upgrading evidence`, async t => {
    const f = await fixture(t, { full });
    await projectJourney({ ...f, ...(full ? { scope: 'full' } : {}) });
    const p = await readPacket(f);
    p.journey_status = 'failed'; p.failure_recorded = true;
    const row = p.features[0];
    row.reported_cleanup = structuredClone(row.cleanup);
    Object.assign(row, { verification: 'failed', product_exit: null, reported_product_exit: 0, product_status: 'unknown', cleanup: { status: 'unknown', fixture_removed: null, descendant_termination: 'not_attested' } });
    const stderr = Buffer.from('diagnostic from unverified execution\n');
    Object.assign(p.references.find(r => r.id === 'healthy.product.stderr'), { bytes: stderr.length, sha256: sha256(stderr) });
    p.streams.find(s => s.id === 'healthy.product.stderr').omitted_bytes = stderr.length;
    await put(join(f.output, 'packet.json'), p); await resealPacket(f.output);
    const before = await readFile(join(f.output, 'packet.json'));
    assert.equal((await checkPacket(f.output)).status, 'valid');
    assert.deepEqual(await readFile(join(f.output, 'packet.json')), before);
    assert.equal(p.features[0].verification, 'failed');
    assert.equal(p.features[0].cleanup.status, 'unknown');
  });
}


test('read-only retained inspection validates full evidence without acquiring output', async t => {
  const { inspectRetainedJourney } = await import('./project-method-journey-evidence.mjs');
  for (const doctorFailure of [false, true]) {
    const f = await fixture(t, { full: true, doctorFailure });
    const before = await readFile(join(f.input, 'journey.json'));
    const result = await inspectRetainedJourney({ input: f.input, scope: 'full' });
    assert.equal(result.journey_status, doctorFailure ? 'failed' : 'passed');
    assert.equal((await readdir(f.root)).includes('packet'), false);
    assert.deepEqual(await readFile(join(f.input, 'journey.json')), before);
    await writeFile(join(f.input, 'journey.json'), '{}');
    await assert.rejects(inspectRetainedJourney({ input: f.input, scope: 'full' }));
  }
  await assert.rejects(inspectRetainedJourney({ input: 'relative', scope: 'full' }));
  await assert.rejects(inspectRetainedJourney({ input: '/unused', scope: 'all' }));
});
