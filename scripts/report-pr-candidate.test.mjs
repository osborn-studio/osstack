import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, mkdir, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createScratchDir } from './lib/scratch.mjs';
import { runPrCandidateReport } from './report-pr-candidate.mjs';
const H = 'a'.repeat(40), B = 'b'.repeat(40);
const facts = { number: 7, url: 'https://github.com/owner/repo/pull/7', state: 'OPEN', isDraft: false, headRefOid: H, baseRefOid: B, headRefName: 'feature', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' };
function runner(mode = 'pass') {
  const calls = [];
  return { calls, async run(command, args) {
    calls.push({ command, args });
    if (mode === 'unavailable') return { stdout: '', stderr: 'fixture authentication unavailable', exitCode: 1 };
    let repository = { nameWithOwner: 'owner/repo', pullRequest: facts };
    const query = args.find(a => a.startsWith('query='));
    if (query.includes('CandidateChecks')) repository = { nameWithOwner: 'owner/repo', object: { oid: H, statusCheckRollup: { contexts: { nodes: [{ __typename: 'CheckRun', id: 'c1', name: 'test', status: 'COMPLETED', conclusion: mode === 'blocked' ? 'FAILURE' : 'SUCCESS', detailsUrl: null }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    if (query.includes('CandidateThreads')) repository = { nameWithOwner: 'owner/repo', pullRequest: { number: 7, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    return { stdout: JSON.stringify({ data: { repository } }), stderr: '', exitCode: 0 };
  } };
}
const args = output => ['--repo', 'owner/repo', '--pr', '7', '--output', output, '--required-check', 'test'];
async function fixture(fn) {
  const root = await createScratchDir('tests', 'pr-snapshot-script');
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('writes exact raw receipts, manifest hashes and restrictive modes without mutation commands', () => fixture(async root => {
  const output = join(root, 'report'), seam = runner();
  const result = await runPrCandidateReport(args(output), { runner: seam });
  assert.equal(result.exitCode, 0);
  const snapshot = JSON.parse(await readFile(join(output, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.summary, 'no_observed_blocker'); assert.equal(snapshot.merge_authorized, false);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.execution_path, 'injected_runner'); assert.equal(manifest.files.length, 10);
  for (const member of manifest.files) {
    const bytes = await readFile(join(output, member.path));
    assert.equal(bytes.length, member.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), member.sha256);
    assert.equal((await lstat(join(output, member.path))).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  assert.equal(seam.calls.length, 4);
  assert.ok(seam.calls.every(c => c.command === 'gh' && c.args.slice(0, 2).join(' ') === 'api graphql'));
}));
test('an observed failure still exits zero for a written report, never authorizes merge', () => fixture(async root => {
  const result = await runPrCandidateReport(args(join(root, 'report')), { runner: runner('blocked') });
  assert.equal(result.exitCode, 0); assert.equal(result.summary, 'blocked');
}));
test('initial forge failure keeps raw failure and returns unavailable exit three', () => fixture(async root => {
  const output = join(root, 'report'), seam = runner('unavailable');
  const result = await runPrCandidateReport(args(output), { runner: seam });
  assert.equal(result.exitCode, 3); assert.equal(result.summary, 'unknown'); assert.equal(seam.calls.length, 1);
  assert.match(await readFile(join(output, 'raw/initial.stderr'), 'utf8'), /unavailable/);
}));
for (const [name, alter] of [
  ['unknown flag', a => [...a, '--watch']], ['duplicate flag', a => [...a, '--pr', '8']],
  ['invalid number', a => a.map(x => x === '7' ? '7x' : x)], ['one expected pin', a => [...a, '--expect-head', H]],
  ['duplicate required name', a => [...a, '--required-check', 'test']],
]) test(`preflight rejects ${name} before any forge request or output`, () => fixture(async root => {
  const output = join(root, 'report'), seam = runner();
  assert.equal((await runPrCandidateReport(alter(args(output)), { runner: seam })).exitCode, 2);
  assert.equal(seam.calls.length, 0); assert.deepEqual(await readdir(root), []);
}));
test('existing output and terminal symlink refuse before calls and preserve contents', () => fixture(async root => {
  const output = join(root, 'report'); await mkdir(output);
  const seam = runner();
  assert.equal((await runPrCandidateReport(args(output), { runner: seam })).exitCode, 2);
  const link = join(root, 'link'); await symlink(output, link);
  assert.equal((await runPrCandidateReport(args(link), { runner: seam })).exitCode, 2);
  assert.equal(seam.calls.length, 0); assert.deepEqual(await readdir(output), []);
}));
test('output outside scratch and relative output refuse before calls', async () => {
  const seam = runner();
  for (const output of ['relative-output', '/not-the-scratch-root/pr-report']) assert.equal((await runPrCandidateReport(args(output), { runner: seam })).exitCode, 2);
  assert.equal(seam.calls.length, 0);
});
test('real process help is build-independent and never reads forge', () => {
  const result = spawnSync(process.execPath, ['scripts/report-pr-candidate.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /not a merge authorization/);
});
