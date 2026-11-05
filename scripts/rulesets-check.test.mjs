import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RULESET_NAMES, applyBody, checkRulesets, compareRuleset, loadRulesetFiles, readLiveRulesets, resolveActors, validateRulesetFile } from './lib/rulesets.mjs';
import { createScratchDir } from './lib/scratch.mjs';
import { main, parseArgs } from './rulesets-check.mjs';

const DIR = fileURLToPath(new URL('../.github/rulesets/', import.meta.url));
const ACTORS = { 'osstack-publisher': 1001, 'osstack-merger': 1005 };
const files = await loadRulesetFiles(DIR);
const byName = name => files.find(f => f.name === name);

// A live copy as GitHub returns it: resolved actors, an id, and server defaults the file does not state.
function liveCopy(doc, id) {
  const body = applyBody(resolveActors(doc, ACTORS));
  return { id, source_type: 'Repository', source: 'o/sandbox', ...body,
    rules: body.rules.map(r => r.type === 'pull_request' ? { ...r, parameters: { ...r.parameters, allowed_merge_methods: ['merge', 'squash', 'rebase'] } } : r) };
}
const sandboxLive = () => files.filter(f => f._osstack.apply_to.includes('sandbox')).map((f, i) => liveCopy(f, 100 + i));
const fakeGet = live => async path => {
  const list = /^repos\/o\/sandbox\/rulesets\?per_page=100&page=(\d+)&includes_parents=true$/.exec(path);
  if (list) return Number(list[1]) === 1 ? live.map(({ id, name, source_type, source }) => ({ id, name, source_type, source })) : [];
  const one = /^(?:repos\/o\/sandbox|orgs\/[^/]+)\/rulesets\/(\d+)$/.exec(path);
  if (one) return live.find(l => l.id === Number(one[1]));
  throw new Error(`unexpected path ${path}`);
};

test('the four ruleset files exist and follow ADR-006 decision 5', async () => {
  assert.deepEqual(files.map(f => f.name).sort(), [...RULESET_NAMES].sort());
  // No bypass on the quality and history rulesets, so App bypasses elsewhere do not extend to them.
  assert.deepEqual(byName('main-quality').bypass_actors, []);
  assert.deepEqual(byName('mission-history').bypass_actors, []);
  // App A (publisher) is never on the merge allowlist; App E bypasses main-update only through pull requests.
  assert.deepEqual(byName('main-update').bypass_actors, [{ actor_id: '${app:osstack-merger}', actor_type: 'Integration', bypass_mode: 'pull_request' }]);
  assert.deepEqual(byName('mission-writers').bypass_actors.map(a => a.actor_id), ['${app:osstack-publisher}']);
  // Only main-quality may go to the main repository now; the others wait for the owner's allowlist and the phase 3 fix.
  for (const f of files) assert.deepEqual(f._osstack.apply_to, f.name === 'main-quality' ? ['sandbox', 'main-repo-interim'] : ['sandbox']);
});

test('main-quality requires the five CI checks from GitHub Actions and the current review rules', async () => {
  const rules = Object.fromEntries(byName('main-quality').rules.map(r => [r.type, r.parameters ?? {}]));
  assert.deepEqual(rules.required_status_checks.required_status_checks, ['check', 'graph-macos-fixtures (22)', 'graph-macos-fixtures (24)', 'graph-runtime-matrix (20.6.0)', 'graph-runtime-matrix (22.23.1)']
    .map(context => ({ context, integration_id: 15368 })));
  assert.equal(rules.pull_request.required_approving_review_count, 1);
  assert.equal(rules.pull_request.require_last_push_approval, true);
  assert.equal(rules.pull_request.required_review_thread_resolution, true);
  assert.equal(rules.pull_request.dismiss_stale_reviews_on_push, true);
  assert.ok('deletion' in rules && 'non_fast_forward' in rules);
  // The job names must still exist in CI.
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const job of ['check:', 'graph-macos-fixtures:', 'graph-runtime-matrix:']) assert.match(ci, new RegExp(`^  ${job}$`, 'm'));
  assert.match(ci, /node: \['22', '24'\]/);
  assert.match(ci, /node: \['20\.6\.0', '22\.23\.1'\]/);
});

test('file validation rejects unknown keys, wrong names, unresolvable actors and duplicate rules', () => {
  const base = structuredClone(byName('mission-history'));
  for (const [mutate, file] of [
    [d => { d.extra = 1; }, 'mission-history.json'],
    [() => {}, 'other.json'],
    [d => { d._osstack.apply_to = ['production']; }, 'mission-history.json'],
    [d => { d.bypass_actors = [{ actor_id: 42, actor_type: 'Integration', bypass_mode: 'always' }]; }, 'mission-history.json'],
    [d => { d.bypass_actors = [{ actor_id: '${app:x}', actor_type: 'User', bypass_mode: 'always' }]; }, 'mission-history.json'],
    [d => { d.rules.push({ type: 'deletion' }); }, 'mission-history.json'],
    [d => { d.enforcement = 'evaluate'; }, 'mission-history.json'],
  ]) {
    const doc = structuredClone(base); mutate(doc);
    assert.throws(() => validateRulesetFile(doc, file), /RULESET_FILE_INVALID/);
  }
});

