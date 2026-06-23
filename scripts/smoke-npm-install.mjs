#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "osstack-npm-smoke-"));
const packDir = join(tempRoot, "packs");
const prefix = join(tempRoot, "prefix");
const workspace = join(tempRoot, "workspace");
const osstackHome = join(tempRoot, "home");
const launchAgentsDir = join(tempRoot, "LaunchAgents");
let knowledgeCloudChild;
let installedDaemon;

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
  const releaseDoctor = run(osstackBin, [
    "release",
    "doctor",
    "--target",
    "npm",
    "--json",
  ], {
    cwd: root,
    capture: true,
    env: {
      ...process.env,
      OSSTACK_TEST_RELEASE_GITHUB_AUTH: "ok",
      OSSTACK_TEST_RELEASE_GITHUB_ACTIONS: "ok",
      OSSTACK_TEST_RELEASE_SECRETS: "NPM_TOKEN",
      OSSTACK_TEST_RELEASE_NPM_AUTH: "ok",
      OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS: "ok",
      OSSTACK_TEST_RELEASE_VERSION_PR: "none",
    },
  });
  const releaseDoctorParsed = JSON.parse(releaseDoctor.stdout);
  if (releaseDoctorParsed.ok !== true || releaseDoctorParsed.readiness?.npm_publish !== true) {
    throw new Error(`installed CLI release doctor did not mark npm publish ready: ${releaseDoctor.stdout}`);
  }
  if (!releaseDoctorParsed.checks?.some((check) => check.id === "npm_publish_assets" && check.status === "ok")) {
    throw new Error(`installed CLI release doctor did not validate npm publish assets: ${releaseDoctor.stdout}`);
  }
  if (!releaseDoctorParsed.checks?.some((check) => check.id === "npm_scope_access" && check.status === "ok")) {
    throw new Error(`installed CLI release doctor did not validate npm scope access: ${releaseDoctor.stdout}`);
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

  const cockpitEnv = {
    ...process.env,
    OSSTACK_HOME: join(tempRoot, "cockpit-home"),
    OSSTACK_SOCKET: join(tempRoot, "cockpit.sock"),
    OSSTACK_UPDATE_CHECK: "0",
  };
  installedDaemon = await startInstalledDaemon(osstackBin, cockpitEnv);
  await mkdir(join(workspace, "reports"), { recursive: true });
  await mkdir(join(workspace, "release", "osstack-proof-installed-tui"), { recursive: true });
  await writeFile(join(workspace, "reports", "osstack-report-installed-tui.md"), "# installed tui report\n", "utf-8");
  await writeFile(join(workspace, "release", "osstack-proof-installed-tui", "manifest.json"), "{}\n", "utf-8");
  const cockpitTui = run(osstackBin, ["cockpit", "tui", "--workspace", workspace, "--json"], {
    cwd: root,
    capture: true,
    env: cockpitEnv,
  });
  const cockpitTuiParsed = JSON.parse(cockpitTui.stdout);
  if (
    cockpitTuiParsed.mode !== "terminal-cockpit"
    || cockpitTuiParsed.workspace !== workspace
    || !cockpitTuiParsed.sections?.some((section) => section.title === "Evidence" && section.lines?.some((line) => line.includes("reports=1")))
    || !cockpitTuiParsed.actions?.some((action) => action.command === "osstack cockpit run --workspace <path> --json")
  ) {
    throw new Error(`installed CLI cockpit tui did not render expected terminal model: ${cockpitTui.stdout}`);
  }
  const cockpitTuiInteractive = run(osstackBin, ["cockpit", "tui", "--workspace", workspace, "--interactive", "--json"], {
    cwd: root,
    capture: true,
    env: {
      ...cockpitEnv,
      OSSTACK_TEST_COCKPIT_TUI_INPUT: "2\n",
    },
  });
  const cockpitTuiInteractiveParsed = JSON.parse(cockpitTuiInteractive.stdout);
  if (
    cockpitTuiInteractiveParsed.mode !== "terminal-cockpit-action"
    || cockpitTuiInteractiveParsed.selected_index !== 2
    || !cockpitTuiInteractiveParsed.next_command?.includes("osstack deliver")
  ) {
    throw new Error(`installed CLI cockpit tui interactive selection failed: ${cockpitTuiInteractive.stdout}`);
  }
  await installedDaemon.stop();
  installedDaemon = undefined;

  run("git", ["init", "-b", "main"], { cwd: workspace });
  run("git", ["config", "user.name", "osstack npm smoke"], { cwd: workspace });
  run("git", ["config", "user.email", "osstack-npm-smoke@example.invalid"], { cwd: workspace });
  await writeFile(join(workspace, "README.md"), "osstack installed deliver smoke\n", "utf-8");
  run("git", ["add", "README.md"], { cwd: workspace });
  run("git", ["commit", "-m", "initial"], { cwd: workspace });
  const installedDeliver = run(osstackBin, [
    "deliver",
    "Ship installed CLI deliver smoke",
    "--workspace",
    workspace,
    "--execute",
    "node -e \"require('fs').writeFileSync('installed-deliver.txt','ok')\"",
    "--verify",
    "node -e \"process.exit(require('fs').existsSync('installed-deliver.txt') ? 0 : 1)\"",
    "--worktree",
    "--worktree-root",
    join(workspace, ".osstack-worktrees"),
    "--auto-agent",
    "--json",
  ], { cwd: root, capture: true });
  const installedDeliverParsed = JSON.parse(installedDeliver.stdout);
  if (installedDeliverParsed.completed_tasks?.[0]?.outcome !== "success") {
    throw new Error(`installed CLI deliver did not complete successfully: ${installedDeliver.stdout}`);
  }
  assertIncludes(
    await readFile(installedDeliverParsed.artifacts.report, "utf-8"),
    "Conformance: L4 Audited",
    "installed CLI deliver report must prove L4 conformance",
  );
  assertIncludes(
    await readFile(installedDeliverParsed.artifacts.proof_manifest, "utf-8"),
    "\"kind\": \"osstack.proof_pack\"",
    "installed CLI deliver must write a proof manifest",
  );
  if (typeof installedDeliverParsed.artifacts.proof_zip !== "string") {
    throw new Error(`installed CLI deliver did not report a proof zip artifact: ${installedDeliver.stdout}`);
  }
  const installedDeliverVerify = JSON.parse(await readFile(join(installedDeliverParsed.artifacts.proof_dir, "verify-results.json"), "utf-8"));
  if (installedDeliverVerify.status !== "pass") {
    throw new Error(`installed CLI deliver verify-results did not pass: ${JSON.stringify(installedDeliverVerify)}`);
  }
  const installedDeliverWorktree = JSON.parse(await readFile(join(installedDeliverParsed.artifacts.proof_dir, "worktree-status.json"), "utf-8"));
  if (!installedDeliverWorktree.entries?.some((entry) => entry.status === "merged")) {
    throw new Error(`installed CLI deliver did not record a merged worktree: ${JSON.stringify(installedDeliverWorktree)}`);
  }
  const installedDeliverProofValidation = assertProofValidationPass({
    command: osstackBin,
    runId: installedDeliverParsed.loop_id,
    proofDir: installedDeliverParsed.artifacts.proof_dir,
    proofZip: installedDeliverParsed.artifacts.proof_zip,
    message: "installed CLI deliver proof validate",
  });

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
  const loopProofValidation = assertProofValidationPass({
    command: osstackBin,
    runId: "npm-smoke-loop",
    proofDir: join(workspace, "release", "osstack-proof-npm-smoke-loop"),
    proofZip,
    message: "installed CLI proof --loop validation",
    requireCoreEvidence: false,
  });

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
    release_doctor: {
      npm_publish: releaseDoctorParsed.readiness?.npm_publish,
      npm_publish_assets: releaseDoctorParsed.checks.find((check) => check.id === "npm_publish_assets")?.status ?? null,
    },
    installed_deliver: {
      loop_id: installedDeliverParsed.loop_id,
      report: installedDeliverParsed.artifacts.report,
      proof_manifest: installedDeliverParsed.artifacts.proof_manifest,
      proof_zip: installedDeliverParsed.artifacts.proof_zip,
      proof_validation: {
        file_integrity: installedDeliverProofValidation.file_integrity?.ok,
        archive_integrity: installedDeliverProofValidation.archive_integrity?.ok,
      },
    },
    installed_cockpit_tui: {
      mode: cockpitTuiParsed.mode,
      sections: cockpitTuiParsed.sections.map((section) => section.title),
      actions: cockpitTuiParsed.actions.length,
      interactive_selection: cockpitTuiInteractiveParsed.selected_index,
    },
    examples: examplesParsed.examples.length,
    evidence_artifacts: {
      scorecard_markdown: scorecardMarkdown,
      proof_manifest: proofManifest,
      proof_zip: proofZip,
      proof_validation: {
        file_integrity: loopProofValidation.file_integrity?.ok,
        archive_integrity: loopProofValidation.archive_integrity?.ok,
      },
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
  if (installedDaemon !== undefined) {
    await installedDaemon.stop();
  }
  if (knowledgeCloudChild !== undefined) {
    knowledgeCloudChild.kill("SIGTERM");
  }
  if (process.env["OSSTACK_KEEP_NPM_SMOKE"] !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`kept smoke directory: ${tempRoot}`);
  }
}

