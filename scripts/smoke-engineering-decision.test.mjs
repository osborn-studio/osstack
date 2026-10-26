import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  fixtureEnvironment, runJsonCommand, stopChild, waitForFixtureReady,
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