test('actors resolve to numeric App ids, and a missing id is refused', () => {
  assert.equal(resolveActors(byName('main-update'), ACTORS).bypass_actors[0].actor_id, 1005);
  assert.throws(() => resolveActors(byName('main-update'), {}), /UNRESOLVED_ACTOR/);
  assert.throws(() => resolveActors(byName('main-update'), { 'osstack-merger': '1005' }), /UNRESOLVED_ACTOR/);
});

test('the apply body drops osstack metadata', () => {
  const body = applyBody(resolveActors(byName('mission-writers'), ACTORS));
  assert.equal('_osstack' in body, false);
  assert.equal(body.bypass_actors[0].actor_id, 1001);
});

test('a faithful live copy matches; server-added parameters are notes, not differences', () => {
  const report = checkRulesets(files, sandboxLive(), 'sandbox', ACTORS);
  assert.equal(report.ok, true, JSON.stringify(report.results));
  assert.ok(report.results.find(r => r.name === 'main-quality').notes.some(n => n.includes('allowed_merge_methods')));
});

test('a response without bypass_actors (caller cannot administer rulesets) fails instead of reading as no bypass', () => {
  const live = sandboxLive();
  delete live.find(r => r.name === 'main-quality').bypass_actors;
  const report = checkRulesets(files, live, 'sandbox', ACTORS);
  assert.equal(report.ok, false);
  assert.equal(report.results.find(r => r.name === 'main-quality').status, 'unreadable');
});

// The exact policy, fixed here so that weakening a ruleset file also has to change this test.
const PR_RULE = { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: true, required_review_thread_resolution: true } };
const CHECKS_RULE = { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: ['check', 'graph-macos-fixtures (22)', 'graph-macos-fixtures (24)', 'graph-runtime-matrix (20.6.0)', 'graph-runtime-matrix (22.23.1)'].map(context => ({ context, integration_id: 15368 })) } };
const DEFAULT_BRANCH = { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } };
const MISSION = { ref_name: { include: ['refs/heads/osstack/mission/**'], exclude: [] } };
const POLICY = {
  'main-quality': { name: 'main-quality', target: 'branch', enforcement: 'active', conditions: DEFAULT_BRANCH, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, PR_RULE, CHECKS_RULE], bypass_actors: [] },
  'main-update': { name: 'main-update', target: 'branch', enforcement: 'active', conditions: DEFAULT_BRANCH, rules: [{ type: 'update' }],
    bypass_actors: [{ actor_id: '${app:osstack-merger}', actor_type: 'Integration', bypass_mode: 'pull_request' }] },
  'mission-writers': { name: 'mission-writers', target: 'branch', enforcement: 'active', conditions: MISSION, rules: [{ type: 'creation' }, { type: 'update' }],
    bypass_actors: [{ actor_id: '${app:osstack-publisher}', actor_type: 'Integration', bypass_mode: 'always' }] },
  'mission-history': { name: 'mission-history', target: 'branch', enforcement: 'active', conditions: MISSION, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }], bypass_actors: [] },
};
test('every ruleset file is exactly the ADR-006 policy', () => {
  for (const f of files) assert.deepEqual(applyBody(f), POLICY[f.name], f.name);
});

test('each kind of drift fails the check', () => {
  const cases = {
    'removed rule': l => { l.find(r => r.name === 'mission-history').rules = [{ type: 'deletion' }]; },
    'extra rule': l => { l.find(r => r.name === 'mission-history').rules.push({ type: 'creation' }); },
    'bypass added': l => { l.find(r => r.name === 'main-quality').bypass_actors = [{ actor_id: 1005, actor_type: 'Integration', bypass_mode: 'always' }]; },
    'bypass mode widened': l => { l.find(r => r.name === 'main-update').bypass_actors[0].bypass_mode = 'always'; },
    'check producer changed': l => { l.find(r => r.name === 'main-quality').rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks[0].integration_id = 999; },
    'check dropped': l => { l.find(r => r.name === 'main-quality').rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks.pop(); },
    'approvals lowered': l => { l.find(r => r.name === 'main-quality').rules.find(r => r.type === 'pull_request').parameters.required_approving_review_count = 0; },
    'condition widened': l => { l.find(r => r.name === 'mission-writers').conditions.ref_name.include = ['~ALL']; },
    'enforcement off': l => { l.find(r => r.name === 'mission-history').enforcement = 'disabled'; },
    'update allows fetch and merge': l => { l.find(r => r.name === 'main-update').rules.find(r => r.type === 'update').parameters = { update_allows_fetch_and_merge: true }; },
    'ruleset missing': l => { l.splice(l.findIndex(r => r.name === 'mission-writers'), 1); },
    'ruleset duplicated': l => { l.push({ ...l[0], id: 999 }); },
    'unknown ruleset': l => { l.push({ id: 998, name: 'org-wide', source_type: 'Organization', target: 'branch', enforcement: 'active', rules: [{ type: 'update' }], bypass_actors: [] }); },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const live = structuredClone(sandboxLive()); mutate(live);
    assert.equal(checkRulesets(files, live, 'sandbox', ACTORS).ok, false, label);
  }
});

