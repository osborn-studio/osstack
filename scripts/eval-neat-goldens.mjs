#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");
const manifestPath = join(
  repoRoot,
  "packages",
  "governance",
  "fixtures",
  "knowledge-hygiene",
  "golden",
  "manifest.json",
);
const reportPath = join(repoRoot, "docs", "reports", "neat-r0-golden-eval.md");
const check = process.argv.includes("--check");

if (!existsSync(cliPath)) {
  console.error(`Missing built CLI at ${cliPath}; run the CLI build first.`);
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schema_version !== "1" || manifest.scenarios.length !== 12) {
  throw new Error("Golden manifest must contain exactly twelve v1 scenarios.");
}

const workspace = await mkdtemp(join(tmpdir(), "osstack-neat-goldens-"));
try {
  const results = [];
  for (const scenario of manifest.scenarios) {
    results.push(await evaluateScenario(scenario));
  }
  const score = scoreResults(results);
  const report = renderReport(manifest, results, score);
  if (check) {
    const current = existsSync(reportPath)
      ? await readFile(reportPath, "utf8")
      : undefined;
    if (current !== report) {
      console.error("Golden evaluation report is stale; rerun without --check.");
      process.exitCode = 1;
    }
  } else {
    await writeFile(reportPath, report, "utf8");
  }

  if (
    score.blocking_precision < 0.95 ||
    score.warning_precision < 0.8 ||
    score.false_negatives.length > 0
  ) {
    throw new Error(
      `Precision gate failed: blocking=${score.blocking_precision}, warning=${score.warning_precision}, false_negatives=${score.false_negatives.length}`,
    );
  }
  console.log(
    `neat goldens PASS: scenarios=12 blocking=${percent(score.blocking_precision)} warning=${percent(score.warning_precision)} false_negatives=${score.false_negatives.length}`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function evaluateScenario(scenario) {
  const scenarioRoot = join(workspace, scenario.id);
  await mkdir(scenarioRoot, { recursive: true });
  await writeFiles(scenarioRoot, scenario.files ?? {});
  for (const [path, bytes] of Object.entries(scenario.large_files ?? {})) {
    await writeOne(scenarioRoot, path, "x".repeat(bytes));
  }
  for (const [path, target] of Object.entries(scenario.symlinks ?? {})) {
    const absolutePath = fixturePath(scenarioRoot, path);
    const resolvedTarget = resolve(dirname(absolutePath), target);
    if (!isInside(scenarioRoot, resolvedTarget)) {
      throw new Error(`${scenario.id}: symlink target escapes fixture root`);
    }
    await mkdir(dirname(absolutePath), { recursive: true });
    await symlink(target, absolutePath);
  }
  if (scenario.git) {
    await runGit(scenarioRoot, ["init", "-b", "main"]);
    await runGit(scenarioRoot, ["add", "."]);
    await runGit(scenarioRoot, [
      "-c",
      "user.name=osstack-neat-eval",
      "-c",
      "user.email=osstack-neat-eval@example.invalid",
      "commit",
      "-m",
      "fixture baseline",
    ]);
    await writeFiles(scenarioRoot, scenario.post_commit_files ?? {});
  }

  const args = [cliPath, "neat", "check", "--repo", scenarioRoot, "--json"];
  if (scenario.mode === "all") args.push("--all");
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: scenarioRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  const envelope = JSON.parse(stdout);
  if (envelope.status !== "ok" || envelope.result?.command !== "knowledge_hygiene.check") {
    throw new Error(`${scenario.id}: invalid success envelope`);
  }
  const report = envelope.result.report;
  const actual = report.findings.map(findingKey).sort(compareText);
  const expected = (scenario.expected_findings ?? []).map(findingKey).sort(compareText);
  const labelledFalsePositives = (scenario.expected_false_positives ?? [])
    .map(findingKey)
    .sort(compareText);
  return {
    id: scenario.id,
    class: scenario.class,
    actual,
    expected,
    labelled_false_positives: labelledFalsePositives,
    complete: report.completeness.complete,
  };
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await writeOne(root, path, content);
  }
}

async function writeOne(root, path, content) {
  const absolutePath = fixturePath(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd, timeout: 10_000 });
}

