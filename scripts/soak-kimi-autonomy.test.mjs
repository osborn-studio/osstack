import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runDeterministicSoak,
  runRealSoakSnapshot,
  sha256,
  validateSoakReportFile,
  validateTaskManifest,
} from "./soak-kimi-autonomy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "soak-kimi-autonomy.mjs");
const fixtureRoot = join(root, "fixtures", "autonomy", "r2-deploy");

async function temporaryHome(label) {
  return mkdtemp(join(tmpdir(), `osstack-${label}-`));
}

async function writeChecksummed(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    `${path}.sha256`,
    `${sha256(content)}  ${path.split("/").at(-1)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function writeProof(home, runId) {
  const proofDir = join(home, "autonomy", runId);
  await mkdir(proofDir, { recursive: true });
  const result = `${JSON.stringify({ run_id: runId, outcome: "completed" })}\n`;
  await writeFile(join(proofDir, "result.json"), result);
  await writeFile(join(proofDir, "manifest.json"), `${JSON.stringify({
    schema_version: 1,
    kind: "osstack.proof_pack",
    run_id: runId,
    artifacts: [{
      path: "result.json",
      sha256: sha256(result),
      bytes: Buffer.byteLength(result),
    }],
  }, null, 2)}\n`);
  return proofDir;
}

function realTaskManifest() {
  return {
    schema_version: 1,
    kind: "osstack.kimi_autonomy_task_manifest",
    created_at: "2026-07-28T00:00:00.000Z",
    tasks: Array.from({ length: 30 }, (_, index) => ({
      task_id: `real-task-${String(index + 1).padStart(2, "0")}`,
      repo: index % 2 === 0 ? "owner/repo-a" : "owner/repo-b",
      risk: index % 2 === 0 ? "RISK-R1" : "RISK-R2",
      prompt_sha256: sha256(`unique-real-prompt-${index + 1}`),
      acceptance_criteria: [`criterion ${index + 1}`],
      workspace_path:
        index % 2 === 0
          ? "/Volumes/AIMATE_WORK/Developer/CodeX/worktrees/soak-repo-a"
          : "/Volumes/AIMATE_WORK/Developer/CodeX/worktrees/soak-repo-b",
    })),
  };
}

function event(at, type, details = {}) {
  return {
    event_id: sha256(`${at}:${type}:${JSON.stringify(details)}`).slice(0, 24),
    occurred_at: at,
    type,
    ...details,
  };
}

async function writeProductizationEvidence(home) {
  const reports = join(home, "reports");
  const manifestPath = join(reports, "kimi-autonomy-task-manifest.json");
  const manifest = realTaskManifest();
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeChecksummed(manifestPath, manifestContent);

  const started = Date.parse("2026-07-20T00:00:00.000Z");
  const events = [
    event(new Date(started).toISOString(), "soak_started"),
  ];
  let latestProofDir = "";
  for (let index = 1; index <= 30; index += 1) {
    const runId = `run_real_${String(index).padStart(3, "0")}`;
    latestProofDir = await writeProof(home, runId);
    events.push(event(
      new Date(started + index * 60_000).toISOString(),
      "task_completed",
      {
        task_id: `real-task-${String(index).padStart(2, "0")}`,
        run_id: runId,
        proof_dir: latestProofDir,
        outcome: "completed",
        unattended: index <= 27,
      },
    ));
  }
  for (let index = 1; index <= 5; index += 1) {
    events.push(event(
      new Date(started + index * 86_400_000).toISOString(),
      "daemon_restart",
      { signal: "SIGKILL", success: true },
    ));
  }
  for (let index = 1; index <= 3; index += 1) {
    events.push(event(
      new Date(started + 5 * 86_400_000 + index * 3_600_000).toISOString(),
      "network_interruption",
      { recovered: true },
    ));
    events.push(event(
      new Date(
        started + 5 * 86_400_000 + index * 3_600_000 + 1_000,
      ).toISOString(),
      "rollback_drill",
      { forced_deploy_failure: true, success: true },
    ));
  }
  events.push(
    event(
      new Date(started + 6 * 86_400_000).toISOString(),
      "notification_outage",
      { persisted_before_retry: true, retry_delivered: true },
    ),
    event(
      new Date(started + 6 * 86_400_000).toISOString(),
      "stale_signed_decision",
      { rejected: true },
    ),
    event(
      new Date(started + 6 * 86_400_000).toISOString(),
      "deploy_digest_mismatch",
      { rejected: true },
    ),
    event(
      new Date(started + 7 * 86_400_000).toISOString(),
      "soak_observation",
      { state: "complete" },
    ),
  );
  const eventsPath = join(reports, "kimi-autonomy-soak-events.ndjson");
  await writeChecksummed(
    eventsPath,
    `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return { manifestPath, eventsPath, latestProofDir };
}

