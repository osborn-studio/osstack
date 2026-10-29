#!/usr/bin/env node
// Fixed historical evidence projection. No driver/model execution or generic redaction.
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratchRoot } from './lib/scratch.mjs';
import { evaluateCase, sha256, jsonBytes } from './lib/skills-check-verification.mjs';

const IDS = ['healthy', 'missing-ref'];
const FULL_IDS = [...IDS, 'drift', 'mixed', 'empty'];
const POLICIES = {
  healthy: { exit: 0, failed: 0, drifted: 0, sources: ['healthy'], status: 'healthy' },
  'missing-ref': { exit: 1, failed: 1, drifted: 0, sources: ['missing-ref'], status: 'failed' },
  drift: { exit: 2, failed: 0, drifted: 1, sources: ['drift'], status: 'drift' },
  mixed: { exit: 1, failed: 1, drifted: 1, sources: ['healthy', 'missing-ref', 'drift'], status: 'failed' },
  empty: { exit: 0, failed: 0, drifted: 0, sources: [], status: 'empty' },
};
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_PACKET = 64 * 1024;
const SCOPE = { cases: IDS, omitted: ['drift', 'mixed', 'empty'], basis: 'retained_bytes_and_recorded_claims', live_revalidation: false, model_execution: false, formal_gate_pass: false };
const FULL_SCOPE = { ...SCOPE, cases: FULL_IDS, omitted: [] };
const REF_SUFFIXES = ['manifest', 'receipt', 'cleanup', 'bindings', 'expectations', 'product.command', 'product.detail', 'product.input', 'product.stdout', 'product.stderr'];
const REF_IDS = new Set(['journey.manifest', 'journey.receipt', ...IDS.flatMap(id => REF_SUFFIXES.map(s => `${id}.${s}`))]);
const FULL_REF_IDS = new Set(['journey.manifest', 'journey.receipt', ...FULL_IDS.flatMap(id => REF_SUFFIXES.map(s => `${id}.${s}`))]);
const check = (ok, code) => { if (!ok) throw Error(code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const member = (value, values, code) => check(values.includes(value), code);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const exit = value => value === null || (integer(value) && value <= 255);
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
function keys(value, names) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) && equal(Object.keys(value).sort(), [...names].sort()), 'closed_schema_keys');
}
const safeLine = text => typeof text === 'string' && /^(?:Checking 1 source\(s\) against their tracked refs\.\.\.|[01] source\(s\) failed to check\.|0 source\(s\) drifted from blessed_sha\.|  ✓ healthy  up-to-date \([a-f0-9]{12}\)|  ✗ missing-ref  unreachable: no_matching_ref)$/.test(text);
const safeFullLine = text => typeof text === 'string' && /^(?:Checking [013] source\(s\) against their tracked refs\.\.\.|[01] source\(s\) failed to check\.|[01] source\(s\) drifted from blessed_sha\.|  ✓ healthy  up-to-date \([a-f0-9]{12}\)|  ✗ missing-ref  unreachable: no_matching_ref|  ⚠ drift  drift  blessed=[a-f0-9]{12}  head=[a-f0-9]{12}  ref=refs\/heads\/main)$/.test(text);

