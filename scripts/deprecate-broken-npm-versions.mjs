#!/usr/bin/env node
// npm deprecate contract: https://docs.npmjs.com/cli/v11/commands/npm-deprecate/
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const json = args.includes("--json");
const expectedAccount = "osbornhello";
const registry = "https://registry.npmjs.org/";
const delayMs = Number.parseInt(process.env.OSSTACK_NPM_DEPRECATION_DELAY_MS ?? "2000", 10);
const targets = [
  {
    spec: "@osstack/cli@0.13.0",
    version: "0.13.0",
    message: "Broken release: @osstack/governance@0.13.0 was not published. Upgrade to @osstack/cli@0.13.1 or later.",
  },
  {
    spec: "@osstack/loop@0.13.0",
    version: "0.13.0",
    message: "Broken release: @osstack/governance@0.13.0 was not published. Upgrade to @osstack/loop@0.13.1 or later.",
  },
];

if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
  console.error("OSSTACK_NPM_DEPRECATION_DELAY_MS must be a non-negative integer");
  process.exit(2);
}

function classifyFailure(output) {
  if (/EOTP|one-time password|auth\/cli/i.test(output)) return "fresh_2fa_required";
  if (/ENEEDAUTH|E401|not logged in|authentication/i.test(output)) return "npm_auth_required";
  if (/E404|not found/i.test(output)) return "registry_version_unavailable";
  return "registry_query_failed";
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

function normalizedMetadata(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed === "string") return { version: parsed };
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return {
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      deprecated: typeof parsed.deprecated === "string" ? parsed.deprecated : undefined,
    };
  }
  return {};
}

async function deprecationState(target) {
  try {
    const { stdout } = await execFileAsync("npm", [
      "view",
      target.spec,
      "version",
      "deprecated",
      "--json",
      "--registry",
      registry,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const metadata = normalizedMetadata(stdout);
    if (metadata.version !== target.version) {
      return { error: "registry_version_mismatch", actual_version: metadata.version ?? null };
    }
    if (metadata.deprecated === target.message) return { configured: true };
    if (metadata.deprecated !== undefined && metadata.deprecated.length > 0) {
      return { mismatch: metadata.deprecated };
    }
    return { missing: true };
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    return { error: classifyFailure(output) };
  }
}

function applyDeprecation(target) {
  const commandArgs = ["deprecate", target.spec, target.message, "--registry", registry];
  return new Promise((resolvePromise) => {
    const child = spawn("npm", commandArgs, {
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (chunk) => {
      const output = json ? process.stderr : process.stdout;
      output.write(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", () => resolvePromise({ ok: false }));
    child.on("close", (code) => resolvePromise({ ok: code === 0 }));
  });
}

function wait(ms) {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function emit(result) {
  if (json) {
    const output = result.ok ? console.log : console.error;
    output(JSON.stringify(result, null, 2));
    return;
  }
  if (!execute) {
    console.log(`Plan: deprecate ${result.targets.length} known-broken exact npm versions.`);
    console.log("No registry query or mutation was performed. Rerun with --execute in an interactive npm-authenticated terminal.");
    return;
  }
  if (result.ok) {
    console.log(`Verified deprecation warnings for ${result.targets.length} exact npm versions`);
    return;
  }
  if (result.error === "npm_auth_required" || result.error === "fresh_2fa_required") {
    console.error("A fresh npm login and 2FA/web-auth session is required; no unverified target was advanced.");
  } else if (result.error === "mismatched_deprecation") {
    console.error(`An existing deprecation warning differs and was not replaced: ${result.failed_spec}`);
  } else if (result.error === "unexpected_npm_account") {
    console.error(`Expected npm account ${expectedAccount}; found ${result.account}. No package metadata was queried or changed.`);
  } else {
    console.error(`npm deprecation recovery stopped at ${result.failed_spec ?? "preflight"}: ${result.error}`);
  }
}

const baseResult = {
  kind: "npm_broken_version_deprecation",
  ok: true,
  execute,
  expected_account: expectedAccount,
  registry,
  targets,
};

if (!execute) {
  emit({
    ...baseResult,
    command: "pnpm deprecate:npm-broken -- --execute",
    note: "Execution audits every exact version before mutation, preserves matching warnings, refuses to replace mismatches, verifies each write, and can be rerun safely.",
  });
  process.exit(0);
}

const authentication = await npmWhoami();
if (authentication.error !== undefined) {
  emit({ ...baseResult, ok: false, error: authentication.error, already_deprecated: [], deprecated: [] });
  process.exit(1);
}
if (authentication.account !== expectedAccount) {
  emit({
    ...baseResult,
    ok: false,
    account: authentication.account,
    error: "unexpected_npm_account",
    already_deprecated: [],
    deprecated: [],
  });
  process.exit(1);
}

const alreadyDeprecated = [];
const deprecated = [];
const missing = [];
for (const target of targets) {
  const state = await deprecationState(target);
  if (state.error !== undefined) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: state.error,
      failed_spec: target.spec,
      actual_version: state.actual_version,
      already_deprecated: alreadyDeprecated,
      deprecated,
    });
    process.exit(1);
  }
  if (state.mismatch !== undefined) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: "mismatched_deprecation",
      failed_spec: target.spec,
      actual_message: state.mismatch,
      already_deprecated: alreadyDeprecated,
      deprecated,
    });
    process.exit(1);
  }
  if (state.configured === true) {
    alreadyDeprecated.push(target.spec);
  } else {
    missing.push(target);
  }
}

for (let index = 0; index < missing.length; index += 1) {
  const target = missing[index];
  const applied = await applyDeprecation(target);
  if (!applied.ok) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: "deprecation_command_failed",
      failed_spec: target.spec,
      already_deprecated: alreadyDeprecated,
      deprecated,
    });
    process.exit(1);
  }
  const verified = await deprecationState(target);
  if (verified.configured !== true) {
    emit({
      ...baseResult,
      ok: false,
      account: authentication.account,
      error: "post_deprecation_verification_failed",
      failed_spec: target.spec,
      already_deprecated: alreadyDeprecated,
      deprecated,
    });
    process.exit(1);
  }
  deprecated.push(target.spec);
  if (index < missing.length - 1) await wait(delayMs);
}

emit({
  ...baseResult,
  account: authentication.account,
  already_deprecated: alreadyDeprecated,
  deprecated,
});
