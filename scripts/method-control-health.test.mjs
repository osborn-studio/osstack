// Offline retained-evidence fixtures adapted from the existing projector tests.
// They exercise the real readonly verifier; they are not actual product drives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, symlink, writeFile, rename, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createScratchDir } from './lib/scratch.mjs';
import { sha256, jsonBytes, sealEvidence, evaluateCase, caseDefinition } from './lib/skills-check-verification.mjs';
import { inspectMethodControlHealth } from './method-control-health.mjs';
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

async function edit(path, change) { const x = JSON.parse(await readFile(path)); change(x); await put(path, x); }
const ids = ['healthy', 'missing-ref', 'drift', 'mixed', 'empty'];
const now = '2026-10-30T12:00:00.000Z';
const expected = [[0,'healthy'],[1,'failed'],[2,'drift'],[1,'failed'],[0,'empty']];
async function healthFixture(t, options = {}) {
  const f = await fixture(t, { full: true, doctorFailure: options.doctorFailure ?? false });
  const record = join(f.root, 'record'); await mkdir(record);
  await rename(f.input, join(record, 'journey')); f.input = join(record, 'journey');
  f.journey.started_at = '2026-10-30T10:00:00.000Z'; f.journey.ended_at = '2026-10-30T10:00:05.000Z';
  if (options.doctorFailure) {
    f.journey.failure = 'doctor_failed';
    await put(join(f.input, 'healthy-doctor.command.json'), { exit_code: 0, timed_out: false, output_limited: false, signal: null, killed: false, error: null });
    await put(join(f.input, 'healthy-doctor.stdout'), { ready: false, executed: false, cases: ['healthy'], checks: [{ id: 'node_version', ok: false }] });
    await writeFile(join(f.input, 'healthy-doctor.stderr'), '');
  }
  await put(join(f.input, 'journey.json'), f.journey); await sealRoot(f.input);
  const map = { schema_version: 1, target: 'skills-check-full', features: ids.map((case_id,i) => ({ case_id, expected_product_exit: expected[i][0], expected_product_status: expected[i][1] })) };
  const mapRaw = Buffer.from(jsonBytes(map)); await writeFile(join(record, 'map-before.json'), mapRaw);
  const receipt = { schema_version: 1, status: options.doctorFailure ? 'blocked' : 'consistent', exit_code: options.doctorFailure ? 2 : 0, started_at: '2026-10-30T10:00:00.000Z', ended_at: '2026-10-30T10:00:06.000Z',
    map: { before_sha256: sha256(mapRaw), bytes: mapRaw.length, after_sha256: sha256(mapRaw), unchanged: true },
    tool: { before_sha256: 'a'.repeat(64), after_sha256: 'a'.repeat(64), unchanged: true },
    journey: { status: f.journey.status, failure: f.journey.failure ?? null, receipt: 'journey/journey.json', receipt_sha256: sha256(await readFile(join(f.input, 'journey.json'))), receipt_matches_returned: true, manifest: 'journey/journey-manifest.json', manifest_sha256: sha256(await readFile(join(f.input, 'journey-manifest.json'))), features: f.journey.features, limitations: [] },
    rows: options.doctorFailure ? [] : ids.map((case_id,i) => ({ case_id, expected: { product_exit: expected[i][0], product_status: expected[i][1] }, actual: { product_exit: expected[i][0], product_status: expected[i][1] }, matches: true })), failure: options.doctorFailure ? 'journey_failed' : null, subsequent_failures: [], model_calls: 0, formal_gate_pass: false, execution_path: 'runJourney', limitations: [] };
  await put(join(record, 'maintenance.json'), receipt);
  const config = { schema_version: 1, project: 'osstack', max_age_seconds: 86400, features: [{ feature_id: 'maintenance', owner_ref: null, source_digest: f.journey.features[0].bindings?.source_digest ?? null, build_digest: f.journey.features[0].bindings?.build_digest ?? null, driver_sha256: 'a'.repeat(64), changed_paths: ['scripts/maintain-skills-check-map.mjs'], required_feature_ids: [], attempts: [{ attempt_id: 'one', kind: 'maintenance', path: 'record', receipt_sha256: sha256(await readFile(join(record, 'maintenance.json'))) }] }] };
  const configPath = join(f.root, 'config.json');
  const save = async () => { await put(configPath, config); };
  const changeReceipt = async change => { change(receipt); await put(join(record, 'maintenance.json'), receipt); config.features[0].attempts[0].receipt_sha256 = sha256(await readFile(join(record, 'maintenance.json'))); await save(); };
  await save(); return { ...f, record, receipt, config, configPath, save, changeReceipt, options: { config: configPath, asOf: now } };
}
test('verified retained full-five expected nonzero results are consistent, not product regression', async t => {
 const f = await healthFixture(t); const r = await inspectMethodControlHealth(f.options);
 assert.equal(r.features[0].health, 'bounded_consistent'); assert.equal(r.features[0].owner.status, 'unassigned');
 assert.equal(r.features[0].attempts[0].classification, 'consistent'); assert.equal(r.features[0].last_success.attempt_id, 'one');
 assert.equal(r.execution, 'not_run'); assert.equal(r.schedule, 'not_configured');
});
test('old record without wrapper tool stays unknown', async t => {
 const f = await healthFixture(t); await f.changeReceipt(r => { delete r.tool; });
 const row = (await inspectMethodControlHealth(f.options)).features[0];
 assert.equal(row.health, 'unknown'); assert.equal(row.versions.driver, 'unknown'); assert.equal(row.last_success, null);
});
test('wrapper evidence read failure and successful retained journey coexist', async t => {
 const f = await healthFixture(t); await f.changeReceipt(r => { r.status='blocked';r.exit_code=2;r.failure='ENOENT';r.rows=[];r.journey.receipt_sha256=null;r.journey.receipt_matches_returned=null;r.journey.manifest_sha256=null; });
 const row = (await inspectMethodControlHealth(f.options)).features[0];
 assert.equal(row.health, 'tool_evidence_failure'); assert.equal(row.attempts[0].record_details.journey_status, 'passed'); assert.equal(row.last_success,null);
});
test('recomputed map mismatch remains unknown cause rather than automatic drift or regression', async t => {
 const f = await healthFixture(t); const p=join(f.record,'map-before.json'); const map=JSON.parse(await readFile(p)); map.features[1].expected_product_exit=0; await put(p,map); const b=await readFile(p);
 await f.changeReceipt(r => { r.map.before_sha256=sha256(b);r.map.after_sha256=sha256(b);r.map.bytes=b.length;r.rows[1].expected.product_exit=0;r.rows[1].matches=false;r.status='mismatch';r.exit_code=1; });
 const row=(await inspectMethodControlHealth(f.options)).features[0]; assert.equal(row.health,'expectation_mismatch');assert.equal(row.attempts[0].cause,'unknown');
});
test('a newer blocked attempt cannot be hidden by older success or config order', async t => {
 const f=await healthFixture(t);await cp(f.record,join(f.root,'later'),{recursive:true});
 const p=join(f.root,'later','maintenance.json');await edit(p,r=>{r.ended_at='2026-10-30T11:00:00.000Z';r.status='blocked';r.exit_code=2;r.failure='ENOENT';r.rows=[];r.journey.receipt_sha256=null;r.journey.receipt_matches_returned=null;r.journey.manifest_sha256=null;});
 f.config.features[0].attempts.unshift({attempt_id:'later',kind:'maintenance',path:'later',receipt_sha256:sha256(await readFile(p))});await f.save();
 const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.latest_attempt.attempt_id,'later');assert.equal(row.last_success.attempt_id,'one');assert.equal(row.health,'tool_evidence_failure');
});
test('unreadable potentially newer attempt blocks latest while retaining historical success', async t=>{
 const f=await healthFixture(t);f.config.features[0].attempts.push({attempt_id:'missing',kind:'maintenance',path:'missing',receipt_sha256:'a'.repeat(64)});await f.save();
 const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.latest_attempt.status,'unknown');assert.equal(row.last_success.attempt_id,'one');assert.equal(row.health,'unknown');
});
for(const [label,change] of [['source',c=>{c.features[0].source_digest='f'.repeat(64);}],['build',c=>{c.features[0].build_digest='f'.repeat(64);}],['driver',c=>{c.features[0].driver_sha256='f'.repeat(64);}],['expired',c=>{c.max_age_seconds=1;}]]) test(`configured version or age mismatch remains stale: ${label}`,async t=>{const f=await healthFixture(t);change(f.config);await f.save();assert.equal((await inspectMethodControlHealth(f.options)).features[0].health,'stale');});
test('doctor classification requires actual retained failed checks',async t=>{const f=await healthFixture(t,{doctorFailure:true});assert.equal((await inspectMethodControlHealth(f.options)).features[0].health,'environment_blocked');});
test('changed-path selection reads affected records only and preserves unmapped paths',async t=>{
 const f=await healthFixture(t);f.config.features.push({...f.config.features[0],feature_id:'packet',changed_paths:['scripts/packet.mjs'],attempts:[{attempt_id:'missing',kind:'maintenance',path:'missing',receipt_sha256:'a'.repeat(64)}]});await f.save();const reads=[];
 const r=await inspectMethodControlHealth({...f.options,changedPaths:['scripts/maintain-skills-check-map.mjs','unmapped.ts']},{onRead:x=>reads.push(x)});
 assert.deepEqual(r.features.map(x=>x.feature_id),['maintenance']);assert.deepEqual(r.unmapped_changed_paths,['unmapped.ts']);assert.ok(!reads.some(x=>x.path.includes('missing')));
});
test('project-declared dependencies propagate impact to dependent feature',async t=>{
 const f=await healthFixture(t);f.config.features.push({...f.config.features[0],feature_id:'packet',changed_paths:['packet.mjs'],required_feature_ids:['maintenance'],attempts:[]});await f.save();const r=await inspectMethodControlHealth({...f.options,changedPaths:['scripts/maintain-skills-check-map.mjs']});assert.deepEqual(r.features.map(x=>x.feature_id),['maintenance','packet']);assert.equal(r.features[1].health,'unknown');
});
for(const [name,change] of [['hash',async f=>writeFile(join(f.record,'maintenance.json'),'{}')],['member',async f=>writeFile(join(f.record,'journey/cases/healthy/healthy.stdout'),'wrong')],['symlink',async f=>{await rename(f.record,join(f.root,'real'));await symlink('real',f.record);}],['future',async f=>f.changeReceipt(r=>{r.ended_at='2027-01-01T00:00:00.000Z';})]])test(`invalid retained evidence stays unknown: ${name}`,async t=>{const f=await healthFixture(t);await change(f);const r=await inspectMethodControlHealth(f.options);assert.equal(r.features[0].health,'unknown');assert.equal(r.features[0].attempts[0].integrity,'unknown');});
test('CLI report is read-only and exit0 is not health',async t=>{const f=await healthFixture(t);const before=await readFile(join(f.record,'maintenance.json'));const run=spawnSync(process.execPath,[resolve('scripts/method-control-health.mjs'),'--config',f.configPath,'--as-of',now],{encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).features[0].health,'bounded_consistent');assert.deepEqual(await readFile(join(f.record,'maintenance.json')),before);});