test("deterministic dry soak exercises local faults and writes atomic evidence", async () => {
  const home = await temporaryHome("soak-dry");
  const fixedNow = Date.parse("2026-07-28T00:00:00.000Z");
  const result = await runDeterministicSoak({
    home,
    now: () => fixedNow,
  });

  assert.equal(result.report.task_count, 6);
  assert.deepEqual(result.report.risk_counts, {
    "RISK-R1": 3,
    "RISK-R2": 3,
  });
  assert.equal(result.report.daemon_restarts, 1);
  assert.equal(result.report.network_interruptions, 1);
  assert.equal(result.report.rollback_drills, 1);
  assert.equal(result.report.metrics.restart_recovery_rate, 1);
  assert.equal(result.report.metrics.rollback_success_rate, 1);
  assert.equal(result.report.metrics.notification_outage_recoveries, 1);
  assert.equal(result.report.metrics.stale_decision_rejections, 1);
  assert.equal(result.report.metrics.deploy_digest_mismatch_rejections, 1);
  assert.equal(result.report.metrics.external_github_writes, 0);
  assert.equal(result.report.metrics.external_deploy_writes, 0);

  const validation = await validateSoakReportFile(result.report_path);
  assert.equal(validation.ok, true, JSON.stringify(validation.failed_predicates));
  const fixtureState = JSON.parse(
    await readFile(join(home, "soak-fixture", "deploy-state.json"), "utf8"),
  );
  assert.equal(fixtureState.healthy, true);
  assert.ok(fixtureState.events.some((entry) => entry.kind === "rollback"));
  assert.match(
    await readFile(`${result.report_path}.sha256`, "utf8"),
    /^[a-f0-9]{64}\s+/u,
  );
});

