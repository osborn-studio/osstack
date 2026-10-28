import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertCleanShutdown, engineeringWorkflowObservation, fixtureEnvironment, removeFixtureRoot, runJsonCommand, sanitizedDiagnostic, stopChild, waitForFixtureReady,
} from "./smoke-engineering-decision.mjs";

function child(source) {
  return spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

test("fixture excludes inherited serving homes, provider credentials and Node injection", () => {
  const env = fixtureEnvironment("/isolated/smoke", "/scratch", "fixture-token", {
    PATH: "/bin", HOME: "/user", OSSTACK_HOME: "/production",
    OSSTACK_SOCKET: "/production.sock", OSSTACK_ENGINEERING_AUTH_FILE: "/production.json",
    ANTHROPIC_API_KEY: "secret", NODE_OPTIONS: "--require=/user/inject.js",
  });
  assert.equal(env.OSSTACK_HOME, "/isolated/smoke/home");
  assert.equal(env.HOME, "/isolated/smoke/user-home");
  assert.equal(env.OSSTACK_SOCKET, "d.sock");
  assert.equal(env.OSSTACK_ENGINEERING_FIXTURE_SOCKET, "d.sock");
  assert.equal(env.OSSTACK_ENGINEERING_AUTH_FILE, "/isolated/smoke/authority.json");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("startup rejects an exited fixture and removes pending listeners", async () => {
  const fixture = child("process.exit(7)");
  await assert.rejects(waitForFixtureReady(fixture, 3000), /fixture_exited_before_ready/);
  assert.equal(fixture.listenerCount("message"), 0);
  assert.equal(fixture.listenerCount("exit"), 0);
  await stopChild(fixture);
});

test("a missing executable reports spawn failure instead of waiting for timeout", async () => {
  const fixture = spawn("/nonexistent/osstack-smoke-node", [], { stdio: "ignore" });
  await assert.rejects(waitForFixtureReady(fixture, 3000), /fixture_spawn_failed/);
  await stopChild(fixture);
});

test("a silent startup times out and is reaped", async () => {
  const fixture = child("setInterval(() => {}, 1000)");
  try {
    await assert.rejects(waitForFixtureReady(fixture, 100), /fixture_startup_timeout/);
    assert.equal(fixture.listenerCount("message"), 0);
  } finally {
    await stopChild(fixture, 300, 3000);
  }
  assert.notEqual(fixture.signalCode ?? fixture.exitCode, null);
});

test("shutdown escalates when a real child ignores SIGTERM", async () => {
  const fixture = child('process.on("SIGTERM", () => {}); process.send({ready:true}); setInterval(() => {}, 1000);');
  try {
    await waitForFixtureReady(fixture, 3000);
    const result = await stopChild(fixture, 100, 3000);
    assert.equal(result.forced, true);
    assert.equal(fixture.signalCode, "SIGKILL");
  } finally {
    await stopChild(fixture, 100, 3000);
  }
});

test("a hung CLI subprocess is killed within its command deadline", async () => {
  const started = performance.now();
  await assert.rejects(runJsonCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeout: 100,
  }), /command_failed/);
  assert.ok(performance.now() - started < 3000);
});

test("invalid or failed CLI output cannot be accepted as a success receipt", async () => {
  await assert.rejects(runJsonCommand(process.execPath, ["-e", "console.log('not-json')"]), /command_invalid_json/);
  await assert.rejects(runJsonCommand(process.execPath, ["-e", "console.log('{}'); process.exit(9)"]), /command_failed/);
});

test("the crash fixture ignores an inherited product socket override", async () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const { createScratchDir, scratchRoot } = await import("../packages/core/dist/index.js");
  const { build } = await import("esbuild");
  const root = await realpath(await createScratchDir("smoke", "socket-env"));
  let fixture;
  try {
    const env = fixtureEnvironment(root, scratchRoot(), "fixture-only-not-production-00000000");
    delete env.OSSTACK_ENGINEERING_FIXTURE_SOCKET;
    env.OSSTACK_SOCKET = join(root, "inherited.sock");
    await mkdir(env.HOME, { recursive: true, mode: 0o700 });
    await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
    await writeFile(env.OSSTACK_ENGINEERING_AUTH_FILE, '{"version":1,"principals":[]}', { mode: 0o600 });
    await symlink(join(repository, "packages/cli/node_modules"), join(root, "node_modules"), "dir");
    await build({ entryPoints: [join(repository, "scripts/fixtures/engineering-crash-host.ts")], bundle: true,
      platform: "node", format: "esm", packages: "external", outfile: join(root, "host.mjs"), logLevel: "silent" });
    fixture = fork(join(root, "host.mjs"), [root, "complete"], {
      cwd: root, env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await waitForFixtureReady(fixture);
    assert.equal(existsSync(join(root, "d.sock")), true);
    assert.equal(existsSync(env.OSSTACK_SOCKET), false);
  } finally {
    await stopChild(fixture);
    await rm(root, { recursive: true, force: true });
  }
});

for (const code of [0, 7]) test(`a daemon that exited early with code ${code} cannot pass cleanup`, async () => {
  const fixture = child(`process.send({ready:true}); setTimeout(() => process.exit(${code}), 50);`);
  const exited = once(fixture, "exit");
  await waitForFixtureReady(fixture, 3000);
  await exited;
  const shutdown = await stopChild(fixture);
  assert.equal(shutdown.exit_code, code);
  assert.throws(() => assertCleanShutdown(shutdown), /fixture_unexpected_exit/);
});

test("a daemon must handle the requested graceful shutdown with exit zero", async () => {
  const fixture = child('process.on("SIGTERM", () => process.exit(0)); process.send({ready:true}); setInterval(() => {}, 1000);');
  try {
    await waitForFixtureReady(fixture, 3000);
    assertCleanShutdown(await stopChild(fixture));
  } finally { await stopChild(fixture); }
});

test("bounded diagnostics redact the credential and terminal control bytes", () => {
  const credential = "fixture-only-test-token-not-for-production";
  const diagnostic = sanitizedDiagnostic("x".repeat(9000) + "\u001b" + credential + "\u0000 failed", [credential]);
  assert.ok(diagnostic.length <= 2048);
  assert.ok(diagnostic.includes("[redacted]"));
  assert.equal(diagnostic.includes(credential), false);
  assert.equal(/[\u0000\u001b]/.test(diagnostic), false);
});

test("a real fixture boot failure keeps a private diagnostic and removes authority tokens", async () => {
  const script = fileURLToPath(new URL("smoke-engineering-decision.mjs", import.meta.url));
  const { scratchRoot, createScratchDir } = await import("../packages/core/dist/index.js");
  const brokenGit = await createScratchDir("tests", "engineering-broken-git");
  await writeFile(join(brokenGit, "git"), `#!${process.execPath}\nprocess.stderr.write("injected_git_failure"); process.exit(9);\n`, { mode: 0o700 });
  let report;
  try {
    await runJsonCommand(process.execPath, [script], {
      env: { ...process.env, OSSTACK_SCRATCH_ROOT: scratchRoot(), PATH: brokenGit },
      timeout: 20000,
    });
    assert.fail("the fixture cannot initialize Git with this PATH");
  } catch (error) {
    report = JSON.parse(error.stderr);
  }
  assert.equal(report.status, "failed");
  assert.equal(report.diagnostics.stage, "start_fixture");
  const root = dirname(report.diagnostics_path);
  assert.ok(basename(root).startsWith("engineering-decision-"));
  try {
    assert.equal((await stat(report.diagnostics_path)).mode & 0o077, 0);
    const diagnostic = JSON.parse(await readFile(report.diagnostics_path, "utf8"));
    assert.match(diagnostic.fixture_stderr, /injected_git_failure/);
    assert.equal(diagnostic.shutdown.exit_code, 1);
    assert.equal(existsSync(join(root, "authority.json")), false);
    assert.equal(existsSync(join(root, "observation.json")), false);
  } finally { await rm(brokenGit, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); if (report.evidence) await rm(report.evidence.directory, { recursive: true, force: true }); }
});

for (const mode of ['--doctor', '--dry-run']) test(`${mode} is read-only and never creates a fixture or evidence directory`, async () => {
  const { createScratchDir } = await import('../packages/core/dist/index.js');
  const root = await createScratchDir('tests', 'engineering-readonly');
  const untouched = join(root, 'must-not-exist');
  try {
    const report = await runJsonCommand(process.execPath, [fileURLToPath(new URL('./smoke-engineering-decision.mjs', import.meta.url)), mode, '--evidence-dir', join(root, 'evidence')], {
      env: { ...process.env, OSSTACK_SCRATCH_ROOT: untouched, OSSTACK_ENGINEERING_CREDENTIAL: 'read-only-secret' },
    });
    assert.equal(report.status, mode === '--doctor' ? 'preflight' : 'planned');
    assert.equal(report.ready, true); assert.equal(report.executed, false); assert.equal(report.provider_qualified, false);
    assert.equal(existsSync(untouched), false); assert.equal(existsSync(join(root, 'evidence')), false);
    assert.equal(JSON.stringify(report).includes('read-only-secret'), false);
    assert.ok(report.plan.some(step => step.includes('engineering decide')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing build preflight fails without creating directories or running a CLI', async () => {
  const { engineeringPreflight } = await import('./lib/engineering-verification-evidence.mjs');
  const { createScratchDir } = await import('../packages/core/dist/index.js');
  const root = await createScratchDir('tests', 'engineering-missing-build');
  try {
    const report = await engineeringPreflight({ repository: root, evidenceDir: join(root, 'new-evidence') });
    assert.equal(report.ready, false); assert.equal(report.executed, false);
    assert.ok(report.checks.some(check => check.id === 'compiled_cli' && check.ok === false));
    assert.equal(existsSync(join(root, 'new-evidence')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing evidence destination is rejected before fixture work and is never overwritten', async () => {
  const { createScratchDir } = await import('../packages/core/dist/index.js');
  const root = await createScratchDir('tests', 'engineering-evidence-collision');
  const evidence = join(root, 'existing'); const scratch = join(root, 'no-fixture');
  await mkdir(evidence); await writeFile(join(evidence, 'sentinel'), 'keep');
  try {
    await assert.rejects(runJsonCommand(process.execPath, [fileURLToPath(new URL('./smoke-engineering-decision.mjs', import.meta.url)), '--evidence-dir', evidence], { env: { ...process.env, OSSTACK_SCRATCH_ROOT: scratch } }), error => { assert.match(JSON.parse(error.stderr).reason, /evidence_destination_new/); return true; });
    assert.equal(await readFile(join(evidence, 'sentinel'), 'utf8'), 'keep'); assert.equal(existsSync(scratch), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('successful compiled user flow retains independently verifiable evidence after fixture cleanup', { timeout: 160000 }, async () => {
  const { createHash } = await import('node:crypto');
  const { createScratchDir } = await import('../packages/core/dist/index.js');
  const root = await createScratchDir('tests', 'engineering-success-evidence');
  const evidence = join(root, 'evidence');
  try {
    const receipt = await runJsonCommand(process.execPath, [fileURLToPath(new URL('./smoke-engineering-decision.mjs', import.meta.url)), '--evidence-dir', evidence], { timeout: 150000 });
    assert.equal(receipt.status, 'passed'); assert.equal(receipt.action_receipt, 'applied'); assert.equal(receipt.cleanup.scratch_removed, true);
    assert.equal(receipt.completion_level, 'observed_turn'); assert.equal(receipt.provider_qualified, false);
    assert.equal(receipt.evidence.directory, evidence);
    const saved = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'));
    assert.deepEqual(saved, receipt);
    const run = JSON.parse(await readFile(join(evidence, 'run.json'), 'utf8'));
    assert.equal(existsSync(run.fixture_root), false);
    assert.match(run.bindings.source.digest, /^[a-f0-9]{64}$/); assert.match(run.bindings.build.digest, /^[a-f0-9]{64}$/);
    assert.equal(run.bindings_unchanged, true); assert.equal(run.environment.provider_credentials_inherited, false);
    const raw = await readFile(join(evidence, 'observations.ndjson'), 'utf8');
    const observations = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(observations.some(row => row.stage === 'reconcile' && row.exit_code === 0 && JSON.parse(row.stdout).state === 'applied'));
    assert.ok(observations.some(row => row.stage === 'decide' && row.exit_code === 0));
    assert.equal(/fixture-only-[a-f0-9-]{36}/.test(raw), false);
    const cleanup = JSON.parse(await readFile(join(evidence, 'cleanup.json'), 'utf8'));
    assert.equal(cleanup.process_exit_confirmed, true); assert.equal(cleanup.scratch_removed, true);
    assert.equal(cleanup.process_started, true); assert.ok(Number.isInteger(cleanup.pid));
    assert.ok(observations.some(row => row.command === 'fixture daemon start' && row.pid === cleanup.pid));
    const manifest = JSON.parse(await readFile(join(evidence, 'manifest.json'), 'utf8'));
    for (const file of manifest.files) assert.equal(createHash('sha256').update(await readFile(join(evidence, file.path))).digest('hex'), file.sha256);
    assert.ok(manifest.files.some(file => file.path === 'observations.ndjson'));
    assert.equal((await stat(join(evidence, 'observations.ndjson'))).mode & 0o077, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});


// Component checks only: this does not inject failure into the complete finally path.
test('cleanup removal and workflow observation helpers preserve distinct component outcomes', async () => {
  const cleanup = await removeFixtureRoot('/owned-test-fixture', async () => { const error = Error('private detail'); error.code = 'EACCES'; throw error; });
  assert.deepEqual(cleanup, { scratch_removed: false, error_code: 'EACCES' });
  assert.deepEqual(engineeringWorkflowObservation(undefined, { action_receipt: 'applied', completion_level: 'observed_turn' }), {
    action_receipt: 'applied', completion_level: 'observed_turn', status: 'observed', provider_qualified: false,
  });
  assert.throws(() => assertCleanShutdown({ was_running: true, forced: true, exit_code: null, signal: 'SIGKILL' }), /fixture_unexpected_exit/);
});

test('fixture allocation failure closes the reserved independent evidence instead of losing its location', async () => {
  const { createScratchDir } = await import('../packages/core/dist/index.js');
  const root = await createScratchDir('tests', 'engineering-prepare-failure'); const evidence = join(root, 'evidence');
  const notDirectory = join(root, 'not-directory'); await writeFile(notDirectory, 'occupied');
  try {
    await assert.rejects(runJsonCommand(process.execPath, [fileURLToPath(new URL('./smoke-engineering-decision.mjs', import.meta.url)), '--evidence-dir', evidence], { env: { ...process.env, OSSTACK_SCRATCH_ROOT: notDirectory } }), error => {
      const report = JSON.parse(error.stderr); assert.equal(report.evidence.directory, evidence); assert.match(report.reason, /create_fixture/); return true;
    });
    const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.cleanup.process_started, false); assert.equal(receipt.cleanup.process_exit_confirmed, true); assert.equal(existsSync(join(evidence, 'manifest.json')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evidence reservation races cannot reuse or overwrite the winning directory', async () => {
  const { reserveEngineeringEvidence } = await import('./lib/engineering-verification-evidence.mjs');
  const { createScratchDir } = await import('../packages/core/dist/index.js'); const root = await createScratchDir('tests', 'engineering-evidence-race');
  try {
    const results = await Promise.allSettled([reserveEngineeringEvidence(join(root, 'once')), reserveEngineeringEvidence(join(root, 'once'))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'EEXIST');
    assert.equal(await readFile(join(root, 'once', 'observations.ndjson'), 'utf8'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('failed commands with empty stdout retain exact invocation inputs', async () => {
  const observations = []; const argv = ['-e', 'process.exit(9)', 'request-fixture-uuid', '2030-01-01T00:00:00Z'];
  await assert.rejects(runJsonCommand(process.execPath, argv, { cwd: process.cwd(), observe: value => observations.push(value) }), /command_failed/);
  assert.equal(observations.length, 1); assert.equal(observations[0].stdout, ''); assert.equal(observations[0].exit_code, 9);
  assert.equal(observations[0].executable, process.execPath); assert.deepEqual(observations[0].argv, argv); assert.equal(observations[0].cwd, process.cwd());
});

test('doctor rejects missing git using read-only PATH lookup', async () => {
  let observed;
  const { createScratchDir } = await import('../packages/core/dist/index.js'); const root = await createScratchDir('tests', 'engineering-no-git');
  try {
    await assert.rejects(runJsonCommand(process.execPath, [fileURLToPath(new URL('./smoke-engineering-decision.mjs', import.meta.url)), '--doctor', '--evidence-dir', join(root, 'evidence')], { env: { ...process.env, PATH: root, OSSTACK_SCRATCH_ROOT: join(root, 'untouched') }, observe: value => { observed = value; } }), error => {
      assert.equal(error.message, 'command_failed'); const report = JSON.parse(observed.stdout); assert.equal(report.ready, false); assert.equal(report.executed, false); assert.ok(report.checks.some(check => check.id === 'git_executable' && !check.ok)); return true;
    });
    assert.equal(existsSync(join(root, 'evidence')), false); assert.equal(existsSync(join(root, 'untouched')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('content bindings ignore a stray non-directory packages entry', async () => {
  const { engineeringBindings } = await import('./lib/engineering-verification-evidence.mjs');
  const { createScratchDir } = await import('../packages/core/dist/index.js'); const root = await createScratchDir('tests', 'engineering-binding-stray');
  try {
    for (const dir of ['packages', 'scripts/lib', 'scripts/fixtures']) await mkdir(join(root, dir), { recursive: true });
    for (const file of ['package.json', 'pnpm-lock.yaml', 'scripts/smoke-engineering-decision.mjs', 'scripts/lib/engineering-verification-evidence.mjs']) await writeFile(join(root, file), '{}');
    const before = await engineeringBindings(root); await writeFile(join(root, 'packages/.DS_Store'), 'stray');
    assert.deepEqual(await engineeringBindings(root), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('assertion failure details preserve actual expected and predicate text', async () => {
  const { engineeringFailureDetails } = await import('./smoke-engineering-decision.mjs');
  let cause; try { assert.equal(2, 1, 'adapter invocation count'); } catch (error) { cause = error; }
  const detail = engineeringFailureDetails(cause);
  assert.equal(detail.actual, 2); assert.equal(detail.expected, 1); assert.match(detail.message, /adapter invocation count/);
});

test('disk evidence strips controls before credential redaction recursively', async () => {
  const { reserveEngineeringEvidence, appendEngineeringObservation, writeEngineeringEvidence } = await import('./lib/engineering-verification-evidence.mjs');
  const { createScratchDir } = await import('../packages/core/dist/index.js'); const root = await createScratchDir('tests', 'engineering-redaction');
  const secret = 'fixture-only-secret'; const poisoned = 'fixture-only-\u001bsecret';
  try {
    const evidence = await reserveEngineeringEvidence(join(root, 'evidence'));
    await appendEngineeringObservation(evidence, { stdout: poisoned, argv: [secret, { nested: poisoned }] }, [secret]);
    await writeEngineeringEvidence(evidence, 'diagnostics.json', { nested: [poisoned, secret] }, [secret]);
    for (const file of ['observations.ndjson', 'diagnostics.json']) {
      const raw = await readFile(join(evidence.directory, file), 'utf8');
      assert.equal(raw.includes(secret), false); assert.equal(raw.includes('\\u001b'), false); assert.ok(raw.includes('[redacted]'));
    }
    assert.deepEqual(JSON.parse(await readFile(join(evidence.directory, 'diagnostics.json'), 'utf8')), { nested: ['[redacted]', '[redacted]'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded stderr redaction survives chunks controls and truncation boundaries', async () => {
  const { createBoundedEvidenceTail } = await import('./lib/engineering-verification-evidence.mjs');
  const secret = 'fixture-only-secret'; const tail = createBoundedEvidenceTail([secret], 32);
  tail.push('x'.repeat(100) + 'fixture-only-'); assert.equal(tail.read().includes('fixture-only-'), false);
  tail.push('\u001bsecret' + 'y'.repeat(20));
  assert.equal(tail.read().includes(secret), false); assert.ok(tail.read().includes('[redacted]')); assert.ok(tail.read().length <= 32);
  assert.equal(sanitizedDiagnostic('fixture-only-\u001bsecret', [secret]), '[redacted]');
});
