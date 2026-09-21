// Build the CLI first. All calls use a synthetic fetch and an isolated home.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  rmdir,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "osstack-decision-smoke-"));
const cli = fileURLToPath(
  new URL("../packages/cli/dist/bin.js", import.meta.url),
);
const preload = join(root, "fake-provider.mjs");
const dispatches = join(root, "dispatches");
await writeFile(
  preload,
  `
import { appendFile } from 'node:fs/promises';
globalThis.fetch = async (url, options) => {
  if (url !== 'https://api.typesafe.ai/v1/systemone') throw Error('unexpected endpoint');
  const request = JSON.parse(options.body);
  await appendFile(process.env.DECISION_SMOKE_DISPATCHES, 'dispatch\\n');
  if (process.env.DECISION_SMOKE_STALL) await new Promise(() => {});
  await new Promise(resolve => setTimeout(resolve, 250));
  return new Response(JSON.stringify({model: request.model, answers:{decision:{type:'choice',choice:'assertion',confidence:1,
    probabilities:Object.fromEntries(Object.keys(request.questions.decision.criteria).map(k=>[k,k==='assertion'?1:0]))}},
    usage:{input_tokens:100,output_tokens:1}}));
};
`,
);
const baseEnv = {
  ...process.env,
  OSSTACK_HOME: join(root, "isolated-home"),
  TYPESAFE_API_KEY: "synthetic-test-key",
  DECISION_SMOKE_DISPATCHES: dispatches,
};
function run(args, extra = {}) {
  const child = spawn(
    process.execPath,
    ["--import", preload, cli, "decision", ...args],
    { env: { ...baseEnv, ...extra }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, done };
}
async function count() {
  try {
    return (await readFile(dispatches, "utf8")).trim().split("\n").length;
  } catch {
    return 0;
  }
}
async function until(test) {
  for (let i = 0; i < 200; i++) {
    if (await test()) return;
    await delay(25);
  }
  throw Error("timed out waiting for child dispatch");
}
try {
  const input = join(root, "input.json");
  await writeFile(
    input,
    JSON.stringify({
      schemaVersion: 1,
      scopeId: "smoke",
      taskId: "t",
      taskRevision: 0,
      purpose: "failure_label",
      state: "test assertion failure",
    }),
  );
  assert.equal((await run(["advise", "--input", input]).done).code, 0);
  assert.equal(await count(), 0, "dry-run must never dispatch");
  const store = join(root, "budget");
  assert.equal(
    (await run(["init", "--store", store, "--scope", "smoke"]).done).code,
    0,
  );
  const args = ["advise", "--input", input, "--live", "--store", store];
  const results = await Promise.all(
    Array.from({ length: 6 }, () => run(args).done),
  );
  assert(results.some((result) => result.code === 0));
  assert(
    results.every(
      (result) =>
        result.code === 0 ||
        (result.code === 1 && result.stdout.includes("DECISION_STORE_BUSY")),
    ),
    JSON.stringify(results),
  );
  assert.equal(
    await count(),
    1,
    "concurrent processes must dispatch exactly once",
  );
  assert.equal((await run(args).done).code, 0);
  assert.equal(await count(), 1, "completed replay must not dispatch");
  const crashedStore = join(root, "crashed");
  assert.equal(
    (await run(["init", "--store", crashedStore, "--scope", "smoke"]).done)
      .code,
    0,
  );
  const crashArgs = [
    "advise",
    "--input",
    input,
    "--live",
    "--store",
    crashedStore,
  ];
  const stalled = run(crashArgs, { DECISION_SMOKE_STALL: "1" });
  await until(async () => (await count()) === 2);
  stalled.child.kill("SIGKILL");
  await stalled.done;
  const blocked = await run(crashArgs).done;
  assert.equal(blocked.code, 1);
  assert(blocked.stdout.includes("DECISION_STORE_BUSY"));
  // Simulate operator recovery only after the dead child is reaped. Never delete records.
  await rmdir(join(crashedStore, ".lock"));
  const recovered = await run(crashArgs).done;
  assert.equal(recovered.code, 2);
  assert(recovered.stdout.includes('"status":"dispatched"'));
  assert.equal(
    await count(),
    2,
    "crash recovery must not resend an unknown outcome",
  );
  const status = JSON.parse(
    (await run(["status", "--store", crashedStore]).done).stdout,
  );
  assert.equal(status.chargedOrHeldMicroUSD, 2753);
  assert.equal(status.unknown, 1);
  assert(
    !(await readdir(root)).includes("isolated-home"),
    "decision commands must not open a control-plane home",
  );
  console.log(
    "PASS: offline, concurrent dispatch, settled replay, SIGKILL, sticky lock and unknown hold; zero real network calls",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
