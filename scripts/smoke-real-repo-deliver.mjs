#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "osstack-real-repo-deliver-smoke-"));

try {
  run("pnpm", ["build"], { cwd: root });
  await writeFixtureRepo(workspace);
  git(["init", "-b", "main"]);
  git(["config", "user.name", "osstack smoke"]);
  git(["config", "user.email", "osstack-smoke@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-m", "initial failing app"]);

  const osstackBin = join(root, "packages", "cli", "dist", "bin.js");
  const deliver = run(process.execPath, [
    osstackBin,
    "deliver",
    "Fix the calculator package so npm test passes",
    "--workspace",
    workspace,
    "--execute",
    "node -e \"require('fs').writeFileSync('src/math.js', 'export function add(a, b) {\\n  return a + b;\\n}\\n')\"",
    "--verify",
    "npm test",
    "--worktree",
    // Local landing is an explicit opt-in pinned to the checked-out branch (D7).
    "--land-branch",
    "main",
    "--worktree-root",
    join(workspace, ".osstack-worktrees"),
    "--auto-agent",
    "--json",
  ], { cwd: root, capture: true });
  const summary = JSON.parse(deliver.stdout);
  assert(summary.completed_tasks?.[0]?.outcome === "success", "deliver must complete successfully against the fixture repo");
  assert(summary.artifacts?.report !== undefined, "deliver must produce a report");
  assert(summary.artifacts?.proof_dir !== undefined, "deliver must produce a proof dir");
  assert(summary.artifacts?.proof_manifest !== undefined, "deliver must produce a proof manifest");
  assert(summary.artifacts?.proof_zip !== undefined, "deliver must produce a proof zip");

  run("npm", ["test"], { cwd: workspace });
  const fixedSource = await readFile(join(workspace, "src", "math.js"), "utf-8");
  assertIncludes(fixedSource, "return a + b", "delivered fixture repo must contain the merged code fix");

  const report = await readFile(summary.artifacts.report, "utf-8");
  assertIncludes(report, "Conformance: L4 Audited", "real repo deliver report must prove L4 audited conformance");
  assertIncludes(report, "1 verifier command and 0 verifier adapters passed.", "real repo deliver report must include verifier summary");

  const proofDir = summary.artifacts.proof_dir;
  const verifyResults = JSON.parse(await readFile(join(proofDir, "verify-results.json"), "utf-8"));
  assert(verifyResults.status === "pass", "real repo proof verify-results must pass");
  assert(
    verifyResults.results?.some((result) => result.summary?.includes("1 verifier command")),
    "real repo proof must preserve verifier command summary",
  );

  const worktreeStatus = JSON.parse(await readFile(join(proofDir, "worktree-status.json"), "utf-8"));
  assert(worktreeStatus.entries?.some((entry) => entry.status === "merged"), "real repo deliver must merge worktree changes");

  const proofValidation = run(process.execPath, [
    osstackBin,
    "proof",
    "validate",
    summary.loop_id,
    "--proof-dir",
    proofDir,
    "--json",
  ], { cwd: root, capture: true });
  const proofValidationSummary = JSON.parse(proofValidation.stdout);
  assert(proofValidationSummary.ok === true, "real repo proof validate must pass");
  assert(proofValidationSummary.file_integrity?.ok === true, "real repo proof file integrity must pass");
  assert(proofValidationSummary.archive_integrity?.checked === true, "real repo proof validate must inspect proof zip inventory");
  assert(proofValidationSummary.archive_integrity?.ok === true, "real repo proof zip inventory validation must pass");
  assert(
    proofValidationSummary.archive_integrity?.proof_zip === summary.artifacts.proof_zip,
    "real repo proof zip validation must inspect the deliver proof zip",
  );

  const diff = run("git", ["diff", "HEAD~1..HEAD", "--", "src/math.js"], { cwd: workspace, capture: true }).stdout;
  assertIncludes(diff, "return a + b", "real repo git history must contain the delivered fix");

  console.log(JSON.stringify({
    ok: true,
    kind: "real-repo-deliver-smoke",
    workspace,
    loop_id: summary.loop_id,
    task_id: summary.task.task_id,
    report: summary.artifacts.report,
    proof_dir: proofDir,
    proof_zip: summary.artifacts.proof_zip,
    proof_validation: "proof-core",
    verification: "npm test",
    merged_worktree: true,
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_REAL_REPO_DELIVER_SMOKE"] !== "1") {
    await rm(workspace, { recursive: true, force: true });
  } else {
    console.error(`kept real repo deliver smoke workspace: ${workspace}`);
  }
}

async function writeFixtureRepo(dir) {
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "test"), { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({
    name: "osstack-real-repo-fixture",
    version: "0.0.0",
    type: "module",
    private: true,
    scripts: {
      test: "node --test",
    },
  }, null, 2)}\n`);
  await writeFile(join(dir, "src", "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  await writeFile(join(dir, "test", "math.test.js"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { add } from '../src/math.js';",
    "",
    "test('add sums two numbers', () => {",
    "  assert.equal(add(2, 3), 5);",
    "});",
    "",
  ].join("\n"));
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

function git(args) {
  execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, expected, message) {
  if (!text.includes(expected)) {
    throw new Error(`${message}: missing ${JSON.stringify(expected)}`);
  }
}
