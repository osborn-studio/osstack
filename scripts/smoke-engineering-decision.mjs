#!/usr/bin/env node
// Actual compiled CLI + independent daemon + deterministic, unpaid Adapter.
// This verifies local integration only; it cannot qualify a live Provider.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  appendEngineeringObservation, engineeringBindings, engineeringPreflight, parseEngineeringOptions,
  reserveEngineeringEvidence, sanitizeEvidence, sealEngineeringEvidence, writeEngineeringEvidence,
} from './lib/engineering-verification-evidence.mjs';

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repository, "packages/cli/dist/bin.js");

export function fixtureEnvironment(root, scratchRoot, credential, source = process.env) {
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "SystemRoot"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    HOME: join(root, "user-home"),
    TMPDIR: join(root, "tmp"),
    OSSTACK_HOME: join(root, "home"),
    OSSTACK_SCRATCH_ROOT: scratchRoot,
    OSSTACK_LOOP_CONTAINMENT_ROOT: join(root, "containment"),
    // Both daemon and CLI run with cwd=root. The Unix socket path is short
    // even when the scratch root exceeds macOS's sockaddr_un path budget.
    OSSTACK_SOCKET: "d.sock",
    OSSTACK_ENGINEERING_FIXTURE_SOCKET: "d.sock",
    OSSTACK_DASHBOARD_HOST: "127.0.0.1",
    OSSTACK_DASHBOARD_PORT: "0",
    OSSTACK_UPDATE_CHECK: "0",
    OSSTACK_ATTENTION: "1",
    OSSTACK_ENGINEERING: "1",
    OSSTACK_ENGINEERING_AUTH_FILE: join(root, "authority.json"),
    OSSTACK_ENGINEERING_CREDENTIAL: credential,
  };
}