for (const [label, mutate] of [
 ['extra configuration field', c => { c.authorized = true; }],
 ['duplicate feature', c => { c.features.push(c.features[0]); }],
 ['unknown dependency', c => { c.features[0].required_feature_ids = ['absent']; }],
 ['dependency cycle', c => { c.features[0].required_feature_ids = ['maintenance']; }],
 ['path escape', c => { c.features[0].attempts[0].path = '../outside'; }],
 ['total attempt budget', c => { c.features[0].attempts = Array.from({ length: 8 }, (_, i) => ({ ...c.features[0].attempts[0], attempt_id: `a-${i}`, path: `record-${i}` })); c.features.push({ ...c.features[0], feature_id: 'packet', attempts: [{ attempt_id: 'ninth', kind: 'maintenance', path: 'extra', receipt_sha256: 'a'.repeat(64) }] }); }],
]) test(`invalid configuration rejects before reading any record: ${label}`, async t => {
 const f = await healthFixture(t); mutate(f.config); await f.save(); const reads=[];
 await assert.rejects(inspectMethodControlHealth(f.options,{onRead:x=>reads.push(x)}));
 assert.deepEqual(reads.map(x=>x.kind), ['config']);
});
test('resealed contradictory comparison cannot become verified',async t=>{
 const f=await healthFixture(t);await f.changeReceipt(r=>{r.rows[1].actual.product_exit=0;});
 const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.health,'unknown');assert.equal(row.attempts[0].integrity,'unknown');assert.ok(row.attempts[0].issues.includes('maintenance_result'));
});
test('equal receipt timestamps make latest ambiguous, independent of input order',async t=>{
 const f=await healthFixture(t);await cp(f.record,join(f.root,'equal'),{recursive:true});f.config.features[0].attempts.push({...f.config.features[0].attempts[0],attempt_id:'equal',path:'equal'});await f.save();
 const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.latest_attempt.status,'unknown');assert.equal(row.health,'unknown');assert.deepEqual(new Set(row.latest_attempt.unresolved_attempt_ids),new Set(['one','equal']));
});
test('owner is only the explicit project declaration and missing current bindings remain unknown',async t=>{
 const f=await healthFixture(t);f.config.features[0].owner_ref='experiment:maintainer';f.config.features[0].source_digest=null;await f.save();const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.owner.status,'configured');assert.equal(row.owner.ref,'experiment:maintainer');assert.equal(row.versions.source,'unknown');assert.equal(row.health,'unknown');
});

