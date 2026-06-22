#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-binary-release-pack-smoke-"));
const releaseDir = join(tempRoot, "release");
const extractDir = join(tempRoot, "extract");

try {
  const build = JSON.parse(run(process.execPath, [
    "scripts/build-single-binary.mjs",
    "--output-dir",
    releaseDir,
    "--json",
  ], { cwd: root, capture: true }).stdout);
  const signed = JSON.parse(run(process.execPath, [
    "scripts/sign-single-binary.mjs",
    "--manifest",
    build.manifest_path,
    "--identity",
    "-",
    "--json",
  ], { cwd: root, capture: true }).stdout);
  const sbom = JSON.parse(run(process.execPath, [
    "scripts/generate-single-binary-sbom.mjs",
    "--manifest",
    build.manifest_path,
    "--json",
  ], { cwd: root, capture: true }).stdout);
  const packed = JSON.parse(run(process.execPath, [
    "scripts/package-single-binary.mjs",
    "--manifest",
    build.manifest_path,
    "--json",
  ], { cwd: root, capture: true }).stdout);
  const releaseDoctor = JSON.parse(run(process.execPath, [
    "packages/cli/dist/bin.js",
    "release",
    "doctor",
    "--target",
    "single-binary",
    "--json",
  ], {
    cwd: root,
    capture: true,
    env: singleBinaryReleaseDoctorEnv(),
  }).stdout);

  const archiveBytes = await readFile(packed.archive_path);
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  if (archiveSha256 !== packed.archive_sha256) {
    throw new Error("archive sha256 mismatch");
  }

  const listing = run("tar", ["-tzf", packed.archive_path], { cwd: root, capture: true }).stdout;
  for (const required of [
    basename(build.binary_path),
    basename(build.manifest_path),
    basename(build.checksum_path),
    basename(sbom.sbom_path),
  ]) {
    assertIncludes(listing, required, `archive must contain ${required}`);
  }

  await mkdir(extractDir, { recursive: true });
  run("tar", ["-xzf", packed.archive_path, "-C", extractDir], { cwd: root });
  const extractedBinary = join(extractDir, basename(build.binary_path));
  const version = run(extractedBinary, ["--version"], { cwd: root, capture: true }).stdout.trim();
  if (version !== `osstack ${build.version}`) {
    throw new Error(`extracted binary version mismatch: ${version}`);
  }

  const archiveManifest = JSON.parse(await readFile(packed.archive_manifest_path, "utf-8"));
  if (archiveManifest.publishing?.github_release_uploaded !== false) {
    throw new Error("local archive manifest must not claim GitHub Release upload");
  }
  if (archiveManifest.binary?.signed !== true || archiveManifest.binary?.ad_hoc !== true) {
    throw new Error("archive manifest must record signed ad-hoc binary");
  }
  if (archiveManifest.sbom?.format !== "SPDX-2.3") {
    throw new Error("archive manifest must record SPDX SBOM");
  }
  const sbomDoc = JSON.parse(await readFile(sbom.sbom_path, "utf-8"));
  if (sbomDoc.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbomDoc.files) || sbomDoc.files.length < 3) {
    throw new Error("SBOM must be SPDX 2.3 and list release files");
  }
  if (releaseDoctor.ok !== true || releaseDoctor.readiness?.single_binary_release !== true) {
    throw new Error(`release doctor must mark single-binary release ready: ${JSON.stringify(releaseDoctor)}`);
  }
  if (!releaseDoctor.checks?.some((check) => check.id === "single_binary_release_assets" && check.status === "ok")) {
    throw new Error(`release doctor must validate single-binary release assets: ${JSON.stringify(releaseDoctor)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    kind: "single-binary-release-pack-smoke",
    archive_path: packed.archive_path,
    archive_manifest_path: packed.archive_manifest_path,
    archive_sha256: archiveSha256,
    contents: packed.contents,
    signed: signed.signed,
    ad_hoc: signed.ad_hoc,
    notarized: signed.notarized,
    github_release_uploaded: archiveManifest.publishing.github_release_uploaded,
    sbom_path: sbom.sbom_path,
    sbom_format: sbomDoc.spdxVersion,
    release_doctor: {
      single_binary_release: releaseDoctor.readiness?.single_binary_release,
      single_binary_release_assets: releaseDoctor.checks.find((check) => check.id === "single_binary_release_assets")?.status ?? null,
    },
    extracted_version: version,
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_BINARY_RELEASE_PACK_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept release pack smoke dir: ${tempRoot}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
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

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)}`);
  }
}

function singleBinaryReleaseDoctorEnv() {
  return {
    ...process.env,
    OSSTACK_TEST_RELEASE_GITHUB_AUTH: "ok",
    OSSTACK_TEST_RELEASE_GITHUB_ACTIONS: "ok",
    OSSTACK_TEST_RELEASE_SECRETS: [
      "APPLE_ID",
      "APPLE_TEAM_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "DEVELOPER_ID_APPLICATION",
      "MACOS_CERTIFICATE_P12",
      "MACOS_CERTIFICATE_PASSWORD",
    ].join(","),
    OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW: "ok",
  };
}
