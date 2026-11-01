#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScratchDir } from "./lib/scratch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const READMES = ["README.md", "README.zh.md"];
const VERSION_PATTERN = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";

export function syncReadmeVersion(text, version) {
  if (!new RegExp(`^${VERSION_PATTERN}$`).test(version)) {
    throw new Error(`invalid CLI version: ${version}`);
  }

  let packageReferences = 0;
  let versionSamples = 0;
  const withPackageReferences = text.replace(
    new RegExp(`@osstack/cli@${VERSION_PATTERN}`, "g"),
    () => {
      packageReferences += 1;
      return `@osstack/cli@${version}`;
    },
  );
  const updated = withPackageReferences.replace(
    new RegExp(`^osstack ${VERSION_PATTERN}$`, "gm"),
    () => {
      versionSamples += 1;
      return `osstack ${version}`;
    },
  );

  return { text: updated, packageReferences, versionSamples };
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

async function selfTest() {
  const source = [
    "Published: `@osstack/cli@1.2.3`",
    "osstack 1.2.3",
    "osstack-0.8.1-darwin-arm64",
    "https://example.test/releases/tag/v0.8.1",
    "",
  ].join("\n");
  const result = syncReadmeVersion(source, "2.0.0");
  if (result.packageReferences !== 1 || result.versionSamples !== 1) {
    throw new Error("self-test failed to count npm release references");
  }
  if (!result.text.includes("@osstack/cli@2.0.0") || !result.text.includes("osstack 2.0.0")) {
    throw new Error("self-test failed to synchronize npm release references");
  }
  if (!result.text.includes("osstack-0.8.1-darwin-arm64") || !result.text.includes("/releases/tag/v0.8.1")) {
    throw new Error("self-test changed the independent single-binary channel");
  }
  const root = await createScratchDir("smoke", "version-packages");
  try {
    // A missing dist/, a partial one kept alive by an ignored file, and one without build info.
    for (const [name, files] of [["missing", ["tsconfig.tsbuildinfo"]], ["partial", ["tsconfig.tsbuildinfo", "dist/.npmignore"]], ["plain", ["dist/index.js"]]]) {
      for (const file of files) { mkdirSync(dirname(join(root, "packages", name, file)), { recursive: true }); writeFileSync(join(root, "packages", name, file), ""); }
    }
    const dropped = dropBuildInfo(root);
    if (dropped.join() !== "missing,partial" || existsSync(join(root, "packages/partial/tsconfig.tsbuildinfo")) || !existsSync(join(root, "packages/plain/dist/index.js"))) {
      throw new Error("self-test failed to drop every package's build info");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("version-packages self-test: ok");
}

/** A gitignored tsbuildinfo survives that reset while dist/ is deleted or left partial (ignored files such as
 * dist/.npmignore keep the directory), and tsc would then emit nothing. Drop all of it so the build is full. */
export function dropBuildInfo(root = ROOT) {
  const dropped = [];
  for (const name of readdirSync(join(root, "packages"))) {
    const info = join(root, "packages", name, "tsconfig.tsbuildinfo");
    if (existsSync(info)) { rmSync(info); dropped.push(name); }
  }
  return dropped.sort();
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  run("pnpm", ["changeset", "version"]);
  const version = JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")).version;
  for (const name of READMES) {
    const path = join(ROOT, name);
    const result = syncReadmeVersion(readFileSync(path, "utf8"), version);
    if (result.packageReferences === 0 || result.versionSamples === 0) {
      throw new Error(`${name} is missing the canonical npm version references`);
    }
    writeFileSync(path, result.text, "utf8");
  }

  // The inventory runs the built CLI. Rebuild it and its workspace dependencies here: the
  // Changesets action checks out the old release branch and hard-resets it to main, which
  // deletes any dist/ that branch still tracked (packages/knowledge/dist, untracked since #331).
  dropBuildInfo();
  run("pnpm", ["--filter", "@osstack/cli...", "build"]);
  run(process.execPath, ["scripts/generate-inventory.mjs"]);
  run(process.execPath, ["scripts/release-facts.mjs"]);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`version-packages: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
