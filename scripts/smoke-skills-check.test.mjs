import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CASE_IDS, assertOwnedFixture, caseDefinition, evaluateCase, failureReason, fixtureEnvironment, parseOptions, preflight,
  reserveEvidence, runCommand, sourceBindings,
} from './lib/skills-check-verification.mjs';
import { runVerification } from './smoke-skills-check.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
async function temporary(label) {
  const { createScratchDir } = await import('../packages/core/dist/index.js');
  return createScratchDir('tests', `skills-check-${label}`);
}

test('public option defaults and every single case are explicit', () => {
  assert.deepEqual(parseOptions([]), { mode: 'run', caseName: 'all', evidenceDir: undefined });
  for (const caseName of CASE_IDS) assert.equal(parseOptions(['--case', caseName]).caseName, caseName);
  assert.equal(parseOptions(['--doctor']).mode, 'doctor');
  assert.equal(parseOptions(['--dry-run']).mode, 'dry-run');
});
for (const args of [['--helpful'], ['--case'], ['--case', 'unknown'], ['--doctor', '--dry-run'], ['--case', 'all', '--case', 'empty'], ['--evidence-dir'], ['--evidence-dir', 'a', '--evidence-dir', 'b']]) {
  test(`usage rejects ${JSON.stringify(args)}`, () => assert.throws(() => parseOptions(args), error => error.exitCode === 2));
}

test('fixture environment excludes default homes, Git injection, credentials and Node injection', () => {
  const env = fixtureEnvironment('/owned', '/scratch', '/bin', '/owned/case-home');
  assert.equal(env.OSSTACK_HOME, '/owned/case-home');
  assert.equal(env.HOME, '/owned/user-home');
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'file');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/owned/empty-gitconfig');
  for (const key of ['OSSTACK_SOCKET', 'NODE_OPTIONS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_SSH_COMMAND', 'ANTHROPIC_API_KEY']) assert.equal(env[key], undefined);
});

