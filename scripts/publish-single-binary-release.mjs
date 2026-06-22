#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const archiveManifestPath = requiredFlag("--archive-manifest");
const tag = requiredFlag("--tag");
const repo = flagValue("--repo") ?? process.env.GITHUB_REPOSITORY;
const title = flagValue("--title") ?? tag;
const notes = flagValue("--notes") ?? "osstack single-binary release asset";
const dryRun = args.includes("--dry-run");
const json = args.includes("--json");

if (!dryRun && (typeof repo !== "string" || repo.length === 0)) {
  throw new Error("--repo or GITHUB_REPOSITORY is required when not using --dry-run");
}

const archiveManifest = JSON.parse(await readFile(archiveManifestPath, "utf-8"));
if (archiveManifest.kind !== "osstack.single_binary.archive") {
  throw new Error(`unexpected archive manifest kind: ${archiveManifest.kind}`);
}
const archivePath = archiveManifest.archive?.path;
if (typeof archivePath !== "string" || archivePath.length === 0) {
  throw new Error("archive.path is required");
}

const archiveBytes = await readFile(archivePath);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
if (archiveSha256 !== archiveManifest.archive?.sha256) {
  throw new Error("archive sha256 mismatch");
}
await stat(archivePath);

const releaseDir = dirname(archiveManifestPath);
const assets = [
  archivePath,
  archiveManifestPath,
  join(releaseDir, "sha256sums.txt"),
].filter(Boolean);
for (const asset of assets) {
  await stat(asset);
}

if (!dryRun) {
  const releaseView = run("gh", ["release", "view", tag, "--repo", repo], { allowFailure: true, capture: true });
  if (releaseView.status !== 0) {
    run("gh", ["release", "create", tag, "--repo", repo, "--title", title, "--notes", notes], { capture: json });
  }
  run("gh", ["release", "upload", tag, ...assets, "--repo", repo, "--clobber"], { capture: json });
  archiveManifest.publishing = {
    ...(archiveManifest.publishing ?? {}),
    github_release_uploaded: true,
    github_release_tag: tag,
    github_release_repo: repo,
    uploaded_at: new Date().toISOString(),
    uploaded_assets: assets,
  };
  await writeFile(archiveManifestPath, `${JSON.stringify(archiveManifest, null, 2)}\n`);
}

const summary = {
  ok: true,
  dry_run: dryRun,
  tag,
  repo: repo ?? null,
  archive_path: archivePath,
  archive_manifest_path: archiveManifestPath,
  archive_sha256: archiveSha256,
  assets,
  github_release_uploaded: dryRun ? false : true,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`dry_run=${dryRun ? "true" : "false"}`);
  console.log(`tag=${tag}`);
  console.log(`archive=${archivePath}`);
  for (const asset of assets) console.log(`asset=${asset}`);
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
  if (result.status !== 0 && options.allowFailure !== true) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${commandArgs.join(" ")} failed with ${result.status}${output ? `\n${output}` : ""}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
