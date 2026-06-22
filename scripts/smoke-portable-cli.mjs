#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-portable-cli-smoke-"));
const bundleDir = join(tempRoot, "osstack-portable");
const packDir = join(tempRoot, "packs");
const workspace = join(tempRoot, "workspace");

try {
  run("pnpm", ["-r", "build"], { cwd: root });
  run("pnpm", ["-r", "--filter", "./packages/*", "pack", "--pack-destination", packDir], { cwd: root });
  const tarballs = (await readdir(packDir))
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(packDir, name))
    .sort();
  if (tarballs.length === 0) {
    throw new Error("no package tarballs were produced");
  }
  await mkdir(bundleDir, { recursive: true });
  run("npm", ["install", "-g", "--prefix", bundleDir, "--omit=dev", ...tarballs], { cwd: root });
  await mkdir(workspace, { recursive: true });

  const osstackBin = join(bundleDir, "bin", "osstack");
  const version = run(osstackBin, ["--version"], { cwd: root, capture: true });
  assertIncludes(version.stdout, "osstack", "portable shim must execute osstack --version");

  const help = run(osstackBin, ["help"], { cwd: root, capture: true });
  assertIncludes(help.stdout, "deliver <prompt>", "portable shim must expose product commands");
  assertIncludes(help.stdout, "proof [run_id]", "portable shim must expose evidence commands");

  const doctor = run(osstackBin, ["loop", "doctor", "--workspace", workspace, "--json"], { cwd: root, capture: true });
  const doctorParsed = JSON.parse(doctor.stdout);
  if (doctorParsed.ok !== true || doctorParsed.workspace_path !== workspace) {
    throw new Error(`portable loop doctor did not pass: ${doctor.stdout}`);
  }

  const binStat = await stat(osstackBin);
  const distStat = await stat(join(bundleDir, "lib", "node_modules", "@osstack", "cli", "dist", "bin.js"));
  const nodeModulesStat = await stat(join(bundleDir, "lib", "node_modules"));
  const packageJson = JSON.parse(
    await readFile(join(bundleDir, "lib", "node_modules", "@osstack", "cli", "package.json"), "utf-8"),
  );

  console.log(JSON.stringify({
    ok: true,
    kind: "portable-cli-bundle",
    package: packageJson.name,
    bundle_dir: bundleDir,
    entrypoint: osstackBin,
    generated_files: [
      "bin/osstack",
      "lib/node_modules/@osstack/cli/dist/bin.js",
      "lib/node_modules",
    ],
    tarballs: tarballs.length,
    entrypoint_mode: binStat.mode.toString(8),
    dist_size_bytes: distStat.size,
    node_modules_is_directory: nodeModulesStat.isDirectory(),
    version: version.stdout.trim(),
    loop_doctor_ok: doctorParsed.ok,
    single_file_candidates: {
      node_sea: {
        available: true,
        node: process.version,
        note: "Node SEA can be evaluated next, but a true single executable still needs blob injection tooling such as postject and macOS signing/notarization handling.",
      },
      bun: toolProbe("bun"),
      pkg: toolProbe("pkg"),
      nexe: toolProbe("nexe"),
      postject: toolProbe("postject"),
    },
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_PORTABLE_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept portable smoke bundle: ${bundleDir}`);
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

function toolProbe(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    available: result.status === 0,
    command: basename(command),
    version: result.status === 0 ? (result.stdout || result.stderr).trim().split("\n")[0] : undefined,
  };
}

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)}`);
  }
}
