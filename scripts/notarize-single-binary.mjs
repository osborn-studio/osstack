#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const manifestPath = requiredFlag("--manifest");
const appleId = flagValue("--apple-id") ?? process.env["APPLE_ID"];
const teamId = flagValue("--team-id") ?? process.env["APPLE_TEAM_ID"];
const password = flagValue("--password") ?? process.env["APPLE_APP_SPECIFIC_PASSWORD"];
const json = args.includes("--json");

const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
const binaryPath = manifest.binary?.path;
if (typeof binaryPath !== "string" || binaryPath.length === 0) {
  throw new Error("manifest.binary.path is required");
}
if (manifest.signing?.signed !== true || manifest.signing?.ad_hoc === true) {
  throw new Error("single-binary notarization requires a Developer ID signed binary; run sign:single-binary with a Developer ID identity first");
}
if (!appleId || !teamId || !password) {
  throw new Error("APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_SPECIFIC_PASSWORD are required for notarization");
}

const tempRoot = await mkdtemp(join(tmpdir(), "osstack-single-binary-notarize-"));
const submissionZip = join(tempRoot, `${basename(binaryPath)}.notarization.zip`);
try {
  run("ditto", ["-c", "-k", "--keepParent", binaryPath, submissionZip], { capture: json });
  run("xcrun", [
    "notarytool",
    "submit",
    submissionZip,
    "--apple-id",
    appleId,
    "--team-id",
    teamId,
    "--password",
    password,
    "--wait",
  ], { capture: json });
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
run("spctl", ["--assess", "--type", "execute", "--verbose=2", binaryPath], { capture: json });

const binaryBytes = await readFile(binaryPath);
const sha256 = createHash("sha256").update(binaryBytes).digest("hex");
manifest.binary.sha256 = sha256;
manifest.binary.size_bytes = binaryBytes.length;
manifest.signing = {
  ...manifest.signing,
  notarized: true,
  notarized_at: new Date().toISOString(),
  notarization_tool: "xcrun notarytool",
  notarization_submission: "zip",
  stapled: false,
  assessed: true,
  note: "Developer ID signed, notarized through a zipped command-line tool submission, and assessed for public macOS distribution.",
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (typeof manifest.checksum_path === "string" && manifest.checksum_path.length > 0) {
  await writeFile(manifest.checksum_path, `${sha256}  ${manifest.binary.name ?? basename(binaryPath)}\n`);
}

const summary = {
  ok: true,
  binary_path: binaryPath,
  binary_name: basename(binaryPath),
  manifest_path: manifestPath,
  sha256,
  signed: true,
  ad_hoc: false,
  notarized: true,
  stapled: false,
  assessed: true,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`binary=${binaryPath}`);
  console.log("notarized=true stapled=false assessed=true");
  console.log(`sha256=${sha256}`);
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