export function waitForFixtureReady(child, timeoutMs = 15000) {
  return new Promise((resolveReady, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const finish = (error, message) => {
      cleanup();
      if (error) reject(error); else resolveReady(message);
    };
    const onMessage = message => {
      if (message?.ready === true) finish(undefined, message);
      else finish(new Error("fixture_invalid_ready_message"));
    };
    const onError = () => finish(new Error("fixture_spawn_failed"));
    const onExit = () => finish(new Error("fixture_exited_before_ready"));
    const timer = setTimeout(() => finish(new Error("fixture_startup_timeout")), timeoutMs);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

function waitForExit(child, timeoutMs) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const finish = exited => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function stopChild(child, gracefulMs = 3000, killMs = 3000) {
  const status = (forced, wasRunning) => ({ forced, was_running: wasRunning, exit_code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return status(false, false);
  const graceful = waitForExit(child, gracefulMs);
  child.kill("SIGTERM");
  if (await graceful) return status(false, true);
  const killed = waitForExit(child, killMs);
  child.kill("SIGKILL");
  if (!(await killed)) throw new Error("fixture_cleanup_failed: process exit unconfirmed; preserve scratch evidence");
  return status(true, true);
}

export function assertCleanShutdown(shutdown) {
  if (!shutdown.was_running || shutdown.forced || shutdown.exit_code !== 0 || shutdown.signal !== null) {
    throw new Error("fixture_unexpected_exit");
  }
}

export function sanitizedDiagnostic(text, secrets = []) {
  let result = String(text ?? "");
  for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
  return result.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(-2048);
}

export async function runJsonCommand(command, args, options = {}) {
  const { observe, ...childOptions } = options;
  const startedAt = new Date().toISOString();
  const invocation = { executable: command, argv: [...args], cwd: resolve(childOptions.cwd ?? process.cwd()) };
  let stdout; let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(command, args, {
      ...childOptions, encoding: "utf8", timeout: options.timeout ?? 10000,
      killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    }));
  } catch (cause) {
    await observe?.({ ...invocation, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: typeof cause.code === 'number' ? cause.code : null,
      spawn_error: typeof cause.code === 'string' ? cause.code : null, signal: cause.signal ?? null, killed: cause.killed === true,
      stdout: String(cause.stdout ?? ''), stderr: String(cause.stderr ?? '') });
    const error = new Error("command_failed");
    Object.defineProperty(error, "stderr", { value: String(cause.stderr ?? "").slice(-8192) });
    throw error;
  }
  await observe?.({ ...invocation, started_at: startedAt, ended_at: new Date().toISOString(), exit_code: 0, signal: null, stdout, stderr });
  try { return JSON.parse(stdout); } catch { throw new Error("command_invalid_json"); }
}

// The child shares the daemon's scratch cwd, so d.sock stays below the macOS
// Unix socket path limit even when the physical scratch root is very long.
async function fixtureRpc(method, params, options) {
  const source = `
import {connect} from 'node:net';
const request=JSON.parse(process.argv[1]);
const response=await new Promise((resolve,reject)=>{
  const socket=connect(process.env.OSSTACK_SOCKET);let bytes=Buffer.alloc(0),done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('rpc_timeout')),4000);
  socket.on('error',()=>finish(Error('rpc_transport')));
  socket.on('end',()=>{if(!done)finish(Error('rpc_incomplete'));});
  socket.on('connect',()=>{const body=Buffer.from(JSON.stringify(request));const head=Buffer.alloc(4);head.writeUInt32BE(body.length);socket.write(Buffer.concat([head,body]));});
  socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length<4)return;const size=bytes.readUInt32BE(0);if(size>1048576)return finish(Error('rpc_oversize'));if(bytes.length<size+4)return;try{const response=JSON.parse(bytes.subarray(4,size+4));if(response.id!==1||response.ok!==true)throw Error('rpc_rejected');finish(null,response.result);}catch(error){finish(error);}});
});
console.log(JSON.stringify(response));`;
  return runJsonCommand(process.execPath, ["--input-type=module", "-e", source, JSON.stringify({ id: 1, method, params })], { ...options, timeout: Math.min(options.timeout, 5000) });
}

export async function removeFixtureRoot(root, remove = rm) {
  try { await remove(root, { recursive: true, force: true }); return { scratch_removed: true }; }
  catch (error) { return { scratch_removed: false, error_code: error.code ?? 'fixture_remove_failed' }; }
}
export function engineeringWorkflowObservation(receipt, actionObservation) {
  return receipt || actionObservation ? { ...actionObservation, ...receipt, status: 'observed', provider_qualified: false } : null;
}

export async function runSmoke({ evidenceDir } = {}) {
  const preflight = await engineeringPreflight({ repository, evidenceDir });
  if (!preflight.ready) {
    const error = new Error('preflight_failed:' + preflight.checks.filter(check => !check.ok).map(check => check.id).join(','));
    error.preflight = preflight; throw error;
  }
  const bindings = await engineeringBindings(repository);
  const { createScratchDir, scratchRoot } = await import(pathToFileURL(join(repository, "packages/core/dist/index.js")).href);
  const evidence = await reserveEngineeringEvidence(evidenceDir, scratchRoot());
  let root;
  try { root = await realpath(await createScratchDir("smoke", "engineering-decision")); }
  catch (cause) {
    const error = new Error('engineering_smoke_failed:create_fixture:' + (cause.code ?? 'unavailable'));
    error.evidence = evidence;
    const cleanup = { process_exit_confirmed: false, process_started: false, scratch_removed: false, reason: 'fixture_not_created' };
    await writeEngineeringEvidence(evidence, 'run.json', { schema_version: 1, status: 'incomplete', provider_qualified: false, bindings, reason: error.message });
    await writeEngineeringEvidence(evidence, 'cleanup.json', cleanup);
    await writeEngineeringEvidence(evidence, 'receipt.json', { schema_version: 1, status: 'failed', provider_qualified: false, reason: error.message, cleanup, evidence });
    await sealEngineeringEvidence(evidence); throw error;
  }
  const credential = `fixture-only-${randomUUID()}`;
  const env = fixtureEnvironment(root, scratchRoot(), credential);
  const runInfo = { schema_version: 1, run_id: evidence.run_id, started_at: new Date().toISOString(), fixture_root: root,
    status: 'running', provider_qualified: false, bindings, environment: { node: process.version, platform: process.platform, arch: process.arch,
      fixture_home: env.OSSTACK_HOME, socket: env.OSSTACK_SOCKET, provider_credentials_inherited: false,
      inherited_keys: Object.keys(env).filter(key => !key.includes('CREDENTIAL')).sort() } };
  const trace = [];
  let fixture;
  let stage = "prepare";
  let receipt;
  let actionObservation;
  let failure;
  let interrupted = false;
  let fixtureStderr = "";
  let commandStderr = "";
  const overallDeadline = Date.now() + 90000;
  const remaining = () => {
    if (interrupted) throw new Error("interrupted");
    const ms = overallDeadline - Date.now();
    if (ms <= 0) throw new Error("smoke_deadline");
    return Math.min(ms, 10000);
  };
  const onSignal = () => { interrupted = true; fixture?.kill("SIGTERM"); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const record = command => observation => appendEngineeringObservation(evidence, { stage, command, ...observation }, [credential]);
  const cli = async (family, ...args) => {
    const result = await runJsonCommand(process.execPath, [cliPath, family, ...args, "--json"], { cwd: root, env, timeout: remaining(), observe: record(`${family} ${args[0]}`) });
    trace.push({ command: `${family} ${args[0]}`, state: result.mission?.state ?? result.state ?? null, replay: result.replay ?? null });
    return result;
  };
  const authority = async scope => {
    const principals = scope ? [{
      credential_sha256: createHash("sha256").update(credential).digest("hex"),
      principal_id: "fixture-owner", client_session_id: "fixture-cli",
      read_scopes: [scope], write_scopes: [scope], stop_scopes: [scope], operator_scopes: [],
    }] : [];
    await writeFile(env.OSSTACK_ENGINEERING_AUTH_FILE, JSON.stringify({ version: 1, principals }), { mode: 0o600 });
  };
  try {
    await writeEngineeringEvidence(evidence, 'run.json', runInfo, [credential]);
    await mkdir(env.HOME, { recursive: true, mode: 0o700 });
    await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
    await symlink(join(repository, "packages/cli/node_modules"), join(root, "node_modules"), "dir");
    await authority();
    stage = "bundle_fixture";
    const { build } = await import("esbuild");
    await build({
      entryPoints: [join(repository, "scripts/fixtures/engineering-crash-host.ts")],
      bundle: true, platform: "node", format: "esm", packages: "external",
      outfile: join(root, "host.mjs"), logLevel: "silent",
    });
    runInfo.fixture_bundle_sha256 = createHash('sha256').update(await readFile(join(root, 'host.mjs'))).digest('hex');
    stage = "start_fixture";
    if (interrupted) throw new Error("interrupted");
    fixture = fork(join(root, "host.mjs"), [root, "complete"], {
      cwd: root, env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    fixture.stderr.on("data", chunk => { fixtureStderr = (fixtureStderr + String(chunk)).slice(-8192); });
    const ready = await waitForFixtureReady(fixture, Math.min(15000, overallDeadline - Date.now()));
    assert.equal(ready.repo, join(root, "repo"));
    stage = "watch";
    const watched = await cli("attention", "watch", "--task", "task", "--repo", ready.repo, "--default-tenant");
    const scope = watched.scope?.scope_id;
    assert.match(scope ?? "", /^[a-f0-9]{64}$/);
    await authority(scope);
    stage = "adopt";
    const adopted = await cli("engineering", "adopt", "--scope", scope, "--task", "task", "--run", "run", "--session", "session", "--goal", "Observe this compatibility reply", "--request", randomUUID());
    const mission = adopted.mission?.mission_id;
    assert.equal(typeof mission, "string");
    stage = "observe";
    let view = await cli("engineering", "observe", "--mission", mission);
    assert.equal(view.waits?.length, 1);
    const observation = join(root, "observation.json");
    await writeFile(observation, JSON.stringify(view), { mode: 0o600 });
    stage = "defer";
    await cli("engineering", "defer", "--observation", observation, "--wait", view.waits[0].wait_id, "--request", randomUUID(), "--revisit-at", new Date(Date.now() + 60000).toISOString(), "--reason", "Fixture deferral before explicit choice");
    view = await cli("engineering", "observe", "--mission", mission);
    await writeFile(observation, JSON.stringify(view), { mode: 0o600 });
    stage = "decide";
    const action = randomUUID();
    const answer = ["decide", "--observation", observation, "--wait", view.waits[0].wait_id, "--action", action, "--choice", "keep"];
    await cli("engineering", ...answer);
    stage = "completion";
    const deadline = Date.now() + 15000;
    do {
      view = await cli("engineering", "observe", "--mission", mission);
      if (view.mission?.state === "completed") break;
      if (Date.now() >= deadline) throw new Error("completion_timeout");
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    } while (true);
    assert.equal(view.observation_proof?.kind, "observed_turn");
    stage = "same_key_replay";
    const replay = await cli("engineering", ...answer);
    assert.equal(replay.replay, true);
    stage = "reconcile";
    const actionReceipt = await cli("engineering", "reconcile", "--kind", "query_action", "--mission", mission, "--action", action);
    assert.equal(actionReceipt.state, "applied");
    actionObservation = { action_receipt: 'applied', completion_level: view.observation_proof.kind,
      same_key_replay: replay.replay, observed_at: new Date().toISOString(), provider_qualified: false };
    const invocations = (await readFile(join(root, "invocations.log"), "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(invocations.length, 1);
    stage = "drain";
    const drainDeadline = Date.now() + 5000;
    let drain;
    do {
      drain = await fixtureRpc("daemon.drain", { timeout_ms: 0 }, { cwd: root, env, timeout: remaining(), observe: record("daemon.drain") });
      if (drain.drained === true) break;
      if (Date.now() >= drainDeadline) throw new Error("drain_timeout");
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    } while (true);
    assert.equal(drain.execution_lease_holds, 0);
    assert.equal(drain.active_runs, 0);
    assert.equal(drain.graph_holds, 0);
    assert.equal(drain.attention_dispatch_holds, 0);
    const health = await fixtureRpc("health", {}, { cwd: root, env, timeout: remaining(), observe: record("health") });
    assert.equal(health.execution_lease_holds, 0);
    assert.equal(health.active_runs, 0);
    receipt = {
      schema_version: 1, status: "passed", profile: "local_deterministic_fixture",
      compiled_cli: true, independent_daemon: true, commands: trace,
      invocations: invocations.length, completion_level: "observed_turn",
      action_receipt: "applied", same_key_replay: true, provider_qualified: false,
      drain: { drained: true, execution_lease_holds: 0, active_runs: 0, graph_holds: 0, attention_dispatch_holds: 0 },
      unverified: ["live_provider", "physical_power_loss", "hostile_same_uid_isolation", "process_domain_termination", "nondefault_tenant", "remote_host"],
    };
  } catch (error) {
    commandStderr = error.stderr ?? "";
    failure = new Error(sanitizeEvidence(`engineering_smoke_failed:${stage}:${error.code ?? error.message}`, [credential]));
  } finally {
    // Do not remove a live process's home if shutdown cannot be confirmed.
    try {
      let shutdown;
      try {
        shutdown = await stopChild(fixture);
        if (receipt) assertCleanShutdown(shutdown);
      } catch (error) {
        failure ??= new Error(`engineering_smoke_failed:cleanup:${error.message}`);
      }
      if (interrupted && !failure) failure = new Error("engineering_smoke_failed:interrupted");
      try {
        const after = await engineeringBindings(repository);
        runInfo.final_bindings = { source_digest: after.source.digest, build_digest: after.build.digest, git_head: after.git_head };
        runInfo.bindings_unchanged = after.source.digest === bindings.source.digest && after.build.digest === bindings.build.digest;
        if (!runInfo.bindings_unchanged) failure ??= new Error('engineering_smoke_failed:bindings_changed_during_run');
      } catch { failure ??= new Error('engineering_smoke_failed:binding_recheck_failed'); }
      let cleanup = { process_exit_confirmed: shutdown !== undefined && (shutdown.exit_code !== null || shutdown.signal !== null),
        exit_code: shutdown?.exit_code ?? null, signal: shutdown?.signal ?? null, forced: shutdown?.forced ?? null, scratch_removed: false };
      let diagnostics;
      if (!failure) {
        const removal = await removeFixtureRoot(root);
        cleanup = { ...cleanup, ...removal };
        if (!removal.scratch_removed) failure = new Error('engineering_smoke_failed:cleanup:' + removal.error_code);
        else receipt.cleanup = cleanup;
      }
      if (failure) {
        diagnostics = { stage, reason: failure.message, commands: trace, shutdown: shutdown ?? null,
          fixture_stderr: sanitizedDiagnostic(fixtureStderr, [credential]), command_stderr: sanitizedDiagnostic(commandStderr, [credential]) };
        // Cleanup can partially remove the root. Independent evidence still closes
        // out even when the original diagnostic can no longer be written there.
        try {
          await rm(env.OSSTACK_ENGINEERING_AUTH_FILE, { force: true });
          await rm(join(root, "observation.json"), { force: true });
          failure.diagnostics_path = join(root, "failure.json");
          await writeFile(failure.diagnostics_path, JSON.stringify(diagnostics, null, 2), { mode: 0o600 });
        } catch (error) { diagnostics.fixture_cleanup_error = error.code ?? 'unavailable'; delete failure.diagnostics_path; }
        failure.diagnostics = diagnostics;
      }
      await appendEngineeringObservation(evidence, { stage: 'fixture_exit', command: 'fixture daemon',
        exit_code: shutdown?.exit_code ?? null, signal: shutdown?.signal ?? null, stderr: fixtureStderr, stderr_retention: 'last 8192 characters' }, [credential]);
      runInfo.ended_at = new Date().toISOString(); runInfo.status = failure ? 'failed' : 'passed';
      const finalReceipt = failure ? { schema_version: 1, status: 'failed', provider_qualified: false, reason: failure.message,
        workflow_observation: engineeringWorkflowObservation(receipt, actionObservation), cleanup, evidence } : { ...receipt, evidence };
      await writeEngineeringEvidence(evidence, 'run.json', runInfo, [credential]);
      await writeEngineeringEvidence(evidence, 'cleanup.json', cleanup, [credential]);
      await writeEngineeringEvidence(evidence, 'receipt.json', finalReceipt, [credential]);
      if (diagnostics) await writeEngineeringEvidence(evidence, 'diagnostics.json', diagnostics, [credential]);
      await sealEngineeringEvidence(evidence);
      if (failure) failure.evidence = evidence; else receipt = finalReceipt;
    } catch (error) {
      failure ??= new Error('engineering_smoke_failed:evidence_or_cleanup:' + (error.code ?? error.message));
      failure.evidence = evidence;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  if (failure) throw failure;
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseEngineeringOptions(process.argv.slice(2));
    if (options.mode !== 'run') {
      const report = await engineeringPreflight({ repository, evidenceDir: options.evidenceDir, mode: options.mode });
      console.log(JSON.stringify(report, null, 2)); if (!report.ready) process.exitCode = 1;
    } else console.log(JSON.stringify(await runSmoke(options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ schema_version: 1, status: "failed", provider_qualified: false, reason: error.message,
      ...(error.preflight ? { preflight: error.preflight } : {}), ...(error.evidence ? { evidence: error.evidence } : {}),
      ...(error.diagnostics_path ? { diagnostics_path: error.diagnostics_path, diagnostics: error.diagnostics } : {}) }));
    process.exitCode = 1;
  }
}
