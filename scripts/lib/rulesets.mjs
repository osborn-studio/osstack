// Ruleset files under .github/rulesets and their read-only comparison with a live repository
// (bridge plan task 2.2, ADR-006 decision 5). Nothing here creates, updates or deletes a ruleset:
// the repository admin applies them, and this module only reads GitHub through GET requests.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const RULESET_NAMES = ['main-quality', 'main-update', 'mission-writers', 'mission-history'];
// `main-repo-interim` is the main repository before the owner decides the main-update allowlist (ADR-006 decision 5):
// a match there proves only main-quality, not who may merge. A full `main-repo` target is added with that decision.
export const APPLY_TARGETS = ['sandbox', 'main-repo-interim'];
const ACTOR_REF = /^\$\{app:([a-z0-9-]+)\}$/;
const TOP_KEYS = ['_osstack', 'name', 'target', 'enforcement', 'conditions', 'rules', 'bypass_actors'];

export class RulesetError extends Error {
  constructor(code, detail, exitCode = 2) { super(`${code}: ${detail}`); this.code = code; this.exitCode = exitCode; }
}

/** Reads every *.json in dir. Each file must be one known ruleset whose file name equals its name. */
export async function loadRulesetFiles(dir) {
  const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
  const out = [];
  for (const file of files) {
    const doc = JSON.parse(await readFile(join(dir, file), 'utf8'));
    validateRulesetFile(doc, file);
    out.push(doc);
  }
  const names = out.map(d => d.name);
  for (const name of RULESET_NAMES) if (!names.includes(name)) throw new RulesetError('RULESET_FILE_MISSING', name);
  return out;
}

export function validateRulesetFile(doc, file) {
  const fail = detail => { throw new RulesetError('RULESET_FILE_INVALID', `${file}: ${detail}`); };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('not an object');
  for (const key of Object.keys(doc)) if (!TOP_KEYS.includes(key)) fail(`unknown key ${key}`);
  if (!RULESET_NAMES.includes(doc.name)) fail(`unknown ruleset name ${doc.name}`);
  if (file !== `${doc.name}.json`) fail('file name must equal the ruleset name');
  const applyTo = doc._osstack?.apply_to;
  if (!Array.isArray(applyTo) || applyTo.length === 0 || applyTo.some(t => !APPLY_TARGETS.includes(t))) fail(`_osstack.apply_to must list only ${APPLY_TARGETS.join(', ')}`);
  if (doc.target !== 'branch' || doc.enforcement !== 'active') fail('target must be branch and enforcement active');
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) fail('rules must be a non-empty array');
  const types = doc.rules.map(r => r.type);
  if (new Set(types).size !== types.length) fail('duplicate rule type');
  if (!Array.isArray(doc.bypass_actors)) fail('bypass_actors must be an array');
  for (const actor of doc.bypass_actors) {
    if (actor.actor_type !== 'Integration' || !['always', 'pull_request'].includes(actor.bypass_mode)) fail('bypass actors must be Integrations with mode always or pull_request');
    if (typeof actor.actor_id !== 'string' || !ACTOR_REF.test(actor.actor_id)) fail('bypass actor_id must be an ${app:<name>} reference');
  }
}

/** Replaces ${app:<name>} references with numeric App ids from the actors map ({ "<name>": <app id> }). */
export function resolveActors(doc, actors) {
  return {
    ...doc,
    bypass_actors: doc.bypass_actors.map(actor => {
      const name = ACTOR_REF.exec(actor.actor_id)[1];
      const id = actors?.[name];
      if (!Number.isSafeInteger(id) || id <= 0) throw new RulesetError('UNRESOLVED_ACTOR', `${doc.name}: no App id for ${name}`);
      return { ...actor, actor_id: id };
    }),
  };
}

/** The request body for POST/PUT /repos/{repo}/rulesets: the file without osstack metadata. */
export function applyBody(doc) {
  const { _osstack: _metadata, ...body } = doc;
  return body;
}

const sortedStrings = list => [...(list ?? [])].sort();
function normalizeConditions(conditions) {
  const ref = conditions?.ref_name ?? {};
  const extra = Object.keys(conditions ?? {}).filter(k => k !== 'ref_name').sort();
  return { include: sortedStrings(ref.include), exclude: sortedStrings(ref.exclude), other: extra };
}
function normalizeActors(actors) {
  return (actors ?? []).map(a => ({ actor_id: a.actor_id, actor_type: a.actor_type, bypass_mode: a.bypass_mode }))
    .sort((a, b) => `${a.actor_type}:${a.actor_id}`.localeCompare(`${b.actor_type}:${b.actor_id}`));
}
function normalizeParameters(type, parameters) {
  if (type !== 'required_status_checks' || !parameters) return parameters ?? {};
  const checks = (parameters.required_status_checks ?? []).map(c => ({ context: c.context, integration_id: c.integration_id ?? null }))
    .sort((a, b) => a.context.localeCompare(b.context));
  return { ...parameters, required_status_checks: checks };
}