async function directory(path) { const st = await lstat(path); check(st.isDirectory() && !st.isSymbolicLink(), 'directory_required'); }
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function names(path, max) {
  const entries = [];
  for await (const entry of await opendir(path)) { entries.push(entry.name); check(entries.length <= max, 'directory_entry_limit'); }
  return entries;
}
async function bounded(path, max = MAX_FILE) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat(); check(info.isFile(), 'regular_file_required'); check(info.size <= max, 'file_size_limit');
    const bytes = Buffer.alloc(info.size + 1); let size = 0;
    while (size < bytes.length) { const r = await fd.read(bytes, size, bytes.length - size, size); if (!r.bytesRead) break; size += r.bytesRead; }
    check(size <= info.size, 'file_grew_during_read'); return Buffer.from(bytes.subarray(0, size));
  } finally { await fd.close(); }
}
export function parseOptions(argv) {
  if (argv.length === 2 && argv[0] === '--check' && isAbsolute(argv[1])) return { check: argv[1] };
  if (argv.length === 4 && argv[0] === '--input' && argv[2] === '--output' && isAbsolute(argv[1]) && isAbsolute(argv[3])) return { input: argv[1], output: argv[3] };
  if (argv.length === 6 && argv[0] === '--input' && argv[2] === '--output' && isAbsolute(argv[1]) && isAbsolute(argv[3]) && argv[4] === '--scope' && argv[5] === 'full') return { input: argv[1], output: argv[3], scope: 'full' };
  throw Error('usage: node scripts/project-method-journey-evidence.mjs --input ABSOLUTE_JOURNEY --output ABSOLUTE_NEW_PACKET [--scope full] | --check ABSOLUTE_PACKET');
}
async function sealed(dir, manifestName, allowedDirectories = []) {
  await directory(dir);
  const manifestBytes = await bounded(join(dir, manifestName)); const manifest = JSON.parse(manifestBytes);
  check(Array.isArray(manifest.files) && manifest.files.length <= 128, 'manifest_shape');
  const files = new Map(); let total = 0;
  for (const entry of manifest.files) {
    keys(entry, ['path', 'bytes', 'sha256']);
    check(typeof entry.path === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.path) && entry.path !== manifestName && !files.has(entry.path), 'manifest_path');
    check(integer(entry.bytes) && HASH.test(entry.sha256), 'manifest_entry');
    const bytes = await bounded(join(dir, entry.path)); total += bytes.length; check(total <= 32 * 1024 * 1024, 'manifest_total_limit');
    check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'manifest_hash'); files.set(entry.path, bytes);
  }
  for (const name of await names(dir, 129 + allowedDirectories.length)) {
    if (allowedDirectories.includes(name)) await directory(join(dir, name));
    else check(name === manifestName || files.has(name), 'manifest_inventory');
  }
  return { manifest, manifestBytes, files };
}
function required(files, name) { check(files.has(name), 'required_evidence'); return files.get(name); }
const parse = (files, name) => JSON.parse(required(files, name));
function ref(references, id, bytes) { references.push({ id, bytes: bytes.length, sha256: sha256(bytes) }); }
function cleanup(value) {
  check(value && typeof value === 'object', 'cleanup_required');
  member(value.status, ['passed', 'failed', 'unknown', 'not_started'], 'cleanup_status');
  check(value.descendant_termination === 'not_attested', 'descendant_claim');
  const removed = value.fixture_removed ?? null; check(removed === null || typeof removed === 'boolean', 'cleanup_removed');
  check(value.status !== 'not_started' || removed === null, 'not_started_removed');
  return { status: value.status, fixture_removed: removed, descendant_termination: 'not_attested' };
}
function stream(streams, references, caseId, channel, bytes, full) {
  const id = `${caseId}.product.${channel}`; ref(references, id, bytes);
  // Exact allowlisted lines only; arbitrary error text and environment values never cross.
  const selected = channel === 'stdout' ? bytes.toString('utf8').split('\n').filter(full ? safeFullLine : safeLine).slice(0, 8) : [];
  const selectedBytes = selected.reduce((n, line) => n + Buffer.byteLength(line), 0);
  streams.push({ id, selected_lines: selected, omitted_bytes: bytes.length - selectedBytes });
}
function bindingDigests(files) {
  if (!files.has('bindings.json')) return { source_digest: null, build_digest: null };
  const bindings = parse(files, 'bindings.json'); const out = {};
  for (const kind of ['source', 'build']) {
    const group = bindings[kind]; check(group && Array.isArray(group.files) && HASH.test(group.digest), 'bindings_shape');
    check(group.digest === sha256(Buffer.from(JSON.stringify(group.files))), 'bindings_digest');
    out[`${kind}_digest`] = group.digest;
  }
  return out;
}
// Full scope binds fixed expectations to retained Git observations. This does
// not execute Git, reopen the original fixture, or authenticate its producer.
function fullExpectation(files, id, expected, stdout) {
  const policy = POLICIES[id]; const run = parse(files, 'run.json');
  const cleaned = parse(files, 'cleanup.json');
  check(typeof cleaned.fixture_path === 'string' && isAbsolute(cleaned.fixture_path), 'fixture_path');
  const origin = join(cleaned.fixture_path, 'origin');
  const observedShas = [];
  for (const label of ['git-03', 'git-05']) {
    const command = parse(files, `${label}.command.json`);
    const raw = required(files, `${label}.stdout`); const err = required(files, `${label}.stderr`);
    check(command.cwd === origin && equal(command.argv, ['rev-parse', 'HEAD']) && command.exit_code === 0 && command.direct_child_exit_confirmed === true && !command.signal && !command.timed_out && !command.output_limited && !command.interrupted && !command.spawn_error, 'git_observation');
    check(command.stdout_path === `${label}.stdout` && command.stderr_path === `${label}.stderr` && command.stdout_sha256 === sha256(raw) && command.stderr_sha256 === sha256(err) && err.length === 0, 'git_raw');
    check(Array.isArray(run.commands) && run.commands.filter(row => row.label === label).length === 1 && run.commands.some(row => row.label === label && row.record === `${label}.command.json` && row.exit_code === 0), 'git_index');
    const value = raw.toString('utf8').trim(); check(/^[a-f0-9]{40}$/.test(value), 'git_sha'); observedShas.push(value);
  }
  const [oldSha, currentSha] = observedShas;
  check(oldSha !== currentSha && expected.current_sha === currentSha, 'fixed_current_sha');
  check(expected.expected_exit === policy.exit && expected.failed === policy.failed && expected.drifted === policy.drifted, 'fixed_expectation');
  const sources = policy.sources.map(sourceId => ({ id: sourceId, origin: pathToFileURL(origin).href, ref: sourceId === 'missing-ref' ? 'refs/heads/not-present' : 'refs/heads/main', blessed_sha: sourceId === 'drift' ? oldSha : currentSha, auto_minor: false }));
  check(equal(expected.sources, sources), 'fixed_sources');
  const lines = sources.map(source => source.id === 'missing-ref' ? '  ✗ missing-ref  unreachable: no_matching_ref'
    : source.id === 'drift' ? `  ⚠ drift  drift  blessed=${oldSha.slice(0, 12)}  head=${currentSha.slice(0, 12)}  ref=refs/heads/main`
      : `  ✓ healthy  up-to-date (${currentSha.slice(0, 12)})`);
  check(equal(stdout.toString('utf8').split('\n').filter(line => line !== ''), [`Checking ${sources.length} source(s) against their tracked refs...`, ...lines, `${policy.failed} source(s) failed to check.`, `${policy.drifted} source(s) drifted from blessed_sha.`]), 'full_raw_semantics');
}
function verifyPassed(files, id, feature, receipt, manifest, full) {
  const run = parse(files, 'run.json');
  check(typeof receipt.run_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(receipt.run_id) && manifest.run_id === receipt.run_id && run.run_id === receipt.run_id, 'run_identity');
  check(run.status === 'passed' && equal(run.selected_cases, [id]), 'run_state');
  check(run.bindings_unchanged === true && equal(run.bindings, run.final_bindings) && equal(run.bindings, receipt.binding_digests), 'run_bindings');
  check(receipt.behavior === 'passed' && receipt.failure === null, 'receipt_result');
  const expected = parse(files, 'expectations.json').definitions;
  check(expected?.length === 1 && expected[0].case_id === id, 'fixed_case');
  const e = expected[0]; const code = id === 'healthy' ? 0 : 1;
  if (!full) check(e.expected_exit === code && e.failed === code && e.drifted === 0 && e.sources?.length === 1 && e.sources[0].id === id && /^[a-f0-9]{40}$/.test(e.sources[0].blessed_sha), 'fixed_expectation');
  const command = parse(files, `${id}.command.json`); const detail = parse(files, `${id}.json`);
  const stdout = required(files, `${id}.stdout`); const stderr = required(files, `${id}.stderr`); const input = required(files, `${id}.input.json`);
  if (full) fullExpectation(files, id, e, stdout);
  check(equal(JSON.parse(input), { version: 1, sources: e.sources }), 'input_identity');
  check(Object.entries(command).every(([key, value]) => equal(detail[key], value)), 'command_detail_conflict');
  check(command.stdout_sha256 === sha256(stdout) && command.stderr_sha256 === sha256(stderr), 'raw_hash');
  const observed = evaluateCase(e, { ...command, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }, detail.manifest_before_sha256 === sha256(input) && detail.manifest_after_sha256 === sha256(input));
  check(observed.verification_status === 'passed' && equal(receipt.cases, [observed]) && Object.entries(observed).every(([key, value]) => equal(detail[key], value)), 'behavior_mismatch');
  check(feature.product_exit === observed.actual_exit && feature.product_status === observed.source_check_status && feature.driver_exit === 0 && receipt.status === 'passed' && receipt.driver_exit === 0, 'passed_claim');
}
async function buildProjection(input, full) {
  const ids = full ? FULL_IDS : IDS;
  const root = await sealed(input, 'journey-manifest.json', ['cases', 'scratch', 'home']); const j = parse(root.files, 'journey.json');
  check(j.schema_version === 1, 'journey_version'); member(j.status, ['passed', 'failed'], 'journey_not_closed');
  check(j.features?.length === ids.length && equal(j.features.map(f => f.case_id), ids), 'fixed_case_set');
  check(j.host_execution === 'not_run' && j.native_skill_selection === 'not_observed' && j.model_calls === 0 && j.provider_qualified === false && j.formal_gate_pass === false, 'unexpected_qualification');
  const packet = { schema_version: full ? 2 : 1, kind: 'osstack_method_journey_projection', journey_status: j.status, failure_recorded: j.failure !== undefined && j.failure !== null,
    features: [], streams: [], references: [], scope: full ? FULL_SCOPE : SCOPE };
  ref(packet.references, 'journey.manifest', root.manifestBytes); ref(packet.references, 'journey.receipt', required(root.files, 'journey.json'));
  if (await exists(join(input, 'cases'))) { await directory(join(input, 'cases')); check((await names(join(input, 'cases'), ids.length)).every(id => ids.includes(id)), 'case_directory_set'); }
  const manifests = root.manifest.case_manifests;
  check(Array.isArray(manifests) && manifests.length <= ids.length && new Set(manifests.map(m => m.case_id)).size === manifests.length && manifests.every(m => ids.includes(m.case_id) && HASH.test(m.sha256) && typeof m.verified === 'boolean'), 'case_manifest_index');
  for (const f of j.features) {
    member(f.verification, ['passed', 'failed', 'not_run'], 'verification_status'); member(f.evidence_state, ['sealed', 'not_created', 'unsealed'], 'evidence_state');
    check(f.journey_status === j.status, 'journey_status_conflict');
    const out = { case_id: f.case_id, verification: f.verification, product_exit: f.product_exit ?? null, reported_product_exit: f.reported_product_exit ?? null,
      driver_exit: f.driver_exit ?? null, product_status: f.product_status ?? 'unknown', evidence_state: f.evidence_state, cleanup: cleanup(f.cleanup), reported_cleanup: null, receipt_cleanup_consistent: null, bindings: { source_digest: null, build_digest: null } };
    const dir = join(input, 'cases', f.case_id); const existsCase = await exists(dir); const retained = manifests.find(m => m.case_id === f.case_id);
    if (!existsCase) {
      check(f.evidence_state === 'not_created' && f.verification !== 'passed' && !retained, 'missing_case_evidence');
      check(f.reported_cleanup == null && f.reported_product_exit == null && (f.bindings == null || (f.bindings.source_digest == null && f.bindings.build_digest == null)), 'not_created_claim');
    }
    else {
      check(f.evidence_state === 'sealed' && retained, 'unsealed_case');
      const data = await sealed(dir, 'manifest.json'); check(sha256(data.manifestBytes) === retained.sha256 && retained.verified === (f.verification === 'passed'), 'case_manifest_binding');
      const receipt = parse(data.files, 'receipt.json'); const cleaned = parse(data.files, 'cleanup.json');
      check(equal(receipt.selected_cases, [f.case_id]) && receipt.driver_exit === out.driver_exit && receipt.provider_qualified === false, 'receipt_case');
      if (full && f.verification === 'passed') check(typeof cleaned.fixture_path === 'string' && isAbsolute(cleaned.fixture_path) && receipt.cleanup?.fixture_path === cleaned.fixture_path && f.cleanup?.fixture_path === cleaned.fixture_path, 'cleanup_fixture_identity');
      out.receipt_cleanup_consistent = equal(cleanup(cleaned), cleanup(receipt.cleanup));
      if (f.verification !== 'passed') out.reported_cleanup = cleanup(receipt.cleanup);
      if (f.verification === 'passed') { check(out.receipt_cleanup_consistent, 'receipt_cleanup'); verifyPassed(data.files, f.case_id, f, receipt, data.manifest, full); check(equal(out.cleanup, cleanup(cleaned)), 'feature_cleanup'); }
      // A driver may report passed before the enclosing verifier fails. Keep its claims unverified.
      out.bindings = bindingDigests(data.files);
      if (f.verification === 'passed') check(equal(out.bindings, f.bindings) && equal(out.bindings, receipt.binding_digests), 'feature_bindings');
      ref(packet.references, `${f.case_id}.manifest`, data.manifestBytes);
      for (const [name, suffix] of [['receipt.json', 'receipt'], ['cleanup.json', 'cleanup'], ['bindings.json', 'bindings'], ['expectations.json', 'expectations'], [`${f.case_id}.command.json`, 'product.command'], [`${f.case_id}.json`, 'product.detail'], [`${f.case_id}.input.json`, 'product.input']]) {
        if (data.files.has(name)) ref(packet.references, `${f.case_id}.${suffix}`, data.files.get(name));
      }
      for (const channel of ['stdout', 'stderr']) if (data.files.has(`${f.case_id}.${channel}`)) stream(packet.streams, packet.references, f.case_id, channel, data.files.get(`${f.case_id}.${channel}`), full);
    }
    packet.features.push(out);
  }
  validatePacket(packet); return packet;
}

