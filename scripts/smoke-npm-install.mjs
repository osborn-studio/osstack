#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-npm-smoke-"));
const packDir = join(tempRoot, "packs");
const prefix = join(tempRoot, "prefix");
const workspace = join(tempRoot, "workspace");
const osstackHome = join(tempRoot, "home");
const launchAgentsDir = join(tempRoot, "LaunchAgents");
let knowledgeCloudChild;

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

  const launchdEnv = {
    ...process.env,
    OSSTACK_HOME: osstackHome,
    OSSTACK_LAUNCH_AGENTS_DIR: launchAgentsDir,
  };
  const install = run(osstackBin, ["serve", "--install", "--no-load", "--bin", osstackBin, "--json"], {
    cwd: root,
    capture: true,
    env: launchdEnv,
  });
  const installParsed = JSON.parse(install.stdout);
  if (installParsed.installed !== true || installParsed.loaded !== false || installParsed.load_skipped !== true) {
    throw new Error(`serve --install --no-load did not create an unloaded LaunchAgent: ${install.stdout}`);
  }
  const status = run(osstackBin, ["serve", "--status", "--no-load", "--json"], {
    cwd: root,
    capture: true,
    env: launchdEnv,
  });
  const statusParsed = JSON.parse(status.stdout);
  if (statusParsed.installed !== true || statusParsed.loaded !== false) {
    throw new Error(`serve --status --no-load did not see the installed LaunchAgent: ${status.stdout}`);
  }
  run(osstackBin, ["serve", "--uninstall", "--no-load", "--json"], {
    cwd: root,
    capture: true,
    env: launchdEnv,
  });

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

  await writeFile(join(workspace, "LOOP-STATE.json"), `${JSON.stringify({
    loop_id: "npm-smoke-loop",
    started_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-22T00:01:00.000Z",
    completed_tasks: [{
      task_id: "npm-smoke-task",
      capability: "code.test",
      outcome: "success",
      iterations: 1,
      agent_id: "codex-cli",
      duration_ms: 1000,
    }],
    in_progress: [],
    pending: [],
    decisions: ["Validate installed evidence commands."],
  }, null, 2)}\n`);

  const report = run(osstackBin, ["report", "--loop", "npm-smoke-loop", "--workspace", workspace], { cwd: root, capture: true });
  assertIncludes(report.stdout, "# Osstack Loop Report - npm-smoke-loop", "report --loop must render the installed loop report");

  run(osstackBin, ["scorecard", "--loop", "npm-smoke-loop", "--workspace", workspace], { cwd: root, capture: true });
  const scorecardMarkdown = join(workspace, "release", "osstack-scorecard-npm-smoke-loop.md");
  const scorecardHtml = join(workspace, "release", "osstack-scorecard-npm-smoke-loop.html");
  assertIncludes(await readFile(scorecardMarkdown, "utf-8"), "# Osstack Scorecard - npm-smoke-loop", "scorecard --loop must write markdown");
  assertIncludes(await readFile(scorecardHtml, "utf-8"), "<!doctype html>", "scorecard --loop must write HTML");

  run(osstackBin, ["proof", "--loop", "npm-smoke-loop", "--workspace", workspace, "--json"], { cwd: root, capture: true });
  const proofManifest = join(workspace, "release", "osstack-proof-npm-smoke-loop", "manifest.json");
  const proofZip = join(workspace, "release", "osstack-proof-npm-smoke-loop.zip");
  assertIncludes(await readFile(proofManifest, "utf-8"), "\"run_id\": \"npm-smoke-loop\"", "proof --loop must write manifest");
  const proofZipStat = await stat(proofZip);
  if (proofZipStat.size <= 0) {
    throw new Error(`proof --loop wrote an empty zip: ${proofZip}`);
  }

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

  const knowledgeValidate = run(osstackBin, ["knowledge", "validate", "--official", "--json"], { cwd: root, capture: true });
  const knowledgeValidateParsed = JSON.parse(knowledgeValidate.stdout);
  if (
    knowledgeValidateParsed.ok !== true
    || !Array.isArray(knowledgeValidateParsed.packs)
    || knowledgeValidateParsed.packs.length !== 6
    || !knowledgeValidateParsed.packs.every((pack) => pack.ok === true)
  ) {
    throw new Error(`official knowledge publish gate did not pass: ${knowledgeValidate.stdout}`);
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

  const knowledgeCacheDir = join(tempRoot, "knowledge-cache");
  const knowledgeCloud = await startKnowledgeCloud(knowledgeCloudBin, [
    "--port",
    "0",
    "--official-index",
    join(root, "knowledge-packs", "official", "index.json"),
  ]);
  knowledgeCloudChild = knowledgeCloud.child;
  const knowledgeSync = run(osstackBin, [
    "knowledge",
    "sync",
    "--cloud-url",
    knowledgeCloud.url,
    "--cache-dir",
    knowledgeCacheDir,
    "--json",
  ], { cwd: root, capture: true });
  const knowledgeSyncParsed = JSON.parse(knowledgeSync.stdout);
  if (knowledgeSyncParsed.status !== "synced" || knowledgeSyncParsed.packs?.length !== 6) {
    throw new Error(`installed CLI knowledge sync did not cache official packs: ${knowledgeSync.stdout}`);
  }
  knowledgeCloudChild.kill("SIGTERM");
  knowledgeCloudChild = undefined;

  const fallbackSearch = run(osstackBin, [
    "knowledge",
    "search",
    "proof pack checksum manifest",
    "--cloud-url",
    "http://127.0.0.1:1",
    "--cache-dir",
    knowledgeCacheDir,
    "--limit",
    "3",
    "--json",
  ], { cwd: root, capture: true });
  const fallbackSearchParsed = JSON.parse(fallbackSearch.stdout);
  if (
    fallbackSearchParsed.mode !== "local"
    || fallbackSearchParsed.fallback_mode !== "local"
    || !Array.isArray(fallbackSearchParsed.results)
    || !fallbackSearchParsed.results.some((result) => (
      result.pack_id === "osstack-core/proof-and-scorecard"
      && result.chunk_id === "proof-checksum-pack"
    ))
  ) {
    throw new Error(`installed CLI knowledge search did not fail open to cached packs: ${fallbackSearch.stdout}`);
  }

  console.log(JSON.stringify({
    ok: true,
    tarballs: tarballs.length,
    prefix,
    workspace,
    launchd_install: {
      plist_path: installParsed.plist_path,
      load_skipped: installParsed.load_skipped,
    },
    product_doctor: productDoctorParsed.ok,
    examples: examplesParsed.examples.length,
    evidence_artifacts: {
      scorecard_markdown: scorecardMarkdown,
      proof_manifest: proofManifest,
      proof_zip: proofZip,
    },
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
    knowledge_cache_fallback: {
      synced_packs: knowledgeSyncParsed.packs.length,
      fallback_mode: fallbackSearchParsed.fallback_mode,
      top_result: fallbackSearchParsed.results[0]?.chunk_id ?? null,
    },
  }, null, 2));
} finally {
  if (knowledgeCloudChild !== undefined) {
    knowledgeCloudChild.kill("SIGTERM");
  }
  if (process.env["OSSTACK_KEEP_NPM_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept smoke directory: ${tempRoot}`);
  }
}

function startKnowledgeCloud(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`knowledge cloud did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/^knowledge_cloud=(.+)$/m);
      if (match !== null) {
        clearTimeout(timeout);
        resolve({ child, url: match[1] });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`knowledge cloud exited before startup with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
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
