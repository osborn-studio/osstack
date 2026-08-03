#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function selfTest() {
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
  console.log("version-packages self-test: ok");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
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

  run(process.execPath, ["scripts/generate-inventory.mjs"]);
  run(process.execPath, ["scripts/release-facts.mjs"]);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`version-packages: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