test("deploy fixtures refuse execution outside the explicit local fixture boundary", () => {
  const result = spawnSync(
    process.execPath,
    [join(fixtureRoot, "deploy-production.mjs")],
    {
      encoding: "utf8",
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OSSTACK_SOAK_FIXTURE_ONLY=1/u);
});

test("status validation rejects report tampering without mutating the report", async () => {
  const home = await temporaryHome("soak-tamper");
  const result = await runDeterministicSoak({
    home,
    now: () => Date.parse("2026-07-28T00:00:00.000Z"),
  });
  await writeFile(result.report_path, `${await readFile(result.report_path, "utf8")} `);
  const before = await readFile(result.report_path);
  const beforeStat = await stat(result.report_path);

  const validation = await validateSoakReportFile(result.report_path);

  assert.equal(validation.ok, false);
  assert.equal(
    validation.failed_predicates[0].predicate,
    "report.checksum_and_json",
  );
  assert.deepEqual(await readFile(result.report_path), before);
  assert.equal((await stat(result.report_path)).mtimeMs, beforeStat.mtimeMs);
});

test("real evidence snapshot and read-only productization gate accept all thresholds", async () => {
  const home = await temporaryHome("soak-real");
  const { manifestPath, eventsPath } =
    await writeProductizationEvidence(home);
  const realCli = spawnSync(
    process.execPath,
    [
      script,
      "--duration-days",
      "7",
      "--min-tasks",
      "30",
      "--task-manifest",
      manifestPath,
      "--events",
      eventsPath,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { OSSTACK_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(realCli.status, 0, realCli.stdout);
  const result = JSON.parse(realCli.stdout);
  assert.equal(result.ok, true);

  assert.equal(result.report.task_count, 30);
  assert.equal(result.report.repos.length, 2);
  assert.equal(result.report.daemon_restarts, 5);
  assert.equal(result.report.network_interruptions, 3);
  assert.equal(result.report.rollback_drills, 3);
  assert.equal(result.report.metrics.unattended_completion_rate, 0.9);

  const before = await readFile(result.report_path);
  const beforeStat = await stat(result.report_path);
  const validation = await validateSoakReportFile(result.report_path, {
    requireProductization: true,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.failed_predicates));
  assert.deepEqual(await readFile(result.report_path), before);
  assert.equal((await stat(result.report_path)).mtimeMs, beforeStat.mtimeMs);

  const cli = spawnSync(
    process.execPath,
    [
      script,
      "--status",
      "--require-productization",
      "--report",
      result.report_path,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {},
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(cli.status, 0, cli.stdout);
  assert.equal(JSON.parse(cli.stdout).task_count, 30);
  assert.deepEqual(await readFile(result.report_path), before);
});

test("productization gate fails closed on missing v3 fault evidence", async () => {
  const home = await temporaryHome("soak-v3-fail");
  const { manifestPath, eventsPath } =
    await writeProductizationEvidence(home);
  const result = await runRealSoakSnapshot({
    home,
    taskManifestPath: manifestPath,
    eventLogPath: eventsPath,
  });
  const report = {
    ...result.report,
    metrics: {
      ...result.report.metrics,
      stale_decision_rejections: 0,
      deploy_digest_mismatch_rejections: 0,
    },
  };
  const content = `${JSON.stringify(report, null, 2)}\n`;
  await writeChecksummed(result.report_path, content);

  const validation = await validateSoakReportFile(result.report_path, {
    requireProductization: true,
  });

  assert.equal(validation.ok, false);
  const rejectionFailures = validation.failed_predicates.map(
    (failure) => failure.predicate,
  );
  assert.ok(
    rejectionFailures.includes("productization.stale_decision_rejections"),
  );
  assert.ok(
    rejectionFailures.includes(
      "productization.deploy_digest_mismatch_rejections",
    ),
  );
  assert.ok(
    rejectionFailures.includes(
      "productization.event_evidence.metrics.stale_decision_rejections",
    ),
  );
});

test("real task manifest rejects duplicate prompts and fixture workspaces", async () => {
  const manifest = realTaskManifest();
  manifest.tasks[1].prompt_sha256 = manifest.tasks[0].prompt_sha256;
  manifest.tasks[2].workspace_path =
    "/Volumes/AIMATE_WORK/Developer/CodeX/osstack/fixtures/repo";

  const failures = await validateTaskManifest(manifest, {
    minTasks: 30,
    requireReal: true,
  });

  assert.ok(
    failures.some(
      (failure) =>
        failure.predicate ===
          "task_manifest.tasks[1].prompt_sha256_unique",
    ),
  );
  assert.ok(
    failures.some(
      (failure) =>
        failure.predicate ===
          "task_manifest.tasks[2].workspace_not_fixture",
    ),
  );
});

test("real snapshot rejects replayed event identifiers", async () => {
  const home = await temporaryHome("soak-replay");
  const { manifestPath, eventsPath } =
    await writeProductizationEvidence(home);
  const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
  const replayed = `${lines.join("\n")}\n${lines[1]}\n`;
  await writeChecksummed(eventsPath, replayed);

  await assert.rejects(
    runRealSoakSnapshot({
      home,
      taskManifestPath: manifestPath,
      eventLogPath: eventsPath,
    }),
    /duplicate event_id/u,
  );
});

test("CLI requires an explicit serving home and reports machine-readable failure", () => {
  const environment = { ...process.env };
  delete environment.OSSTACK_HOME;
  const result = spawnSync(
    process.execPath,
    [script, "--dry-run"],
    {
      cwd: root,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    error: "OSSTACK_HOME must be set to an explicit absolute path",
  });
});
