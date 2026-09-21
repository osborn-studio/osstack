#!/usr/bin/env node
// npm trust CLI contract: https://docs.npmjs.com/cli/v11/commands/npm-trust/
import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
if (rootFlag !== -1 && (args[rootFlag + 1] === undefined || args[rootFlag + 1].startsWith("--"))) {
  console.error("--root requires a directory path");
  process.exit(2);
}

const root = resolve(rootFlag === -1 ? process.cwd() : args[rootFlag + 1] ?? "");
const execute = args.includes("--execute");
const json = args.includes("--json");
const expectedRepository = "osborn-studio/osstack";
const expectedWorkflow = "release.yml";
const expectedAccount = "osbornhello";
const registry = "https://registry.npmjs.org/";
const delayMs = Number.parseInt(process.env.OSSTACK_NPM_TRUST_DELAY_MS ?? "2000", 10);

if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
  console.error("OSSTACK_NPM_TRUST_DELAY_MS must be a non-negative integer");
  process.exit(2);
}

async function publicWorkspacePackages() {
  const packagesRoot = join(root, "packages");
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const packages = [];
  const packageNames = new Set();
  for (const entry of entries) {
    try {
      const manifest = JSON.parse(await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"));
      if (manifest.private === true) continue;
      if (typeof manifest.name !== "string" || !isValidPackageName(manifest.name)) {
        throw new Error(`packages/${entry.name}/package.json has an invalid package name`);
      }
      if (packageNames.has(manifest.name)) {
        throw new Error(`packages/${entry.name}/package.json duplicates package name ${manifest.name}`);
      }
      packageNames.add(manifest.name);
      packages.push(manifest.name);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return packages;
}

function isValidPackageName(name) {
  if (Buffer.byteLength(name, "utf8") > 214) return false;
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name);
}

function normalizedTrust(raw) {
  if (raw.trim().length === 0) return undefined;
  const parsed = JSON.parse(raw);
  const configurations = Array.isArray(parsed) ? parsed : [parsed];
  return configurations.find((configuration) => configuration?.type === "github") ?? configurations[0];
}

function matchesExpectedTrust(configuration) {
  const permissions = Array.isArray(configuration?.permissions) ? configuration.permissions : [];
  return configuration?.repository === expectedRepository
    && configuration?.file === expectedWorkflow
    && (permissions.includes("createPackage") || permissions.includes("publish"));
}

function classifyFailure(output) {
  if (/EOTP|one-time password|auth\/cli/i.test(output)) return "fresh_2fa_required";
  if (/ENEEDAUTH|E401|not logged in|authentication/i.test(output)) return "npm_auth_required";
  return "trust_query_failed";
}

async function npmWhoami() {
  try {
    const { stdout } = await execFileAsync("npm", ["whoami", "--registry", registry], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const account = stdout.trim();
    if (account.length === 0) return { error: "npm_auth_required" };
    return { account };
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    return { error: classifyFailure(output) };
  }
}

async function trustState(name) {
  try {
    const { stdout } = await execFileAsync("npm", [
      "trust",
      "list",
      name,
      "--json",
      "--registry",
      registry,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const configuration = normalizedTrust(stdout);
    if (configuration === undefined) return { missing: true };
    if (matchesExpectedTrust(configuration)) return { configured: true };
    return {
      mismatch: {
        type: configuration.type ?? null,
        repository: configuration.repository ?? null,
        file: configuration.file ?? null,
        permissions: Array.isArray(configuration.permissions) ? configuration.permissions : [],
      },
    };
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    return { error: classifyFailure(output) };
  }
}

function configureTrust(name) {
  const commandArgs = [
    "trust",
    "github",
    name,
    "--repository",
    expectedRepository,
    "--file",
    expectedWorkflow,
    "--allow-publish",
    "--yes",
    "--registry",
    registry,
  ];
  return new Promise((resolvePromise) => {
    const child = spawn("npm", commandArgs, {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (chunk) => {
      const target = json ? process.stderr : process.stdout;
      target.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", () => resolvePromise({ ok: false, reason: "trust_command_failed" }));
    child.on("close", (code) => resolvePromise({
      ok: code === 0,
      reason: code === 0 ? undefined : "trust_command_failed",
    }));
  });
}

function wait(ms) {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function emit(result) {
  if (json) {
    const target = result.ok ? console.log : console.error;
    target(JSON.stringify(result, null, 2));
    return;
  }
  if (!execute) {
    console.log(`Plan: configure GitHub Trusted Publisher for ${result.packages.length} public packages.`);
    console.log("No registry mutation was performed. Rerun with --execute in an interactive npm-authenticated terminal.");
    return;
  }
  if (result.ok) {
    console.log(`npm Trusted Publisher configured or verified for ${result.packages.length} public packages`);
    return;
  }
  if (result.error === "npm_auth_required" || result.error === "fresh_2fa_required") {
    console.error("A fresh npm login and 2FA/web-auth session is required; no unverified package was advanced.");
  } else if (result.error === "mismatched_trust") {
    console.error(`Existing Trusted Publisher does not match and was not replaced: ${result.failed_package}`);
  } else if (result.error === "unexpected_npm_account") {
    console.error(`Expected npm account ${expectedAccount}; found ${result.account}. No trust mapping was queried or changed.`);
  } else {
    console.error(`Trusted Publisher configuration stopped at ${result.failed_package ?? "preflight"}: ${result.error}`);
  }
}

let packages;
try {
  packages = await publicWorkspacePackages();
} catch (error) {
  const message = error instanceof Error ? error.message : "unable to read public workspace packages";
  if (json) {
    console.error(JSON.stringify({
      kind: "npm_trusted_publisher_configuration",
      ok: false,
      execute,
      error: "invalid_workspace_package",
      message,
    }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(2);
}
const baseResult = {
  kind: "npm_trusted_publisher_configuration",
  ok: true,
  execute,
  expected: {
    type: "github",
    repository: expectedRepository,
    file: expectedWorkflow,
    permission: "publish",
    registry,
    account: expectedAccount,
  },
  packages,
};

if (!execute) {
  emit({
    ...baseResult,
    command: "pnpm configure:npm-trust -- --execute",
    note: "Execution audits every mapping before mutation, is idempotent, stops on the first error, and never replaces mismatched trust automatically.",
  });
  process.exit(0);
}

const authentication = await npmWhoami();
if (authentication.error !== undefined) {
  emit({ ...baseResult, ok: false, error: authentication.error, already_configured: [], configured: [] });
  process.exit(1);
}
if (authentication.account !== expectedAccount) {
  emit({
    ...baseResult,
    ok: false,
    account: authentication.account,
    error: "unexpected_npm_account",
    already_configured: [],
    configured: [],
  });
  process.exit(1);
}

const alreadyConfigured = [];
const configured = [];
const missing = [];
for (const name of packages) {
  const state = await trustState(name);
  if (state.error !== undefined) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: state.error,
      failed_package: name,
      already_configured: alreadyConfigured,
      configured,
    });
    process.exit(1);
  }
  if (state.mismatch !== undefined) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: "mismatched_trust",
      failed_package: name,
      actual: state.mismatch,
      already_configured: alreadyConfigured,
      configured,
    });
    process.exit(1);
  }
  if (state.configured === true) {
    alreadyConfigured.push(name);
    continue;
  }

  missing.push(name);
}

for (let index = 0; index < missing.length; index += 1) {
  const name = missing[index];
  const applied = await configureTrust(name);
  if (!applied.ok) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: applied.reason,
      failed_package: name,
      already_configured: alreadyConfigured,
      configured,
    });
    process.exit(1);
  }
  const verified = await trustState(name);
  if (verified.configured !== true) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: "post_configuration_verification_failed",
      failed_package: name,
      already_configured: alreadyConfigured,
      configured,
    });
    process.exit(1);
  }
  configured.push(name);
  if (index < missing.length - 1) await wait(delayMs);
}

emit({
  ...baseResult,
  account: authentication.account,
  already_configured: alreadyConfigured,
  configured,
});
