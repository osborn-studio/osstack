#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-binary-release-publish-smoke-"));
const releaseDir = join(tempRoot, "release");

try {
  const build = JSON.parse(run(process.execPath, [
    "scripts/build-single-binary.mjs",
    "--output-dir",
    releaseDir,
    "--json",
  ], { cwd: root, capture: true }).stdout);
  run(process.execPath, [
    "scripts/sign-single-binary.mjs",
    "--manifest",
    build.manifest_path,
    "--identity",
    "-",
    "--json",
  ], { cwd: root, capture: true });
  run(process.execPath, [
    "scripts/generate-single-binary-sbom.mjs",
    "--manifest",
    build.manifest_path,
    "--json",
  ], { cwd: root, capture: true });
  const packed = JSON.parse(run(process.execPath, [
    "scripts/package-single-binary.mjs",
    "--manifest",
    build.manifest_path,
    "--json",
  ], { cwd: root, capture: true }).stdout);
  const publish = JSON.parse(run(process.execPath, [
    "scripts/publish-single-binary-release.mjs",
    "--archive-manifest",
    packed.archive_manifest_path,
    "--tag",
    `v${build.version}`,
    "--repo",
    "gilosbornhello/osstack",
    "--dry-run",
    "--json",
  ], { cwd: root, capture: true }).stdout);
  const adHocDryRun = JSON.parse(run(process.execPath, [
    "scripts/publish-single-binary-release.mjs",
    "--archive-manifest",
    packed.archive_manifest_path,
    "--tag",
    `v${build.version}-adhoc-publish-smoke`,
    "--repo",
    "gilosbornhello/osstack",
    "--allow-ad-hoc",
    "--dry-run",
    "--json",
  ], { cwd: root, capture: true }).stdout);

  if (publish.dry_run !== true || publish.github_release_uploaded !== false) {
    throw new Error(`dry-run publish summary must not claim upload: ${JSON.stringify(publish)}`);
  }
  if (adHocDryRun.dry_run !== true || adHocDryRun.github_release_uploaded !== false || adHocDryRun.release_channel !== "dry-run") {
    throw new Error(`ad-hoc dry-run publish summary must stay a dry run: ${JSON.stringify(adHocDryRun)}`);
  }
  if (!Array.isArray(publish.assets) || publish.assets.length !== 4) {
    throw new Error(`dry-run publish must include four assets: ${JSON.stringify(publish.assets)}`);
  }
  const archiveManifest = JSON.parse(await readFile(packed.archive_manifest_path, "utf-8"));
  if (archiveManifest.publishing?.github_release_uploaded !== false) {
    throw new Error("dry-run publish must not mutate archive manifest upload state");
  }
  const blockedPublicUpload = runAllowFailure(process.execPath, [
    "scripts/publish-single-binary-release.mjs",
    "--archive-manifest",
    packed.archive_manifest_path,
    "--tag",
    `v${build.version}-publish-smoke`,
    "--repo",
    "osstack-invalid/publish-smoke",
    "--json",
  ], { cwd: root, capture: true });
  if (blockedPublicUpload.status === 0) {
    throw new Error("public publish must reject ad-hoc or non-notarized archive candidates");
  }
  const blockedOutput = [blockedPublicUpload.stdout, blockedPublicUpload.stderr].filter(Boolean).join("\n");
  if (!blockedOutput.includes("--allow-ad-hoc")) {
    throw new Error(`public publish rejection must explain explicit ad-hoc release option: ${blockedOutput}`);
  }

  console.log(JSON.stringify({
    ok: true,
    kind: "single-binary-release-publish-smoke",
    dry_run: publish.dry_run,
    tag: publish.tag,
    repo: publish.repo,
    assets: publish.assets,
    ad_hoc_dry_run: adHocDryRun.release_channel,
    github_release_uploaded: publish.github_release_uploaded,
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_BINARY_RELEASE_PUBLISH_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept release publish smoke dir: ${tempRoot}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}${output ? `\n${output}` : ""}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runAllowFailure(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
