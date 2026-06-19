#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");

if (!existsSync(cliPath)) {
  console.error(`Missing built CLI at ${cliPath}`);
  console.error("Run: pnpm build");
  process.exit(1);
}

const requestedWorkspace = process.env["OSSTACK_LOOP_DAEMON_DEMO_WORKSPACE"];
const overwrite = process.env["OSSTACK_LOOP_DAEMON_DEMO_OVERWRITE"] === "1";
const base = requestedWorkspace === undefined
  ? await mkdtemp(join(tmpdir(), "osstack-loop-daemon-demo-"))
  : resolve(requestedWorkspace);
const workspace = requestedWorkspace === undefined ? join(base, "workspace") : base;

if (requestedWorkspace !== undefined && existsSync(workspace) && readdirSync(workspace).length > 0) {
  if (!overwrite) {
    console.error(`Daemon demo workspace is not empty: ${workspace}`);
    console.error("Set OSSTACK_LOOP_DAEMON_DEMO_OVERWRITE=1 to replace it.");
    process.exit(1);
  }
  await rm(workspace, { recursive: true, force: true });
}

await mkdir(join(workspace, "src"), { recursive: true });
await mkdir(join(workspace, "tasks"), { recursive: true });

await writeFile(join(workspace, "package.json"), JSON.stringify({
  name: "osstack-loop-daemon-demo",
  private: true,
  type: "commonjs",
  scripts: {
    test: "node test.js",
  },
}, null, 2) + "\n", "utf-8");

await writeFile(join(workspace, "src", "math.js"), [
  "function add(a, b) {",
  "  return a - b;",
  "}",
  "",
  "module.exports = { add };",
  "",
].join("\n"), "utf-8");

await writeFile(join(workspace, "test.js"), [
  "const assert = require('node:assert/strict');",
  "const { add } = require('./src/math.js');",
  "",
  "assert.equal(add(2, 3), 5);",
  "console.log('daemon demo tests passed');",
  "",
].join("\n"), "utf-8");

await writeFile(join(workspace, "fix.js"), [
  "const { writeFileSync } = require('node:fs');",
  "",
  "writeFileSync('src/math.js', [",
  "  'function add(a, b) {',",
  "  '  return a + b;',",
  "  '}',",
  "  '',",
  "  'module.exports = { add };',",
  "  '',",
  "].join('\\n'));",
  "",
].join("\n"), "utf-8");

const initial = await run("npm", ["test"], { cwd: workspace, reject: false });
if (initial.code === 0) {
  throw new Error("daemon demo should start with a failing test, but npm test passed");
}

const socketPath = join(tmpdir(), `osstack-loop-daemon-${process.pid}.sock`);
const daemonEnv = {
  OSSTACK_HOME: join(base, ".osstack-daemon-demo"),
  OSSTACK_SOCKET: socketPath,
};

