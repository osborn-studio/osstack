#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "osstack-deliver-proof-smoke-"));

try {
  run("pnpm", ["build"], { cwd: root });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "osstack smoke"]);
  git(["config", "user.email", "osstack-smoke@example.invalid"]);
  await writeFile(join(workspace, "README.md"), "osstack deliver proof smoke\n", "utf-8");
  git(["add", "README.md"]);
  git(["commit", "-m", "initial"]);

  const osstackBin = join(root, "packages", "cli", "dist", "bin.js");
  const deliver = run(process.execPath, [
    osstackBin,
    "deliver",
    "Ship smoke proof",
    "--workspace",
    workspace,
    "--execute",
    "node -e \"require('fs').writeFileSync('smoke.txt','ok')\"",
    "--verify",
    "node -e \"process.exit(require('fs').existsSync('smoke.txt') ? 0 : 1)\"",
    "--worktree",
    "--worktree-root",
    join(workspace, ".osstack-worktrees"),
    "--auto-agent",
    "--json",
  ], { cwd: root, capture: true });
  const summary = JSON.parse(deliver.stdout);
  assert(summary.completed_tasks?.[0]?.outcome === "success", "deliver must complete one successful task");
  assert(summary.artifacts?.report !== undefined, "deliver must produce report artifact");
  assert(summary.artifacts?.scorecard_markdown !== undefined, "deliver must produce scorecard markdown");
  assert(summary.artifacts?.scorecard_html !== undefined, "deliver must produce scorecard html");
  assert(summary.artifacts?.proof_dir !== undefined, "deliver must produce proof dir");
  assert(summary.artifacts?.proof_manifest !== undefined, "deliver must produce proof manifest");
  assert(summary.artifacts?.proof_zip !== undefined, "deliver must produce proof zip");

  const proofDir = summary.artifacts.proof_dir;
  const proofManifestPath = summary.artifacts.proof_manifest;
  const proofManifest = JSON.parse(await readFile(proofManifestPath, "utf-8"));
  const proofPaths = new Set(proofManifest.artifacts.map((artifact) => artifact.path));
  for (const required of [
    "agent-runtime.json",
    "verify-results.json",
    "worktree-status.json",
    "policy-decision.json",
    "git-diff.patch",
    "sha256sums.txt",
  ]) {
    assert(proofPaths.has(required), `proof pack must include ${required}`);
  }

  const report = await readFile(summary.artifacts.report, "utf-8");
  assertIncludes(report, "Conformance: L4 Audited", "deliver smoke report must prove L4 audited conformance");
  assertIncludes(report, "## Worktree Status", "deliver smoke report must include worktree evidence");
  assertIncludes(report, "## Verify Results", "deliver smoke report must include verify evidence");

  const verifyResults = JSON.parse(await readFile(join(proofDir, "verify-results.json"), "utf-8"));
  assert(verifyResults.status === "pass", "verify-results must pass");
  assert(verifyResults.results?.[0]?.reviewer_agent_id === "local-verifier", "verify-results must record verifier id");

  const worktreeStatus = JSON.parse(await readFile(join(proofDir, "worktree-status.json"), "utf-8"));
  assert(worktreeStatus.status === "recorded", "worktree-status must be recorded");
  assert(worktreeStatus.entries?.some((entry) => entry.status === "merged"), "worktree-status must record a merge");
  for (const [index, entry] of worktreeStatus.entries.entries()) {
    assert(entry.branch !== "unknown", `worktree-status entry ${index} must record branch`);
    assert(entry.path !== "unknown", `worktree-status entry ${index} must record path`);
    if (entry.status === "merged") {
      assert(entry.commit !== "unknown", `worktree-status merged entry ${index} must record commit`);
    }
  }

  const proofZipStat = await stat(summary.artifacts.proof_zip);
  assert(proofZipStat.size > 0, "proof zip must be non-empty");

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
  assert(proofValidationSummary.ok === true, "proof validate must pass for deliver proof smoke");
  assert(proofValidationSummary.scope === "proof-core", "proof validate must use proof-core by default");
  assert(proofValidationSummary.missing?.length === 0, "proof validate must not report missing core evidence");

  const compliancePath = join(workspace, "release", "compliance-engineering-readiness.md");
  const compliance = run(process.execPath, [
    osstackBin,
    "compliance",
    "render",
    summary.loop_id,
    "--pack",
    "engineering-readiness",
    "--proof-dir",
    proofDir,
    "--output",
    compliancePath,
    "--json",
  ], { cwd: root, capture: true });
  const complianceSummary = JSON.parse(compliance.stdout);
  assert(complianceSummary.pack_id === "engineering-readiness", "compliance render must use engineering-readiness pack");
  assert(complianceSummary.output === compliancePath, "compliance render must write requested output");
  const complianceReport = await readFile(compliancePath, "utf-8");
  assertIncludes(
    complianceReport,
    "External certification claim: `none`",
    "compliance report must avoid external certification claims",
  );
  assertIncludes(
    complianceReport,
    "| Evidence integrity | PRESENT | `manifest.json` | Proof manifest artifacts carry SHA-256 checksums. |",
    "compliance report must map proof manifest evidence",
  );

  const soc2CompliancePath = join(workspace, "release", "compliance-soc2-lite.md");
  const soc2Compliance = run(process.execPath, [
    osstackBin,
    "compliance",
    "render",
    summary.loop_id,
    "--pack",
    "soc2-lite",
    "--proof-dir",
    proofDir,
    "--output",
    soc2CompliancePath,
    "--json",
  ], { cwd: root, capture: true });
  const soc2ComplianceSummary = JSON.parse(soc2Compliance.stdout);
  assert(soc2ComplianceSummary.pack_id === "soc2-lite", "compliance render must support non-default lite packs from proof dir");
  assert(soc2ComplianceSummary.output === soc2CompliancePath, "SOC 2 lite compliance render must write requested output");
  const soc2ComplianceReport = await readFile(soc2CompliancePath, "utf-8");
  assertIncludes(
    soc2ComplianceReport,
    "External certification claim: `none`",
    "SOC 2 lite compliance report must avoid external certification claims",
  );
  assertIncludes(
    soc2ComplianceReport,
    "This report is not a SOC 2, ISO 27001, EU AI Act, or third-party certification.",
    "SOC 2 lite compliance report must include the no-certification disclaimer",
  );

  const pr = run(process.execPath, [
    osstackBin,
    "pr",
    "--workspace",
    workspace,
    "--events",
    join(proofDir, "events.jsonl"),
    "--proof-dir",
    proofDir,
    "--dry-run",
    "--json",
  ], { cwd: root, capture: true });
  const prSummary = JSON.parse(pr.stdout);
  assert(prSummary.mode === "dry-run", "pr command must run in dry-run mode");
  const prBody = await readFile(prSummary.path, "utf-8");
  assertIncludes(prBody, "# PR Evidence", "dry-run PR body must be written");
  assertIncludes(prBody, "## Proof Pack", "dry-run PR body must include proof pack section");
  assertIncludes(prBody, proofDir, "dry-run PR body must reference proof dir");

  console.log(JSON.stringify({
    ok: true,
    workspace,
    loop_id: summary.loop_id,
    task_id: summary.task.task_id,
    report: summary.artifacts.report,
    scorecard: summary.artifacts.scorecard_markdown,
    proof_dir: proofDir,
    proof_zip: summary.artifacts.proof_zip,
    proof_validation: "proof-core",
    compliance_report: compliancePath,
    soc2_compliance_report: soc2CompliancePath,
    pr_body: prSummary.path,
    conformance: "L4 Audited",
  }, null, 2));
} finally {
  if (process.env["OSSTACK_KEEP_DELIVER_SMOKE"] !== "1") {
    await rm(workspace, { recursive: true, force: true });
  } else {
    console.error(`kept smoke workspace: ${workspace}`);
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
