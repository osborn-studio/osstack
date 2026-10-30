#!/usr/bin/env node
// Local authoring data only. This selector neither drives a journey nor grants authority.
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMITS = { index: 65536, observations: 65536, leaf: 32768, total: 131072, closure: 8 };
const surfaces = ['cli', 'rpc', 'ui'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export class FeatureMapError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'FeatureMapError'; this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new FeatureMapError(code, details); };
const valid = (condition, code) => { if (!condition) fail(code); };
function object(value, keys, code) {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  valid(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);
}
function text(value, code) {
  valid(typeof value === 'string' && value.length > 0 && value.trim() === value && Buffer.byteLength(value) <= 4096, code);
  valid(!Array.from(value).some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127), code);
}
function id(value, code) { valid(typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value), code); }
function digest(value, code) { valid(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), code); }
function list(value, check, code, minimum = 0, maximum = 32) {
  valid(Array.isArray(value) && value.length >= minimum && value.length <= maximum, code);
  value.forEach(item => check(item, code));
}
function unique(values, code) { valid(new Set(values).size === values.length, code); }
function texts(value, code, minimum = 0) { list(value, text, code, minimum); unique(value, code); }
function ids(value, code, minimum = 0) { list(value, id, code, minimum); unique(value, code); }
function reference(value) {
  text(value, 'invalid_index');
  valid(!isAbsolute(value) && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'path_escape');
}
function validateIndex(index) {
  const code = 'invalid_index';
  object(index, ['schema_version', 'features'], code); valid(index.schema_version === 1, code);
  list(index.features, row => {
    object(row, ['feature_id', 'user_outcome', 'keywords', 'surfaces', 'leaf_ref', 'sha256', 'required_feature_ids', 'maintenance_owner_ref'], code);
    id(row.feature_id, code); text(row.user_outcome, code); texts(row.keywords, code, 1);
    list(row.surfaces, value => valid(surfaces.includes(value), code), code, 1, 3); unique(row.surfaces, code);
    reference(row.leaf_ref); digest(row.sha256, code); ids(row.required_feature_ids, code);
    if (row.maintenance_owner_ref !== null) text(row.maintenance_owner_ref, code);
  }, code, 1);
  unique(index.features.map(row => row.feature_id), code);
  const rows = new Map(index.features.map(row => [row.feature_id, row]));
  const visiting = new Set(), visited = new Set();
  function visit(key) {
    valid(rows.has(key), 'unknown_dependency'); valid(!visiting.has(key), 'dependency_cycle');
    if (visited.has(key)) return;
    visiting.add(key); rows.get(key).required_feature_ids.forEach(visit); visiting.delete(key); visited.add(key);
  }
  rows.forEach(row => visit(row.feature_id));
  return rows;
}
function validateLeaf(leaf, row) {
  const code = 'invalid_leaf';
  object(leaf, ['schema_version', 'feature_id', 'user_outcome', 'source_revision', 'driver_version', 'entries', 'preconditions', 'drive_refs', 'observations', 'gotchas', 'recovery_refs', 'covered_entry_ids', 'known_gaps', 'last_live_evidence'], code);
  valid(leaf.schema_version === 1, code); id(leaf.feature_id, code);
  for (const key of ['user_outcome', 'source_revision', 'driver_version']) text(leaf[key], code);
  list(leaf.entries, entry => {
    object(entry, ['id', 'surface', 'user_route'], code); id(entry.id, code); valid(surfaces.includes(entry.surface), code); text(entry.user_route, code);
  }, code, 1, 16);
  unique(leaf.entries.map(x => x.id), code);
  list(leaf.preconditions, entry => {
    object(entry, ['id', 'kind', 'description'], code); id(entry.id, code);
    valid(['data', 'auth', 'entitlement', 'runtime'].includes(entry.kind), code); text(entry.description, code);
  }, code); unique(leaf.preconditions.map(x => x.id), code);
  texts(leaf.drive_refs, code, 1); texts(leaf.recovery_refs, code, 1); texts(leaf.gotchas, code); texts(leaf.known_gaps, code);
  list(leaf.observations, entry => {
    object(entry, ['predicate_id', 'observable', 'side_effects'], code); id(entry.predicate_id, code); text(entry.observable, code); texts(entry.side_effects, code);
  }, code, 1); unique(leaf.observations.map(x => x.predicate_id), code);
  ids(leaf.covered_entry_ids, code);
  valid(leaf.covered_entry_ids.every(key => leaf.entries.some(x => x.id === key)), code);
  list(leaf.last_live_evidence, entry => {
    object(entry, ['ref', 'sha256'], code); text(entry.ref, code); digest(entry.sha256, code);
  }, code); unique(leaf.last_live_evidence.map(x => x.ref), code);
  valid(leaf.feature_id === row.feature_id && leaf.user_outcome === row.user_outcome, 'leaf_identity_mismatch');
  valid(JSON.stringify([...new Set(leaf.entries.map(x => x.surface))].sort()) === JSON.stringify([...row.surfaces].sort()), 'leaf_identity_mismatch');
}
function validateObservations(input, rows) {
  const code = 'invalid_observations';
  object(input, ['schema_version', 'features'], code); valid(input.schema_version === 1, code);
  list(input.features, row => {
    object(row, ['feature_id', 'source_revision', 'driver_version', 'preconditions', 'observed_entry_ids'], code);
    id(row.feature_id, code); valid(rows.has(row.feature_id), code);
    for (const key of ['source_revision', 'driver_version']) if (row[key] !== null) text(row[key], code);
    list(row.preconditions, entry => {
      object(entry, ['id', 'status'], code); id(entry.id, code); valid(['met', 'missing', 'unknown'].includes(entry.status), code);
    }, code); unique(row.preconditions.map(x => x.id), code); ids(row.observed_entry_ids, code);
  }, code); unique(input.features.map(x => x.feature_id), code);
  return new Map(input.features.map(row => [row.feature_id, row]));
}
async function leafPath(root, ref) {
  let path = root;
  for (const part of ref.split('/')) {
    path = join(path, part);
    try { valid(!(await lstat(path)).isSymbolicLink(), 'symlink'); }
    catch (error) { if (error instanceof FeatureMapError) throw error; fail(error.code === 'ENOENT' ? 'required_material_missing' : 'file_unavailable'); }
  }
  const canonical = await realpath(path).catch(() => fail('file_unavailable'));
  const rel = relative(root, canonical);
  valid(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'path_escape');
  return path;
}
async function readBounded(path, kind, onRead, remaining = LIMITS[kind]) {
  let file;
  try {
    const entry = await lstat(path);
    valid(!entry.isSymbolicLink(), 'symlink'); valid(entry.isFile(), 'not_regular');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat(); valid(before.isFile(), 'not_regular'); valid(before.size <= LIMITS[kind], 'file_too_large');
    valid(before.size <= remaining, 'selection_budget');
    const buffer = Buffer.alloc(Math.min(LIMITS[kind], remaining) + 1); let size = 0;
    while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
    valid(size <= LIMITS[kind], 'file_too_large'); valid(size <= remaining, 'selection_budget');
    const after = await file.stat(), current = await lstat(path);
    valid(!current.isSymbolicLink(), 'symlink');
    valid(before.dev === current.dev && before.ino === current.ino && before.size === after.size && size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && current.mtimeMs === after.mtimeMs && current.ctimeMs === after.ctimeMs, 'file_changed');
    const bytes = Buffer.from(buffer.subarray(0, size));
    if (onRead) { try { await onRead({ kind, path }); } catch { fail('observer_failed'); } }
    return bytes;
  } catch (error) {
    if (error instanceof FeatureMapError) throw error;
    fail(kind === 'leaf' && error.code === 'ENOENT' ? 'required_material_missing' : 'file_unavailable');
  } finally { await file?.close(); }
}
function parse(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('invalid_utf8'); }
  try { return JSON.parse(content); } catch { fail('invalid_json'); }
}
function state(leaf, observed) {
  if (observed) {
    valid(observed.preconditions.every(x => leaf.preconditions.some(p => p.id === x.id)), 'invalid_observations');
    valid(observed.observed_entry_ids.every(key => leaf.entries.some(x => x.id === key)), 'invalid_observations');
  }
  const compare = key => observed?.[key] == null ? 'unknown' : observed[key] === leaf[key] ? 'matches_reported' : 'drift';
  const freshness = { source: compare('source_revision'), driver: compare('driver_version') };
  const preconditions = leaf.preconditions.map(row => {
    const status = observed?.preconditions.find(x => x.id === row.id)?.status;
    return { id: row.id, status: status === 'met' ? 'reported_met' : status === 'missing' ? 'blocked' : 'unknown' };
  });
  const availability = Object.values(freshness).includes('drift') ? 'drift'
    : preconditions.some(x => x.status === 'blocked') ? 'blocked'
      : Object.values(freshness).includes('unknown') || preconditions.some(x => x.status === 'unknown') ? 'unknown' : 'reported_available';
  return { freshness, preconditions, availability, declared_covered_entry_ids: leaf.covered_entry_ids,
    caller_observed_entry_ids: observed?.observed_entry_ids ?? [], unverified_entry_ids: leaf.entries.map(x => x.id),
    evidence_status: leaf.last_live_evidence.length === 0 ? 'draft' : 'unverified', execution_status: 'not_run' };
}
export async function selectFeatureMap(input, { onRead } = {}) {
  valid(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid_arguments');
  valid(Object.keys(input).every(key => ['index', 'query', 'limit', 'observations'].includes(key)), 'invalid_arguments');
  text(input.index, 'invalid_arguments'); text(input.query, 'invalid_arguments');
  const limit = input.limit ?? 1;
  valid(Number.isInteger(limit) && limit >= 1 && limit <= 5, 'invalid_arguments');
  if (input.observations !== undefined) text(input.observations, 'invalid_arguments');
  valid(onRead === undefined || typeof onRead === 'function', 'invalid_arguments');
  const indexPath = resolve(input.index), root = await realpath(dirname(indexPath)).catch(() => fail('file_unavailable'));
  const bytes = await readBounded(indexPath, 'index', onRead), index = parse(bytes), rows = validateIndex(index);
  let observedBytes = null, observed = new Map();
  if (input.observations !== undefined) {
    observedBytes = await readBounded(resolve(input.observations), 'observations', onRead);
    observed = validateObservations(parse(observedBytes), rows);
  }
  let searchKnowledgePacks;
  try {
    ({ searchKnowledgePacks } = await import('../packages/knowledge/dist/index.js'));
    if (typeof searchKnowledgePacks !== 'function') fail('knowledge_unavailable');
  }
  catch { fail('knowledge_unavailable'); }
  const pack = { path: indexPath, manifest: { id: 'feature-map-index', version: '1', name: 'Local feature metadata', license: 'UNSPECIFIED', source_kind: 'local-index', quality_score: 100,
    chunks: index.features.map(row => ({ chunk_id: row.feature_id, title: row.feature_id, body: [row.user_outcome, ...row.keywords].join(' '), tags: row.keywords })) } };
  const matches = searchKnowledgePacks([pack], input.query, { limit });
  const reasons = new Map(), selectedIds = [];
  for (const hit of matches) reasons.set(hit.chunk_id, [{ kind: 'query', matched_terms: hit.matched_terms, score: hit.score, required_by: null }]);
  function expand(key, parent) {
    if (parent) {
      if (!reasons.has(key)) reasons.set(key, []);
      reasons.get(key).push({ kind: 'dependency', matched_terms: [], score: 0, required_by: parent });
    }
    if (selectedIds.includes(key)) return;
    selectedIds.push(key); valid(selectedIds.length <= LIMITS.closure, 'selection_budget');
    rows.get(key).required_feature_ids.forEach(child => expand(child, key));
  }
  matches.forEach(hit => expand(hit.chunk_id, null));
  const selected = []; let total = 0;
  for (const key of selectedIds) {
    const row = rows.get(key);
    try {
      const path = await leafPath(root, row.leaf_ref), raw = await readBounded(path, 'leaf', onRead, LIMITS.total - total);
      // Recheck confinement after reading; this is a snapshot check, not a concurrent-writer fence.
      await leafPath(root, row.leaf_ref);
      total += raw.length; valid(total <= LIMITS.total, 'selection_budget');
      valid(sha(raw) === row.sha256, 'content_drift'); const leaf = parse(raw); validateLeaf(leaf, row);
      selected.push({ feature_id: key, reasons: reasons.get(key), leaf_ref: row.leaf_ref, sha256: sha(raw), bytes: raw.length, leaf,
        ...state(leaf, observed.get(key)), maintenance_owner_ref: row.maintenance_owner_ref });
    } catch (error) {
      if (error instanceof FeatureMapError) { error.details = { feature_id: key }; throw error; }
      throw error;
    }
  }
  return { schema_version: 1, selection_status: matches.length ? 'complete' : 'no_match', query: input.query,
    index_sha256: sha(bytes), observations_sha256: observedBytes === null ? null : sha(observedBytes), engine: 'bm25_index_metadata', selected,
    omitted: index.features.filter(row => !selectedIds.includes(row.feature_id)).map(row => ({ feature_id: row.feature_id, reason: 'not_selected' })),
    authority: 'none; no execution or evidence qualification' };
}
const help = `Usage: node scripts/method-feature-map.mjs --index PATH --query TEXT [--limit 1..5] [--observations PATH]
Select index metadata with existing BM25; read only matched and required leaves.
Ranking is lexical, not semantic. Tokens shorter than two characters are ignored.
For CJK queries, use explicit indexed keywords separated by spaces.
Limits: index/observations 64 KiB; query 4 KiB; 8 leaves, 32 KiB each, 128 KiB total.
Leaf paths stay under the index directory; leaf symlinks are rejected.
Exit 0 means complete material delivery, not product success. Inspect availability.
Exit 1 means no match; 2 invalid/unreadable input; 3 material drift, missing required leaf, selection budget or unavailable knowledge build.
Observations are caller-declared. Missing observations remain unknown. No commands run.
Evidence references, entry coverage, source/driver freshness and ownership are not independently verified.
`;
export async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return 0; }
  try {
    const input = {}, seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      valid(['--index', '--query', '--limit', '--observations'].includes(flag) && !seen.has(flag) && typeof value === 'string' && value.length > 0, 'invalid_arguments');
      seen.add(flag);
      if (flag === '--limit') { valid(/^[1-5]$/.test(value), 'invalid_arguments'); input.limit = Number(value); }
      else input[flag.slice(2)] = value;
    }
    const result = await selectFeatureMap(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result.selection_status === 'no_match' ? 1 : 0;
  } catch (error) {
    const code = error instanceof FeatureMapError ? error.code : 'internal_error';
    process.stderr.write(`${JSON.stringify({ schema_version: 1, error: code, details: error instanceof FeatureMapError ? error.details : {} })}\n`);
    return ['required_material_missing', 'content_drift', 'selection_budget', 'knowledge_unavailable'].includes(code) ? 3 : 2;
  }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