let daemon;
try {
  daemon = await startDaemonProcess(daemonEnv);
  await runCli(["health"], { env: daemonEnv });

  await runCli([
    "loop",
    "enqueue",
    "Fix add() so the daemon-managed demo test passes",
    "--workspace",
    workspace,
    "--capability",
    "code.test",
    "--priority",
    "90",
    "--id",
    "daemon-demo-fix-add",
  ], { env: daemonEnv });

  const start = await runCli([
    "loop",
    "start",
    "--workspace",
    workspace,
    "--source",
    "task_queue",
    "--execute",
    "node fix.js",
    "--verify",
    "npm test",
    "--archive-completed",
    "--once",
    "--interval-ms",
    "25",
    "--json",
  ], { env: daemonEnv });

  const started = parseJson(start.stdout);
  if (typeof started.loop_session_id !== "string") {
    throw new Error(`expected daemon loop_session_id, got ${JSON.stringify(started)}`);
  }

  const session = await waitForLoopSession(started.loop_session_id, daemonEnv, (candidate) => (
    candidate.status === "stopped" && candidate.executed_task_count === 1
  ));
  if (
    session.successful_task_count !== 1
    || session.failed_task_count !== 0
    || session.stop_reason !== "max cycles reached"
  ) {
    throw new Error(`unexpected daemon loop session: ${JSON.stringify(session)}`);
  }

  await run("npm", ["test"], { cwd: workspace });

  const state = parseJson(await readFile(join(workspace, "LOOP-STATE.json"), "utf-8"));
  assertCompleted(state, "daemon-demo-fix-add", "success");
  const markdown = await readFile(join(workspace, "STATE.md"), "utf-8");
  assertIncludes(markdown, "daemon-demo-fix-add - success", "STATE.md should include daemon demo success");

  const status = await runCli(["loop", "status", "--daemon", "--workspace", workspace], { env: daemonEnv });
  assertIncludes(status.stdout, "daemon-demo-fix-add - success", "daemon loop status should include demo success");
  const stats = await runCli(["stats"], { env: daemonEnv });
  assertIncludes(stats.stdout, "loop_sessions=1", "daemon stats should include the demo session");
  assertIncludes(stats.stdout, "executed=1", "daemon stats should include the executed demo task");
  assertIncludes(stats.stdout, "ok=1", "daemon stats should include the successful demo task");

  console.log("[demo:daemon] Loop Engineering daemon demo completed");
  console.log(`[demo:daemon] workspace=${workspace}`);
  console.log(`[demo:daemon] osstack_home=${daemonEnv.OSSTACK_HOME}`);
  console.log(`[demo:daemon] loop_session_id=${started.loop_session_id}`);
  console.log("[demo:daemon] inspected files:");
  console.log(`  ${join(workspace, "src", "math.js")}`);
  console.log(`  ${join(workspace, "STATE.md")}`);
  console.log(`  ${join(workspace, "LOOP-STATE.json")}`);
  console.log("[demo:daemon] rerun final check:");
  console.log(`  cd ${shellQuote(workspace)} && npm test`);
} finally {
  await daemon?.stop();
  await rm(socketPath, { force: true });
}

async function startDaemonProcess(env) {
  const child = spawn(process.execPath, [cliPath, "serve"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8");
  });

  try {
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(`daemon exited early with ${child.exitCode}\n${stdout.trim()}\n${stderr.trim()}`);
      }
      return stdout.includes("osstack daemon listening") || existsSync(env.OSSTACK_SOCKET);
    }, 5_000, "daemon did not become ready");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      try {
        await waitFor(
          () => child.exitCode !== null || child.signalCode !== null,
          5_000,
          "daemon did not stop after SIGTERM",
        );
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }
    },
  };
}

async function waitForLoopSession(loopSessionId, env, predicate) {
  let last;
  await waitFor(async () => {
    const list = await runCli(["loop", "list", "--json"], { env });
    const result = parseJson(list.stdout);
    if (!Array.isArray(result.loops)) {
      throw new Error(`expected daemon loop list, got ${JSON.stringify(result)}`);
    }
    last = result.loops.find((loop) => loop.loop_session_id === loopSessionId);
    return last !== undefined && predicate(last);
  }, 8_000, () => `loop session did not reach expected state: ${JSON.stringify(last)}`);
  return last;
}

async function runCli(args, options = {}) {
  return await run(process.execPath, [cliPath, ...args], { cwd: repoRoot, ...options });
}

async function run(command, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      clearTimeout(timeout);
      const result = { code, stdout, stderr };
      if (code === 0 || options.reject === false) {
        resolvePromise(result);
      } else {
        rejectPromise(new Error([
          `${command} ${args.join(" ")} failed with exit ${code}`,
          stdout.trim(),
          stderr.trim(),
        ].filter(Boolean).join("\n")));
      }
    });
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
      if (error.message?.includes("expected daemon loop list")) throw error;
    }
    await sleep(25);
  }
  const rendered = typeof message === "function" ? message() : message;
  if (lastError !== undefined) {
    throw new Error(`${rendered}\nlast error: ${lastError.message}`);
  }
  throw new Error(rendered);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`expected JSON output, got:\n${value}\n${error.message}`);
  }
}

function assertCompleted(value, taskId, outcome) {
  const tasks = value.completed_tasks;
  if (!Array.isArray(tasks)) {
    throw new Error("expected completed_tasks array");
  }
  const task = tasks.find((candidate) => candidate.task_id === taskId);
  if (task?.outcome !== outcome) {
    throw new Error(`expected ${taskId} outcome=${outcome}, got ${JSON.stringify(task)}`);
  }
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)} in ${JSON.stringify(value)}`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
