#!/usr/bin/env node
// Fixed two-feature journey. No model, arbitrary command, provider or runtime activation.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratchRoot } from './lib/scratch.mjs';
import { evaluateCase, fixtureEnvironment, sha256, writeJson } from './lib/skills-check-verification.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = ['healthy', 'missing-ref'];
const check = (condition, label) => { if (!condition) throw Error(label); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const absent = async path => { try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
export function parseOptions(args) {
  if (args.length !== 2 || args[0] !== '--output' || !isAbsolute(args[1])) throw Error('usage: node scripts/method-verification-journey.mjs --output ABSOLUTE_NEW_ROOT');
  return { output: args[1] };
}
async function boundedFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check((await handle.stat()).isFile(), 'evidence_not_regular');
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1); let size = 0;
    while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, size); if (!result.bytesRead) break; size += result.bytesRead; }
    check(size < buffer.length, 'evidence_size_limit'); return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
export async function verifyCaseEvidence({ directory, scratch, caseId, repository: target, stdout, driverExit }) {
  check(cases.includes(caseId), 'invalid_case');
  check((await lstat(directory)).isDirectory() && !(await lstat(directory)).isSymbolicLink(), 'evidence_directory');
  const manifest = JSON.parse(await boundedFile(join(directory, 'manifest.json')));
  check(Array.isArray(manifest.files) && manifest.files.length <= 128, 'manifest_shape');
  const buffers = new Map(); let total = 0;
  for (const file of manifest.files) {
    check(typeof file.path === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(file.path) && file.path !== 'manifest.json' && !buffers.has(file.path), 'manifest_path');
    check(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), 'manifest_entry');
    const bytes = await boundedFile(join(directory, file.path)); total += bytes.length;
    check(total <= 32 * 1024 * 1024, 'manifest_total_limit');
    check(bytes.length === file.bytes && sha256(bytes) === file.sha256, `manifest_hash:${file.path}`); buffers.set(file.path, bytes);
  }
  check(equal((await readdir(directory)).sort(), [...buffers.keys(), 'manifest.json'].sort()), 'manifest_inventory');
  for (const name of ['receipt.json', 'cleanup.json', 'run.json', 'bindings.json', 'expectations.json', 'environment.json', `${caseId}.command.json`, `${caseId}.json`, `${caseId}.stdout`, `${caseId}.stderr`, `${caseId}.input.json`]) check(buffers.has(name), `required_evidence:${name}`);
  const json = name => JSON.parse(buffers.get(name));
  const receipt = json('receipt.json'); const cleanup = json('cleanup.json'); const run = json('run.json');
  check(Buffer.from(stdout).equals(buffers.get('receipt.json')), 'receipt_stdout');
  check(driverExit === 0 && receipt.driver_exit === 0 && receipt.status === 'passed' && receipt.behavior === 'passed' && receipt.failure === null && receipt.provider_qualified === false, 'driver_result');
  check(typeof receipt.run_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(receipt.run_id), 'run_id_required');
  check(manifest.run_id === receipt.run_id && run.run_id === receipt.run_id && run.status === 'passed', 'run_identity');
  check(equal(receipt.selected_cases, [caseId]) && equal(run.selected_cases, [caseId]) && receipt.cases?.length === 1, 'selected_case');
  check(receipt.evidence?.directory === directory && receipt.evidence.manifest === 'manifest.json' && receipt.evidence.bindings === 'bindings.json', 'evidence_identity');
  check(run.bindings_unchanged === true && equal(run.bindings, run.final_bindings) && equal(run.bindings, receipt.binding_digests), 'bindings_changed');
  const bindings = json('bindings.json');
  for (const kind of ['source', 'build']) {
    check(Array.isArray(bindings[kind]?.files) && sha256(Buffer.from(JSON.stringify(bindings[kind].files))) === bindings[kind].digest, 'binding_digest');
    const required = kind === 'source' ? ['scripts/smoke-skills-check.mjs', 'scripts/lib/skills-check-verification.mjs', 'packages/cli/src/skills-command.ts'] : ['packages/cli/dist/bin.js', 'packages/core/dist/index.js', 'packages/skill-registry/dist/index.js'];
    const paths = bindings[kind].files.map(file => file.path);
    check(new Set(paths).size === paths.length && required.every(path => paths.includes(path)), 'binding_anchors');
    check(bindings[kind].files.every(file => typeof file.path === 'string' && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256)), 'binding_entries');
    check(run.bindings[`${kind}_digest`] === bindings[kind].digest, 'binding_identity');
  }
  const definitions = json('expectations.json').definitions;
  check(definitions?.length === 1 && definitions[0].case_id === caseId, 'expected_case');
  const expected = definitions[0]; const expectedExit = caseId === 'healthy' ? 0 : 1;
  check(expected.expected_exit === expectedExit && expected.failed === expectedExit && expected.drifted === 0 && /^[a-f0-9]{40}$/.test(expected.current_sha), 'fixed_expectation');
  check(expected.sources?.length === 1 && expected.sources[0].id === caseId && expected.sources[0].ref === (caseId === 'healthy' ? 'refs/heads/main' : 'refs/heads/not-present') && expected.sources[0].blessed_sha === expected.current_sha, 'fixed_source');
  check(expected.sources[0].origin === pathToFileURL(join(cleanup.fixture_path, 'origin')).href, 'fixture_origin');
  const input = buffers.get(`${caseId}.input.json`); check(equal(JSON.parse(input), { version: 1, sources: expected.sources }), 'input_identity');
  const command = json(`${caseId}.command.json`); const detail = json(`${caseId}.json`);
  check(command.executable === process.execPath && equal(command.argv, [join(target, 'packages/cli/dist/bin.js'), 'skills', 'check']), 'product_entry');
  check(command.stdout_path === `${caseId}.stdout` && command.stderr_path === `${caseId}.stderr`, 'command_output_paths');
  const rawOut = buffers.get(`${caseId}.stdout`); const rawErr = buffers.get(`${caseId}.stderr`);
  check(command.stdout_sha256 === sha256(rawOut) && command.stderr_sha256 === sha256(rawErr), 'command_output_hash');
  const observed = evaluateCase(expected, { ...command, stdout: rawOut.toString('utf8'), stderr: rawErr.toString('utf8') }, detail.manifest_before_sha256 === sha256(input) && detail.manifest_after_sha256 === sha256(input));
  check(observed.verification_status === 'passed', `behavior:${observed.errors.join(',')}`);
  check(equal(receipt.cases[0], observed) && detail.input_path === `${caseId}.input.json` && Object.entries(observed).every(([key, value]) => equal(detail[key], value)), 'case_receipt');
  check(equal(receipt.cleanup, cleanup) && cleanup.status === 'passed' && cleanup.fixture_removed === true && cleanup.descendant_termination === 'not_attested', 'cleanup_claim');
  check(typeof cleanup.fixture_path === 'string' && dirname(cleanup.fixture_path) === join(await realpath(scratch), 'smoke') && /^skills-check-[A-Za-z0-9_-]+$/.test(cleanup.fixture_path.split(sep).at(-1)), 'cleanup_ownership');
  check(command.cwd === cleanup.fixture_path && command.environment?.OSSTACK_HOME === join(cleanup.fixture_path, `home-${caseId}`), 'command_fixture');
  check(Object.entries(command).every(([key, value]) => equal(detail[key], value)), 'command_detail_conflict');
  const environment = json('environment.json');
  check(equal(environment, fixtureEnvironment(cleanup.fixture_path, await realpath(scratch), environment.PATH, join(cleanup.fixture_path, 'setup-home'))), 'fixture_environment');
  check(equal(command.environment, { ...environment, OSSTACK_HOME: join(cleanup.fixture_path, `home-${caseId}`) }), 'product_environment');
  const labels = ['git-00', 'git-01', 'git-02', 'git-03', 'git-04', 'git-05', caseId];
  check(Array.isArray(run.commands) && equal(run.commands.map(row => row.label), labels), 'command_index');
  for (const row of run.commands) {
    check(row.record === `${row.label}.command.json` && buffers.has(row.record), 'command_record_required');
    const record = json(row.record);
    check(row.exit_code === record.exit_code && record.exit_code === (row.label === caseId ? expectedExit : 0), 'command_exit');
    for (const stream of ['stdout', 'stderr']) {
      const name = `${row.label}.${stream}`;
      check(record[`${stream}_path`] === name && buffers.has(name), 'command_raw_required');
      check(record[`${stream}_sha256`] === sha256(buffers.get(name)), 'command_raw_hash');
    }
    check(record.direct_child_exit_confirmed === true && !record.signal && !record.timed_out && !record.output_limited && !record.interrupted && !record.spawn_error, 'command_incomplete');
    if (row.label !== caseId) check(equal(record.environment, environment), 'git_environment');
  }
  for (const [label, cwd, sha] of [['git-00', target, run.git_head], ['git-03', join(cleanup.fixture_path, 'origin'), null], ['git-05', join(cleanup.fixture_path, 'origin'), expected.current_sha]]) {
    const record = json(`${label}.command.json`); const value = buffers.get(`${label}.stdout`).toString('utf8').trim();
    check(record.cwd === cwd && equal(record.argv, ['rev-parse', 'HEAD']) && /^[a-f0-9]{40}$/.test(value) && (sha === null || sha === value), 'git_sha_identity');
  }
  check(!buffers.get('git-03.stdout').equals(buffers.get('git-05.stdout')), 'fixture_commits_distinct');
  check(await absent(cleanup.fixture_path), 'fixture_still_exists');
  check(equal((await readdir(scratch)).sort(), ['smoke']) && (await readdir(join(scratch, 'smoke'))).length === 0, 'scratch_residue');
  return { case_id: caseId, verification: 'passed', product_exit: observed.actual_exit, product_status: observed.source_check_status, driver_exit: 0,
    evidence: directory, manifest_sha256: sha256(await boundedFile(join(directory, 'manifest.json'))), verified_files: buffers.size, bindings: run.bindings, cleanup };
}
// Fixed CLI callers supply the existing driver argv. Short deadlines are a test seam only.
export function invokeDriver(argv, env, timeoutMs, signal, graceMs = 5000) {
  const started = new Date().toISOString();
  return new Promise(resolveResult => {
    let child; let deadline; let escalation; let closing; let done = false;
    const chunks = { stdout: [], stderr: [] }; const sizes = { stdout: 0, stderr: 0 };
    const record = { executable: process.execPath, argv, cwd: repository, started_at: started,
      exit_code: null, signal: null, killed: false, error: null, timed_out: false, interrupted: false, output_limited: false, direct_child_exit_confirmed: false, signals_sent: [] };
    const finish = () => {
      if (done) return; done = true; clearTimeout(deadline); clearTimeout(escalation); clearTimeout(closing); signal?.removeEventListener('abort', abort);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolveResult({ ...record, ended_at: new Date().toISOString(), stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) });
    };
    const stop = () => {
      if (!child?.pid || escalation || done) return;
      record.killed = true; record.signals_sent.push('SIGTERM'); child.kill('SIGTERM');
      escalation = setTimeout(() => {
        if (!record.direct_child_exit_confirmed) { record.signals_sent.push('SIGKILL'); child.kill('SIGKILL'); }
        closing = setTimeout(finish, 2000);
      }, graceMs);
    };
    const abort = () => { record.interrupted = true; stop(); };
    try { child = spawn(process.execPath, argv, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { record.error = error.code ?? error.message; finish(); return; }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
      const remaining = 4 * 1024 * 1024 - sizes[stream]; const kept = bytes.subarray(0, Math.max(0, remaining));
      chunks[stream].push(kept); sizes[stream] += kept.length;
      if (bytes.length > remaining) { record.output_limited = true; stop(); }
    });
    child.once('error', error => { record.error = error.code ?? error.message; if (!child.pid) finish(); else stop(); });
    child.once('exit', (code, exitSignal) => { record.exit_code = code; record.signal = exitSignal; record.direct_child_exit_confirmed = true; });
    child.once('close', finish);
    deadline = setTimeout(() => { record.timed_out = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
async function retainedState(output, features) {
  const manifests = [];
  for (const feature of features) {
    const directory = join(output, 'cases', feature.case_id);
    feature.evidence_state = 'not_created';
    if (!await absent(directory)) {
      feature.evidence_state = 'unsealed';
      const path = join(directory, 'manifest.json');
      if (!await absent(path)) {
        try { const hash = sha256(await boundedFile(path)); manifests.push({ case_id: feature.case_id, sha256: hash, verified: feature.verification === 'passed' }); feature.evidence_state = 'sealed'; }
        catch (error) { feature.evidence_state = `unreadable:${error.code ?? error.message}`; }
      }
    }
  }
  const listings = {};
  for (const name of ['cases', 'scratch']) {
    const path = join(output, name); listings[name] = [];
    if (await absent(path)) continue;
    for (const entry of (await readdir(path)).sort()) { const info = await lstat(join(path, entry)); listings[name].push({ name: entry, type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file' }); }
  }
  return { case_manifests: manifests, shallow_listings: listings, stability: 'snapshot only; interrupted descendants may still write retained files' };
}
export async function runJourney({ output }, seams = {}) {
  check(typeof output === 'string' && isAbsolute(output), 'absolute_output_required'); output = resolve(output);
  const parent = await realpath(dirname(output)); const root = await realpath(scratchRoot());
  check(inside(root, join(parent, output.split(sep).at(-1))), 'output_outside_scratch');
  output = join(parent, output.split(sep).at(-1));
  await mkdir(output, { mode: 0o700 });
  const scratch = join(output, 'scratch'); const evidenceParent = join(output, 'cases');
  const features = cases.map(id => ({ case_id: id, verification: 'not_run', product_exit: null, driver_exit: null, cleanup: { status: 'not_started', descendant_termination: 'not_attested' } }));
  const result = { schema_version: 1, status: 'running', started_at: new Date().toISOString(), features,
    host_execution: 'not_run', native_skill_selection: 'not_observed', model_calls: 0, provider_qualified: false, formal_gate_pass: false,
    scope: 'Fixed local skills-check healthy/missing-ref journey; omitted drift/mixed/empty; no model or native-host claim',
    limitations: ['Manifest hashes establish retained-file consistency, not an authenticated source.', 'Binding digests check driver-declared records and cross-case consistency; they do not independently hash all live source/build files after closeout. Build hashes are not proof of a compiler invocation.', 'Direct child exit and fixture removal do not attest all descendants.'], output };
  const controller = new AbortController(); const interrupted = () => controller.abort();
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const run = seams.invoke ?? invokeDriver;
  try {
    for (const dir of [scratch, evidenceParent, join(output, 'home')]) await mkdir(dir, { mode: 0o700 });
    const env = { PATH: process.env.PATH ?? '', HOME: join(output, 'home'), OSSTACK_HOME: join(output, 'home', 'unused-osstack'), OSSTACK_SCRATCH_ROOT: scratch, LANG: 'C', LC_ALL: 'C' };
    const files = ['scripts/method-verification-journey.mjs', 'scripts/lib/scratch.mjs', 'scripts/smoke-skills-check.mjs', 'scripts/lib/skills-check-verification.mjs'];
    const toolHashes = async () => Object.fromEntries(await Promise.all(files.map(async path => [path, sha256(await readFile(join(repository, path)))])));
    result.tool_files = await toolHashes(); await writeJson(join(output, 'journey.json'), result);
    for (const [index, id] of cases.entries()) {
      controller.signal.throwIfAborted();
      const directory = join(evidenceParent, id); features[index].verification = 'failed'; features[index].evidence = directory;
      const args = [join(repository, 'scripts/smoke-skills-check.mjs'), '--case', id, '--evidence-dir', directory];
      for (const phase of ['doctor', 'drive']) {
        const actualArgs = phase === 'doctor' ? [...args, '--doctor'] : args;
        const record = await run(actualArgs, env, phase === 'doctor' ? 30000 : 180000, controller.signal);
        const { stdout, stderr, ...metadata } = record;
        await writeFile(join(output, `${id}-${phase}.stdout`), stdout, { flag: 'wx', mode: 0o600 });
        await writeFile(join(output, `${id}-${phase}.stderr`), stderr, { flag: 'wx', mode: 0o600 });
        await writeJson(join(output, `${id}-${phase}.command.json`), metadata);
        if (phase === 'drive') {
          features[index].driver_exit = record.exit_code;
          features[index].cleanup = { status: 'unknown', descendant_termination: 'not_attested' };
          try {
            const reported = JSON.parse(stdout);
            features[index].reported_product_exit = reported.cases?.[0]?.actual_exit ?? null;
            features[index].reported_cleanup = reported.cleanup ?? null;
          } catch { /* Raw output is retained even when no receipt can be parsed. */ }
        }
        if (record.interrupted) throw Error('interrupted');
        if (record.timed_out) throw Error(`${phase}_timeout`);
        if (record.output_limited) throw Error(`${phase}_output_limit`);
        check(record.exit_code === 0 && !record.signal && !record.killed && !record.error, `${phase}_execution_failed`);
        if (phase === 'doctor') {
          const doctor = JSON.parse(stdout); check(doctor.ready === true && doctor.executed === false && equal(doctor.cases, [id]) && await absent(directory), 'doctor_failed');
        } else {
          features[index] = await verifyCaseEvidence({ directory, scratch, caseId: id, repository, stdout, driverExit: record.exit_code });
          if (index > 0) check(equal(features[0].bindings, features[index].bindings), 'cross_case_bindings_changed');
        }
      }
    }
    check(equal(result.tool_files, await toolHashes()), 'journey_tools_changed'); result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.failure = controller.signal.aborted ? 'interrupted' : error.message; }
  finally { process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted); }
  result.ended_at = new Date().toISOString();
  result.retained = await retainedState(output, features);
  for (const feature of features) feature.journey_status = result.status;
  await writeJson(join(output, 'journey.json'), result);
  const rows = features.map(f => `| ${f.case_id} | ${f.product_exit ?? (f.reported_product_exit !== undefined && f.reported_product_exit !== null ? `reported:${f.reported_product_exit} (unverified)` : 'not_observed')} | ${f.driver_exit ?? 'not_observed'} | ${f.verification} (journey:${f.journey_status}) | ${f.cleanup.status} | ${f.evidence_state === 'sealed' ? `cases/${f.case_id}/manifest.json` : f.evidence_state} |`);
  await writeFile(join(output, 'feature-map.md'), `# Fixed skills-check journey\n\nJourney status: ${result.status}. See journey.json for failure details.\n\n| Feature | Product exit | Driver exit | Verification | Cleanup | Evidence |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\nExpected missing-ref product exit1 is an unrecovered source failure. Driver exit0 means its fixed negative predicate passed. Native selection/model execution: not observed/not run. Descendant termination: not attested. Other cases: not run.\n`, { mode: 0o600 });
  // Seal only own flat summaries. Per-case manifests retain the original driver's full evidence.
  const index = [];
  for (const name of (await readdir(output)).sort()) if ((await lstat(join(output, name))).isFile()) { const bytes = await boundedFile(join(output, name)); index.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); }
  await writeJson(join(output, 'journey-manifest.json'), { files: index, ...result.retained });
  return result;
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  try { const result = await runJourney(parseOptions(process.argv.slice(2))); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'passed' ? 0 : 1; }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = error.message.startsWith('usage:') ? 2 : 1; }
}
