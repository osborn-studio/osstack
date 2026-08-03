#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readLog(path) {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const temp = await mkdtemp(join(tmpdir(), "osstack-npm-deprecation-smoke-"));
const bin = join(temp, "bin");
await mkdir(bin);
const fakeNpm = join(bin, "npm");
await writeFile(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FIXTURE_STATE;
const callLog = process.env.FIXTURE_CALL_LOG;
const mutationLog = process.env.FIXTURE_MUTATION_LOG;
fs.appendFileSync(callLog, JSON.stringify(args) + "\\n");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
if (args[0] === "whoami") {
  if (process.env.FIXTURE_AUTH === "fail") {
    console.error("npm error code E401");
    console.error("https://www.npmjs.com/auth/cli/secret-auth-id");
    process.exit(1);
  }
  console.log(process.env.FIXTURE_ACCOUNT || "osbornhello");
  process.exit(0);
}
if (args[0] === "view") {
  const record = state[args[1]];
  if (!record) {
    console.error("npm error code E404");
    process.exit(1);
  }
  if (record.deprecated) console.log(JSON.stringify(record));
  else console.log(JSON.stringify(record.version));
  process.exit(0);
}
if (args[0] === "deprecate") {
  fs.appendFileSync(mutationLog, JSON.stringify(args) + "\\n");
  const spec = args[1];
  if (spec === process.env.FIXTURE_FAIL_SPEC) {
    console.error("fixture deprecation failure");
    process.exit(1);
  }
  console.log("fixture deprecated " + spec);
  state[spec] = { ...state[spec], deprecated: args[2] };
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
`);
await chmod(fakeNpm, 0o755);

const cliSpec = "@osstack/cli@0.13.0";
const loopSpec = "@osstack/loop@0.13.0";
const cliMessage = "Broken release: @osstack/governance@0.13.0 was not published. Upgrade to @osstack/cli@0.13.1 or later.";
const loopMessage = "Broken release: @osstack/governance@0.13.0 was not published. Upgrade to @osstack/loop@0.13.1 or later.";
const statePath = join(temp, "state.json");
const callLog = join(temp, "calls.ndjson");
const mutationLog = join(temp, "mutations.ndjson");
const baseEnv = {
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  FIXTURE_STATE: statePath,
  FIXTURE_CALL_LOG: callLog,
  FIXTURE_MUTATION_LOG: mutationLog,
  OSSTACK_NPM_DEPRECATION_DELAY_MS: "0",
};

await writeFile(statePath, JSON.stringify({
  [cliSpec]: { version: "0.13.0" },
  [loopSpec]: { version: "0.13.0" },
}));
const plan = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--json"], { env: baseEnv });
assert(plan.code === 0, `plan mode must succeed without npm: ${plan.stderr}`);
const parsedPlan = JSON.parse(plan.stdout);
assert(parsedPlan.execute === false, "deprecation recovery must default to plan mode");
assert(parsedPlan.targets.map((target) => target.spec).join(",") === `${cliSpec},${loopSpec}`, "plan must bind exact versions only");
assert((await readLog(callLog)).length === 0, "plan mode must not invoke npm at all");

await writeFile(statePath, JSON.stringify({
  [cliSpec]: { version: "0.13.0", deprecated: cliMessage },
  [loopSpec]: { version: "0.13.0" },
}));
const applied = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], { env: baseEnv });
assert(applied.code === 0, `execute mode must deprecate only missing warnings: ${applied.stderr}`);
const parsedApplied = JSON.parse(applied.stdout);
assert(parsedApplied.already_deprecated.includes(cliSpec), "matching warning must be preserved");
assert(parsedApplied.deprecated.includes(loopSpec), "missing warning must be applied and verified");
const mutations = await readLog(mutationLog);
assert(mutations.length === 1, "execute mode must mutate only the missing warning");
assert(mutations[0].join(" ") === [
  "deprecate", loopSpec, loopMessage, "--registry", "https://registry.npmjs.org/",
].join(" "), "deprecation command must bind the exact spec, message, and registry");

const repeated = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], { env: baseEnv });
assert(repeated.code === 0, "a completed run must be idempotent");
assert((await readLog(mutationLog)).length === 1, "an idempotent rerun must not write again");

await writeFile(statePath, JSON.stringify({
  [cliSpec]: { version: "0.13.0" },
  [loopSpec]: { version: "0.13.0", deprecated: "Different existing warning" },
}));
await writeFile(mutationLog, "");
const mismatch = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], { env: baseEnv });
assert(mismatch.code === 1, "a different existing warning must fail closed");
assert((await readLog(mutationLog)).length === 0, "all warnings must be audited before any mutation");

await writeFile(statePath, JSON.stringify({
  [cliSpec]: { version: "0.13.0" },
  [loopSpec]: { version: "0.13.0" },
}));
const auth = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], {
  env: { ...baseEnv, FIXTURE_AUTH: "fail" },
});
assert(auth.code === 1, "missing npm authentication must fail before audit or mutation");
assert(!auth.stderr.includes("secret-auth-id"), "authentication session URLs must not be echoed by the wrapper");
assert((await readLog(mutationLog)).length === 0, "authentication failure must not mutate registry metadata");

const wrongAccount = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], {
  env: { ...baseEnv, FIXTURE_ACCOUNT: "wrong-owner" },
});
assert(wrongAccount.code === 1, "an unexpected npm account must fail before audit or mutation");
assert((await readLog(mutationLog)).length === 0, "the wrong account must never mutate registry metadata");

await writeFile(statePath, JSON.stringify({
  [cliSpec]: { version: "0.13.1" },
  [loopSpec]: { version: "0.13.0" },
}));
const wrongVersion = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], { env: baseEnv });
assert(wrongVersion.code === 1, "an unexpected registry version must fail closed");
assert((await readLog(mutationLog)).length === 0, "version mismatch must not mutate registry metadata");

await writeFile(statePath, JSON.stringify({
  [cliSpec]: { version: "0.13.0" },
  [loopSpec]: { version: "0.13.0" },
}));
const partial = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], {
  env: { ...baseEnv, FIXTURE_FAIL_SPEC: loopSpec },
});
assert(partial.code === 1, "a mutation failure must fail the run");
assert((await readLog(mutationLog)).map((args) => args[1]).join(",") === `${cliSpec},${loopSpec}`, "execution must stop on the first failure");

const resumed = await run(process.execPath, ["scripts/deprecate-broken-npm-versions.mjs", "--execute", "--json"], { env: baseEnv });
assert(resumed.code === 0, `a rerun must resume safely: ${resumed.stderr}`);
assert((await readLog(mutationLog)).map((args) => args[1]).join(",") === `${cliSpec},${loopSpec},${loopSpec}`, "rerun must skip verified work and finish the remaining target");

console.log(JSON.stringify({
  ok: true,
  kind: "npm-broken-version-deprecation-smoke",
  checked: [
    "non-mutating default",
    "exact target versions",
    "exact deprecation messages",
    "matching-warning preservation",
    "idempotent rerun",
    "full audit before mutation",
    "authentication URL redaction",
    "expected npm account binding",
    "registry version verification",
    "first-error stop",
    "resumable completion",
    "JSON stdout isolation",
  ],
}, null, 2));