test('the interim main-repo target expects only main-quality, says it is incomplete, and flags anything else', () => {
  const quality = liveCopy(byName('main-quality'), 1);
  const interim = checkRulesets(files, [quality], 'main-repo-interim', {});
  assert.equal(interim.ok, true);
  assert.equal(interim.complete, false);
  assert.equal(checkRulesets(files, sandboxLive(), 'sandbox', ACTORS).complete, true);
  const report = checkRulesets(files, [quality, liveCopy(byName('mission-history'), 2)], 'main-repo-interim', {});
  assert.equal(report.ok, false);
  assert.equal(report.results.find(r => r.name === 'mission-history').status, 'unexpected');
});

test('reading live rulesets pages through the list and reads organization rulesets from the organization', async () => {
  const seen = [];
  const summaries = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, name: `r${i}`, source_type: i === 0 ? 'Organization' : 'Repository', source: i === 0 ? 'o' : 'o/sandbox' }));
  const get = async path => {
    seen.push(path);
    const list = /&page=(\d+)/.exec(path);
    if (path.includes('?')) return summaries.slice((Number(list[1]) - 1) * 100, Number(list[1]) * 100);
    return { id: Number(path.split('/').at(-1)) };
  };
  const live = await readLiveRulesets('o/sandbox', get);
  assert.equal(live.length, 130);
  assert.equal(seen.filter(p => p.includes('?')).length, 2);
  assert.ok(seen.includes('orgs/o/rulesets/1'));
  assert.ok(seen.includes('repos/o/sandbox/rulesets/2'));
});

test('argument parsing', () => {
  assert.deepEqual(parseArgs(['--repo', 'o/sandbox', '--target', 'sandbox']), { json: false, repo: 'o/sandbox', target: 'sandbox' });
  assert.equal(parseArgs(['--print-body', 'main-update']).printBody, 'main-update');
  for (const bad of [[], ['--repo', 'o/s'], ['--repo', 'nope', '--target', 'sandbox'], ['--repo', 'o/s', '--target', 'prod'], ['--repo', 'o/s', '--repo', 'o/t', '--target', 'sandbox'],
    ['--print-body', 'x'], ['--print-body', 'main-update', '--repo', 'o/s'], ['--repo'], ['--force']]) {
    assert.throws(() => parseArgs(bad), /USAGE/, JSON.stringify(bad));
  }
});

test('main reports match and mismatch with exit codes, and resolves actors before reading GitHub', async () => {
  const out = { text: '', write(s) { this.text += s; } };
  const dir = await createScratchDir('tests', 'rulesets-check');
  const actorsFile = join(dir, 'apps.json');
  await writeFile(actorsFile, JSON.stringify(ACTORS));
  try {
    assert.equal(await main(['--repo', 'o/sandbox', '--target', 'sandbox', '--actors', actorsFile], { get: fakeGet(sandboxLive()), out }), 0);
    assert.match(out.text, /^OK: o\/sandbox/m);
    const drifted = sandboxLive(); drifted.pop();
    assert.equal(await main(['--repo', 'o/sandbox', '--target', 'sandbox', '--actors', actorsFile], { get: fakeGet(drifted), out }), 1);
    let called = false;
    await assert.rejects(main(['--repo', 'o/sandbox', '--target', 'sandbox'], { get: async () => { called = true; return []; }, out }), /UNRESOLVED_ACTOR/);
    assert.equal(called, false);
    out.text = '';
    assert.equal(await main(['--print-body', 'main-update', '--actors', actorsFile], { out }), 0);
    assert.equal(JSON.parse(out.text).bypass_actors[0].actor_id, 1005);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the gh call is always a GET', async () => {
  const source = await readFile(new URL('./rulesets-check.mjs', import.meta.url), 'utf8');
  const calls = source.match(/execFile\)\('gh', \[[^\]]*\]/g);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /'--method', 'GET'/);
  assert.doesNotMatch(source, /--method', '(POST|PUT|PATCH|DELETE)'/);
});