// Post-inspection regressions use the same retained fixtures, never a new product drive.
for (const key of ['source_digest', 'build_digest', 'driver_sha256', 'receipt_sha256']) test(`digest arrays reject before record reads: ${key}`, async t => {
 const f=await healthFixture(t), reads=[];
 const target=key==='receipt_sha256'?f.config.features[0].attempts[0]:f.config.features[0];
 target[key]=[target[key]]; await f.save();
 await assert.rejects(inspectMethodControlHealth(f.options,{onRead:x=>reads.push(x)}),/invalid_config/);
 assert.deepEqual(reads.map(x=>x.kind),['config']);
});
for (const key of ['before_sha256','after_sha256']) test(`retained tool digest arrays stay unknown: ${key}`,async t=>{
 const f=await healthFixture(t);await f.changeReceipt(r=>{r.tool[key]=[r.tool[key]];r.tool.unchanged=false;});
 const row=(await inspectMethodControlHealth(f.options)).features[0];
 assert.equal(row.health,'unknown');assert.ok(row.attempts[0].issues.includes('tool_shape'));
});
test('present map-after contradicting unchanged receipt cannot be consistent',async t=>{
 const f=await healthFixture(t), map=JSON.parse(await readFile(join(f.record,'map-before.json')));
 map.features[1].expected_product_exit=0;await put(join(f.record,'map-after.json'),map);
 const row=(await inspectMethodControlHealth(f.options)).features[0];
 assert.equal(row.health,'unknown');assert.ok(row.attempts[0].issues.includes('map_state'));
});
test('map-after identical bytes and normal missing map-after both remain consistent',async t=>{
 const f=await healthFixture(t);
 assert.equal((await inspectMethodControlHealth(f.options)).features[0].health,'bounded_consistent');
 await cp(join(f.record,'map-before.json'),join(f.record,'map-after.json'));
 assert.equal((await inspectMethodControlHealth(f.options)).features[0].health,'bounded_consistent');
});
test('map-after terminal symlink is not silently ignored',async t=>{
 const f=await healthFixture(t);await symlink('map-before.json',join(f.record,'map-after.json'));
 const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.health,'unknown');assert.ok(row.attempts[0].issues.includes('symlink'));
});
test('verified primary and subsequent diagnostics survive without changing classification',async t=>{
 const f=await healthFixture(t);await f.changeReceipt(r=>{r.status='blocked';r.exit_code=2;r.failure='ENOENT';r.subsequent_failures=['map_after:EACCES'];r.rows=[];r.journey.receipt_sha256=null;r.journey.receipt_matches_returned=null;r.journey.manifest_sha256=null;});
 const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.health,'tool_evidence_failure');
 assert.equal(row.attempts[0].record_details.failure,'ENOENT');assert.deepEqual(row.attempts[0].record_details.subsequent_failures,['map_after:EACCES']);
});
for (const [label,change] of [['primary bytes',r=>{r.failure='é'.repeat(2049);}],['subsequent bytes',r=>{r.subsequent_failures=['é'.repeat(2049)];}],['subsequent count',r=>{r.subsequent_failures=Array(33).fill('EIO');}]]) test(`oversized retained diagnostics stay unknown: ${label}`,async t=>{
 const f=await healthFixture(t);await f.changeReceipt(r=>{r.status='blocked';r.exit_code=2;r.failure='ENOENT';r.rows=[];r.journey.receipt_sha256=null;r.journey.receipt_matches_returned=null;r.journey.manifest_sha256=null;change(r);});
 const row=(await inspectMethodControlHealth(f.options)).features[0];assert.equal(row.health,'unknown');assert.ok(row.attempts[0].issues.includes('failure_shape'));
});
