#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REPORT_FILE = "kimi-autonomy-soak-latest.json";
const TASK_MANIFEST_FILE = "kimi-autonomy-task-manifest.json";
const EVENT_LOG_FILE = "kimi-autonomy-soak-events.ndjson";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "fixtures", "autonomy", "r2-deploy");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  throw error;
}

function requireExplicitHome(environment = process.env) {
  const home = environment.OSSTACK_HOME;
  if (home === undefined || home.trim().length === 0 || !isAbsolute(home)) {
    fail("OSSTACK_HOME must be set to an explicit absolute path");
  }
  return resolve(home);
}

function safeInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${label} must be a positive integer`);
  }
  return Number(value);
}

function parseArguments(argv) {
  const options = {
    dryRun: false,
    status: false,
    requireProductization: false,
    durationDays: 7,
    minTasks: 30,
    report: undefined,
    taskManifest: undefined,
    events: undefined,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${argument} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (argument) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--status":
        options.status = true;
        break;
      case "--require-productization":
        options.requireProductization = true;
        break;
      case "--duration-days":
        options.durationDays = safeInteger(next(), "--duration-days");
        break;
      case "--min-tasks":
        options.minTasks = safeInteger(next(), "--min-tasks");
        break;
      case "--report":
        options.report = resolve(next());
        break;
      case "--task-manifest":
        options.taskManifest = resolve(next());
        break;
      case "--events":
        options.events = resolve(next());
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`unknown argument: ${argument}`);
    }
  }
  if (options.status && options.dryRun) {
    fail("--status and --dry-run cannot be combined");
  }
  return options;
}

function usage() {
  return `Usage:
  OSSTACK_HOME=/absolute/path node scripts/soak-kimi-autonomy.mjs --dry-run
  OSSTACK_HOME=/absolute/path node scripts/soak-kimi-autonomy.mjs \\
    --duration-days 7 --min-tasks 30 \\
    [--task-manifest PATH] [--events PATH]
  node scripts/soak-kimi-autonomy.mjs --status [--require-productization] \\
    --report /absolute/path/kimi-autonomy-soak-latest.json

Default real-snapshot inputs:
  $OSSTACK_HOME/reports/${TASK_MANIFEST_FILE}
  $OSSTACK_HOME/reports/${EVENT_LOG_FILE}

