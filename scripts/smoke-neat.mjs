#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "packages", "cli", "dist", "bin.js");

if (!existsSync(cliPath)) {
  console.error(`Missing built CLI at ${cliPath}; run the CLI build first.`);
  process.exit(2);
}

const workspace = await mkdtemp(join(tmpdir(), "osstack-neat-smoke-"));
try {
  await write("AGENTS.md", "# Canonical instructions\n");
  await write("CLAUDE.md", "# Independent instructions\n");
  await write("README.md", "# Sick repository\n\n[guide](docs/missing.md)\n");
  await write("docs/guide.md", "# Maintained guide\n");
  await write(
    ".osstack/neat.yaml",
    [
      "version: 1",
      "instructions:",
      "  canonical: AGENTS.md",
      "  mirrors:",
      "    - { path: CLAUDE.md, mode: import_or_symlink }",
      "",
    ].join("\n"),
  );

  const beforeFirstCheck = await snapshot(workspace);
  const first = await check();
  assertFinding(first, "reference.markdown_target_missing", "agent_edit");
  assertFinding(first, "instruction.mirror_drift", "human_decision");
  assertEqual(
    await snapshot(workspace),
    beforeFirstCheck,
    "the first read-only check changed the fixture",
  );

  await write("README.md", "# Sick repository\n\n[guide](docs/guide.md)\n");

  const beforeSecondCheck = await snapshot(workspace);
  const second = await check();
  if (
    second.findings.some(
      (finding) => finding.rule_id === "reference.markdown_target_missing",
    )
  ) {
    throw new Error("the simulated editorial correction did not close the link finding");
  }
  assertFinding(second, "instruction.mirror_drift", "human_decision");
  if (
    second.summary.error !== 1 ||
    second.summary.warning !== 0 ||
    !second.completeness.complete
  ) {
    throw new Error(`unexpected final report: ${JSON.stringify(second.summary)}`);
  }
  assertEqual(
    await snapshot(workspace),
    beforeSecondCheck,
    "the second read-only check changed the fixture",
  );

  console.log(
    "neat smoke PASS: agent_edit closed, human_decision retained, both checks wrote zero files",
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function write(path, content) {
  const target = resolve(workspace, path);
  if (relative(workspace, target).startsWith("..")) {
    throw new Error(`fixture path escapes workspace: ${path}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function check() {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "neat",
      "check",
      "--repo",
      workspace,
      "--all",
      "--format",
      "json",
      "--fail-on",
      "none",
    ],
    { cwd: workspace, encoding: "utf8", timeout: 10_000 },
  );
  const envelope = JSON.parse(stdout);
  if (
    envelope.status !== "ok" ||
    envelope.result?.command !== "knowledge_hygiene.check" ||
    envelope.result?.report?.schema_version !== "1"
  ) {
    throw new Error("smoke received an invalid knowledge hygiene envelope");
  }
  return envelope.result.report;
}

function assertFinding(report, ruleId, remediationMode) {
  const finding = report.findings.find(
    (candidate) => candidate.rule_id === ruleId,
  );
  if (!finding || finding.remediation.mode !== remediationMode) {
    throw new Error(
      `expected ${ruleId}/${remediationMode}, got ${JSON.stringify(report.findings)}`,
    );
  }
}

async function snapshot(root) {
  const entries = [];
  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = join(directory, child.name);
      const portable = relative(root, path).split("\\").join("/");
      if (child.isDirectory()) {
        entries.push(`directory:${portable}`);
        await walk(path);
      } else if (child.isSymbolicLink()) {
        entries.push(`symlink:${portable}:${await readlink(path)}`);
      } else {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        entries.push(`file:${portable}:${digest}`);
      }
    }
  }
  await walk(root);
  return entries.join("\n");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}