test('doctor and dry-run inspect files only, without importing product code or running Git', async () => {
  const root = await temporary('preflight');
  try {
    const bin = join(root, 'bin'); await mkdir(bin);
    const sentinel = join(root, 'executed');
    await writeFile(join(bin, 'git'), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
    for (const rel of ['packages/cli/dist/bin.js', 'packages/core/dist/index.js', 'packages/skill-registry/dist/index.js']) {
      const path = join(root, rel); await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, `throw Error('product must not be imported by preflight')`);
    }
    const before = await readdir(root, { recursive: true });
    for (const mode of ['doctor', 'dry-run']) {
      const result = await preflight({ repository: root, evidenceDir: join(root, 'new-evidence'), mode, path: bin });
      assert.equal(result.ready, true); assert.equal(result.executed, false);
    }
    assert.deepEqual(await readdir(root, { recursive: true }), before);
    assert.equal(existsSync(sentinel), false);
    assert.equal((await preflight({ repository: root, path: join(root, 'no-git') })).ready, false);
    assert.equal((await preflight({ repository: root, evidenceDir: bin, path: bin })).ready, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evidence directory reservation is exclusive, including a simultaneous collision', async () => {
  const root = await temporary('evidence');
  try {
    const target = join(root, 'once');
    const results = await Promise.allSettled([reserveEvidence(target), reserveEvidence(target)]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.find(x => x.status === 'rejected').reason.code, 'EEXIST');
    await writeFile(join(target, 'sentinel'), 'keep');
    await assert.rejects(reserveEvidence(target), { code: 'EEXIST' });
    assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('command runner preserves nonzero exit as an observation and records exact inputs', async () => {
  const argv = ['-e', "process.stdout.write('not reachable');process.stderr.write('detail');process.exit(1)"];
  const result = await runCommand(process.execPath, argv, { cwd: repository, env: {} });
  assert.equal(result.exit_code, 1); assert.equal(result.stdout, 'not reachable'); assert.equal(result.stderr, 'detail');
  assert.deepEqual(result.argv, argv); assert.equal(result.cwd, repository); assert.equal(result.direct_child_exit_confirmed, true);
});

test('hung and output-flooding owned commands are bounded and cannot be successful observations', async () => {
  const started = performance.now();
  const hung = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: repository, env: {}, timeoutMs: 80 });
  assert.equal(hung.timed_out, true); assert.equal(hung.direct_child_exit_confirmed, true);
  const flood = await runCommand(process.execPath, ['-e', "setInterval(()=>process.stdout.write('x'.repeat(8192)),0)"], { cwd: repository, env: {}, maxBytes: 1024 });
  assert.equal(flood.output_limited, true); assert.ok(Buffer.byteLength(flood.stdout) <= 1024);
  assert.ok(performance.now() - started < 5000);
});

test('missing executable is bounded and does not invent a process exit', async () => {
  const result = await runCommand('/nonexistent/skills-check-fixture', [], { cwd: repository, env: {} });
  assert.equal(result.spawn_error, 'ENOENT'); assert.equal(result.process_started, false);
  assert.equal(result.direct_child_exit_confirmed, false);
});

test('missing-ref accepts expected source failure but rejects the old zero-exit bug or mutated input', () => {
  const source = { id: 'missing-ref', ref: 'refs/heads/not-present' };
  const expected = { case_id: 'missing-ref', expected_exit: 1, failed: 1, drifted: 0, sources: [source] };
  const observed = { exit_code: 1, stdout: 'Checking 1 source(s) against their tracked refs...\n  ✗ missing-ref  unreachable: no_matching_ref\n\n1 source(s) failed to check.\n0 source(s) drifted from blessed_sha.\n', stderr: '', direct_child_exit_confirmed: true, timed_out: false, output_limited: false };
  assert.equal(evaluateCase(expected, observed, true).verification_status, 'passed');
  assert.equal(evaluateCase(expected, { ...observed, exit_code: 0 }, true).verification_status, 'failed');
  assert.equal(evaluateCase(expected, observed, false).verification_status, 'failed');
  assert.equal(evaluateCase(expected, { ...observed, stdout: observed.stdout.replace('no_matching_ref', 'timeout') }, true).verification_status, 'failed');
});

test('binding includes the new driver and helper, with large manifests kept separately', async () => {
  const bindings = await sourceBindings(repository);
  for (const path of ['scripts/smoke-skills-check.mjs', 'scripts/lib/skills-check-verification.mjs']) assert.ok(bindings.source.files.some(f => f.path === path));
  assert.ok(bindings.build.files.some(f => f.path === 'packages/cli/dist/bin.js'));
});

test('drift verifies the actual head/ref rather than accepting any warning with exit 2', () => {
  const expected = caseDefinition('drift', 'file:///owned', 'a'.repeat(40), 'b'.repeat(40));
  const output = 'Checking 1 source(s) against their tracked refs...\n  ⚠ drift  drift  blessed=aaaaaaaaaaaa  head=bbbbbbbbbbbb  ref=refs/heads/main\n\n0 source(s) failed to check.\n1 source(s) drifted from blessed_sha.\n';
  const observed = { exit_code: 2, stdout: output, stderr: '', direct_child_exit_confirmed: true };
  assert.equal(evaluateCase(expected, observed, true).verification_status, 'passed');
  assert.equal(evaluateCase(expected, { ...observed, stdout: output.replace('bbbbbbbbbbbb', 'cccccccccccc') }, true).source_check_status, 'unknown');
});

test('symlink CLI entry executes verification and retains a nonempty receipt and hashed evidence', { timeout: 30000 }, async () => {
  const root = await temporary('symlink-entry');
  try {
    const entry = join(root, 'entry.mjs'); const evidenceDir = join(root, 'evidence');
    await symlink(join(repository, 'scripts/smoke-skills-check.mjs'), entry);
    const invocation = await runCommand(process.execPath, [entry, '--case', 'empty', '--evidence-dir', evidenceDir], {
      cwd: repository, env: { PATH: process.env.PATH, OSSTACK_HOME: join(root, 'outer-home'), OSSTACK_SCRATCH_ROOT: process.env.OSSTACK_SCRATCH_ROOT },
    });
    assert.equal(invocation.exit_code, 0); assert.notEqual(invocation.stdout.trim(), '');
    const receipt = JSON.parse(invocation.stdout);
    assert.equal(receipt.status, 'passed'); assert.deepEqual(receipt.selected_cases, ['empty']);
    assert.equal(receipt.cleanup.fixture_removed, true); assert.equal(existsSync(receipt.cleanup.fixture_path), false);
    assert.deepEqual(JSON.parse(await readFile(join(evidenceDir, 'receipt.json'), 'utf8')), receipt);
    const manifest = JSON.parse(await readFile(join(evidenceDir, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) assert.equal(createHash('sha256').update(await readFile(join(evidenceDir, file.path))).digest('hex'), file.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cleanup ownership rejects scratch roots, evidence ancestors, outside directories and final symlinks', async () => {
  const root = await temporary('ownership');
  try {
    const smoke = join(root, 'smoke'); const owned = join(smoke, 'skills-check-owned'); const evidence = join(root, 'evidence');
    await mkdir(owned, { recursive: true }); await mkdir(evidence);
    const outside = join(root, 'skills-check-outside'); await mkdir(outside);
    const nested = join(owned, 'evidence'); await mkdir(nested);
    const linked = join(smoke, 'skills-check-link'); await symlink(owned, linked);
    await writeFile(join(evidence, 'sentinel'), 'preserve');
    assert.equal(typeof await assertOwnedFixture(owned, root, evidence), 'string');
    for (const candidate of [root, smoke, evidence, outside, linked]) await assert.rejects(assertOwnedFixture(candidate, root, evidence), /fixture_ownership_unconfirmed/);
    await assert.rejects(assertOwnedFixture(owned, root, nested), /fixture_ownership_unconfirmed/);
    await assert.rejects(assertOwnedFixture(owned, root, owned), /fixture_ownership_unconfirmed/);
    assert.equal(await readFile(join(evidence, 'sentinel'), 'utf8'), 'preserve');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('allocation remains recorded and safely cleaned when subsequent canonicalization fails', { timeout: 30000 }, async () => {
  const root = await temporary('allocation'); let allocated;
  try {
    const result = await runVerification({ caseName: 'empty', evidenceDir: join(root, 'evidence') }, {
      canonicalizeFixture: async path => { allocated = path; throw Object.assign(Error('canonicalization failed'), { code: 'REALPATH_TEST_FAILURE' }); },
    });
    assert.equal(result.status, 'failed'); assert.equal(result.failure, 'REALPATH_TEST_FAILURE');
    assert.equal(result.cleanup.fixture_path, allocated); assert.equal(result.cleanup.status, 'passed');
    assert.equal(result.cleanup.fixture_removed, true); assert.equal(existsSync(allocated), false);
  } finally { if (allocated) await rm(allocated, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('interrupt and unusual error codes always produce explicit string failure reasons', () => {
  const controller = new AbortController(); controller.abort();
  let caught; try { controller.signal.throwIfAborted(); } catch (error) { caught = error; }
  assert.equal(caught.code, 20); assert.equal(failureReason(caught), 'interrupted');
  assert.equal(failureReason({ code: 99 }), '99'); assert.equal(failureReason(null), 'verification_failed');
});

test('single missing-ref case succeeds as verification and usage rejects unknown CLI flags', { timeout: 30000 }, async () => {
  const root = await temporary('single');
  try {
    const evidenceDir = join(root, 'evidence');
    const invocation = await runCommand(process.execPath, [join(repository, 'scripts/smoke-skills-check.mjs'), '--case', 'missing-ref', '--evidence-dir', evidenceDir], {
      cwd: repository, env: { PATH: process.env.PATH, OSSTACK_HOME: join(root, 'outer-home'), OSSTACK_SCRATCH_ROOT: process.env.OSSTACK_SCRATCH_ROOT },
    });
    assert.equal(invocation.exit_code, 0);
    const receipt = JSON.parse(invocation.stdout);
    assert.deepEqual(receipt.selected_cases, ['missing-ref']); assert.equal(receipt.cases[0].actual_exit, 1);
    assert.equal(receipt.cases[0].source_check_status, 'failed');
    const invalid = await runCommand(process.execPath, [join(repository, 'scripts/smoke-skills-check.mjs'), '--unknown'], { cwd: repository, env: {} });
    assert.equal(invalid.exit_code, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const cleanupFailure of ['throws', 'returns-without-removing']) test(`owned cleanup ${cleanupFailure} retains passed behavior but fails the driver`, { timeout: 30000 }, async () => {
  const root = await temporary('cleanup'); let retained;
  try {
    const evidenceDir = join(root, 'evidence');
    const result = await runVerification({ caseName: 'healthy', evidenceDir }, { removeFixture: async path => {
      retained = path; if (cleanupFailure === 'throws') throw Object.assign(Error('test removal failure'), { code: 'EACCES' });
    } });
    assert.equal(result.status, 'failed'); assert.equal(result.driver_exit, 1);
    assert.equal(result.behavior, 'passed'); assert.equal(result.cases[0].actual_exit, 0);
    assert.equal(result.cleanup.status, 'failed'); assert.equal(result.cleanup.fixture_removed, false);
    assert.equal(existsSync(retained), true); assert.equal(existsSync(join(evidenceDir, 'manifest.json')), true);
    assert.deepEqual(JSON.parse(await readFile(join(evidenceDir, 'receipt.json'), 'utf8')), result);
  } finally { if (retained) await rm(retained, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('real compiled CLI verifies all five cases while preserving raw failures and separate evidence', { timeout: 120000 }, async () => {
  const root = await temporary('integration');
  try {
    const evidenceDir = join(root, 'evidence');
    const result = await runVerification({ caseName: 'all', evidenceDir });
    assert.equal(result.status, 'passed'); assert.equal(result.driver_exit, 0);
    assert.deepEqual(result.cases.map(x => x.actual_exit), [0, 1, 2, 1, 0]);
    assert.ok(result.cases.every(x => x.verification_status === 'passed' && x.input_unchanged));
    assert.equal(result.cases[1].source_check_status, 'failed');
    assert.equal(result.cases[2].source_check_status, 'drift');
    assert.equal(result.cleanup.fixture_removed, true);
    assert.equal(existsSync(result.cleanup.fixture_path), false);
    assert.ok(JSON.stringify(result).length < 12000);
    const saved = JSON.parse(await readFile(join(evidenceDir, 'receipt.json'), 'utf8'));
    assert.deepEqual(result, saved);
    const manifest = JSON.parse(await readFile(join(evidenceDir, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) {
      const bytes = await readFile(join(evidenceDir, file.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    for (const id of CASE_IDS) {
      const record = JSON.parse(await readFile(join(evidenceDir, `${id}.json`), 'utf8'));
      assert.equal(record.manifest_before_sha256, record.manifest_after_sha256);
      assert.equal(record.argv.at(-1), 'check');
    }
    assert.match(await readFile(join(evidenceDir, 'missing-ref.stdout'), 'utf8'), /unreachable: no_matching_ref/);
    const input = JSON.parse(await readFile(join(evidenceDir, 'missing-ref.input.json'), 'utf8'));
    assert.equal(input.sources[0].ref, 'refs/heads/not-present');
    assert.equal(result.provider_qualified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
