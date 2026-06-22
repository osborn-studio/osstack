#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-npm-smoke-"));
const packDir = join(tempRoot, "packs");
const prefix = join(tempRoot, "prefix");
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

  run("npm", ["install", "-g", "--prefix", prefix, ...tarballs], { cwd: root });
  const osstackBin = join(prefix, "bin", "osstack");
  run(osstackBin, ["--version"], { cwd: root });
  await mkdir(workspace, { recursive: true });
  const doctor = run(osstackBin, ["loop", "doctor", "--workspace", workspace, "--json"], { cwd: root, capture: true });
  const parsed = JSON.parse(doctor.stdout);
  if (parsed.ok !== true) {
    throw new Error(`loop doctor did not pass after npm install: ${doctor.stdout}`);
  }

  console.log(JSON.stringify({
    ok: true,
    tarballs: tarballs.length,
    prefix,
    workspace,
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_NPM_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept smoke directory: ${tempRoot}`);
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
