import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createScratchDir } from './lib/scratch.mjs';
import { runPrStackCandidateReport } from './report-pr-stack-candidate.mjs';
const plan = { schema_version: 1, repo: 'owner/repo', target_base: 'main', prs: [{ pr: 20, requiredChecks: ['test'] }, { pr: 7, requiredChecks: ['test'] }] };
const oid = pr => pr.toString(16).padStart(40, '0');
function runner(unavailable = false, branch = null) {
  const calls = [];
  return { calls, async run(command, args, options) {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    if (unavailable) return { stdout: '', stderr: 'offline transport failure', exitCode: 1 };
    const get = prefix => args.find(a => a.startsWith(prefix))?.slice(prefix.length);
    const query = get('query='), pr = Number(get('number=') ?? Number.parseInt(get('oid='), 16));
    const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    let repository = { nameWithOwner: 'owner/repo', pullRequest: { number: pr, url: `https://github.com/owner/repo/pull/${pr}`, state: pr === 20 ? 'MERGED' : 'OPEN', isDraft: false, headRefOid: oid(pr), baseRefOid: 'b'.repeat(40), headRefName: `feature-${pr}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' } };
    if (branch !== null) {
      repository.pullRequest.state = 'OPEN';
      if (pr === 20) repository.pullRequest.headRefName = branch;
      if (pr === 7) repository.pullRequest.baseRefName = branch;
    }
    if (query.includes('CandidateChecks')) repository = { nameWithOwner: 'owner/repo', object: { oid: oid(pr), statusCheckRollup: { contexts: page([{ __typename: 'CheckRun', id: `check-${pr}`, name: 'test', status: 'COMPLETED', conclusion: 'NEUTRAL', detailsUrl: null }]) } } };
    if (query.includes('CandidateThreads')) repository = { nameWithOwner: 'owner/repo', pullRequest: { number: pr, reviewThreads: page([]) } };
    return { stdout: JSON.stringify({ data: { repository } }), stderr: '', exitCode: 0 };
  } };
}
async function fixture(fn) {
  const owned = await createScratchDir('tests', 'pr-stack-script');
  const file = join(owned, 'plan.json'); await writeFile(file, `${JSON.stringify(plan)}\n`);
  try { await fn(owned, file); } finally { await rm(owned, { recursive: true, force: true }); }
}
const args = (file, output) => ['--plan', file, '--output', output];
const digest = b => createHash('sha256').update(b).digest('hex');
test('retains plan bytes, both full observations and readable non-authorizing report', () => fixture(async (root, file) => {
  const seam = runner(), output = join(root, 'report'), before = await readFile(file);
  const result = await runPrStackCandidateReport(args(file, output), { runner: seam });
  assert.equal(result.exitCode, 0); assert.equal(result.frontier_pr, 7); assert.equal(result.merge_authorized, false);
  assert.deepEqual(await readFile(file), before); assert.deepEqual(await readFile(join(output, 'plan.json')), before);
  const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
  assert.equal(report.rows[1].candidate_summary, 'unknown'); assert.ok(report.rows[1].unknowns.includes('checks_not_success'));
  const md = await readFile(join(output, 'report.md'), 'utf8');
  assert.match(md.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))), /checks_not_success/); assert.match(md, /not Ready/); assert.match(md, /prs\/7\/snapshot.json/);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.execution_path, 'injected_runner'); assert.equal(manifest.files.length, 24);
  assert.equal(result.manifest_sha256, digest(await readFile(join(output, 'manifest.json'))));
  for (const f of manifest.files) {
    const b = await readFile(join(output, f.path)); assert.equal(b.length, f.bytes); assert.equal(digest(b), f.sha256);
    assert.equal((await lstat(join(output, f.path))).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  assert.equal(seam.calls.length, 8); assert.ok(seam.calls.every(c => c.args.slice(0, 2).join(' ') === 'api graphql'));
}));
test('unavailable lower observations write a partial report with raw failures and exit three', () => fixture(async (root, file) => {
  const output = join(root, 'partial'), seam = runner(true);
  const result = await runPrStackCandidateReport(args(file, output), { runner: seam });
  assert.equal(result.exitCode, 3); assert.equal(result.status, 'frontier_unknown');
  assert.equal(result.frontier_pr, 20); assert.equal(seam.calls.length, 2);
  assert.match(await readFile(join(output, 'prs/20/raw/initial.stderr'), 'utf8'), /offline transport/);
}));
for (const [name, bytes] of [
  ['invalid JSON', '{'], ['unknown field', JSON.stringify({ ...plan, watch: true })],
  ['duplicate PR', JSON.stringify({ ...plan, prs: [{ pr: 7 }, { pr: 7 }] })],
  ['oversized', ' '.repeat(65537)], ['invalid UTF8', Buffer.from([255])],
]) test(`preflight ${name} creates no output and makes no query`, () => fixture(async (root, file) => {
  await writeFile(file, bytes); const seam = runner();
  assert.equal((await runPrStackCandidateReport(args(file, join(root, 'out')), { runner: seam })).exitCode, 2);
  assert.equal(seam.calls.length, 0); assert.deepEqual(await readdir(root), ['plan.json']);
}));
test('refuses terminal symlink and directory plans before calls', () => fixture(async (root, file) => {
  const link = join(root, 'plan-link'); await symlink(file, link);
  const seam = runner();
  for (const input of [link, root]) assert.equal((await runPrStackCandidateReport(args(input, join(root, 'out')), { runner: seam })).exitCode, 2);
  assert.equal(seam.calls.length, 0); assert.deepEqual((await readdir(root)).sort(), ['plan-link', 'plan.json']);
}));
for (const variant of ['existing', 'terminal-link', 'outside-parent', 'escaping-parent', 'root-itself']) {
  test(`refuses ${variant} without output changes or forge calls`, () => fixture(async (owned, file) => {
    const narrow = join(owned, 'narrow'), outside = join(owned, 'outside'); await mkdir(narrow); await mkdir(outside);
    const existing = join(narrow, 'exists'); await mkdir(existing); await writeFile(join(existing, 'sentinel'), 'unchanged');
    await symlink(outside, join(narrow, 'escape')); await symlink(existing, join(narrow, 'link'));
    const output = ({ existing, 'terminal-link': join(narrow, 'link'), 'outside-parent': join(outside, 'new'), 'escaping-parent': join(narrow, 'escape/new'), 'root-itself': narrow })[variant];
    const saved = process.env.OSSTACK_SCRATCH_ROOT; process.env.OSSTACK_SCRATCH_ROOT = narrow;
    try {
      const seam = runner(); assert.equal((await runPrStackCandidateReport(args(file, output), { runner: seam })).exitCode, 2); assert.equal(seam.calls.length, 0);
      assert.equal(await readFile(join(existing, 'sentinel'), 'utf8'), 'unchanged'); assert.deepEqual(await readdir(outside), []);
    } finally { if (saved === undefined) delete process.env.OSSTACK_SCRATCH_ROOT; else process.env.OSSTACK_SCRATCH_ROOT = saved; }
  }));
}
test('unknown/duplicate flags and relative output refuse before calls', () => fixture(async (root, file) => {
  const seam = runner();
  for (const argv of [[...args(file, join(root, 'out')), '--watch', 'yes'], [...args(file, join(root, 'out')), '--plan', file], args(file, 'relative')]) assert.equal((await runPrStackCandidateReport(argv, { runner: seam })).exitCode, 2);
  assert.equal(seam.calls.length, 0); assert.deepEqual(await readdir(root), ['plan.json']);
}));
test('Markdown escapes branch-name text rather than creating links or new headings', () => fixture(async (root, file) => {
  await writeFile(file, JSON.stringify({ ...plan, target_base: '<script>[x](https://example.test)|`' }));
  const output = join(root, 'out'); await runPrStackCandidateReport(args(file, output), { runner: runner() });
  const md = await readFile(join(output, 'report.md'), 'utf8'); assert.ok(!md.includes('<script>')); assert.ok(!md.includes('[x](https://example.test)'));
}));
test('CLI help executes without a build or a forge request', () => {
  const p = spawnSync(process.execPath, ['scripts/report-pr-stack-candidate.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(p.status, 0); assert.match(p.stdout, /--plan/); assert.match(p.stdout, /not a merge authorization/);
});

for (const branch of ['www.example.test/login', 'a@b.example', 'https://example.test/path', 'release_~[text](https://example.test)']) {
  test(`forge branch cannot create a bare link or formatting token: ${branch}`, () => fixture(async (root, file) => {
    const output = join(root, 'out');
    assert.equal((await runPrStackCandidateReport(args(file, output), { runner: runner(false, branch) })).exitCode, 0);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    assert.equal(report.rows[1].relation.expected_base, branch);
    assert.equal(report.rows[1].relation.observed_base, branch);
    assert.equal(report.rows[1].relation.status, 'parent_matches');
    const md = await readFile(join(output, 'report.md'), 'utf8');
    assert.ok(!md.includes(branch)); assert.ok(!md.includes('www.')); assert.ok(!md.includes('@'));
    const line = md.split('\n').find(l => l.includes('Relation: parent_matches'));
    assert.equal(line.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))), `Relation: parent_matches; expected base: ${branch}; observed base: ${branch}.`);
  }));
}
for (const code of [0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x85, 0x9b, 0x200b, 0xfeff]) {
  test(`forge display control U+${code.toString(16)} becomes a visible escape, never a decoded control`, () => fixture(async (root, file) => {
    const control = String.fromCodePoint(code), branch = `safe${control}suffix`, output = join(root, 'out');
    assert.equal((await runPrStackCandidateReport(args(file, output), { runner: runner(false, branch) })).exitCode, 0);
    const raw = JSON.parse(await readFile(join(output, 'prs/20/snapshot.json'), 'utf8'));
    assert.equal(raw.final.headRefName, branch);
    const md = await readFile(join(output, 'report.md'), 'utf8');
    const decoded = md.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    assert.ok(!md.includes(control)); assert.ok(!decoded.includes(control));
    assert.ok(decoded.includes(`safe\\u{${code.toString(16).toUpperCase()}}suffix`));
  }));
}
