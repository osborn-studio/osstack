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

async function createRepo(root, packages) {
  for (const pkg of packages) {
    const directory = join(root, "packages", pkg.directory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: pkg.name,
      ...(pkg.private === true ? { private: true } : {}),
    }));
  }
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

const temp = await mkdtemp(join(tmpdir(), "osstack-npm-trust-configure-smoke-"));
const bin = join(temp, "bin");
await mkdir(bin);
const fakeNpm = join(bin, "npm");
await writeFile(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FIXTURE_STATE;
const logPath = process.env.FIXTURE_LOG;
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
if (args[0] === "trust" && args[1] === "list") {
  const configuration = state[args[2]];
  if (configuration) console.log(JSON.stringify(configuration));
  process.exit(0);
}
if (args[0] === "trust" && args[1] === "github") {
  fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
  const name = args[2];
  if (name === process.env.FIXTURE_FAIL_PACKAGE) {
    console.error("fixture configuration failure");
    process.exit(1);
  }
  console.log("fixture configured " + name);
  state[name] = {
    type: "github",
    repository: "osborn-studio/osstack",
    file: "release.yml",
    permissions: ["publish"],
  };
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
`);
await chmod(fakeNpm, 0o755);

const expectedTrust = {
  type: "github",
  repository: "osborn-studio/osstack",
  file: "release.yml",
  permissions: ["publish"],
};
const baseEnv = {
  PATH: `${bin}:${process.env.PATH ?? ""}`,
  OSSTACK_NPM_TRUST_DELAY_MS: "0",
  OSSTACK_NPM_TRUSTED_REPOSITORY: "attacker/repo",
  OSSTACK_NPM_TRUSTED_WORKFLOW: "attacker.yml",
};

const invalidRoot = join(temp, "invalid");
const invalidState = join(temp, "invalid-state.json");
const invalidLog = join(temp, "invalid-log.ndjson");
await createRepo(invalidRoot, [{ directory: "invalid", name: "--repository" }]);
await writeFile(invalidState, "{}");
const invalid = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  invalidRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: invalidState, FIXTURE_LOG: invalidLog } });
assert(invalid.code !== 0, "invalid package names must be rejected before npm invocation");
assert((await readLog(invalidLog)).length === 0, "invalid package names must never reach npm trust");

const duplicateRoot = join(temp, "duplicate");
const duplicateState = join(temp, "duplicate-state.json");
const duplicateLog = join(temp, "duplicate-log.ndjson");
await createRepo(duplicateRoot, [
  { directory: "one", name: "@fixture/duplicate" },
  { directory: "two", name: "@fixture/duplicate" },
]);
await writeFile(duplicateState, "{}");
const duplicate = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  duplicateRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: duplicateState, FIXTURE_LOG: duplicateLog } });
assert(duplicate.code !== 0, "duplicate package names must fail before npm invocation");
assert((await readLog(duplicateLog)).length === 0, "duplicate package names must never reach npm trust");

const happyRoot = join(temp, "happy");
const happyState = join(temp, "happy-state.json");
const happyLog = join(temp, "happy-log.ndjson");
await createRepo(happyRoot, [
  { directory: "configured", name: "@fixture/configured" },
  { directory: "missing", name: "@fixture/missing" },
  { directory: "private", name: "@fixture/private", private: true },
]);
await writeFile(happyState, JSON.stringify({ "@fixture/configured": expectedTrust }));

const plan = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  happyRoot,
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: happyState, FIXTURE_LOG: happyLog } });
assert(plan.code === 0, "plan mode must succeed without npm authentication");
const parsedPlan = JSON.parse(plan.stdout);
assert(parsedPlan.execute === false, "configuration must default to non-mutating plan mode");
assert(parsedPlan.packages.length === 2, "plan must include public packages only");
assert(parsedPlan.expected.repository === "osborn-studio/osstack", "environment must not override the repository mutation target");
assert(parsedPlan.expected.file === "release.yml", "environment must not override the workflow mutation target");
assert((await readLog(happyLog)).length === 0, "plan mode must never invoke npm trust mutation");

const applied = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  happyRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: happyState, FIXTURE_LOG: happyLog } });
assert(applied.code === 0, `execute mode must configure missing trust: ${applied.stderr}`);
const parsedApplied = JSON.parse(applied.stdout);
assert(parsedApplied.ok === true, "execute summary must report success after verification");
assert(parsedApplied.already_configured.includes("@fixture/configured"), "existing trust must be preserved");
assert(parsedApplied.configured.includes("@fixture/missing"), "missing trust must be configured");
const happyCalls = await readLog(happyLog);
assert(happyCalls.length === 1, "execute mode must mutate only the missing package");
assert(happyCalls[0].join(" ") === [
  "trust", "github", "@fixture/missing",
  "--repository", "osborn-studio/osstack",
  "--file", "release.yml",
  "--allow-publish", "--yes",
  "--registry", "https://registry.npmjs.org/",
].join(" "), "npm trust command must bind the exact repository, workflow, permission, and registry");

const repeated = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  happyRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: happyState, FIXTURE_LOG: happyLog } });
assert(repeated.code === 0, "rerun must be idempotent");
assert((await readLog(happyLog)).length === 1, "rerun must not replace correct trust mappings");

const mismatchRoot = join(temp, "mismatch");
const mismatchState = join(temp, "mismatch-state.json");
const mismatchLog = join(temp, "mismatch-log.ndjson");
await createRepo(mismatchRoot, [
  { directory: "a-missing", name: "@fixture/missing-before-mismatch" },
  { directory: "z-mismatch", name: "@fixture/mismatch" },
]);
await writeFile(mismatchState, JSON.stringify({
  "@fixture/mismatch": { ...expectedTrust, repository: "other/repo" },
}));
const mismatch = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  mismatchRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: mismatchState, FIXTURE_LOG: mismatchLog } });
assert(mismatch.code === 1, "mismatched existing trust must fail closed");
assert((await readLog(mismatchLog)).length === 0, "all mappings must be audited before any mutation when a mismatch exists");

const authRoot = join(temp, "auth");
const authState = join(temp, "auth-state.json");
const authLog = join(temp, "auth-log.ndjson");
await createRepo(authRoot, [{ directory: "auth", name: "@fixture/auth" }]);
await writeFile(authState, "{}");
const auth = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  authRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: authState, FIXTURE_LOG: authLog, FIXTURE_AUTH: "fail" } });
assert(auth.code === 1, "missing npm authentication must fail before mutation");
assert(!auth.stderr.includes("secret-auth-id"), "authentication output must redact web-auth session URLs");
assert((await readLog(authLog)).length === 0, "authentication failure must not mutate trust");

const accountLog = join(temp, "account-log.ndjson");
const account = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  authRoot,
  "--execute",
  "--json",
], {
  env: {
    ...baseEnv,
    FIXTURE_STATE: authState,
    FIXTURE_LOG: accountLog,
    FIXTURE_ACCOUNT: "wrong-owner",
  },
});
assert(account.code === 1, "an unexpected npm account must fail before trust queries or mutation");
assert((await readLog(accountLog)).length === 0, "an unexpected npm account must never mutate trust");

const foreignRoot = join(temp, "foreign");
const foreignState = join(temp, "foreign-state.json");
const foreignLog = join(temp, "foreign-log.ndjson");
await createRepo(foreignRoot, [
  { directory: "a-missing", name: "@fixture/missing-before-foreign" },
  { directory: "z-foreign", name: "@fixture/foreign" },
]);
await writeFile(foreignState, JSON.stringify({
  "@fixture/foreign": {
    type: "gitlab",
    repository: "group/project",
    file: ".gitlab-ci.yml",
    permissions: ["publish"],
  },
}));
const foreign = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  foreignRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: foreignState, FIXTURE_LOG: foreignLog } });
assert(foreign.code === 1, "a non-GitHub publisher must be treated as mismatch, not missing");
assert((await readLog(foreignLog)).length === 0, "a foreign publisher must block all mutation without automatic replacement");

const partialRoot = join(temp, "partial");
const partialState = join(temp, "partial-state.json");
const partialLog = join(temp, "partial-log.ndjson");
await createRepo(partialRoot, [
  { directory: "a", name: "@fixture/a" },
  { directory: "b", name: "@fixture/b" },
  { directory: "c", name: "@fixture/c" },
]);
await writeFile(partialState, "{}");
const partial = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  partialRoot,
  "--execute",
  "--json",
], {
  env: {
    ...baseEnv,
    FIXTURE_STATE: partialState,
    FIXTURE_LOG: partialLog,
    FIXTURE_FAIL_PACKAGE: "@fixture/b",
  },
});
assert(partial.code === 1, "configuration failure must fail the run");
const partialCalls = await readLog(partialLog);
assert(partialCalls.map((args) => args[2]).join(",") === "@fixture/a,@fixture/b", "configuration must stop at the first failure");

const resumed = await run(process.execPath, [
  "scripts/configure-npm-trusted-publishers.mjs",
  "--root",
  partialRoot,
  "--execute",
  "--json",
], { env: { ...baseEnv, FIXTURE_STATE: partialState, FIXTURE_LOG: partialLog } });
assert(resumed.code === 0, `a rerun must resume safely: ${resumed.stderr}`);
const resumedCalls = await readLog(partialLog);
assert(resumedCalls.map((args) => args[2]).join(",") === "@fixture/a,@fixture/b,@fixture/b,@fixture/c", "rerun must skip verified work and finish remaining packages");

console.log(JSON.stringify({
  ok: true,
  kind: "npm-trusted-publisher-configuration-smoke",
  checked: [
    "non-mutating default",
    "public-package discovery",
    "exact GitHub trust arguments",
    "idempotent rerun",
    "mismatch fail-closed",
    "authentication URL redaction",
    "package-name argument validation",
    "duplicate package rejection",
    "immutable repository and workflow target",
    "expected npm account binding",
    "foreign publisher mismatch refusal",
    "JSON stdout isolation",
    "first-error stop",
    "resumable completion",
  ],
}, null, 2));
