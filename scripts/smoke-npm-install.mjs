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

  const productDoctor = run(osstackBin, ["doctor", "--workspace", workspace, "--json"], { cwd: root, capture: true });
  const productDoctorParsed = JSON.parse(productDoctor.stdout);
  if (productDoctorParsed.ok !== true || productDoctorParsed.loop?.ok !== true) {
    throw new Error(`product doctor did not pass after npm install: ${productDoctor.stdout}`);
  }

  const doctor = run(osstackBin, ["loop", "doctor", "--workspace", workspace, "--json"], { cwd: root, capture: true });
  const parsed = JSON.parse(doctor.stdout);
  if (parsed.ok !== true) {
    throw new Error(`loop doctor did not pass after npm install: ${doctor.stdout}`);
  }

  const loopHelp = run(osstackBin, ["loop", "--help"], { cwd: root, capture: true });
  assertIncludes(loopHelp.stdout, "osstack loop run [options]", "loop help must expose loop run");
  assertIncludes(loopHelp.stdout, "--proof", "loop help must expose proof generation");
  assertIncludes(loopHelp.stdout, "--knowledge M", "loop help must expose knowledge mode");

  const examples = run(osstackBin, ["examples", "--json"], { cwd: root, capture: true });
  const examplesParsed = JSON.parse(examples.stdout);
  if (!Array.isArray(examplesParsed.examples) || examplesParsed.examples.length < 6) {
    throw new Error(`examples smoke expected at least 6 workflows: ${examples.stdout}`);
  }
  if (!examples.stdout.includes("osstack deliver") || !examples.stdout.includes("--proof")) {
    throw new Error(`examples smoke did not expose deliver/proof paths: ${examples.stdout}`);
  }

  const guide = run(osstackBin, ["guide"], { cwd: root, capture: true });
  assertIncludes(guide.stdout, "osstack doctor --workspace .", "guide must include product doctor");
  assertIncludes(guide.stdout, "osstack proof view", "guide must include proof view");

  const knowledgeEval = run(osstackBin, [
    "knowledge",
    "eval",
    "--official",
    "--fixtures",
    join(root, "knowledge-evals", "retrieval", "osstack-core.json"),
    "--json",
  ], { cwd: root, capture: true });
  const knowledgeEvalParsed = JSON.parse(knowledgeEval.stdout);
  if (knowledgeEvalParsed.total !== 30 || knowledgeEvalParsed.passed !== 30 || knowledgeEvalParsed.failed !== 0) {
    throw new Error(`official knowledge retrieval eval did not pass 30/30: ${knowledgeEval.stdout}`);
  }

  const knowledgeSources = run(osstackBin, ["knowledge", "sources", "--internal", "--official", "--json"], { cwd: root, capture: true });
  const knowledgeSourcesParsed = JSON.parse(knowledgeSources.stdout);
  if (
    !Array.isArray(knowledgeSourcesParsed.packs)
    || knowledgeSourcesParsed.packs.length !== 6
    || !knowledgeSourcesParsed.packs.every((pack) => Array.isArray(pack.sources) && pack.sources.length > 0)
  ) {
    throw new Error(`official knowledge sources did not expose provenance for all packs: ${knowledgeSources.stdout}`);
  }

  const knowledgeCloudBin = join(prefix, "bin", "osstack-knowledge-cloud");
  const knowledgeHelp = run(knowledgeCloudBin, ["--help"], { cwd: root, capture: true });
  if (!knowledgeHelp.stdout.includes("osstack-knowledge-cloud")) {
    throw new Error(`knowledge cloud help did not print expected command name: ${knowledgeHelp.stdout}`);
  }
  const knowledgeStart = run(
    knowledgeCloudBin,
    [
      "--port",
      "0",
      "--official-index",
      join(root, "knowledge-packs", "official", "index.json"),
      "--json",
    ],
    {
      cwd: root,
      capture: true,
      env: { ...process.env, OSSTACK_KNOWLEDGE_CLOUD_ONCE: "1" },
    },
  );
  const knowledgeParsed = JSON.parse(knowledgeStart.stdout);
  if (knowledgeParsed.packs !== 6 || knowledgeParsed.private_packs !== 0) {
    throw new Error(`knowledge cloud npm smoke did not load official packs: ${knowledgeStart.stdout}`);
  }

  console.log(JSON.stringify({
    ok: true,
    tarballs: tarballs.length,
    prefix,
    workspace,
    product_doctor: productDoctorParsed.ok,
    examples: examplesParsed.examples.length,
    knowledge_eval: {
      total: knowledgeEvalParsed.total,
      passed: knowledgeEvalParsed.passed,
      failed: knowledgeEvalParsed.failed,
    },
    knowledge_sources: {
      packs: knowledgeSourcesParsed.packs.length,
    },
    knowledge_cloud: {
      packs: knowledgeParsed.packs,
      private_packs: knowledgeParsed.private_packs,
    },
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
    throw new Error(`${message}: missing ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
}
