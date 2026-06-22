#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const manifestPath = requiredFlag("--manifest");
const json = args.includes("--json");

const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
const binaryPath = manifest.binary?.path;
const checksumPath = manifest.checksum_path;
if (typeof binaryPath !== "string" || binaryPath.length === 0) {
  throw new Error("manifest.binary.path is required");
}
if (typeof checksumPath !== "string" || checksumPath.length === 0) {
  throw new Error("manifest.checksum_path is required");
}

const releaseDir = dirname(manifestPath);
const binaryName = manifest.binary?.name ?? basename(binaryPath);
const manifestName = basename(manifestPath);
const checksumName = basename(checksumPath);
const sbomPath = join(releaseDir, `${binaryName}.sbom.spdx.json`);
let sbomName;
try {
  await stat(sbomPath);
  sbomName = basename(sbomPath);
} catch {
  sbomName = undefined;
}
const archiveName = `${binaryName}.tar.gz`;
const archivePath = join(releaseDir, archiveName);
const archiveManifestPath = join(releaseDir, `${binaryName}.archive.json`);
const contents = [
  binaryName,
  manifestName,
  checksumName,
  ...(sbomName === undefined ? [] : [sbomName]),
];

run("tar", [
  "-czf",
  archivePath,
  "-C",
  releaseDir,
  ...contents,
], { capture: json });

const archiveBytes = await readFile(archivePath);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const archiveStat = await stat(archivePath);
const archiveManifest = {
  schema_version: "1",
  kind: "osstack.single_binary.archive",
  package: manifest.package,
  version: manifest.version,
  platform: manifest.platform,
  arch: manifest.arch,
  generated_at: new Date().toISOString(),
  archive: {
    path: archivePath,
    name: archiveName,
    size_bytes: archiveStat.size,
    sha256: archiveSha256,
  },
  contents,
  binary: {
    name: binaryName,
    sha256: manifest.binary?.sha256,
    signed: manifest.signing?.signed === true,
    ad_hoc: manifest.signing?.ad_hoc === true,
    notarized: manifest.signing?.notarized === true,
  },
  publishing: {
    github_release_uploaded: false,
    note: "Local archive candidate only. Upload after CI, release approval, and notarization gates pass.",
  },
};
if (sbomName !== undefined) {
  archiveManifest.sbom = {
    path: sbomPath,
    name: sbomName,
    format: "SPDX-2.3",
    sha256: createHash("sha256").update(await readFile(sbomPath)).digest("hex"),
  };
}
await writeFile(archiveManifestPath, `${JSON.stringify(archiveManifest, null, 2)}\n`);

const summary = {
  ok: true,
  archive_path: archivePath,
  archive_manifest_path: archiveManifestPath,
  archive_sha256: archiveSha256,
  archive_size_bytes: archiveStat.size,
  contents: archiveManifest.contents,
  signed: archiveManifest.binary.signed,
  ad_hoc: archiveManifest.binary.ad_hoc,
  notarized: archiveManifest.binary.notarized,
  github_release_uploaded: false,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`archive=${archivePath}`);
  console.log(`archive_manifest=${archiveManifestPath}`);
  console.log(`sha256=${archiveSha256}`);
}

function requiredFlag(name) {
  const value = flagValue(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function flagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf-8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${commandArgs.join(" ")} failed with ${result.status}${output ? `\n${output}` : ""}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