/**
 * Differences between one expected (actor-resolved) ruleset and its live copy.
 * target, enforcement, conditions, the set of rule types and bypass actors must match exactly.
 * Rule parameters must match for every key the file states; keys GitHub adds with defaults are reported as notes,
 * except on required_status_checks, whose check list must match exactly.
 */
export function compareRuleset(expected, live) {
  const diffs = []; const notes = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const key of ['target', 'enforcement']) if (expected[key] !== live[key]) diffs.push(`${key}: expected ${expected[key]}, live ${live[key]}`);
  const ec = normalizeConditions(expected.conditions); const lc = normalizeConditions(live.conditions);
  if (!eq(ec, lc)) diffs.push(`conditions: expected ${JSON.stringify(ec)}, live ${JSON.stringify(lc)}`);
  const liveRules = new Map((live.rules ?? []).map(r => [r.type, r]));
  const expectedTypes = expected.rules.map(r => r.type).sort();
  const liveTypes = [...liveRules.keys()].sort();
  if (!eq(expectedTypes, liveTypes)) diffs.push(`rule types: expected ${expectedTypes.join(',')}, live ${liveTypes.join(',')}`);
  for (const rule of expected.rules) {
    const other = liveRules.get(rule.type);
    if (!other) continue;
    const ep = normalizeParameters(rule.type, rule.parameters); const lp = normalizeParameters(rule.type, other.parameters);
    for (const key of Object.keys(ep)) if (!eq(ep[key], lp[key])) diffs.push(`${rule.type}.${key}: expected ${JSON.stringify(ep[key])}, live ${JSON.stringify(lp[key])}`);
    for (const key of Object.keys(lp)) if (!(key in ep)) notes.push(`${rule.type}.${key} is set live (${JSON.stringify(lp[key])}) but not stated in the file`);
  }
  const ea = normalizeActors(expected.bypass_actors); const la = normalizeActors(live.bypass_actors);
  if (!eq(ea, la)) diffs.push(`bypass_actors: expected ${JSON.stringify(ea)}, live ${JSON.stringify(la)}`);
  return { diffs, notes };
}

/** Lists the repository's rulesets page by page, then reads each one in full. `get(path)` must perform a GET. */
export async function readLiveRulesets(repo, get) {
  const summaries = [];
  for (let page = 1; ; page += 1) {
    const batch = await get(`repos/${repo}/rulesets?per_page=100&page=${page}&includes_parents=true`);
    if (!Array.isArray(batch)) throw new RulesetError('GITHUB_RESPONSE_INVALID', 'ruleset list is not an array', 1);
    summaries.push(...batch);
    if (batch.length < 100) break;
    if (page >= 50) throw new RulesetError('GITHUB_RESPONSE_INVALID', 'more than 50 pages of rulesets', 1);
  }
  const full = [];
  for (const s of summaries) {
    // Rulesets inherited from the organization are read from the organization endpoint.
    const path = s.source_type === 'Organization' ? `orgs/${s.source}/rulesets/${s.id}` : `repos/${repo}/rulesets/${s.id}`;
    full.push(await get(path));
  }
  return full;
}

/**
 * Compares the files meant for `target` with the live rulesets.
 * Missing, duplicated or differing rulesets fail; a live ruleset with no file is reported as `unexpected` and also fails,
 * because any applicable rule changes what the publisher and mergers may do.
 */
export function checkRulesets(files, live, target, actors) {
  const wanted = files.filter(f => f._osstack.apply_to.includes(target)).map(f => resolveActors(f, actors));
  const results = []; let ok = true;
  for (const expected of wanted) {
    const matches = live.filter(l => l.name === expected.name);
    if (matches.length !== 1) { ok = false; results.push({ name: expected.name, status: matches.length ? 'duplicate' : 'missing', diffs: [], notes: [] }); continue; }
    // GitHub omits bypass_actors when the caller cannot write rulesets; treating that as [] would hide a bypass.
    if (!Array.isArray(matches[0].bypass_actors)) {
      ok = false;
      results.push({ name: expected.name, status: 'unreadable', id: matches[0].id, diffs: ['bypass_actors missing from the response: read with an account that can administer rulesets'], notes: [] });
      continue;
    }
    const { diffs, notes } = compareRuleset(expected, matches[0]);
    if (diffs.length) ok = false;
    results.push({ name: expected.name, status: diffs.length ? 'differs' : 'match', id: matches[0].id, diffs, notes });
  }
  const known = new Set(wanted.map(w => w.name));
  for (const l of live) if (!known.has(l.name)) { ok = false; results.push({ name: l.name, status: 'unexpected', id: l.id, source: l.source_type ?? 'Repository', diffs: [], notes: [] }); }
  return { ok, target, complete: target !== 'main-repo-interim', results };
}