// Publication validator reads the packet only. It neither follows original paths nor authenticates provenance.
export function validatePacket(p) {
  keys(p, ['schema_version', 'kind', 'journey_status', 'failure_recorded', 'features', 'streams', 'references', 'scope']);
  check([1, 2].includes(p.schema_version), 'packet_version_scope');
  const full = p.schema_version === 2; const ids = full ? FULL_IDS : IDS; const refIds = full ? FULL_REF_IDS : REF_IDS;
  check(p.kind === 'osstack_method_journey_projection' && equal(p.scope, full ? FULL_SCOPE : SCOPE), 'packet_version_scope');
  member(p.journey_status, ['passed', 'failed'], 'packet_status'); check(typeof p.failure_recorded === 'boolean', 'failure_flag');
  check(Array.isArray(p.features) && p.features.length === ids.length && equal(p.features.map(f => f.case_id), ids), 'packet_cases');
  for (const f of p.features) {
    keys(f, ['case_id', 'verification', 'product_exit', 'reported_product_exit', 'driver_exit', 'product_status', 'evidence_state', 'cleanup', 'reported_cleanup', 'receipt_cleanup_consistent', 'bindings']);
    member(f.verification, ['passed', 'failed', 'not_run'], 'packet_verification'); member(f.product_status, full ? ['healthy', 'failed', 'drift', 'empty', 'unknown'] : ['healthy', 'failed', 'unknown'], 'packet_product_status');
    member(f.evidence_state, ['sealed', 'not_created'], 'packet_evidence_state'); check(exit(f.product_exit) && exit(f.reported_product_exit) && exit(f.driver_exit), 'packet_exit');
    keys(f.cleanup, ['status', 'fixture_removed', 'descendant_termination']); cleanup(f.cleanup);
    check(f.receipt_cleanup_consistent === null || typeof f.receipt_cleanup_consistent === 'boolean', 'cleanup_consistency');
    if (f.reported_cleanup !== null) { keys(f.reported_cleanup, ['status', 'fixture_removed', 'descendant_termination']); cleanup(f.reported_cleanup); }
    keys(f.bindings, ['source_digest', 'build_digest']); check(Object.values(f.bindings).every(v => v === null || (typeof v === 'string' && HASH.test(v))), 'packet_bindings');
    if (f.verification === 'passed') check(f.product_exit === (full ? POLICIES[f.case_id].exit : f.case_id === 'healthy' ? 0 : 1) && f.product_status === (full ? POLICIES[f.case_id].status : f.case_id === 'healthy' ? 'healthy' : 'failed') && f.driver_exit === 0 && f.reported_product_exit === null && f.evidence_state === 'sealed' && f.cleanup.status === 'passed' && f.cleanup.fixture_removed === true && f.reported_cleanup === null && f.receipt_cleanup_consistent === true && Object.values(f.bindings).every(v => v !== null), 'packet_passed_claim');
    else {
      check(f.product_exit === null && f.product_status === 'unknown', 'unverified_product_claim');
      check(['unknown', 'not_started'].includes(f.cleanup.status) && f.cleanup.fixture_removed === null, 'unverified_cleanup_claim');
    }
    if (f.evidence_state === 'not_created') check(f.reported_cleanup === null && f.receipt_cleanup_consistent === null && f.reported_product_exit === null && Object.values(f.bindings).every(v => v === null), 'not_created_claim');
    if (f.verification === 'not_run') check(f.driver_exit === null && f.reported_product_exit === null && f.evidence_state === 'not_created' && f.cleanup.status === 'not_started' && f.reported_cleanup === null && f.receipt_cleanup_consistent === null, 'not_run_claim');
  }
  if (p.journey_status === 'passed') {
    check(p.features.every(f => f.verification === 'passed') && !p.failure_recorded, 'journey_pass_claim');
    check(p.features.every(f => equal(p.features[0].bindings, f.bindings)), 'cross_case_bindings');
  }
  check(Array.isArray(p.references) && p.references.length <= refIds.size, 'reference_count'); const refs = new Map();
  for (const r of p.references) { keys(r, ['id', 'bytes', 'sha256']); check(refIds.has(r.id) && !refs.has(r.id) && integer(r.bytes) && r.bytes <= MAX_FILE && typeof r.sha256 === 'string' && HASH.test(r.sha256), 'reference_shape'); refs.set(r.id, r); }
  check(refs.has('journey.manifest') && refs.has('journey.receipt'), 'journey_references');
  for (const f of p.features) {
    const present = [...refs.keys()].filter(id => id.startsWith(f.case_id + '.'));
    if (f.evidence_state === 'not_created') check(present.length === 0, 'unexpected_case_reference');
    else for (const suffix of f.verification === 'passed' ? REF_SUFFIXES : ['manifest', 'receipt', 'cleanup']) check(refs.has(`${f.case_id}.${suffix}`), 'required_case_reference');
  }
  check(Array.isArray(p.streams) && p.streams.length <= ids.length * 2, 'stream_count'); const streams = new Set();
  for (const s of p.streams) {
    keys(s, ['id', 'selected_lines', 'omitted_bytes']); check(ids.some(id => s.id === `${id}.product.stdout` || s.id === `${id}.product.stderr`) && refs.has(s.id) && !streams.has(s.id), 'stream_id'); streams.add(s.id);
    check(Array.isArray(s.selected_lines) && s.selected_lines.length <= 8 && s.selected_lines.every(full ? safeFullLine : safeLine), 'snippet_allowlist');
    if (s.id.endsWith('.stderr')) check(s.selected_lines.length === 0, 'stderr_not_projected');
    const feature = p.features.find(f => s.id.startsWith(f.case_id + '.'));
    if (feature.verification === 'passed') {
      if (s.id.endsWith('.stderr')) check(refs.get(s.id).bytes === 0, 'passed_stderr_conflict');
      const id = feature.case_id;
      if (full && s.id.endsWith('.stdout')) {
        const policy = POLICIES[id];
        const lines = s.selected_lines;
        check(lines.length === policy.sources.length + 3 && lines[0] === `Checking ${policy.sources.length} source(s) against their tracked refs...` && lines.at(-2) === `${policy.failed} source(s) failed to check.` && lines.at(-1) === `${policy.drifted} source(s) drifted from blessed_sha.`, 'passed_snippet_conflict');
        for (const [i, sourceId] of policy.sources.entries()) {
          const line = lines[i + 1];
          check(sourceId === 'healthy' ? /^  ✓ healthy  up-to-date \([a-f0-9]{12}\)$/.test(line) : sourceId === 'missing-ref' ? line === '  ✗ missing-ref  unreachable: no_matching_ref' : /^  ⚠ drift  drift  blessed=[a-f0-9]{12}  head=[a-f0-9]{12}  ref=refs\/heads\/main$/.test(line), 'passed_snippet_conflict');
        }
        if (id === 'mixed') check(lines[1].match(/\(([a-f0-9]{12})\)/)[1] === lines[3].match(/head=([a-f0-9]{12})/)[1], 'passed_snippet_conflict');
      } else if (!full) {
        const failed = id === 'healthy' ? 0 : 1;
        const summaries = ['Checking 1 source(s) against their tracked refs...', `${failed} source(s) failed to check.`, '0 source(s) drifted from blessed_sha.'];
        check(s.selected_lines.every(line => summaries.includes(line) || (id === 'healthy' ? /^  ✓ healthy  up-to-date \([a-f0-9]{12}\)$/.test(line) : line === '  ✗ missing-ref  unreachable: no_matching_ref')), 'passed_snippet_conflict');
      }
    }
    const bytes = s.selected_lines.reduce((n, line) => n + Buffer.byteLength(line), 0);
    check(bytes <= 1024 && integer(s.omitted_bytes) && s.omitted_bytes + bytes === refs.get(s.id).bytes, 'snippet_bytes');
  }
  for (const id of refs.keys()) if (id.endsWith('.stdout') || id.endsWith('.stderr')) check(streams.has(id), 'missing_stream');
  check(Buffer.byteLength(jsonBytes(p)) <= MAX_PACKET, 'packet_size_limit'); return p;
}
export async function checkPacket(path) {
  await directory(path); check(equal((await names(path, 2)).sort(), ['manifest.json', 'packet.json']), 'packet_inventory');
  const manifestBytes = await bounded(join(path, 'manifest.json'), 4096); const manifest = JSON.parse(manifestBytes);
  check(manifestBytes.equals(Buffer.from(jsonBytes(manifest))), 'packet_manifest_canonical'); keys(manifest, ['schema_version', 'files']);
  check(manifest.schema_version === 1 && Array.isArray(manifest.files) && manifest.files.length === 1, 'packet_manifest');
  const row = manifest.files[0]; keys(row, ['path', 'bytes', 'sha256']); check(row.path === 'packet.json' && integer(row.bytes) && HASH.test(row.sha256), 'packet_manifest_entry');
  const bytes = await bounded(join(path, 'packet.json'), MAX_PACKET); check(bytes.length === row.bytes && sha256(bytes) === row.sha256, 'packet_manifest_hash');
  const packet = JSON.parse(bytes); check(bytes.equals(Buffer.from(jsonBytes(packet))), 'packet_canonical');
  validatePacket(packet); return { status: 'valid', packet_sha256: sha256(bytes), original_evidence_revalidated: false, formal_gate_pass: false };
}
export async function projectJourney({ input, output, scope }) {
  check(scope === undefined || scope === 'full', 'invalid_scope');
  check(typeof input === 'string' && typeof output === 'string' && isAbsolute(input) && isAbsolute(output), 'absolute_paths_required');
  await directory(input); input = await realpath(input); output = resolve(output);
  const parent = await realpath(dirname(output)); output = join(parent, output.split(sep).at(-1));
  check(!inside(input, output) && !inside(output, input), 'input_output_overlap');
  const scratch = await realpath(scratchRoot()); check(inside(scratch, output) && output !== scratch, 'output_outside_scratch');
  check(!await exists(output), 'output_exists');
  const packet = await buildProjection(input, scope === 'full'); // Validate before acquiring an output directory.
  await mkdir(output, { mode: 0o700 });
  const bytes = Buffer.from(jsonBytes(packet));
  await writeFile(join(output, 'packet.json'), bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(join(output, 'manifest.json'), jsonBytes({ schema_version: 1, files: [{ path: 'packet.json', bytes: bytes.length, sha256: sha256(bytes) }] }), { flag: 'wx', mode: 0o600 });
  await checkPacket(output);
  return { status: 'projected', packet_sha256: sha256(bytes), input_opened_read_only: true, formal_gate_pass: false };
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  try { const options = parseOptions(process.argv.slice(2)); console.log(JSON.stringify(options.check ? await checkPacket(options.check) : await projectJourney(options))); }
  catch (error) { const usage = error.message.startsWith('usage:'); console.error(JSON.stringify({ status: 'rejected', error: usage || /^[a-z_]+$/.test(error.message) ? error.message : 'projection_or_packet_validation_failed' })); process.exitCode = usage ? 2 : 1; }
}