function findingKey(finding) {
  const path = finding.path
    ?? (finding.location?.kind === "repository_scope" ? "." : finding.location?.path);
  return `${finding.severity}|${finding.rule_id}|${path}`;
}

function fixturePath(root, path) {
  const absolutePath = resolve(root, path);
  if (!isInside(root, absolutePath)) {
    throw new Error(`Fixture path escapes repository: ${path}`);
  }
  return absolutePath;
}

function isInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scoreResults(results) {
  const truePositives = [];
  const falsePositives = [];
  const falseNegatives = [];
  for (const result of results) {
    const expected = new Set(result.expected);
    const labelledFalsePositives = new Set(result.labelled_false_positives);
    for (const actual of result.actual) {
      if (expected.has(actual)) truePositives.push(`${result.id}:${actual}`);
      else falsePositives.push(`${result.id}:${actual}`);
      if (!expected.has(actual) && !labelledFalsePositives.has(actual)) {
        throw new Error(`${result.id}: unlabelled false positive ${actual}`);
      }
    }
    for (const expectedFinding of expected) {
      if (!result.actual.includes(expectedFinding)) {
        falseNegatives.push(`${result.id}:${expectedFinding}`);
      }
    }
  }
  const blocking = precisionForSeverity(truePositives, falsePositives, "error");
  const warning = precisionForSeverity(truePositives, falsePositives, "warning");
  return {
    blocking_precision: blocking,
    warning_precision: warning,
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
  };
}

function precisionForSeverity(truePositives, falsePositives, severity) {
  const trueCount = truePositives.filter((value) => value.includes(`:${severity}|`)).length;
  const falseCount = falsePositives.filter((value) => value.includes(`:${severity}|`)).length;
  return trueCount + falseCount === 0 ? 1 : trueCount / (trueCount + falseCount);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function cells(values) {
  return values.length === 0 ? "none" : values.map((value) => `\`${value}\``).join("<br>");
}

function renderReport(sourceManifest, results, score) {
  const lines = [
    "# neat R0 golden evaluation",
    "",
    `Label source: ${sourceManifest.label_source}.`,
    "",
    "The scorer is a separate deterministic process from the production engine and consumes only strict CLI JSON plus the frozen label manifest. The maker also ran this first score, so self-evaluation bias remains declared; release-owner review is still required before publication.",
    "",
    "## Result",
    "",
    "| Metric | Result | Gate |",
    "|---|---:|---:|",
    `| Scenario classes | ${results.length} | 12 |`,
    `| Blocking precision | ${percent(score.blocking_precision)} | >=95% |`,
    `| Warning precision | ${percent(score.warning_precision)} | >=80% |`,
    `| False negatives | ${score.false_negatives.length} | 0 |`,
    "",
    "## Scenario review",
    "",
    "| Scenario | Expected labels | Actual findings | Review |",
    "|---|---|---|---|",
  ];
  for (const result of results) {
    const unexpected = result.actual.filter((value) => !result.expected.includes(value));
    const review = unexpected.length === 0
      ? "matches labels"
      : `labelled false positive: ${cells(unexpected)}`;
    lines.push(
      `| ${result.id}: ${result.class} | ${cells(result.expected)} | ${cells(result.actual)} | ${review} |`,
    );
  }
  lines.push(
    "",
    "## Error analysis",
    "",
    `- False positives: ${cells(score.false_positives)}.`,
    `- False negatives: ${cells(score.false_negatives)}.`,
    "- The sole expected false positive is the R0 change-contract limitation: a real human review without a review-target edit cannot yet be represented. R1 `reviewed_no_change` resolution evidence is the planned closure path.",
    "- No fixture accesses network services, user memory, or the real home directory; every repository is generated under a temporary directory and removed after scoring.",
    "",
    "## Reproduce",
    "",
    "```bash",
    "pnpm eval:neat-goldens",
    "```",
    "",
  );
  return lines.join("\n");
}
