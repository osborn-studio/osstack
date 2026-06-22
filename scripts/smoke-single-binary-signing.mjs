#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-binary-signing-smoke-"));

try {
  const build = JSON.parse(run(process.execPath, [
    "scripts/build-single-binary.mjs",
    "--output-dir",
    join(tempRoot, "release"),
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
  if (signed.signed !== true || signed.ad_hoc !== true || signed.notarized !== false) {
    throw new Error(`unexpected signing summary: ${JSON.stringify(signed)}`);
  }

  run("codesign", ["--verify", "--verbose=2", build.binary_path], { cwd: root, capture: true });
  const version = run(build.binary_path, ["--version"], { cwd: root, capture: true }).stdout.trim();
  if (version !== `osstack ${build.version}`) {
    throw new Error(`signed binary version mismatch: ${version}`);
  }

  const manifest = JSON.parse(await readFile(build.manifest_path, "utf-8"));
  if (manifest.signing?.signed !== true || manifest.signing?.ad_hoc !== true) {
    throw new Error("signed manifest must record ad-hoc signing");
  }
  if (manifest.signing?.notarized !== false) {
    throw new Error("ad-hoc signing smoke must not claim notarization");
  }

  console.log(JSON.stringify({
    ok: true,
    kind: "single-binary-signing-smoke",
    binary_path: build.binary_path,
    manifest_path: build.manifest_path,
    signed: manifest.signing.signed,
    ad_hoc: manifest.signing.ad_hoc,
    notarized: manifest.signing.notarized,
    version,
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_BINARY_SIGNING_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept signed binary smoke dir: ${tempRoot}`);
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
