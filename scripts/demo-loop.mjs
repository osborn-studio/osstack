#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");

if (!existsSync(cliPath)) {
  console.error(`Missing built CLI at ${cliPath}`);
  console.error("Run: pnpm build");
  process.exit(1);
}

const requestedWorkspace = process.env["OSSTACK_LOOP_DEMO_WORKSPACE"];
const overwrite = process.env["OSSTACK_LOOP_DEMO_OVERWRITE"] === "1";
const workspace = requestedWorkspace === undefined
  ? await mkdtemp(join(tmpdir(), "osstack-loop-demo-"))
  : resolve(requestedWorkspace);

if (requestedWorkspace !== undefined) {
  if (existsSync(workspace) && readdirSync(workspace).length > 0) {
    if (!overwrite) {
      console.error(`Demo workspace is not empty: ${workspace}`);
      console.error("Set OSSTACK_LOOP_DEMO_OVERWRITE=1 to replace it.");
      process.exit(1);
    }
    await rm(workspace, { recursive: true, force: true });
  }
}

await mkdir(join(workspace, "src"), { recursive: true });
await mkdir(join(workspace, "tasks"), { recursive: true });

await writeFile(join(workspace, "package.json"), JSON.stringify({
  name: "osstack-loop-demo",
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
  "console.log('demo tests passed');",
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
  throw new Error("demo should start with a failing test, but npm test passed");
}

await runCli([
  "loop",
  "enqueue",
  "Fix add() so the demo test passes",
  "--workspace",
  workspace,
  "--capability",
  "code.test",
  "--priority",
  "90",
  "--id",
  "demo-fix-add",
]);

const loopRun = await runCli([
  "loop",
  "run",
  "--workspace",
  workspace,
  "--source",
  "task_queue",
  "--execute",
  "node fix.js",
  "--verify",
  "npm test",
  "--archive-completed",
  "--json",
]);
const summary = parseJson(loopRun.stdout);
assertCompleted(summary, "demo-fix-add", "success");

await run("npm", ["test"], { cwd: workspace });

const state = parseJson(await readFile(join(workspace, "LOOP-STATE.json"), "utf-8"));
assertCompleted(state, "demo-fix-add", "success");
const markdown = await readFile(join(workspace, "STATE.md"), "utf-8");
if (!markdown.includes("demo-fix-add - success")) {
  throw new Error(`STATE.md did not include demo success:\n${markdown}`);
}

const status = await runCli(["loop", "status", "--workspace", workspace]);
if (!status.stdout.includes("demo-fix-add - success")) {
  throw new Error(`loop status did not include demo success:\n${status.stdout}`);
}

console.log("[demo] Loop Engineering demo completed");
console.log(`[demo] workspace=${workspace}`);
console.log("[demo] inspected files:");
console.log(`  ${join(workspace, "src", "math.js")}`);
console.log(`  ${join(workspace, "STATE.md")}`);
console.log(`  ${join(workspace, "LOOP-STATE.json")}`);
console.log("[demo] rerun final check:");
console.log(`  cd ${shellQuote(workspace)} && npm test`);

async function runCli(args) {
  return await run(process.execPath, [cliPath, ...args], { cwd: repoRoot });
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

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
