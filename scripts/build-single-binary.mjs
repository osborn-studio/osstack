#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const targetPlatform = flagValue("--platform") ?? platform();
const targetArch = flagValue("--arch") ?? arch();
if (targetPlatform !== platform() || targetArch !== arch()) {
  throw new Error(
    `cross-compilation is not wired yet: requested ${targetPlatform}-${targetArch}, host is ${platform()}-${arch()}`,
  );
}
const outputDir = resolve(flagValue("--output-dir") ?? join("dist", "single-binary", `${targetPlatform}-${targetArch}`));
const json = args.includes("--json");
const skipBuild = args.includes("--skip-build");
const cliDir = join(root, "packages", "cli");

const packageJson = JSON.parse(await readFile(join(cliDir, "package.json"), "utf-8"));
const version = packageJson.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("packages/cli/package.json must contain a version");
}

const bunVersion = run("bun", ["--version"], { cwd: root, capture: true }).stdout.trim();
if (!skipBuild) {
  run("pnpm", ["--filter", "@osstack/cli", "build"], { cwd: root, capture: json });
}

await mkdir(outputDir, { recursive: true });
const binaryName = `osstack-${version}-${targetPlatform}-${targetArch}`;
const binaryPath = join(outputDir, binaryName);
const manifestPath = join(outputDir, `${binaryName}.manifest.json`);
const checksumPath = join(outputDir, "sha256sums.txt");
const entrypoint = join("dist", "bin.js");

run("bun", [
  "build",
  entrypoint,
  "--compile",
  "--env",
  "inline",
  "--outfile",
  binaryPath,
], {
  cwd: cliDir,
  env: { ...process.env, OSSTACK_VERSION: version },
  capture: json,
});

const binaryBytes = await readFile(binaryPath);
const sha256 = createHash("sha256").update(binaryBytes).digest("hex");
const binaryStat = await stat(binaryPath);
await writeFile(checksumPath, `${sha256}  ${binaryName}\n`);

const manifest = {
  schema_version: "1",
  kind: "osstack.single_binary.release_asset",
  package: packageJson.name,
  version,
  platform: targetPlatform,
  arch: targetArch,
  bun_version: bunVersion,
  generated_at: new Date().toISOString(),
  binary: {
    path: binaryPath,
    name: binaryName,
    size_bytes: binaryStat.size,
    sha256,
  },
  checksum_path: checksumPath,
  signing: {
    signed: false,
    notarized: false,
    note: "Local release candidate only. Sign, notarize, and cross-machine smoke before publishing.",
  },
  verification: [
    `${binaryPath} --version`,
    `${binaryPath} help`,
    `${binaryPath} loop doctor --workspace <workspace> --json`,
  ],
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const summary = {
  ok: true,
  binary_path: binaryPath,
  manifest_path: manifestPath,
  checksum_path: checksumPath,
  sha256,
  size_bytes: binaryStat.size,
  version,
  platform: targetPlatform,
  arch: targetArch,
  bun_version: bunVersion,
  signed: false,
  notarized: false,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`binary=${binaryPath}`);
  console.log(`manifest=${manifestPath}`);
  console.log(`sha256=${sha256}`);
  console.log("signed=false notarized=false");
}

function flagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf-8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${commandArgs.join(" ")} failed with ${result.status}${output ? `\n${output}` : ""}`);
  }
  if (options.capture === true) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output.length > 0 && !json) console.error(output);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