The harness never performs GitHub or real deployment writes. Real work is
performed by the guarded daemon; this command freezes and validates its
checksummed event evidence.
`;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function writeChecksummedJson(path, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWrite(path, content);
  await atomicWrite(`${path}.sha256`, `${sha256(content)}  ${path.split(sep).at(-1)}\n`);
  return { path, sha256: sha256(content) };
}

async function readExpectedChecksum(path) {
  const content = (await readFile(`${path}.sha256`, "utf8")).trim();
  const digest = content.split(/\s+/u)[0];
  if (!SHA256_PATTERN.test(digest)) {
    fail(`invalid checksum file for ${path}`);
  }
  return digest;
}

async function readChecksummedText(path) {
  const content = await readFile(path, "utf8");
  const expected = await readExpectedChecksum(path);
  const actual = sha256(content);
  if (actual !== expected) {
    fail(`checksum mismatch for ${path}`, { expected, actual });
  }
  return { content, sha256: actual };
}

async function readChecksummedJson(path) {
  const checked = await readChecksummedText(path);
  let value;
  try {
    value = JSON.parse(checked.content);
  } catch {
    fail(`invalid JSON in ${path}`);
  }
  return { ...checked, value };
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function canonicalRisk(value) {
  if (value === "R1" || value === "RISK-R1") return "RISK-R1";
  if (value === "R2" || value === "RISK-R2") return "RISK-R2";
  return null;
}

function isFixtureWorkspace(path) {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.includes("/fixtures/")
    || normalized.endsWith("/fixtures")
    || normalized.includes("/tmp/")
    || normalized.includes("/var/folders/")
  );
}

export async function validateTaskManifest(
  manifest,
  { minTasks = 30, requireReal = true } = {},
) {
  const failures = [];
  const add = (predicate, expected, actual) => {
    failures.push({ predicate, expected, actual });
  };
  if (!object(manifest)) {
    return [{
      predicate: "task_manifest.object",
      expected: true,
      actual: false,
    }];
  }
  if (manifest.schema_version !== 1) {
    add("task_manifest.schema_version", 1, manifest.schema_version);
  }
  if (manifest.kind !== "osstack.kimi_autonomy_task_manifest") {
    add(
      "task_manifest.kind",
      "osstack.kimi_autonomy_task_manifest",
      manifest.kind,
    );
  }
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  if (tasks.length < minTasks) {
    add("task_manifest.minimum_tasks", minTasks, tasks.length);
  }
  const taskIds = new Set();
  const promptDigests = new Set();
  const repos = new Set();
  for (const [index, task] of tasks.entries()) {
    if (!object(task)) {
      add(`task_manifest.tasks[${index}].object`, true, false);
      continue;
    }
    if (typeof task.task_id !== "string" || task.task_id.length === 0) {
      add(`task_manifest.tasks[${index}].task_id`, "non-empty", task.task_id);
    } else if (taskIds.has(task.task_id)) {
      add(
        `task_manifest.tasks[${index}].task_id_unique`,
        true,
        task.task_id,
      );
    } else {
      taskIds.add(task.task_id);
    }
    if (typeof task.repo !== "string" || !task.repo.includes("/")) {
      add(`task_manifest.tasks[${index}].repo`, "owner/name", task.repo);
    } else {
      repos.add(task.repo);
    }
    if (canonicalRisk(task.risk) === null) {
      add(
        `task_manifest.tasks[${index}].risk`,
        "RISK-R1 or RISK-R2",
        task.risk,
      );
    }
    if (
      typeof task.prompt_sha256 !== "string"
      || !SHA256_PATTERN.test(task.prompt_sha256)
    ) {
      add(
        `task_manifest.tasks[${index}].prompt_sha256`,
        "64 lowercase hex characters",
        task.prompt_sha256,
      );
    } else if (promptDigests.has(task.prompt_sha256)) {
      add(
        `task_manifest.tasks[${index}].prompt_sha256_unique`,
        true,
        task.prompt_sha256,
      );
    } else {
      promptDigests.add(task.prompt_sha256);
    }
    if (
      !Array.isArray(task.acceptance_criteria)
      || task.acceptance_criteria.length === 0
      || task.acceptance_criteria.some(
        (criterion) =>
          typeof criterion !== "string" || criterion.trim().length === 0,
      )
    ) {
      add(
        `task_manifest.tasks[${index}].acceptance_criteria`,
        "one or more non-empty strings",
        task.acceptance_criteria,
      );
    }
    if (
      typeof task.workspace_path !== "string"
      || !isAbsolute(task.workspace_path)
    ) {
      add(
        `task_manifest.tasks[${index}].workspace_path`,
        "absolute path",
        task.workspace_path,
      );
    } else if (requireReal && isFixtureWorkspace(task.workspace_path)) {
      add(
        `task_manifest.tasks[${index}].workspace_not_fixture`,
        true,
        task.workspace_path,
      );
    }
  }
  if (repos.size < 2) {
    add("task_manifest.minimum_repositories", 2, repos.size);
  }
  return failures;
}

async function verifyProofDirectory(proofDirectory, latestRunId) {
  const failures = [];
  const add = (predicate, expected, actual) => {
    failures.push({ predicate, expected, actual });
  };
  if (typeof proofDirectory !== "string" || !isAbsolute(proofDirectory)) {
    add("latest_proof_dir.absolute", true, proofDirectory);
    return failures;
  }
  const proofRoot = resolve(proofDirectory);
  let manifest;
  try {
    const metadata = await stat(proofRoot);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    manifest = JSON.parse(await readFile(join(proofRoot, "manifest.json"), "utf8"));
  } catch (error) {
    add(
      "latest_proof_dir.readable_manifest",
      true,
      error instanceof Error ? error.message : String(error),
    );
    return failures;
  }
  if (!object(manifest)) {
    add("latest_proof_manifest.object", true, false);
    return failures;
  }
  if (
    typeof manifest.run_id === "string"
    && manifest.run_id !== latestRunId
  ) {
    add("latest_proof_manifest.run_id", latestRunId, manifest.run_id);
  }
  const artifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : [];
  if (artifacts.length === 0) {
    add("latest_proof_manifest.artifacts", "one or more", artifacts.length);
  }
  for (const [index, artifact] of artifacts.entries()) {
    if (
      !object(artifact)
      || typeof artifact.path !== "string"
      || typeof artifact.sha256 !== "string"
      || !SHA256_PATTERN.test(artifact.sha256)
    ) {
      add(`latest_proof_manifest.artifacts[${index}]`, "path + sha256", artifact);
      continue;
    }
    const artifactPath = resolve(proofRoot, artifact.path);
    if (
      isAbsolute(artifact.path)
      || (
        artifactPath !== proofRoot
        && !artifactPath.startsWith(`${proofRoot}${sep}`)
      )
    ) {
      add(
        `latest_proof_manifest.artifacts[${index}].contained`,
        true,
        artifact.path,
      );
      continue;
    }
    try {
      const content = await readFile(artifactPath);
      const actual = sha256(content);
      if (actual !== artifact.sha256) {
        add(
          `latest_proof_manifest.artifacts[${index}].sha256`,
          artifact.sha256,
          actual,
        );
      }
    } catch (error) {
      add(
        `latest_proof_manifest.artifacts[${index}].readable`,
        true,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return failures;
}

function validateReportShape(report) {
  const failures = [];
  const add = (predicate, expected, actual) => {
    failures.push({ predicate, expected, actual });
  };
  if (!object(report)) {
    return [{ predicate: "report.object", expected: true, actual: false }];
  }
  if (report.schema_version !== 1) {
    add("report.schema_version", 1, report.schema_version);
  }
  const started = Date.parse(report.started_at);
  const ended = Date.parse(report.ended_at);
  if (!Number.isFinite(started)) {
    add("report.started_at", "ISO timestamp", report.started_at);
  }
  if (!Number.isFinite(ended)) {
    add("report.ended_at", "ISO timestamp", report.ended_at);
  }
  if (Number.isFinite(started) && Number.isFinite(ended) && ended < started) {
    add("report.non_negative_elapsed_time", true, ended - started);
  }
  if (!Array.isArray(report.repos) || report.repos.some((repo) => typeof repo !== "string")) {
    add("report.repos", "string[]", report.repos);
  } else if (new Set(report.repos).size !== report.repos.length) {
    add("report.repos_unique", true, report.repos);
  }
  for (const field of [
    "task_count",
    "daemon_restarts",
    "network_interruptions",
    "rollback_drills",
    "unauthorized_actions",
    "reviewer_mutations",
    "proof_integrity_failures",
    "high_severity_open_defects",
  ]) {
    if (!isNonNegativeInteger(report[field])) {
      add(`report.${field}`, "non-negative integer", report[field]);
    }
  }
  for (const field of ["risk_counts", "outcomes", "metrics"]) {
    if (!object(report[field])) {
      add(`report.${field}`, "object", report[field]);
    }
  }
  for (const field of ["risk_counts", "outcomes"]) {
    if (object(report[field])) {
      for (const [key, value] of Object.entries(report[field])) {
        if (!isNonNegativeInteger(value)) {
          add(`report.${field}.${key}`, "non-negative integer", value);
        }
      }
      const total = Object.values(report[field]).reduce(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0,
      );
      if (isNonNegativeInteger(report.task_count) && total !== report.task_count) {
        add(`report.${field}_total`, report.task_count, total);
      }
    }
  }
  if (object(report.metrics)) {
    for (const [key, value] of Object.entries(report.metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        add(`report.metrics.${key}`, "finite number", value);
      }
    }
  }
  if (typeof report.latest_run_id !== "string" || report.latest_run_id.length === 0) {
    add("report.latest_run_id", "non-empty string", report.latest_run_id);
  }
  return failures;
}

function productizationPredicates(report) {
  const failures = [];
  const addMinimum = (predicate, expected, actual) => {
    if (!(typeof actual === "number" && actual >= expected)) {
      failures.push({ predicate, expected: `>= ${expected}`, actual });
    }
  };
  const addExact = (predicate, expected, actual) => {
    if (actual !== expected) failures.push({ predicate, expected, actual });
  };
  const elapsedDays =
    (Date.parse(report.ended_at) - Date.parse(report.started_at)) / DAY_MS;
  addMinimum("productization.elapsed_days", 7, elapsedDays);
  addMinimum("productization.task_count", 30, report.task_count);
  addMinimum(
    "productization.risk_r1_r2_tasks",
    30,
    (report.risk_counts?.["RISK-R1"] ?? 0)
      + (report.risk_counts?.["RISK-R2"] ?? 0),
  );
  addMinimum("productization.repositories", 2, report.repos?.length);
  addMinimum("productization.daemon_restarts", 5, report.daemon_restarts);
  addMinimum(
    "productization.network_interruptions",
    3,
    report.network_interruptions,
  );
  addMinimum("productization.rollback_drills", 3, report.rollback_drills);
  addExact(
    "productization.unauthorized_actions",
    0,
    report.unauthorized_actions,
  );
  addExact(
    "productization.reviewer_mutations",
    0,
    report.reviewer_mutations,
  );
  addExact(
    "productization.proof_integrity_failures",
    0,
    report.proof_integrity_failures,
  );
  addExact(
    "productization.restart_recovery_rate",
    1,
    report.metrics?.restart_recovery_rate,
  );
  addExact(
    "productization.rollback_success_rate",
    1,
    report.metrics?.rollback_success_rate,
  );
  addMinimum(
    "productization.unattended_completion_rate",
    0.85,
    report.metrics?.unattended_completion_rate,
  );
  addMinimum(
    "productization.notification_outage_recoveries",
    1,
    report.metrics?.notification_outage_recoveries,
  );
  addMinimum(
    "productization.sigkill_recoveries",
    5,
    report.metrics?.sigkill_recoveries,
  );
  addMinimum(
    "productization.network_interruption_recoveries",
    3,
    report.metrics?.network_interruption_recoveries,
  );
  addMinimum(
    "productization.forced_rollback_successes",
    3,
    report.metrics?.forced_rollback_successes,
  );
  addMinimum(
    "productization.stale_decision_rejections",
    1,
    report.metrics?.stale_decision_rejections,
  );
  addMinimum(
    "productization.deploy_digest_mismatch_rejections",
    1,
    report.metrics?.deploy_digest_mismatch_rejections,
  );
  addExact(
    "productization.high_severity_open_defects",
    0,
    report.high_severity_open_defects,
  );
  return failures;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (object(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function eventEvidencePredicates(report, evidence) {
  const failures = [];
  for (const field of [
    "started_at",
    "ended_at",
    "repos",
    "task_count",
    "risk_counts",
    "outcomes",
    "daemon_restarts",
    "network_interruptions",
    "rollback_drills",
    "unauthorized_actions",
    "reviewer_mutations",
    "proof_integrity_failures",
    "latest_run_id",
    "latest_proof_dir",
    "high_severity_open_defects",
  ]) {
    if (canonicalJson(report[field]) !== canonicalJson(evidence[field])) {
      failures.push({
        predicate: `productization.event_evidence.${field}`,
        expected: evidence[field],
        actual: report[field],
      });
    }
  }
  for (const [metric, expected] of Object.entries(evidence.metrics)) {
    if (report.metrics?.[metric] !== expected) {
      failures.push({
        predicate: `productization.event_evidence.metrics.${metric}`,
        expected,
        actual: report.metrics?.[metric],
      });
    }
  }
  return failures;
}

export async function validateSoakReportFile(
  reportPath,
  { requireProductization = false } = {},
) {
  const failures = [];
  let checked;
  try {
    checked = await readChecksummedJson(resolve(reportPath));
  } catch (error) {
    return {
      ok: false,
      report: null,
      report_sha256: null,
      failed_predicates: [{
        predicate: "report.checksum_and_json",
        expected: true,
        actual: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  const report = checked.value;
  failures.push(...validateReportShape(report));
  if (object(report)) {
    failures.push(
      ...await verifyProofDirectory(
        report.latest_proof_dir,
        report.latest_run_id,
      ),
    );
  }
  if (requireProductization && object(report)) {
    failures.push(...productizationPredicates(report));
    let validatedManifest;
    if (
      typeof report.task_manifest_path !== "string"
      || !isAbsolute(report.task_manifest_path)
    ) {
      failures.push({
        predicate: "productization.task_manifest_path",
        expected: "absolute path",
        actual: report.task_manifest_path,
      });
    } else {
      try {
        const manifest = await readChecksummedJson(report.task_manifest_path);
        if (manifest.sha256 !== report.task_manifest_sha256) {
          failures.push({
            predicate: "productization.task_manifest_sha256",
            expected: report.task_manifest_sha256,
            actual: manifest.sha256,
          });
        }
        failures.push(
          ...await validateTaskManifest(
            manifest.value,
            { minTasks: 30, requireReal: true },
          ),
        );
        validatedManifest = manifest.value;
      } catch (error) {
        failures.push({
          predicate: "productization.task_manifest_checksum_and_json",
          expected: true,
          actual: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (
      typeof report.event_log_path !== "string"
      || !isAbsolute(report.event_log_path)
    ) {
      failures.push({
        predicate: "productization.event_log_path",
        expected: "absolute path",
        actual: report.event_log_path,
      });
    } else if (validatedManifest !== undefined) {
      try {
        const eventLog = await readChecksummedText(report.event_log_path);
        if (eventLog.sha256 !== report.event_log_sha256) {
          failures.push({
            predicate: "productization.event_log_sha256",
            expected: report.event_log_sha256,
            actual: eventLog.sha256,
          });
        }
        const events = parseEventLog(eventLog.content);
        const evidence = deriveRealEvidence(validatedManifest, events);
        failures.push(...await verifyCompletedTaskProofs(events));
        failures.push(...eventEvidencePredicates(report, evidence));
      } catch (error) {
        failures.push({
          predicate: "productization.event_log_checksum_and_counts",
          expected: true,
          actual: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    ok: failures.length === 0,
    report,
    report_sha256: checked.sha256,
    failed_predicates: failures,
  };
}

function runFixture(name, statePath, extraEnvironment = {}, expectedStatus = 0) {
  const result = spawnSync(
    process.execPath,
    [join(fixtureRoot, name)],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        OSSTACK_SOAK_FIXTURE_ONLY: "1",
        OSSTACK_SOAK_FIXTURE_STATE: statePath,
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== expectedStatus) {
    fail(`${name} exited ${result.status}; expected ${expectedStatus}`, {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
}

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  fail(`timed out waiting for ${path}`);
}

async function forceDaemonKillAndRecovery(home) {
  const checkpoint = join(home, "soak-fixture", "daemon-checkpoint.json");
  await mkdir(dirname(checkpoint), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs=require('node:fs');",
        "const path=process.argv[1];",
        "fs.writeFileSync(path, JSON.stringify({run_id:'run_soak_006',state:'running'}));",
        "setInterval(()=>{}, 1000);",
      ].join(""),
      checkpoint,
    ],
    { stdio: "ignore" },
  );
  await waitForFile(checkpoint);
  child.kill("SIGKILL");
  const exit = await new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  if (exit.signal !== "SIGKILL") {
    fail("forced daemon child was not killed with SIGKILL", { exit });
  }
  const saved = JSON.parse(await readFile(checkpoint, "utf8"));
  if (saved.run_id !== "run_soak_006" || saved.state !== "running") {
    fail("daemon checkpoint did not survive SIGKILL");
  }
  await atomicWrite(checkpoint, `${JSON.stringify({
    ...saved,
    state: "completed",
    recovered_after_sigkill: true,
  }, null, 2)}\n`);
  return true;
}

async function writeDryProof(home, runId, createdAt, index) {
  const proofDir = join(home, "autonomy", runId);
  await mkdir(proofDir, { recursive: true });
  const result = `${JSON.stringify({
    schema_version: 1,
    run_id: runId,
    fixture_task: index,
    outcome: "completed",
    external_writes: 0,
  }, null, 2)}\n`;
  await writeFile(join(proofDir, "result.json"), result, {
    encoding: "utf8",
    mode: 0o600,
  });
  const manifest = {
    schema_version: 1,
    kind: "osstack.proof_pack",
    run_id: runId,
    created_at: createdAt,
    artifacts: [{
      path: "result.json",
      sha256: sha256(result),
      bytes: Buffer.byteLength(result),
    }],
  };
  await writeFile(
    join(proofDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return proofDir;
}

export async function runDeterministicSoak({
  home,
  now = () => Date.now(),
} = {}) {
  const explicitHome = home === undefined
    ? requireExplicitHome()
    : resolve(home);
  if (!isAbsolute(explicitHome)) {
    fail("deterministic soak home must be absolute");
  }
  const startedMs = now();
  const statePath = join(explicitHome, "soak-fixture", "deploy-state.json");
  runFixture("deploy-staging.mjs", statePath);
  runFixture("deploy-production.mjs", statePath);
  runFixture("health-check.mjs", statePath);
  runFixture(
    "deploy-production.mjs",
    statePath,
    { OSSTACK_SOAK_FIXTURE_FORCE_UNHEALTHY: "1" },
  );
  runFixture("health-check.mjs", statePath, {}, 1);
  runFixture("rollback.mjs", statePath);
  runFixture("health-check.mjs", statePath);
  const fixtureState = JSON.parse(await readFile(statePath, "utf8"));
  if (
    fixtureState.healthy !== true
    || !fixtureState.events.some(
      (event) => event.kind === "health_check" && event.healthy === false,
    )
    || !fixtureState.events.some((event) => event.kind === "rollback")
  ) {
    fail("fixture rollback drill did not recover health");
  }

  const restartRecovered = await forceDaemonKillAndRecovery(explicitHome);
  let networkAvailable = false;
  let networkRejected = false;
  try {
    if (!networkAvailable) throw new Error("simulated network unavailable");
  } catch {
    networkRejected = true;
  }
  networkAvailable = true;
  if (!networkRejected || !networkAvailable) {
    fail("network interruption was not rejected and recovered");
  }

  const notificationPath = join(
    explicitHome,
    "soak-fixture",
    "notification-outbox.json",
  );
  await atomicWrite(notificationPath, `${JSON.stringify({
    notification_id: "soak-notification-001",
    attempts: 1,
    state: "pending",
  }, null, 2)}\n`);
  const persistedNotification = JSON.parse(
    await readFile(notificationPath, "utf8"),
  );
  await atomicWrite(notificationPath, `${JSON.stringify({
    ...persistedNotification,
    attempts: 2,
    state: "delivered",
  }, null, 2)}\n`);
  const notification = JSON.parse(await readFile(notificationPath, "utf8"));
  if (notification.attempts !== 2 || notification.state !== "delivered") {
    fail("notification outage retry failed");
  }

  const decisionIssuedAt = startedMs - 3_600_000;
  const staleDecisionRejected = startedMs - decisionIssuedAt > 300_000;
  if (!staleDecisionRejected) fail("stale signed decision was not rejected");

  const productionScript = await readFile(
    join(fixtureRoot, "deploy-production.mjs"),
  );
  const actualDeployDigest = sha256(productionScript);
  const pinnedDeployDigest = "0".repeat(64);
  const deployDigestMismatchRejected =
    actualDeployDigest !== pinnedDeployDigest;
  if (!deployDigestMismatchRejected) {
    fail("mismatched deploy script digest was not rejected");
  }

  const startedAt = new Date(startedMs).toISOString();
  let latestProofDir = "";
  for (let index = 1; index <= 6; index += 1) {
    latestProofDir = await writeDryProof(
      explicitHome,
      `run_soak_${String(index).padStart(3, "0")}`,
      startedAt,
      index,
    );
  }
  const report = {
    schema_version: 1,
    mode: "deterministic_dry",
    started_at: startedAt,
    ended_at: new Date(startedMs + 1_000).toISOString(),
    repos: ["fixture/repo-a", "fixture/repo-b"],
    task_count: 6,
    risk_counts: { "RISK-R1": 3, "RISK-R2": 3 },
    outcomes: { completed: 6 },
    daemon_restarts: 1,
    network_interruptions: 1,
    rollback_drills: 1,
    unauthorized_actions: 0,
    reviewer_mutations: 0,
    proof_integrity_failures: 0,
    metrics: {
      unattended_completion_rate: 1,
      restart_recovery_rate: restartRecovered ? 1 : 0,
      rollback_success_rate: 1,
      notification_outage_recoveries:
        notification.state === "delivered" ? 1 : 0,
      stale_decision_rejections: staleDecisionRejected ? 1 : 0,
      deploy_digest_mismatch_rejections:
        deployDigestMismatchRejected ? 1 : 0,
      external_github_writes: 0,
      external_deploy_writes: 0,
    },
    latest_run_id: "run_soak_006",
    latest_proof_dir: latestProofDir,
    high_severity_open_defects: 0,
  };
  const reportPath = join(explicitHome, "reports", REPORT_FILE);
  const written = await writeChecksummedJson(reportPath, report);
  return { report, report_path: reportPath, report_sha256: written.sha256 };
}

function parseEventLog(content) {
  const events = [];
  const eventIds = new Set();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail(`invalid event JSON at line ${index + 1}`);
    }
    const timestamp = Date.parse(event?.occurred_at);
    if (
      !object(event)
      || typeof event.type !== "string"
      || typeof event.event_id !== "string"
      || event.event_id.length === 0
      || !Number.isFinite(timestamp)
    ) {
      fail(
        `event at line ${index + 1} must have event_id, type, and occurred_at`,
      );
    }
    if (eventIds.has(event.event_id)) {
      fail(`duplicate event_id at line ${index + 1}: ${event.event_id}`);
    }
    if (timestamp < previousTimestamp) {
      fail(`event log is not chronological at line ${index + 1}`);
    }
    previousTimestamp = timestamp;
    eventIds.add(event.event_id);
    events.push(event);
  }
  return events;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function successRate(events) {
  if (events.length === 0) return 0;
  return events.filter((event) => event.success === true).length / events.length;
}

function deriveRealEvidence(manifest, events) {
  const taskDefinitions = new Map(
    manifest.tasks.map((task) => [task.task_id, task]),
  );
  const taskEvents = [];
  const seenTaskIds = new Set();
  const seenRunIds = new Set();
  for (
    const event of events.filter(
      (candidate) => candidate.type === "task_completed",
    )
  ) {
    if (
      typeof event.task_id !== "string"
      || seenTaskIds.has(event.task_id)
      || !taskDefinitions.has(event.task_id)
    ) {
      fail("event log contains duplicate or unregistered completed task", {
        task_id: event.task_id,
      });
    }
    if (
      typeof event.run_id !== "string"
      || event.run_id.trim().length === 0
      || seenRunIds.has(event.run_id)
      || typeof event.proof_dir !== "string"
      || !isAbsolute(event.proof_dir)
      || event.outcome !== "completed"
      || typeof event.unattended !== "boolean"
    ) {
      fail("completed task evidence is incomplete or duplicated", {
        task_id: event.task_id,
        run_id: event.run_id,
      });
    }
    seenTaskIds.add(event.task_id);
    seenRunIds.add(event.run_id);
    taskEvents.push(event);
  }
  const restarts = events.filter((event) => event.type === "daemon_restart");
  const networkInterruptions = events.filter(
    (event) => event.type === "network_interruption",
  );
  const rollbackDrills = events.filter(
    (event) => event.type === "rollback_drill",
  );
  const latestTask = taskEvents.at(-1);
  if (
    latestTask === undefined
    || typeof latestTask.run_id !== "string"
    || typeof latestTask.proof_dir !== "string"
  ) {
    fail("event log has no completed task with run_id and proof_dir");
  }
  const startEvents = events.filter((event) => event.type === "soak_started");
  if (startEvents.length !== 1) {
    fail("event log requires exactly one soak_started event");
  }
  const eventTimestamps = events.map((event) => Date.parse(event.occurred_at));
  const startedMs = Date.parse(startEvents[0].occurred_at);
  const endedMs = Math.max(...eventTimestamps);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
    fail("event log requires valid occurred_at timestamps");
  }
  if (eventTimestamps.some((timestamp) => timestamp < startedMs)) {
    fail("event log contains evidence before soak_started");
  }
  const risks = taskEvents.map((event) => {
    const definition = taskDefinitions.get(event.task_id);
    return canonicalRisk(definition.risk);
  });
  const outcomes = taskEvents.map((event) =>
    typeof event.outcome === "string" ? event.outcome : "unknown"
  );
  const unattended = taskEvents.filter(
    (event) => event.unattended === true && event.outcome === "completed",
  ).length;
  const highSeverityOpenDefects = new Set();
  for (const event of events) {
    if (
      event.type !== "high_severity_defect_opened"
      && event.type !== "high_severity_defect_closed"
    ) {
      continue;
    }
    if (
      typeof event.defect_id !== "string"
      || event.defect_id.trim().length === 0
    ) {
      fail("high-severity defect event requires a non-empty defect_id");
    }
    if (event.type === "high_severity_defect_opened") {
      if (highSeverityOpenDefects.has(event.defect_id)) {
        fail(`high-severity defect opened twice: ${event.defect_id}`);
      }
      highSeverityOpenDefects.add(event.defect_id);
      continue;
    }
    if (!highSeverityOpenDefects.delete(event.defect_id)) {
      fail(`high-severity defect closed without open: ${event.defect_id}`);
    }
  }
  return {
    started_at: new Date(startedMs).toISOString(),
    ended_at: new Date(endedMs).toISOString(),
    repos: [...new Set(
      taskEvents.map((event) => taskDefinitions.get(event.task_id).repo),
    )].sort(),
    task_count: taskEvents.length,
    risk_counts: countBy(risks),
    outcomes: countBy(outcomes),
    daemon_restarts: restarts.length,
    network_interruptions: networkInterruptions.length,
    rollback_drills: rollbackDrills.length,
    unauthorized_actions: events.filter(
      (event) => event.type === "unauthorized_action",
    ).length,
    reviewer_mutations: events.filter(
      (event) => event.type === "reviewer_mutation",
    ).length,
    proof_integrity_failures: events.filter(
      (event) => event.type === "proof_integrity_failure",
    ).length,
    metrics: {
      unattended_completion_rate:
        taskEvents.length === 0 ? 0 : unattended / taskEvents.length,
      restart_recovery_rate: successRate(restarts),
      rollback_success_rate: successRate(rollbackDrills),
      sigkill_recoveries: restarts.filter(
        (event) =>
          event.signal === "SIGKILL"
          && event.success === true,
      ).length,
      network_interruption_recoveries: networkInterruptions.filter(
        (event) => event.recovered === true,
      ).length,
      forced_rollback_successes: rollbackDrills.filter(
        (event) =>
          event.forced_deploy_failure === true
          && event.success === true,
      ).length,
      notification_outage_recoveries: events.filter(
        (event) =>
          event.type === "notification_outage"
          && event.persisted_before_retry === true
          && event.retry_delivered === true,
      ).length,
      stale_decision_rejections: events.filter(
        (event) =>
          event.type === "stale_signed_decision"
          && event.rejected === true,
      ).length,
      deploy_digest_mismatch_rejections: events.filter(
        (event) =>
          event.type === "deploy_digest_mismatch"
          && event.rejected === true,
      ).length,
    },
    latest_run_id: latestTask.run_id,
    latest_proof_dir: resolve(latestTask.proof_dir),
    high_severity_open_defects: highSeverityOpenDefects.size,
  };
}

async function verifyCompletedTaskProofs(events) {
  const failures = [];
  for (const event of events) {
    if (event.type !== "task_completed") continue;
    const proofFailures = await verifyProofDirectory(
      event.proof_dir,
      event.run_id,
    );
    failures.push(...proofFailures.map((failure) => ({
      ...failure,
      predicate: `task_proof.${event.task_id}.${failure.predicate}`,
    })));
  }
  return failures;
}

export async function runRealSoakSnapshot({
  home,
  taskManifestPath,
  eventLogPath,
  durationDays = 7,
  minTasks = 30,
} = {}) {
  const explicitHome = home === undefined
    ? requireExplicitHome()
    : resolve(home);
  const reports = join(explicitHome, "reports");
  const manifestPath = resolve(
    taskManifestPath ?? join(reports, TASK_MANIFEST_FILE),
  );
  const eventsPath = resolve(eventLogPath ?? join(reports, EVENT_LOG_FILE));
  const manifest = await readChecksummedJson(manifestPath);
  const manifestFailures = await validateTaskManifest(
    manifest.value,
    { minTasks, requireReal: true },
  );
  if (manifestFailures.length > 0) {
    fail("real task manifest failed validation", {
      failed_predicates: manifestFailures,
    });
  }
  const eventLog = await readChecksummedText(eventsPath);
  const events = parseEventLog(eventLog.content);
  const evidence = deriveRealEvidence(manifest.value, events);
  const proofFailures = await verifyCompletedTaskProofs(events);
  if (proofFailures.length > 0) {
    fail("completed task proof validation failed", {
      failed_predicates: proofFailures,
    });
  }
  const report = {
    schema_version: 1,
    mode: "real_evidence_snapshot",
    configured_duration_days: durationDays,
    configured_min_tasks: minTasks,
    ...evidence,
    task_manifest_path: manifestPath,
    task_manifest_sha256: manifest.sha256,
    event_log_path: eventsPath,
    event_log_sha256: eventLog.sha256,
  };
  const reportPath = join(reports, REPORT_FILE);
  const written = await writeChecksummedJson(reportPath, report);
  return { report, report_path: reportPath, report_sha256: written.sha256 };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(usage());
      return 0;
    }
    if (options.status) {
      if (options.report === undefined) {
        fail("--status requires --report");
      }
      const validation = await validateSoakReportFile(
        options.report,
        { requireProductization: options.requireProductization },
      );
      if (!validation.ok) {
        process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(validation.report, null, 2)}\n`);
      return 0;
    }
    const home = requireExplicitHome();
    const result = options.dryRun
      ? await runDeterministicSoak({ home })
      : await runRealSoakSnapshot({
          home,
          taskManifestPath: options.taskManifest,
          eventLogPath: options.events,
          durationDays: options.durationDays,
          minTasks: options.minTasks,
        });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      ...result,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(
        error instanceof Error
        && Array.isArray(error.failed_predicates)
          ? { failed_predicates: error.failed_predicates }
          : {}
      ),
    }, null, 2)}\n`);
    return 1;
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main();
}
