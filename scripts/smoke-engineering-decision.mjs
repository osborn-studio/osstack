#!/usr/bin/env node
// Actual compiled CLI + independent daemon + deterministic, unpaid Adapter.
// This verifies local integration only; it cannot qualify a live Provider.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

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
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return { forced: false };
  const graceful = waitForExit(child, gracefulMs);
  child.kill("SIGTERM");
  if (await graceful) return { forced: false };
  const killed = waitForExit(child, killMs);
  child.kill("SIGKILL");
  if (!(await killed)) throw new Error("fixture_cleanup_failed: process exit unconfirmed; preserve scratch evidence");
  return { forced: true };
}

export async function runJsonCommand(command, args, options = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(command, args, {
      ...options, encoding: "utf8", timeout: options.timeout ?? 10000,
      killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    }));
  } catch {
    // Never include subprocess output, arguments, credentials or observations
    // in a failure receipt. The failing stage is reported separately.
    throw new Error("command_failed");
  }
  try { return JSON.parse(stdout); } catch { throw new Error("command_invalid_json"); }
}

export async function runSmoke() {
  if (!existsSync(cliPath)) throw new Error("missing_build: run pnpm build before this smoke");
  const { createScratchDir, scratchRoot } = await import(pathToFileURL(join(repository, "packages/core/dist/index.js")).href);
  const root = await realpath(await createScratchDir("smoke", "engineering-decision"));
  const credential = `fixture-only-${randomUUID()}`;
  const env = fixtureEnvironment(root, scratchRoot(), credential);
  const trace = [];
  let fixture;
  let stage = "prepare";
  let receipt;
  let failure;
  let interrupted = false;
  const onSignal = () => { interrupted = true; fixture?.kill("SIGTERM"); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const cli = async (family, ...args) => {
    if (interrupted) throw new Error("interrupted");
    const result = await runJsonCommand(process.execPath, [cliPath, family, ...args, "--json"], { cwd: root, env });
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
    stage = "start_fixture";
    if (interrupted) throw new Error("interrupted");
    fixture = fork(join(root, "host.mjs"), [root, "complete"], {
      cwd: root, env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const ready = await waitForFixtureReady(fixture);
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
    const invocations = (await readFile(join(root, "invocations.log"), "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(invocations.length, 1);
    receipt = {
      schema_version: 1, status: "passed", profile: "local_deterministic_fixture",
      compiled_cli: true, independent_daemon: true, commands: trace,
      invocations: invocations.length, completion_level: "observed_turn",
      action_receipt: "applied", same_key_replay: true, provider_qualified: false,
      unverified: ["live_provider", "physical_power_loss", "hostile_same_uid_isolation", "process_domain_termination", "nondefault_tenant", "remote_host"],
    };
  } catch (error) {
    failure = new Error(`engineering_smoke_failed:${stage}:${error.code ?? error.message}`);
  } finally {
    // Do not remove a live process's home if shutdown cannot be confirmed.
    try {
      const shutdown = await stopChild(fixture);
      await rm(root, { recursive: true, force: true });
      if (receipt) receipt.cleanup = { process_exit_confirmed: true, forced: shutdown.forced, scratch_removed: true };
      if (shutdown.forced && !failure) failure = new Error("engineering_smoke_failed:cleanup:forced_shutdown");
      if (interrupted && !failure) failure = new Error("engineering_smoke_failed:interrupted");
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
    if (process.argv.length > 2) throw new Error("usage: node scripts/smoke-engineering-decision.mjs");
    console.log(JSON.stringify(await runSmoke(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ schema_version: 1, status: "failed", provider_qualified: false, reason: error.message }));
    process.exitCode = 1;
  }
}
