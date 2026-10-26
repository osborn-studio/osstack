import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertCleanShutdown, fixtureEnvironment, runJsonCommand, sanitizedDiagnostic, stopChild, waitForFixtureReady,
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
  const { scratchRoot } = await import("../packages/core/dist/index.js");
  let report;
  try {
    await runJsonCommand(process.execPath, [script], {
      env: { ...process.env, OSSTACK_SCRATCH_ROOT: scratchRoot(), PATH: "/nonexistent/osstack-smoke-path" },
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
    assert.match(diagnostic.fixture_stderr, /ENOENT/);
    assert.equal(diagnostic.shutdown.exit_code, 1);
    assert.equal(existsSync(join(root, "authority.json")), false);
    assert.equal(existsSync(join(root, "observation.json")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
