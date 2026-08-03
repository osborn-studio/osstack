#!/usr/bin/env node
import { execFile } from "node:child_process";
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
const json = args.includes("--json");
const expectedRepository = process.env.OSSTACK_NPM_TRUSTED_REPOSITORY ?? "gilosbornhello/osstack";
const expectedWorkflow = process.env.OSSTACK_NPM_TRUSTED_WORKFLOW ?? "release.yml";

async function publicWorkspacePackages() {
  const packagesRoot = join(root, "packages");
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  const packages = [];
  for (const entry of entries) {
    try {
      const manifest = JSON.parse(await readFile(join(packagesRoot, entry.name, "package.json"), "utf8"));
      if (manifest.private === true) continue;
      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        throw new Error(`packages/${entry.name}/package.json has no package name`);
      }
      packages.push(manifest.name);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  return packages;
}

function normalizedTrust(raw) {
  if (raw.trim().length === 0) return undefined;
  const parsed = JSON.parse(raw);
  const configurations = Array.isArray(parsed) ? parsed : [parsed];
  return configurations.find((configuration) => configuration?.type === "github");
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

async function trustState(name) {
  try {
    const { stdout } = await execFileAsync("npm", [
      "trust",
      "list",
      name,
      "--json",
      "--registry",
      "https://registry.npmjs.org/",
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const configuration = normalizedTrust(stdout);
    if (configuration === undefined) return { name, missing: true };
    if (!matchesExpectedTrust(configuration)) {
      return {
        name,
        mismatch: {
          type: configuration.type ?? null,
          repository: configuration.repository ?? null,
          file: configuration.file ?? null,
          permissions: Array.isArray(configuration.permissions) ? configuration.permissions : [],
        },
      };
    }
    return { name, configured: true };
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    return { name, error: classifyFailure(output) };
  }
}

const packages = await publicWorkspacePackages();
const states = [];
for (const name of packages) {
  const state = await trustState(name);
  states.push(state);
  if (state.error !== undefined) break;
}
const configured = states.filter((state) => state.configured === true).map((state) => state.name);
const missing = states.filter((state) => state.missing === true).map((state) => state.name);
const mismatched = states
  .filter((state) => state.mismatch !== undefined)
  .map((state) => ({ name: state.name, actual: state.mismatch }));
const errors = states
  .filter((state) => state.error !== undefined)
  .map((state) => ({ name: state.name, reason: state.error }));
const authenticationRequired = errors.some((error) =>
  error.reason === "fresh_2fa_required" || error.reason === "npm_auth_required"
);
const result = {
  kind: "npm_trusted_publishers",
  ok: configured.length === packages.length,
  expected: {
    type: "github",
    repository: expectedRepository,
    file: expectedWorkflow,
    permission: "publish",
  },
  packages,
  configured,
  missing,
  mismatched,
  authentication_required: authenticationRequired,
  errors,
};

if (json) {
  const target = result.ok ? console.log : console.error;
  target(JSON.stringify(result, null, 2));
} else if (result.ok) {
  console.log(`npm Trusted Publisher verified for ${configured.length} public packages`);
} else {
  if (authenticationRequired) {
    console.error("npm trust verification requires a fresh npm 2FA/web-auth session; rerun this command in an interactive terminal.");
  }
  if (missing.length > 0) console.error(`Missing Trusted Publisher: ${missing.join(", ")}`);
  for (const mismatch of mismatched) {
    console.error(`Mismatched Trusted Publisher: ${mismatch.name}`);
  }
  for (const error of errors.filter((item) => !["fresh_2fa_required", "npm_auth_required"].includes(item.reason))) {
    console.error(`${error.name}: ${error.reason}`);
  }
}
if (!result.ok) process.exit(1);
