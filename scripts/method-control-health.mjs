#!/usr/bin/env node
// Offline retained-record query. Hashes establish consistency, never producer authority.
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRetainedJourney } from './project-method-journey-evidence.mjs';
import { sha256, evaluateCase } from './lib/skills-check-verification.mjs';

const IDS = ['healthy', 'missing-ref', 'drift', 'mixed', 'empty'];
const FEATURES = ['maintenance', 'journey', 'packet'];
const HASH = /^[a-f0-9]{64}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
const diagnostic = value => typeof value === 'string' && Buffer.byteLength(value) <= 4096;
const check = (ok, code) => { if (!ok) throw Error(code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeError = error => /^[A-Za-z0-9_:-]{1,100}$/.test(error?.message ?? '') ? error.message : 'evidence_validation_failed';
function keys(value, expected, code = 'invalid_config') {
  check(value && typeof value === 'object' && !Array.isArray(value) && equal(Object.keys(value).sort(), [...expected].sort()), code);
}
function text(value) { check(typeof value === 'string' && value.trim() === value && value.length > 0 && Buffer.byteLength(value) <= 4096 && !Array.from(value).some(c => c.codePointAt(0) < 32 || c.codePointAt(0) === 127), 'invalid_config'); }
function id(value) { check(typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value), 'invalid_config'); }
function pathRef(value) { text(value); check(!isAbsolute(value) && !value.includes('\\') && value.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'invalid_path'); }
function array(value, max, minimum = 0) { check(Array.isArray(value) && value.length >= minimum && value.length <= max, 'invalid_config'); }
function unique(values) { check(new Set(values).size === values.length, 'invalid_config'); }
function time(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value), 'invalid_time');
  const ms = Date.parse(value); check(Number.isFinite(ms) && new Date(ms).toISOString() === (value.length === 20 ? value.replace('Z', '.000Z') : value), 'invalid_time'); return ms;
}
function parse(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw Error('invalid_json_or_utf8'); } }
async function read(path, max, kind, onRead) {
  let fd;
  try {
    const info = await lstat(path); check(!info.isSymbolicLink(), 'symlink'); check(info.isFile(), 'regular_file_required');
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await fd.stat(); check(before.isFile() && before.size <= max, 'file_size_limit');
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) { const n = await fd.read(buffer, size, buffer.length - size, null); if (!n.bytesRead) break; size += n.bytesRead; }
    const after = await fd.stat(), current = await lstat(path);
    check(!current.isSymbolicLink() && size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.ino === current.ino && after.dev === current.dev, 'file_changed');
    const bytes = Buffer.from(buffer.subarray(0, size)); if (onRead) await onRead({ kind, path }); return bytes;
  } finally { await fd?.close(); }
}
async function confined(root, ref) {
  pathRef(ref); let path = root;
  for (const part of ref.split('/')) { path = join(path, part); check(!(await lstat(path)).isSymbolicLink(), 'symlink'); }
  return path;
}
function validateConfig(config) {
  keys(config, ['schema_version', 'project', 'max_age_seconds', 'features']); check(config.schema_version === 1, 'invalid_config'); text(config.project);
  check(Number.isInteger(config.max_age_seconds) && config.max_age_seconds >= 1 && config.max_age_seconds <= 31536000, 'invalid_config');
  array(config.features, 8, 1); let count = 0;
  for (const f of config.features) {
    keys(f, ['feature_id', 'owner_ref', 'source_digest', 'build_digest', 'driver_sha256', 'changed_paths', 'required_feature_ids', 'attempts']);
    check(FEATURES.includes(f.feature_id), 'invalid_config'); if (f.owner_ref !== null) text(f.owner_ref);
    for (const key of ['source_digest', 'build_digest', 'driver_sha256']) check(f[key] === null || isHash(f[key]), 'invalid_config');
    array(f.changed_paths, 32); f.changed_paths.forEach(pathRef); unique(f.changed_paths);
    array(f.required_feature_ids, 8); f.required_feature_ids.forEach(id); unique(f.required_feature_ids);
    array(f.attempts, 8); count += f.attempts.length;
    for (const a of f.attempts) { keys(a, ['attempt_id', 'kind', 'path', 'receipt_sha256']); id(a.attempt_id); check(a.kind === 'maintenance' && isHash(a.receipt_sha256), 'invalid_config'); pathRef(a.path); }
    unique(f.attempts.map(a => a.attempt_id)); unique(f.attempts.map(a => a.path));
  }
  unique(config.features.map(f => f.feature_id)); check(count <= 8, 'attempt_budget');
  const seen = new Set(), active = new Set(), map = new Map(config.features.map(f => [f.feature_id, f]));
  function visit(key) { check(map.has(key), 'unknown_dependency'); check(!active.has(key), 'dependency_cycle'); if (seen.has(key)) return; active.add(key); map.get(key).required_feature_ids.forEach(visit); active.delete(key); seen.add(key); }
  config.features.forEach(f => visit(f.feature_id));
}
function validateMap(map) {
  keys(map, ['schema_version', 'target', 'features'], 'map_schema'); check(map.schema_version === 1 && map.target === 'skills-check-full' && Array.isArray(map.features) && map.features.length === 5, 'map_schema');
  const seen = new Set();
  for (const row of map.features) {
    keys(row, ['case_id', 'expected_product_exit', 'expected_product_status'], 'map_schema');
    check(IDS.includes(row.case_id) && !seen.has(row.case_id) && Number.isInteger(row.expected_product_exit) && row.expected_product_exit >= 0 && row.expected_product_exit <= 255 && ['healthy', 'failed', 'drift', 'empty'].includes(row.expected_product_status), 'map_schema'); seen.add(row.case_id);
  }
}
const unknownVersions = () => ({ source: 'unknown', build: 'unknown', driver: 'unknown' });
function compare(actual, configured) { return actual == null || configured === null ? 'unknown' : actual === configured ? 'matches_configured' : 'drift'; }
async function boundMember(root, manifest, name, onRead) {
  const entry = manifest.files?.find(x => x.path === name); check(entry && Number.isSafeInteger(entry.bytes) && entry.bytes <= 8 * 1024 * 1024, 'missing_phase_evidence');
  const bytes = await read(await confined(root, name), 8 * 1024 * 1024, 'phase', onRead);
  check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256, 'phase_evidence_hash'); return bytes;
}
async function classifyFailure(journeyDir, manifest, j, packet, onRead) {
  for (const f of j.features) {
    if (f.verification !== 'failed') continue;
    const phase = f.driver_exit === null ? 'doctor' : 'drive';
    try {
      const command = parse(await boundMember(journeyDir, manifest, `${f.case_id}-${phase}.command.json`, onRead));
      const stdout = await boundMember(journeyDir, manifest, `${f.case_id}-${phase}.stdout`, onRead);
      await boundMember(journeyDir, manifest, `${f.case_id}-${phase}.stderr`, onRead);
      if (phase === 'doctor') {
        let doctor; try { doctor = parse(stdout); } catch { /* Unknown diagnostic shape stays unknown below. */ }
        if (doctor?.ready === false && doctor.executed === false && equal(doctor.cases, [f.case_id]) && Array.isArray(doctor.checks) && doctor.checks.some(x => typeof x.id === 'string' && x.ok === false)) return 'environment_blocked';
      }
      if (command.timed_out === true || command.output_limited === true || command.interrupted === true || command.signal || command.killed === true || command.error || (Number.isInteger(command.exit_code) && command.exit_code !== 0)) return 'tool_failure';
    } catch { /* An unverified phase cannot justify a category. */ }
    // For a retained failed case, inspect the exact original files already sealed by the common verifier.
    if (f.evidence_state === 'sealed') {
      try {
        const dir = await confined(journeyDir, `cases/${f.case_id}`);
        const manifestBytes = await read(join(dir, 'manifest.json'), 1048576, 'case_manifest', onRead);
        check(sha256(manifestBytes) === packet.references.find(x => x.id === `${f.case_id}.manifest`)?.sha256, 'case_manifest_hash');
        const m = parse(manifestBytes), expected = parse(await boundMember(dir, m, 'expectations.json', onRead)).definitions;
        const command = parse(await boundMember(dir, m, `${f.case_id}.command.json`, onRead));
        const detail = parse(await boundMember(dir, m, `${f.case_id}.json`, onRead));
        const stdout = (await boundMember(dir, m, `${f.case_id}.stdout`, onRead)).toString('utf8');
        const stderr = (await boundMember(dir, m, `${f.case_id}.stderr`, onRead)).toString('utf8');
        check(expected?.length === 1 && expected[0].case_id === f.case_id && IDS.includes(f.case_id), 'fixed_case');
        const requiredExit = { healthy: 0, 'missing-ref': 1, drift: 2, mixed: 1, empty: 0 }[f.case_id];
        check(expected[0].expected_exit === requiredExit && command.direct_child_exit_confirmed === true && !command.timed_out && !command.output_limited && !command.interrupted && !command.spawn_error && !command.signal && detail.input_unchanged === true, 'product_observation_incomplete');
        const result = evaluateCase(expected[0], { ...command, stdout, stderr }, true);
        if (result.verification_status === 'failed' && result.errors.some(x => x === 'exit_mismatch' || x === 'summary_mismatch' || x === 'unexpected_stderr' || x.startsWith('source_output_mismatch:'))) return 'observed_product_deviation';
      } catch { /* Unsupported failed case shapes are not guessed into product failures. */ }
    }
  }
  return 'unknown';
}
async function inspectAttempt(root, f, attempt, asOf, onRead) {
  const result = { attempt_id: attempt.attempt_id, integrity: 'unknown', recorded_outcome: null, started_at: null, ended_at: null,
    classification: 'unknown', cause: 'unknown', versions: unknownVersions(), tool_state: { status: 'unknown', before_sha256: null }, issues: [],
    receipt_sha256: attempt.receipt_sha256, scope: 'fixed_five_skills_check', record_details: { wrapper_status: null, journey_status: null, map_state: 'unknown', failure: null, subsequent_failures: [] }, historical_success: false };
  try {
    const dir = await confined(root, attempt.path); check((await lstat(dir)).isDirectory(), 'record_directory');
    const raw = await read(await confined(dir, 'maintenance.json'), 1048576, 'maintenance', onRead); check(sha256(raw) === attempt.receipt_sha256, 'receipt_hash');
    const r = parse(raw); check(r.schema_version === 1 && ['consistent', 'mismatch', 'blocked'].includes(r.status) && r.exit_code === ({ consistent: 0, mismatch: 1, blocked: 2 })[r.status], 'maintenance_status');
    check(r.model_calls === 0 && r.formal_gate_pass === false && ['runJourney', 'injected_journey', 'runJourney_with_injected_driver'].includes(r.execution_path), 'maintenance_scope');
    const start = time(r.started_at), end = time(r.ended_at); check(start <= end && end <= asOf, 'attempt_time');
    result.started_at = r.started_at; result.ended_at = r.ended_at; result.recorded_outcome = r.status; result.record_details.wrapper_status = r.status;
    check(r.failure === null || diagnostic(r.failure), 'failure_shape'); check(Array.isArray(r.subsequent_failures) && r.subsequent_failures.length <= 32 && r.subsequent_failures.every(diagnostic), 'failure_shape');
    if (r.status !== 'blocked') check(r.failure === null && r.subsequent_failures.length === 0, 'success_failure_conflict');
    const before = await read(await confined(dir, 'map-before.json'), 65536, 'map', onRead); const map = parse(before); validateMap(map);
    check(r.map && r.map.before_sha256 === sha256(before) && r.map.bytes === before.length && typeof r.map.unchanged === 'boolean', 'map_binding');
    check(r.map.after_sha256 === null || isHash(r.map.after_sha256), 'map_state');
    // Normal unchanged runs omit this file. If retained, it must agree with the receipt.
    let afterPresent = false;
    try { await lstat(join(dir, 'map-after.json')); afterPresent = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (afterPresent) {
      const after = await read(await confined(dir, 'map-after.json'), 65536, 'map', onRead);
      check(sha256(after) === r.map.after_sha256 && after.equals(before) === r.map.unchanged, 'map_state');
    }
    if (r.map.unchanged) { check(r.map.after_sha256 === r.map.before_sha256, 'map_state'); result.record_details.map_state = 'unchanged'; }
    else if (r.map.after_sha256 !== null) {
      check(afterPresent, 'map_state'); result.record_details.map_state = 'changed';
    }
    if (r.tool !== undefined) {
      keys(r.tool, ['before_sha256', 'after_sha256', 'unchanged'], 'tool_shape'); check(isHash(r.tool.before_sha256) && (r.tool.after_sha256 === null || isHash(r.tool.after_sha256)) && typeof r.tool.unchanged === 'boolean', 'tool_shape');
      check(r.tool.unchanged === (r.tool.before_sha256 === r.tool.after_sha256), 'tool_state');
      result.tool_state = { status: r.tool.after_sha256 === null ? 'unknown' : r.tool.unchanged ? 'unchanged' : 'changed', before_sha256: r.tool.before_sha256 };
    }
    const journeyDir = await confined(dir, 'journey'), journeyBytes = await read(await confined(journeyDir, 'journey.json'), 1048576, 'journey', onRead);
    const manifestBytes = await read(await confined(journeyDir, 'journey-manifest.json'), 1048576, 'journey_manifest', onRead);
    const j = parse(journeyBytes), manifest = parse(manifestBytes);
    const packet = await inspectRetainedJourney({ input: journeyDir, scope: 'full' });
    check(packet.references.find(x => x.id === 'journey.receipt')?.sha256 === sha256(journeyBytes) && packet.references.find(x => x.id === 'journey.manifest')?.sha256 === sha256(manifestBytes), 'journey_snapshot_changed');
    check(time(j.started_at) >= start && time(j.ended_at) <= end && time(j.started_at) <= time(j.ended_at), 'journey_time');
    const claims = r.journey;
    check(claims && claims.receipt === 'journey/journey.json' && claims.manifest === 'journey/journey-manifest.json' && claims.status === j.status && (claims.failure ?? null) === (j.failure ?? null) && equal(claims.features, j.features), 'journey_claims');
    for (const [key, bytes] of [['receipt_sha256', journeyBytes], ['manifest_sha256', manifestBytes]]) check(claims[key] === null || claims[key] === sha256(bytes), 'journey_hash');
    check([null, true, false].includes(claims.receipt_matches_returned), 'journey_identity_state');
    result.record_details.journey_status = packet.journey_status;
    const completeWrapper = claims.receipt_sha256 !== null && claims.manifest_sha256 !== null && claims.receipt_matches_returned === true;
    const recomputed = j.status === 'passed' ? packet.features.map(row => {
      const e = map.features.find(x => x.case_id === row.case_id);
      return { case_id: row.case_id, expected: { product_exit: e.expected_product_exit, product_status: e.expected_product_status }, actual: { product_exit: row.product_exit, product_status: row.product_status }, matches: e.expected_product_exit === row.product_exit && e.expected_product_status === row.product_status };
    }) : [];
    check(Array.isArray(r.rows), 'rows_shape');
    if (r.status !== 'blocked') {
      check(completeWrapper && j.status === 'passed' && result.record_details.map_state === 'unchanged' && equal(r.rows, recomputed), 'maintenance_result');
      check((r.status === 'consistent') === recomputed.every(row => row.matches), 'maintenance_comparison');
      check(result.tool_state.status !== 'changed', 'maintenance_tool_changed');
    } else check(r.failure !== null && (r.rows.length === 0 || (completeWrapper && equal(r.rows, recomputed))), 'blocked_rows');
    const source = packet.features.map(x => x.bindings.source_digest), build = packet.features.map(x => x.bindings.build_digest);
    result.versions = { source: compare(source[0] && source.every(x => x === source[0]) ? source[0] : null, f.source_digest), build: compare(build[0] && build.every(x => x === build[0]) ? build[0] : null, f.build_digest), driver: compare(result.tool_state.status === 'unchanged' ? result.tool_state.before_sha256 : null, f.driver_sha256) };
    result.integrity = 'verified_retained';
    result.record_details.failure = r.failure;
    result.record_details.subsequent_failures = [...r.subsequent_failures];
    if (r.execution_path !== 'runJourney') { result.issues.push('injected_execution_path'); return result; }
    if (r.status === 'consistent') result.classification = 'consistent';
    else if (r.status === 'mismatch') result.classification = 'expectation_mismatch';
    else if (result.record_details.map_state === 'changed') result.classification = 'map_changed';
    else if (result.tool_state.status === 'changed') result.classification = 'tool_failure';
    else if (j.status === 'passed' && !completeWrapper && (['ENOENT', 'EACCES', 'EIO', 'journey_result_identity'].includes(r.failure))) result.classification = 'tool_evidence_failure';
    else result.classification = await classifyFailure(journeyDir, manifest, j, packet, onRead);
    result.historical_success = result.classification === 'consistent' && result.tool_state.status === 'unchanged';
    return result;
  } catch (error) { result.integrity = 'unknown'; result.classification = 'unknown'; result.historical_success = false; result.issues.push(safeError(error)); return result; }
}
function summarize(attempts, asOf, age) {
  const order = [...attempts].filter(x => x.integrity === 'verified_retained').sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at));
  const success = order.find(x => x.historical_success);
  const last_success = success ? { attempt_id: success.attempt_id, ended_at: success.ended_at, receipt_sha256: success.receipt_sha256 } : null;
  const unresolved = attempts.filter(x => x.integrity !== 'verified_retained').map(x => x.attempt_id);
  if (order.length > 1 && Date.parse(order[0].ended_at) === Date.parse(order[1].ended_at)) unresolved.push(...order.filter(x => Date.parse(x.ended_at) === Date.parse(order[0].ended_at)).map(x => x.attempt_id));
  const selected = !unresolved.length ? order[0] : null;
  const latest_attempt = { status: unresolved.length ? 'unknown' : selected ? 'selected' : 'none', attempt_id: selected?.attempt_id ?? null, ended_at: selected?.ended_at ?? null, reason: unresolved.length ? 'unreadable_or_unordered_attempt' : selected ? null : 'no_attempts', unresolved_attempt_ids: unresolved };
  const age_status = !selected ? 'unknown' : asOf - Date.parse(selected.ended_at) > age * 1000 ? 'expired' : 'within_window';
  let health = 'unknown';
  if (selected) {
    health = selected.classification === 'consistent' ? 'unknown' : selected.classification;
    if (selected.classification === 'consistent' && selected.tool_state.status === 'unchanged') {
      if (age_status === 'expired' || Object.values(selected.versions).includes('drift')) health = 'stale';
      else if (Object.values(selected.versions).every(x => x === 'matches_configured')) health = 'bounded_consistent';
    }
  }
  return { latest_attempt, last_success, health, versions: selected?.versions ?? unknownVersions(), age_status };
}
export async function inspectMethodControlHealth(input, { onRead } = {}) {
  check(input && typeof input === 'object' && Object.keys(input).every(k => ['config', 'asOf', 'changedPaths'].includes(k)), 'invalid_arguments');
  check(typeof input.config === 'string' && isAbsolute(input.config), 'absolute_config_required');
  const asOf = time(input.asOf), changed = input.changedPaths ?? []; array(changed, 32); changed.forEach(pathRef); unique(changed);
  check(onRead === undefined || typeof onRead === 'function', 'invalid_arguments');
  const root = await realpath(dirname(input.config)), bytes = await read(input.config, 65536, 'config', onRead), config = parse(bytes); validateConfig(config);
  const selected = new Set(), reasons = new Map();
  for (const f of config.features) {
    const paths = changed.filter(path => f.changed_paths.includes(path));
    if (!changed.length || paths.length) { selected.add(f.feature_id); reasons.set(f.feature_id, paths.length ? paths.map(path => `changed:${path}`) : ['explicit_all_configured']); }
  }
  let progress = true;
  while (progress) { progress = false; for (const f of config.features) if (!selected.has(f.feature_id) && f.required_feature_ids.some(key => selected.has(key))) { selected.add(f.feature_id); reasons.set(f.feature_id, f.required_feature_ids.filter(key => selected.has(key)).map(key => `depends_on:${key}`)); progress = true; } }
  const features = [];
  for (const f of config.features.filter(x => selected.has(x.feature_id))) {
    const attempts = [];
    for (const attempt of f.attempts) attempts.push(await inspectAttempt(root, f, attempt, asOf, onRead));
    features.push({ feature_id: f.feature_id, owner: { status: f.owner_ref === null ? 'unassigned' : 'configured', ref: f.owner_ref, configuration_sha256: sha256(bytes) }, selection_reasons: reasons.get(f.feature_id), attempts,
      ...summarize(attempts, asOf, config.max_age_seconds), limitations: ['Only fixed five skills-check maintenance; feature mapping is project-declared.', 'Retained hashes and caller-configured versions are not authentication or live freshness.', 'Owner declaration grants no permissions. Unknown owner remains unassigned.'] });
  }
  return { schema_version: 1, project: config.project, config_sha256: sha256(bytes), as_of: input.asOf, schedule: 'not_configured', notifications: 'none', execution: 'not_run', mapping_basis: 'project_declared', features,
    omitted: config.features.filter(f => !selected.has(f.feature_id)).map(f => ({ feature_id: f.feature_id, reason: 'not_affected' })), unmapped_changed_paths: changed.filter(path => !config.features.some(f => f.changed_paths.includes(path))), qualification: 'none' };
}
const help = `Usage: node scripts/method-control-health.mjs --config ABS --as-of ISO_UTC [--changed-path REL ...]
Read explicitly listed maintenance records. No drive, network, schedule or notification.
Compare recent attempt and historical last success separately. Changed paths use the project-declared exact-path map.
Exit 0 means report generated, not healthy. Exit 2 means invalid arguments or configuration.
Unverified, missing, stale or unsupported records remain unknown or stale. Hashes do not authenticate a producer.
Only fixed five-case skills-check maintenance is supported; expected nonzero product exits are not regressions.
`;
export async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return 0; }
  try {
    const input = { changedPaths: [] }, seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1]; check(['--config', '--as-of', '--changed-path'].includes(flag) && typeof value === 'string' && value.length > 0 && (flag === '--changed-path' || !seen.has(flag)), 'invalid_arguments'); seen.add(flag);
      if (flag === '--changed-path') input.changedPaths.push(value); else input[flag === '--config' ? 'config' : 'asOf'] = value;
    }
    const report = await inspectMethodControlHealth(input); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return 0;
  } catch (error) { process.stderr.write(`${JSON.stringify({ schema_version: 1, error: safeError(error) })}\n`); return 2; }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
