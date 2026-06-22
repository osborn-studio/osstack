#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const args = process.argv.slice(2);
const manifestPath = requiredFlag("--manifest");
const identity = flagValue("--identity") ?? "-";
const json = args.includes("--json");

const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
const binaryPath = manifest.binary?.path;
if (typeof binaryPath !== "string" || binaryPath.length === 0) {
  throw new Error("manifest.binary.path is required");
}

run("codesign", ["--force", "--sign", identity, "--timestamp=none", binaryPath], { capture: json });
run("codesign", ["--verify", "--verbose=2", binaryPath], { capture: json });

const binaryBytes = await readFile(binaryPath);
const sha256 = createHash("sha256").update(binaryBytes).digest("hex");
manifest.binary.sha256 = sha256;
manifest.binary.size_bytes = binaryBytes.length;
manifest.signing = {
  signed: true,
  identity,
  ad_hoc: identity === "-",
  notarized: false,
  signed_at: new Date().toISOString(),
  note: identity === "-"
    ? "Ad-hoc signed local release candidate. Use Developer ID signing and notarization before public distribution."
    : "Signed local release candidate. Notarization is still required before public distribution.",
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
  identity,
  ad_hoc: identity === "-",
  notarized: false,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`binary=${binaryPath}`);
  console.log(`signed=true identity=${identity} notarized=false`);
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
