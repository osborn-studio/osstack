#!/usr/bin/env node
// Compare a maintained map with one real, fixed five-case journey. Never rewrite the map.
import { constants } from 'node:fs';
import { open, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJourney } from './method-verification-journey.mjs';
import { scratchRoot } from './lib/scratch.mjs';
import { sha256 } from './lib/skills-check-verification.mjs';

const IDS = ['healthy', 'missing-ref', 'drift', 'mixed', 'empty'];
const STATUSES = ['healthy', 'failed', 'drift', 'empty'];
const check = (value, reason) => { if (!value) throw Error(reason); };
const keys = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const inside = (parent, child) => { const path = relative(parent, child); return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const json = value => JSON.stringify(value, null, 2) + '\n';

export function parseOptions(argv) {
  const usage = () => Error('usage: node scripts/maintain-skills-check-map.mjs --map ABSOLUTE_JSON --output ABSOLUTE_NEW_ROOT');
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2); const value = argv[i + 1];
    if (!['--map', '--output'].includes(argv[i]) || Object.hasOwn(result, key) || typeof value !== 'string' || !isAbsolute(value)) throw usage();
    result[key] = value;
  }
  if (!result.map || !result.output) throw usage();
  return result;
}

async function mapBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check((await handle.stat()).isFile(), 'map_regular');
    const buffer = Buffer.alloc(65537); let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break; size += read.bytesRead;
    }
    check(size <= 65536, 'map_size'); return Buffer.from(buffer.subarray(0, size));
  } finally { await handle.close(); }
}
function validateMap(bytes) {
  const map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  check(keys(map, ['schema_version', 'target', 'features']) && map.schema_version === 1 && map.target === 'skills-check-full', 'map_schema');
  check(Array.isArray(map.features) && map.features.length === 5, 'map_case_set');
  const seen = new Set();
  for (const row of map.features) {
    check(keys(row, ['case_id', 'expected_product_exit', 'expected_product_status']), 'map_row_schema');
    check(IDS.includes(row.case_id) && !seen.has(row.case_id), 'map_case_set'); seen.add(row.case_id);
    check(Number.isInteger(row.expected_product_exit) && row.expected_product_exit >= 0 && row.expected_product_exit <= 255, 'map_exit');
    check(STATUSES.includes(row.expected_product_status), 'map_status');
  }
  return map;
}

export async function runMaintenance({ map: mapPath, output }, seams = {}) {
  check(typeof mapPath === 'string' && isAbsolute(mapPath) && typeof output === 'string' && isAbsolute(output), 'absolute_paths_required');
  const before = await mapBytes(mapPath); const map = validateMap(before);
  output = resolve(output);
  const parent = await realpath(dirname(output)); const root = await realpath(scratchRoot());
  output = join(parent, output.split(sep).at(-1));
  check(inside(root, output), 'output_outside_scratch');
  check(!inside(output, await realpath(mapPath)), 'map_inside_output');
  // Nonrecursive acquisition refuses an existing directory or symlink without touching it.
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, 'map-before.json'), before, { flag: 'wx', mode: 0o600 });
  const result = {
    schema_version: 1, status: 'blocked', exit_code: 2, started_at: new Date().toISOString(),
    map: { before_sha256: sha256(before), bytes: before.length, after_sha256: null, unchanged: false },
    journey: null, rows: [], failure: null, model_calls: 0, formal_gate_pass: false,
    limitations: [
      'Map agreement covers only the five fixed local cases. It does not establish source-review completion or classify a discrepancy as documentation drift or a product regression.',
      'Source/build bindings and cleanup retain the existing journey claims and limits. They do not authenticate an independent producer or attest every descendant.',
      'Map hashes compare before/after snapshots, not concurrent-writer fencing. No map or product correction is automatic.',
    ],
  };
  let journey;
  try {
    // The seam is for focused tests only; the CLI exposes no alternate driver or command.
    journey = await (seams.journey ?? runJourney)({ output: join(output, 'journey'), scope: 'full' }, { invoke: seams.invoke });
    const raw = await readFile(join(output, 'journey', 'journey.json'));
    check(JSON.stringify(JSON.parse(raw)) === JSON.stringify(journey), 'journey_result_identity');
    result.journey = {
      status: journey.status, failure: journey.failure ?? null,
      receipt: 'journey/journey.json', receipt_sha256: sha256(raw),
      manifest: 'journey/journey-manifest.json', manifest_sha256: sha256(await readFile(join(output, 'journey', 'journey-manifest.json'))),
      features: journey.features, limitations: journey.limitations,
    };
    check(journey.status === 'passed', 'journey_failed');
    check(Array.isArray(journey.features) && journey.features.length === 5 && journey.features.every((f, i) => f.case_id === IDS[i]
      && f.verification === 'passed' && f.driver_exit === 0 && f.evidence_state === 'sealed'
      && f.cleanup?.status === 'passed' && f.cleanup.fixture_removed === true), 'journey_incomplete');
    result.rows = journey.features.map(f => {
      const expected = map.features.find(row => row.case_id === f.case_id);
      return { case_id: f.case_id, expected: { product_exit: expected.expected_product_exit, product_status: expected.expected_product_status },
        actual: { product_exit: f.product_exit, product_status: f.product_status },
        matches: expected.expected_product_exit === f.product_exit && expected.expected_product_status === f.product_status };
    });
    result.status = result.rows.every(row => row.matches) ? 'consistent' : 'mismatch';
    result.exit_code = result.status === 'consistent' ? 0 : 1;
  } catch (error) { result.failure = error.code ?? error.message; }
  try {
    const after = await mapBytes(mapPath); result.map.after_sha256 = sha256(after); result.map.unchanged = before.equals(after);
    if (!result.map.unchanged) {
      await writeFile(join(output, 'map-after.json'), after, { flag: 'wx', mode: 0o600 });
      result.failure = 'map_changed'; result.status = 'blocked'; result.exit_code = 2;
    }
  } catch (error) { result.failure = `map_after:${error.code ?? error.message}`; result.status = 'blocked'; result.exit_code = 2; }
  result.ended_at = new Date().toISOString();
  await writeFile(join(output, 'maintenance.json'), json(result), { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  try { const result = await runMaintenance(parseOptions(process.argv.slice(2))); console.log(json(result)); process.exitCode = result.exit_code; }
  catch (error) { console.error(JSON.stringify({ status: 'blocked', exit_code: 2, error: error.code ?? error.message })); process.exitCode = 2; }
}
