#!/usr/bin/env node
// Real compiled CLI against owned file:// sources. No skill installation or DB.
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CASE_IDS, assertOwnedFixture, caseDefinition, evaluateCase, failureReason, fixtureEnvironment, jsonBytes, parseOptions,
  preflight, reserveEvidence, runCommand, scratchRoot, sealEvidence, sha256, sourceBindings, writeJson,
} from './lib/skills-check-verification.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test seams for allocation canonicalization/cleanup, never CLI options.
export async function runVerification({ caseName = 'all', evidenceDir } = {}, { removeFixture = rm, canonicalizeFixture = realpath } = {}) {
  if (!['all', ...CASE_IDS].includes(caseName)) throw Object.assign(Error('invalid_case'), { exitCode: 2 });
  const checked = await preflight({ repository, evidenceDir, caseName });
  if (!checked.ready) throw Object.assign(Error('preflight_failed'), { preflight: checked });
  const evidence = await reserveEvidence(evidenceDir);
  const startedAt = new Date().toISOString(); const deadline = Date.now() + 90000;
  const selected = caseName === 'all' ? [...CASE_IDS] : [caseName];
  const controller = new AbortController(); const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let fixture; let bindings; let env; let failure = null; let commandsSafeToClean = true; let counter = 0;
  const cases = []; const commands = [];
  const run = { schema_version: 1, run_id: evidence.run_id, status: 'running', started_at: startedAt, selected_cases: selected,
    node: process.version, platform: process.platform, arch: process.arch, budgets: { command_sequence_deadline_ms: 90000, command_ms: 10000, command_output_bytes_per_stream: 1048576, direct_child_exit_grace_ms: 2000,
      scope: 'subprocess deadlines and checks before each command; filesystem binding and cleanup are not hard wall-clock bounded' },
    source_and_build_bindings: 'bindings.json', provider_qualified: false };
  let cleanup = { status: 'not_started', fixture_path: null, fixture_removed: false, descendant_termination: 'not_attested' };
  const saveCommand = async (label, executable, argv, cwd, commandEnv = env) => {
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw Error('driver_deadline');
    const result = await runCommand(executable, argv, { cwd, env: commandEnv, timeoutMs: Math.min(10000, deadline - Date.now()), signal: controller.signal });
    if (result.timed_out || result.output_limited || result.interrupted || (result.process_started && !result.direct_child_exit_confirmed)) commandsSafeToClean = false;
    const { stdout, stderr, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, ...record } = result;
    record.stdout_path = `${label}.stdout`; record.stderr_path = `${label}.stderr`;
    record.stdout_sha256 = sha256(stdoutBytes); record.stderr_sha256 = sha256(stderrBytes);
    record.environment = commandEnv;
    await writeFile(join(evidence.directory, record.stdout_path), stdoutBytes, { mode: 0o600 });
    await writeFile(join(evidence.directory, record.stderr_path), stderrBytes, { mode: 0o600 });
    await writeJson(join(evidence.directory, `${label}.command.json`), record);
    commands.push({ label, record: `${label}.command.json`, exit_code: result.exit_code });
    return { result, record };
  };
  const git = async (args, cwd) => {
    const { result } = await saveCommand(`git-${String(counter++).padStart(2, '0')}`, checked.git_executable, args, cwd);
    if (result.exit_code !== 0 || result.signal || result.timed_out || result.output_limited || result.spawn_error || result.interrupted) throw Error('fixture_git_failed');
    return result.stdout.trim();
  };
  try {
    await writeJson(join(evidence.directory, 'run.json'), run);
    bindings = await sourceBindings(repository); await writeJson(join(evidence.directory, 'bindings.json'), bindings);
    run.bindings = { source_digest: bindings.source.digest, build_digest: bindings.build.digest };
    const { createScratchDir } = await import(pathToFileURL(join(repository, 'packages/core/dist/index.js')).href);
    fixture = await createScratchDir('smoke', 'skills-check');
    cleanup.fixture_path = fixture;
    fixture = await canonicalizeFixture(fixture);
    fixture = await assertOwnedFixture(fixture, scratchRoot(), evidence.directory);
    cleanup.fixture_path = fixture;
    // Evidence was exclusively created before this fresh random fixture; it is
    // never put under the disposable fixture root.
    env = fixtureEnvironment(fixture, scratchRoot(), process.env.PATH ?? '', join(fixture, 'setup-home'));
    for (const name of ['user-home', 'xdg', 'tmp', 'hooks', 'template', 'setup-home']) await mkdir(join(fixture, name), { mode: 0o700 });
    await writeFile(join(fixture, 'empty-gitconfig'), '', { mode: 0o600 });
    await writeJson(join(evidence.directory, 'environment.json'), env);
    run.git_head = await git(['rev-parse', 'HEAD'], repository);
    const origin = join(fixture, 'origin');
    await git(['init', '--initial-branch=main', origin], fixture);
    await git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'owned baseline'], origin);
    const oldSha = await git(['rev-parse', 'HEAD'], origin);
    await git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'owned subsequent commit'], origin);
    const currentSha = await git(['rev-parse', 'HEAD'], origin);
    if (!/^[a-f0-9]{40}$/.test(oldSha) || !/^[a-f0-9]{40}$/.test(currentSha) || oldSha === currentSha) throw Error('invalid_fixture_commits');
    const definitions = selected.map(id => caseDefinition(id, pathToFileURL(origin).href, oldSha, currentSha));
    await writeJson(join(evidence.directory, 'expectations.json'), { recorded_before_case_execution: new Date().toISOString(), definitions,
      scope: 'fixed engineering expectations from this driver; not an independently qualified oracle' });
    for (const expected of definitions) {
      const id = expected.case_id; const home = join(fixture, `home-${id}`); await mkdir(home, { mode: 0o700 });
      const input = jsonBytes({ version: 1, sources: expected.sources }); const manifestPath = join(home, 'skills.config.yaml');
      await writeFile(manifestPath, input, { mode: 0o600 }); await writeFile(join(evidence.directory, `${id}.input.json`), input, { mode: 0o600 });
      const before = sha256(await readFile(manifestPath));
      const { result, record } = await saveCommand(id, process.execPath, [join(repository, 'packages/cli/dist/bin.js'), 'skills', 'check'], fixture,
        fixtureEnvironment(fixture, scratchRoot(), process.env.PATH ?? '', home));
      let after = null; try { after = sha256(await readFile(manifestPath)); } catch { /* Missing or unreadable is not unchanged. */ }
      const observed = evaluateCase(expected, result, after === before);
      // A skills check must not initialize a control-plane database in its home.
      const entries = await readdir(home);
      if (entries.some(name => name !== 'skills.config.yaml')) { observed.errors.push('unexpected_home_side_effect'); observed.verification_status = 'failed'; observed.source_check_status = 'unknown'; }
      cases.push(observed);
      await writeJson(join(evidence.directory, `${id}.json`), { ...record, ...observed, manifest_path: manifestPath,
        manifest_before_sha256: before, manifest_after_sha256: after, input_path: `${id}.input.json` });
      if (!commandsSafeToClean) throw Error('command_termination_incomplete');
    }
    if (cases.some(value => value.verification_status !== 'passed')) failure = 'case_expectation_failed';
  } catch (error) { failure = failureReason(error); }
  finally {
    if (bindings) {
      try {
        const after = await sourceBindings(repository);
        run.final_bindings = { source_digest: after.source.digest, build_digest: after.build.digest };
        run.bindings_unchanged = after.source.digest === bindings.source.digest && after.build.digest === bindings.build.digest;
        if (!run.bindings_unchanged) failure ??= 'source_or_build_changed_during_run';
      } catch { failure ??= 'binding_recheck_failed'; }
    }
    if (controller.signal.aborted) failure ??= 'interrupted';
    if (fixture && commandsSafeToClean) {
      try {
        await assertOwnedFixture(fixture, scratchRoot(), evidence.directory);
        await removeFixture(fixture, { recursive: true, force: true });
        try { await lstat(fixture); throw Object.assign(Error('fixture_still_exists'), { code: 'FIXTURE_STILL_EXISTS' }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        cleanup.status = 'passed'; cleanup.fixture_removed = true;
      }
      catch (error) { cleanup.status = 'failed'; cleanup.reason = failureReason(error); failure ??= 'fixture_cleanup_failed'; }
    } else if (fixture) {
      cleanup.status = 'failed'; cleanup.reason = 'uncertain_command_descendants_fixture_retained'; failure ??= 'fixture_cleanup_unconfirmed';
    } else { cleanup.status = 'not_required'; cleanup.reason = 'fixture_not_allocated'; }
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  const passed = !failure && cases.length === selected.length && cases.every(value => value.verification_status === 'passed') && cleanup.status === 'passed';
  const receipt = { schema_version: 1, run_id: evidence.run_id, status: passed ? 'passed' : 'failed', driver_exit: passed ? 0 : 1,
    selected_cases: selected, cases, behavior: cases.length === selected.length && cases.every(value => value.verification_status === 'passed') ? 'passed' : 'failed_or_not_observed',
    cleanup, failure, provider_qualified: false, evidence: { directory: evidence.directory, manifest: 'manifest.json', bindings: 'bindings.json' },
    binding_digests: run.bindings ?? null,
    limitations: ['local deterministic file:// sources only', 'direct owned child exit observed; descendant termination not attested', 'not skill installation, live provider, dependency closure or formal gate qualification'] };
  run.status = receipt.status; run.ended_at = new Date().toISOString(); run.commands = commands;
  try {
    await writeJson(join(evidence.directory, 'run.json'), run);
    await writeJson(join(evidence.directory, 'cleanup.json'), cleanup);
    await writeJson(join(evidence.directory, 'receipt.json'), receipt);
    await sealEvidence(evidence.directory, evidence.run_id);
  } catch (error) {
    throw Object.assign(Error(`evidence_incomplete:${error.code ?? error.message}`), { evidence, receipt: { ...receipt, status: 'failed', driver_exit: 1 } });
  }
  return receipt;
}

let directEntry = false;
if (process.argv[1]) {
  try { directEntry = await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url)); }
  catch { /* An unrelated/non-file host argv is not this module's CLI entry. */ }
}
if (directEntry) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.mode !== 'run') {
      const result = await preflight({ repository, ...options });
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ready ? 0 : 1;
    } else {
      const result = await runVerification(options); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.driver_exit;
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', reason: error.message, ...(error.preflight ? { preflight: error.preflight } : {}),
      ...(error.evidence ? { evidence: error.evidence } : {}), ...(error.receipt ? { receipt: error.receipt } : {}) }));
    process.exitCode = error.exitCode ?? 1;
  }
}
