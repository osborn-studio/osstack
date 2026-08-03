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

async function publicWorkspacePackages() {
  const packagesRoot = join(root, "packages");
  const entries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
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

async function registryState(name) {
  try {
    const { stdout } = await execFileAsync("npm", [
      "view",
      name,
      "version",
      "--json",
      "--registry",
      "https://registry.npmjs.org/",
    ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const version = JSON.parse(stdout);
    return typeof version === "string" && version.length > 0
      ? { name, version }
      : { name, error: "registry returned no published version" };
  } catch (error) {
    const output = [error?.stdout, error?.stderr, error?.message]
      .filter(Boolean)
      .join("\n");
    return /E404|not found/i.test(output)
      ? { name, missing: true }
      : { name, error: output.slice(0, 2_000) };
  }
}

const packages = await publicWorkspacePackages();
const states = [];
for (let index = 0; index < packages.length; index += 6) {
  states.push(...await Promise.all(packages.slice(index, index + 6).map(registryState)));
}
const missing = states.filter((state) => state.missing === true).map((state) => state.name);
const errors = states
  .filter((state) => typeof state.error === "string")
  .map((state) => ({ name: state.name, error: state.error }));
const result = {
  kind: "npm_package_bootstrap",
  ok: missing.length === 0 && errors.length === 0,
  packages,
  missing,
  errors,
};

if (json) {
  const target = result.ok ? console.log : console.error;
  target(JSON.stringify(result, null, 2));
} else if (result.ok) {
  console.log(`npm package bootstrap verified for ${packages.length} public packages`);
} else {
  if (missing.length > 0) {
    console.error(`Unpublished packages: ${missing.join(", ")}`);
    console.error("Publish the first version manually, then configure npm Trusted Publisher for release.yml.");
  }
  for (const failure of errors) {
    console.error(`${failure.name}: ${failure.error}`);
  }
}
if (!result.ok) process.exit(1);