async function startInstalledDaemon(command, env) {
  const child = spawn(command, ["serve"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`installed daemon exited early with ${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    const health = run(command, ["health"], {
      cwd: root,
      capture: true,
      env,
      allowFailure: true,
    });
    if (health.stdout.includes("\"ok\": true") || health.stdout.includes("osstack")) {
      return {
        stop: async () => stopChild(child, "installed daemon"),
      };
    }
    await sleep(50);
  }
  child.kill("SIGKILL");
  throw new Error(`installed daemon did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function stopChild(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(50);
  }
  child.kill("SIGKILL");
  throw new Error(`${label} did not stop after SIGTERM`);
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
  if (result.status !== 0 && options.allowFailure !== true) {
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

function assertProofValidationPass({ command, runId, proofDir, proofZip, message, requireCoreEvidence = true }) {
  const result = run(command, ["proof", "validate", runId, "--proof-dir", proofDir, "--json"], {
    cwd: root,
    capture: true,
    allowFailure: !requireCoreEvidence,
  });
  const summary = JSON.parse(result.stdout);
  if (requireCoreEvidence && summary.ok !== true) {
    throw new Error(`${message} did not pass: ${result.stdout}`);
  }
  if (summary.file_integrity?.ok !== true) {
    throw new Error(`${message} file integrity did not pass: ${result.stdout}`);
  }
  if (summary.archive_integrity?.checked !== true) {
    throw new Error(`${message} did not inspect proof zip inventory: ${result.stdout}`);
  }
  if (summary.archive_integrity?.ok !== true) {
    throw new Error(`${message} archive integrity did not pass: ${result.stdout}`);
  }
  if (summary.archive_integrity?.proof_zip !== proofZip) {
    throw new Error(`${message} inspected the wrong proof zip: expected ${proofZip}, got ${summary.archive_integrity?.proof_zip}`);
  }
  if (summary.archive_integrity?.issues?.length !== 0) {
    throw new Error(`${message} archive integrity reported issues: ${result.stdout}`);
  }
  return summary;
}
