#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-bun-binary-smoke-"));
const outputDir = join(tempRoot, "release");
const workspace = join(tempRoot, "workspace");

try {
  const packageJson = JSON.parse(await readFile(join(root, "packages", "cli", "package.json"), "utf-8"));
  const version = packageJson.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("packages/cli/package.json must contain a version");
  }

  const buildSummary = JSON.parse(run(process.execPath, [
    "scripts/build-single-binary.mjs",
    "--output-dir",
    outputDir,
    "--json",
  ], { cwd: root, capture: true }).stdout);
  const binaryPath = buildSummary.binary_path;
  const manifestPath = buildSummary.manifest_path;
  const checksumPath = buildSummary.checksum_path;

  await mkdir(workspace, { recursive: true });

  const versionResult = run(binaryPath, ["--version"], { cwd: root, capture: true });
  if (versionResult.stdout.trim() !== `osstack ${version}`) {
    throw new Error(`single binary version mismatch: ${versionResult.stdout}`);
  }

  const help = run(binaryPath, ["help"], { cwd: root, capture: true });
  assertIncludes(help.stdout, "deliver <prompt>", "single binary must expose product commands");
  assertIncludes(help.stdout, "proof [run_id]", "single binary must expose evidence commands");

  const doctor = run(binaryPath, ["loop", "doctor", "--workspace", workspace, "--json"], { cwd: root, capture: true });
  const doctorParsed = JSON.parse(doctor.stdout);
  if (doctorParsed.ok !== true || doctorParsed.workspace_path !== workspace) {
    throw new Error(`single binary loop doctor did not pass: ${doctor.stdout}`);
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
  if (manifest.kind !== "osstack.single_binary.release_asset") {
    throw new Error(`unexpected single binary manifest kind: ${manifest.kind}`);
  }
  if (manifest.signing?.signed !== false || manifest.signing?.notarized !== false) {
    throw new Error("local single binary manifest must not claim signing or notarization");
  }

  const binaryBytes = await readFile(binaryPath);
  const sha256 = createHash("sha256").update(binaryBytes).digest("hex");
  if (sha256 !== buildSummary.sha256 || sha256 !== manifest.binary?.sha256) {
    throw new Error("single binary sha256 mismatch");
  }
  const checksum = await readFile(checksumPath, "utf-8");
  assertIncludes(checksum, sha256, "checksum file must include binary sha256");

  const binaryStat = await stat(binaryPath);
  console.log(JSON.stringify({
    ok: true,
    kind: "bun-single-executable",
    package: packageJson.name,
    version,
    bun_version: buildSummary.bun_version,
    binary_path: binaryPath,
    manifest_path: manifestPath,
    checksum_path: checksumPath,
    sha256,
    binary_size_bytes: binaryStat.size,
    signed: manifest.signing.signed,
    notarized: manifest.signing.notarized,
    loop_doctor_ok: doctorParsed.ok,
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_BUN_BINARY_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept bun single binary: ${binaryPath}`);
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
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)}`);
  }
}
