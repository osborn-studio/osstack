import { connect } from "node:net";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import {
  createAutonomyRun,
  enqueueAutonomyNotification,
  getNotification,
  transitionAutonomyRun,
} from "@osstack/core";
import { guardedOpenDb } from "./guarded-open-db.js";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import type { AutonomyHealthReport } from "./autonomy-health.js";

let tmp: string;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;

function healthyAutonomyHealth(
  overrides: Partial<AutonomyHealthReport> = {},
): AutonomyHealthReport {
  return {
    ok: true,
    can_run_local: true,
    can_merge: true,
    can_push_deploy: true,
    drain_required: false,
    disk_free_bytes: 20 * 1024 ** 3,
    checks: [],
    active_freezes: [],
    resumable_runs: [],
    proof_failures: [],
    notification_outbox: {
      pending_count: 0,
      dead_letter_count: 0,
      oldest_pending_at: null,
      oldest_dead_letter_at: null,
      oldest_attention_age_seconds: 0,
    },
    host_evidence: {
      power_policy: {
        mode: "process_assertion",
        assertion_active: true,
        recorded: true,
      },
      clock_monitor: {
        mode: "monotonic-v1",
        active: true,
      },
      retention: {
        checked_at: 1,
        max_log_bytes: 25 * 1024 ** 2,
        max_log_files: 5,
        proof_retention_days: 30,
        proof_min_keep: 100,
        largest_log_bytes: 0,
        oversized_log_count: 0,
        expired_terminal_proof_count: 0,
        rotated_logs: [],
        removed_proof_dirs: [],
      },
      launchd: {
        required: true,
        loaded: true,
        print_sha256: "a".repeat(64),
      },
    },
    external_blockers: [],
    write_blockers: [],
    next_actions: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-daemon-loop-"));
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  daemon = null;
});

afterEach(async () => {
  if (daemon) await daemon.close();
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  await rm(tmp, { recursive: true, force: true });
});

describe("daemon loop RPC", () => {
  it("routes guarded autonomy resume through the daemon socket", async () => {
    const resumed: string[] = [];
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      autonomyHealth: async () => healthyAutonomyHealth(),
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId) => {
          resumed.push(autonomyRunId);
          return {
            status: "completed",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "completed",
              revision: 7,
              context: {},
            },
          };
        },
      }),
    });
    const runtimeDb = guardedOpenDb({ path: daemon.dbPath });
    createAutonomyRun(runtimeDb, daemon.dbPath, {
      autonomy_run_id: "run-daemon-restart",
      transition_id: "run-daemon-restart:queued",
      task_id: "task-daemon-restart",
      repo_id: "owner/repo",
      workspace_path: join(tmp, "workspace"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    runtimeDb.close();

    const health = await daemonRpc(
      daemon.socketPath,
      "autonomy.health",
    );
    expect(health.ok).toBe(true);
    const response = await daemonRpc(
      daemon.socketPath,
      "autonomy.resume",
      { autonomy_run_id: "run-daemon-restart" },
    );

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      status: "completed",
      run: {
        autonomy_run_id: "run-daemon-restart",
        state: "completed",
      },
    });
    expect(resumed).toEqual(["run-daemon-restart"]);
  });

  it("waits for guarded autonomy boot recovery before closing its database", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const seedDb = guardedOpenDb({ path: dbPath });
    createAutonomyRun(seedDb, dbPath, {
      autonomy_run_id: "run-boot-recovery",
      transition_id: "run-boot-recovery:queued",
      task_id: "task-boot-recovery",
      repo_id: "owner/repo",
      workspace_path: join(tmp, "workspace"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    seedDb.close();

    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let markRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    let recoveryOptions: { recoveryKind?: "restart" } | undefined;
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      autonomyHealth: async () => healthyAutonomyHealth(),
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId, _decision, options) => {
          recoveryOptions = options;
          markRecoveryStarted();
          await recoveryGate;
          return {
            status: "completed",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "completed",
              revision: 2,
              context: {},
            },
          };
        },
      }),
    });
    await recoveryStarted;
    expect(recoveryOptions).toEqual({ recoveryKind: "restart" });

    let closed = false;
    const closing = daemon.close().then(() => {
      closed = true;
    });
    await sleep(20);
    expect(closed).toBe(false);

    releaseRecovery();
    await closing;
    daemon = null;
    expect(closed).toBe(true);
  });

  it("drains durable Owner notifications after daemon restart", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const seedDb = guardedOpenDb({ path: dbPath });
    createAutonomyRun(seedDb, dbPath, {
      autonomy_run_id: "run-notification-restart",
      transition_id: "run-notification-restart:queued",
      task_id: "task-notification-restart",
      repo_id: "owner/repo",
      workspace_path: join(tmp, "workspace"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    const notificationId = enqueueAutonomyNotification(seedDb, dbPath, {
      kind: "escalated",
      autonomy_run_id: "run-notification-restart",
      repo_id: "owner/repo",
      run_state: "escalated",
      source_transition_id: "run-notification-restart:escalated",
      occurred_at: 2,
    }).notification_id;
    seedDb.close();

    const delivered: string[] = [];
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      healthPollIntervalMs: 20,
      notificationSender: {
        send: async (message) => {
          delivered.push(message.notification_id);
        },
      },
    });
    const deadline = Date.now() + 2_000;
    let persistedStatus: string | undefined;
    let persistedAttemptCount: number | undefined;
    while (Date.now() < deadline) {
      const inspectDb = guardedOpenDb({ path: dbPath });
      const row = getNotification(inspectDb, notificationId);
      inspectDb.close();
      persistedStatus = row?.status;
      persistedAttemptCount = row?.attempt_count;
      if (persistedStatus === "delivered") break;
      await sleep(20);
    }

    expect(delivered).toEqual([notificationId]);
    expect({
      status: persistedStatus,
      attempt_count: persistedAttemptCount,
    }).toMatchObject({
      status: "delivered",
      attempt_count: 1,
    });
  });

  it("forces external health recovery after a detected wall-clock jump", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const seedDb = guardedOpenDb({ path: dbPath });
    createAutonomyRun(seedDb, dbPath, {
      autonomy_run_id: "run-clock-recovery",
      transition_id: "run-clock-recovery:queued",
      task_id: "task-clock-recovery",
      repo_id: "owner/clock-repo",
      workspace_path: join(tmp, "clock-repo"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    seedDb.close();

    let healthCalls = 0;
    let wallMs = 1_000;
    let monotonicMs = 1_000;
    const resumed: string[] = [];
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      healthPollIntervalMs: 20,
      clockJumpThresholdMs: 1_000,
      wallClockMs: () => wallMs,
      monotonicClockMs: () => monotonicMs,
      autonomyHealth: async () => {
        healthCalls += 1;
        return healthyAutonomyHealth({
          can_run_local: healthCalls > 1,
        });
      },
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId) => {
          resumed.push(autonomyRunId);
          return {
            status: "completed",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "completed",
              revision: 2,
              context: {},
            },
          };
        },
      }),
    });
    wallMs += 10_000;
    monotonicMs += 20;
    const deadline = Date.now() + 2_000;
    while (resumed.length === 0 && Date.now() < deadline) {
      await sleep(20);
    }

    expect(healthCalls).toBeGreaterThan(1);
    expect(resumed).toEqual(["run-clock-recovery"]);
  });

  it("limits guarded autonomy writers to two after persisting their queued runs", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const seedDb = guardedOpenDb({ path: dbPath });
    for (const [index, repoId] of [
      "repo-one",
      "repo-two",
      "repo-three",
    ].entries()) {
      const runId = `run-concurrency-${index + 1}`;
      createAutonomyRun(seedDb, dbPath, {
        autonomy_run_id: runId,
        transition_id: `${runId}:queued`,
        task_id: `task-concurrency-${index + 1}`,
        repo_id: repoId,
        workspace_path: join(tmp, repoId),
        contract_sha256: String(index + 1).repeat(64),
        routing: {},
        budget: {
          max_builder_iterations: 1,
          max_review_rounds: 1,
          max_wall_time_ms: 60_000,
          max_no_progress_rounds: 1,
        },
        attempt: {},
        event: { kind: "queued" },
        occurred_at: index + 1,
      });
    }
    seedDb.close();

    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    let twoStarted!: () => void;
    let threeStarted!: () => void;
    const firstTwo = new Promise<void>((resolve) => {
      twoStarted = resolve;
    });
    const allThree = new Promise<void>((resolve) => {
      threeStarted = resolve;
    });
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      writeConcurrency: 2,
      autonomyHealth: async () => healthyAutonomyHealth(),
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId) => {
          started.push(autonomyRunId);
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (started.length === 2) twoStarted();
          if (started.length === 3) threeStarted();
          await new Promise<void>((resolve) => {
            releases.set(autonomyRunId, resolve);
          });
          active -= 1;
          return {
            status: "completed",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "completed",
              revision: 2,
              context: {},
            },
          };
        },
      }),
    });

    await Promise.race([
      firstTwo,
      sleep(2_000).then(() => {
        throw new Error("timed out waiting for two guarded writers");
      }),
    ]);
    expect(started).toHaveLength(2);
    expect(maxActive).toBe(2);
    const health = await daemonRpc(daemon.socketPath, "health");
    expect(health.result).toMatchObject({
      concurrency: {
        writes: { limit: 2, active: 2, queued: 1 },
        reads: { limit: 8, active: 0, queued: 0 },
        repository_write_queues: 3,
      },
    });
    const inspectDb = guardedOpenDb({ path: dbPath });
    expect(
      inspectDb.prepare(
        "SELECT COUNT(*) AS total FROM autonomy_run_projection WHERE state = 'queued'",
      ).get(),
    ).toEqual({ total: 3 });
    inspectDb.close();
    for (const runId of started) {
      const repoId = runId.endsWith("1") ? "repo-one" : "repo-two";
      await expect(readFile(
        join(home, "locks", "repos", `${repoId}.lock`),
        "utf-8",
      )).resolves.toContain(runId);
    }

    releases.get(started[0]!)?.();
    await Promise.race([
      allThree,
      sleep(2_000).then(() => {
        throw new Error("timed out waiting for queued guarded writer");
      }),
    ]);
    expect([...started.slice(0, 2)].sort()).toEqual([
      "run-concurrency-1",
      "run-concurrency-2",
    ]);
    expect(started[2]).toBe("run-concurrency-3");
    expect(maxActive).toBe(2);

    for (const release of releases.values()) release();
  });

  it("keeps blocked delivery queued offline and resumes after network recovery", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const seedDb = guardedOpenDb({ path: dbPath });
    const runId = "run-network-recovery";
    createAutonomyRun(seedDb, dbPath, {
      autonomy_run_id: runId,
      transition_id: `${runId}:queued`,
      task_id: "task-network-recovery",
      repo_id: "owner/network-repo",
      workspace_path: join(tmp, "network-repo"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    const states = [
      "classifying",
      "preparing",
      "building",
      "verifying",
      "reviewing",
      "post_classifying",
      "candidate_proof",
      "committing",
      "pushing",
      "blocked_delivery",
    ] as const;
    for (const [index, state] of states.entries()) {
      transitionAutonomyRun(seedDb, dbPath, {
        autonomy_run_id: runId,
        transition_id: `${runId}:${state}`,
        expected_revision: index + 1,
        to_state: state,
        event: { kind: state },
        occurred_at: index + 2,
      });
    }
    seedDb.close();

    let networkAvailable = false;
    const resumed: string[] = [];
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      healthPollIntervalMs: 20,
      autonomyHealth: async () => healthyAutonomyHealth(
        networkAvailable
          ? {}
          : {
              ok: false,
              can_merge: false,
              can_push_deploy: false,
              external_blockers: ["github_network"],
            },
      ),
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId) => {
          resumed.push(autonomyRunId);
          return {
            status: "completed",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "completed",
              revision: 12,
              context: {},
            },
          };
        },
      }),
    });
    await sleep(60);
    expect(resumed).toEqual([]);
    const inspectDb = guardedOpenDb({ path: dbPath });
    expect(
      inspectDb.prepare(
        "SELECT state FROM autonomy_run_projection WHERE autonomy_run_id = ?",
      ).get(runId),
    ).toEqual({ state: "blocked_delivery" });
    inspectDb.close();

    networkAvailable = true;
    const deadline = Date.now() + 2_000;
    while (resumed.length === 0 && Date.now() < deadline) {
      await sleep(20);
    }
    expect(resumed).toEqual([runId]);
  });

  it("recovers an interrupted production deployment while GitHub remains offline", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const runId = "run-offline-production-recovery";
    const seedDb = guardedOpenDb({ path: dbPath });
    createAutonomyRun(seedDb, dbPath, {
      autonomy_run_id: runId,
      transition_id: `${runId}:queued`,
      task_id: "task-offline-production-recovery",
      repo_id: "owner/repo",
      workspace_path: join(tmp, "offline-production-recovery"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    const states = [
      "classifying",
      "preparing",
      "building",
      "verifying",
      "reviewing",
      "post_classifying",
      "candidate_proof",
      "committing",
      "pushing",
      "opening_pr",
      "waiting_ci",
      "merging",
      "deploying_staging",
      "verifying_staging",
      "deploying_production",
    ] as const;
    for (const [index, state] of states.entries()) {
      transitionAutonomyRun(seedDb, dbPath, {
        autonomy_run_id: runId,
        transition_id: `${runId}:${state}`,
        expected_revision: index + 1,
        to_state: state,
        event: { kind: state },
        occurred_at: index + 2,
      });
    }
    seedDb.close();

    const resumed: string[] = [];
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      healthPollIntervalMs: 20,
      autonomyHealth: async () => healthyAutonomyHealth({
        ok: false,
        can_merge: false,
        can_push_deploy: false,
        external_blockers: ["github_network"],
      }),
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId) => {
          resumed.push(autonomyRunId);
          return {
            status: "blocked",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "escalated",
              revision: states.length + 2,
              context: {},
            },
          };
        },
      }),
    });

    const deadline = Date.now() + 2_000;
    while (resumed.length === 0 && Date.now() < deadline) {
      await sleep(20);
    }
    expect(resumed).toEqual([runId]);
  });

  it("blocks guarded writes until the initial autonomy health check completes", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const runId = "run-initial-health";
    const seedDb = guardedOpenDb({ path: dbPath });
    createAutonomyRun(seedDb, dbPath, {
      autonomy_run_id: runId,
      transition_id: `${runId}:queued`,
      task_id: "task-initial-health",
      repo_id: "owner/repo",
      workspace_path: join(tmp, "initial-health"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    seedDb.close();

    let resolveHealth:
      | ((report: AutonomyHealthReport) => void)
      | undefined;
    const initialHealth = new Promise<AutonomyHealthReport>((resolve) => {
      resolveHealth = resolve;
    });
    let resumeCalls = 0;
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      autonomyHealth: async () => await initialHealth,
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId) => {
          resumeCalls += 1;
          return {
            status: "completed",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "completed",
              revision: 2,
              context: {},
            },
          };
        },
      }),
    });

    const blocked = await daemonRpc(
      daemon.socketPath,
      "autonomy.resume",
      { autonomy_run_id: runId },
    );
    resolveHealth?.(healthyAutonomyHealth());

    expect(blocked.ok).toBe(false);
    expect(blocked.error?.message).toContain(
      "until the initial health check completes",
    );
    expect(resumeCalls).toBe(0);
  });

  it("drains and refuses guarded writes when autonomy disk health is critical", async () => {
    const home = process.env["OSSTACK_HOME"];
    if (home === undefined) throw new Error("OSSTACK_HOME is required");
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const seedDb = guardedOpenDb({ path: dbPath });
    createAutonomyRun(seedDb, dbPath, {
      autonomy_run_id: "run-low-disk",
      transition_id: "run-low-disk:queued",
      task_id: "task-low-disk",
      repo_id: "owner/low-disk",
      workspace_path: join(tmp, "low-disk"),
      contract_sha256: "a".repeat(64),
      routing: {},
      budget: {
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_ms: 60_000,
        max_no_progress_rounds: 1,
      },
      attempt: {},
      event: { kind: "queued" },
      occurred_at: 1,
    });
    seedDb.close();

    let resumeCalls = 0;
    daemon = await startDaemon({
      socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock`,
      autonomyHealth: async () => healthyAutonomyHealth({
        ok: false,
        can_run_local: false,
        can_merge: false,
        can_push_deploy: false,
        drain_required: true,
        disk_free_bytes: 2 * 1024 ** 3 - 1,
        write_blockers: ["disk_free"],
      }),
      guardedAutonomyFactory: () => ({
        resume: async (autonomyRunId) => {
          resumeCalls += 1;
          return {
            status: "completed",
            run: {
              autonomy_run_id: autonomyRunId,
              state: "completed",
              revision: 2,
              context: {},
            },
          };
        },
      }),
    });
    const health = await daemonRpc(daemon.socketPath, "autonomy.health");
    expect(health.result).toMatchObject({
      can_run_local: false,
      drain_required: true,
      write_blockers: ["disk_free"],
    });
    const daemonHealth = await daemonRpc(daemon.socketPath, "health");
    expect(daemonHealth.result).toMatchObject({ draining: true });
    const resume = await daemonRpc(
      daemon.socketPath,
      "autonomy.resume",
      { autonomy_run_id: "run-low-disk" },
    );
    expect(resume.ok).toBe(false);
    expect(resume.error?.message).toContain("disk_free");
    expect(resumeCalls).toBe(0);
  });

  it("removes process signal handlers when closed", async () => {
    const sigtermBefore = process.listenerCount("SIGTERM");
    const sigintBefore = process.listenerCount("SIGINT");

    const first = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    await first.close();
    await first.close();

    const second = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    await second.close();

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
  });

  it("runs and reports a local loop cycle through the daemon socket", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "daemon-loop-task",
      capability: "code.test",
      prompt: "Exercise daemon loop RPC",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const runResp = await daemonRpc(daemon.socketPath, "loop.run", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-done.txt', 'ok')\"",
      verifyCommands: ["node -e \"process.exit(require('fs').existsSync('daemon-done.txt') ? 0 : 1)\""],
    });

    expect(runResp.ok).toBe(true);
    expect(runResp.result).toMatchObject({
      json_path: join(workspace, "LOOP-STATE.json"),
      markdown_path: join(workspace, "STATE.md"),
      completed_tasks: [
        expect.objectContaining({ task_id: "daemon-loop-task", outcome: "success" }),
      ],
    });

    const statusResp = await daemonRpc(daemon.socketPath, "loop.status", {
      workspacePath: workspace,
    });

    expect(statusResp.ok).toBe(true);
    expect(statusResp.result).toMatchObject({
      state_json: join(workspace, "LOOP-STATE.json"),
    });
    expect((statusResp.result as { markdown: string }).markdown).toContain("daemon-loop-task - success");
  });

  it("attaches neat evidence to a successful daemon loop without gating it", async () => {
    const workspace = join(tmp, "neat-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await mkdir(join(workspace, ".osstack"));
    await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "daemon-loop-neat-task",
      capability: "code.test",
      prompt: "Exercise daemon neat finalization",
    }));
    await writeFile(join(workspace, ".osstack", "neat.yaml"), `version: 1
required_surfaces:
  - id: missing-readme
    path: README.md
    kind: file
    severity: warning
`);

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const runResp = await daemonRpc(daemon.socketPath, "loop.run", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"process.exit(0)\"",
      neatFinalize: true,
    });

    expect(runResp.ok).toBe(true);
    expect(runResp.result).toMatchObject({
      completed_tasks: [expect.objectContaining({ outcome: "success" })],
      knowledge_hygiene: {
        status: "ok",
        report: { findings: [expect.objectContaining({ rule_id: "surface.required_missing" })] },
      },
    });
  });

  it("runs finite multi-cycle loops through daemon RPC", async () => {
    const workspace = join(tmp, "cycle-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    setTimeout(() => {
      void writeFile(join(workspace, "tasks", "late.json"), JSON.stringify({
        task_id: "daemon-cycle-task",
        capability: "code.test",
        prompt: "Exercise daemon cycles",
      }));
    }, 5);

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const runResp = await daemonRpc(daemon.socketPath, "loop.run", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-cycle-done.txt', 'ok')\"",
      cycles: 2,
      intervalMs: 25,
    });

    expect(runResp.ok).toBe(true);
    expect(runResp.result).toMatchObject({
      completed_tasks: [
        expect.objectContaining({ task_id: "daemon-cycle-task", outcome: "success" }),
      ],
    });
    const result = runResp.result as {
      cycles: Array<{
        discovered_task_count: number;
        executed_task_count: number;
        skipped_task_count: number;
      }>;
      events: Array<{ type: string; seq: number; payload?: unknown }>;
    };
    expect(result.cycles).toHaveLength(2);
    expect(result.cycles.reduce((sum, cycle) => sum + cycle.executed_task_count, 0)).toBe(1);
    expect(result.cycles.reduce((sum, cycle) => sum + cycle.skipped_task_count, 0)).toBeLessThanOrEqual(1);
    expect(result.events
      .filter((event) => event.type === "loop.cycle.started")
      .map((event) => (event.payload as { cycle: number }).cycle)).toEqual([1, 2]);
    expect(result.events.map((event) => event.seq)).toEqual(
      result.events.map((_, index) => index + 1),
    );
  });

  it("runs reviewer adapters through daemon loop.run", async () => {
    const workspace = join(tmp, "reviewer-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await git(workspace, ["init", "-b", "main"]);
    await writeFile(join(workspace, "app.txt"), "before\n");
    await git(workspace, ["add", "app.txt"]);
    await git(workspace, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    await writeFile(join(workspace, "tasks", "review.json"), JSON.stringify({
      task_id: "daemon-reviewer-task",
      capability: "code.test",
      prompt: "Exercise daemon reviewer adapter",
    }));

    const fakeReview = join(workspace, "ds-review");
    await writeFile(fakeReview, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--help" ]; then echo help; exit 0; fi
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
input="$(cat)"
mkdir -p "$(dirname "$out")"
printf 'reviewed:\\n%s\\n' "$input" > "$out"
echo review ok
`, "utf-8");
    await chmod(fakeReview, 0o755);

    const previous = process.env["OSSTACK_DS_REVIEW_BIN"];
    process.env["OSSTACK_DS_REVIEW_BIN"] = fakeReview;
    try {
      daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
      const runResp = await daemonRpc(daemon.socketPath, "loop.run", {
        workspacePath: workspace,
        sources: ["task_queue"],
        executeCommand: "node -e \"require('fs').writeFileSync('app.txt', 'after daemon reviewer\\n')\"",
        verifierAgentIds: ["ds-review"],
      });

      expect(runResp.ok).toBe(true);
      expect(runResp.result).toMatchObject({
        completed_tasks: [
          expect.objectContaining({ task_id: "daemon-reviewer-task", outcome: "success" }),
        ],
      });
      await expect(readFile(join(workspace, "reviews", "ds-review", "latest.md"), "utf-8"))
        .resolves.toContain("+after daemon reviewer");
    } finally {
      if (previous === undefined) delete process.env["OSSTACK_DS_REVIEW_BIN"];
      else process.env["OSSTACK_DS_REVIEW_BIN"] = previous;
    }
  });

  it("starts, reports, and stops a background polling loop", async () => {
    const workspace = join(tmp, "watch-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-watch-done.txt', 'ok')\"",
      intervalMs: 20,
      cycles: 5,
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    await writeFile(join(workspace, "tasks", "watch.json"), JSON.stringify({
      task_id: "daemon-watch-task",
      capability: "code.test",
      prompt: "Exercise daemon background loop",
    }));

    const loop = await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.executed_task_count >= 1
    ));
    expect(loop).toMatchObject({
      loop_session_id: loopSessionId,
      executed_task_count: 1,
    });

    const statusResp = await daemonRpc(daemon.socketPath, "loop.status", {
      workspacePath: workspace,
    });
    expect(statusResp.ok).toBe(true);
    expect((statusResp.result as { markdown: string }).markdown).toContain("daemon-watch-task - success");

    const stopResp = await daemonRpc(daemon.socketPath, "loop.stop", { loopSessionId });
    expect(stopResp.ok).toBe(true);
    expect(stopResp.result).toMatchObject({
      loop_session_id: loopSessionId,
    });
  });

  it("stops a polling loop session when its budget is exceeded and persists the reason", async () => {
    const workspace = join(tmp, "budget-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "budget.json"), JSON.stringify({
      task_id: "daemon-budget-task",
      capability: "code.test",
      prompt: "Exercise session budget stop",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"process.exit(0)\"",
      intervalMs: 20,
      budget: { max_cycles: 1 },
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    const loop = await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.status === "stopped"
    ));
    expect(loop).toMatchObject({
      loop_session_id: loopSessionId,
      status: "stopped",
      stop_reason: expect.stringContaining("budget exceeded"),
      budget: expect.objectContaining({
        exceeded: true,
        limit: "max_cycles",
        limits: expect.objectContaining({ max_cycles: 1 }),
        usage: expect.objectContaining({ cycles: 1 }),
      }),
    });

    const statsResp = await daemonRpc(daemon.socketPath, "stats");
    expect(statsResp.ok).toBe(true);
    const stats = statsResp.result as { loops: { per_loop: Array<{ loop_session_id: string; budget?: unknown }> } };
    const perLoop = stats.loops.per_loop.find((entry) => entry.loop_session_id === loopSessionId);
    expect(perLoop?.budget).toMatchObject({
      exceeded: true,
      limit: "max_cycles",
      usage: expect.objectContaining({ cycles: 1 }),
    });

    // Persistence lags the RPC status: the daemon may report "stopped" over RPC
    // before the final loop-sessions.json write lands (and on slow CI runners
    // that gap is real). Poll for the persisted stop instead of a single read.
    const savedSession = await waitForPersistedSession(
      join(tmp, "home", "loop-sessions.json"),
      loopSessionId,
      (session) => session.stopReason !== undefined,
    );
    expect(savedSession?.stopReason).toContain("budget exceeded");
    expect(savedSession?.lastBudgetCheck).toMatchObject({ exceeded: true, limit: "max_cycles" });
  });

  it("starts a cron-scheduled background loop", async () => {
    const workspace = join(tmp, "scheduled-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "scheduled.json"), JSON.stringify({
      task_id: "daemon-scheduled-task",
      capability: "code.test",
      prompt: "Exercise scheduled daemon loop",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-scheduled-done.txt', 'ok')\"",
      schedule: "* * * * *",
      cycles: 1,
    });

    expect(startResp.ok).toBe(true);
    expect(startResp.result).toMatchObject({
      schedule: "* * * * *",
      max_cycles: 1,
    });
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    const loop = await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));
    expect(loop).toMatchObject({
      loop_session_id: loopSessionId,
      status: "stopped",
      executed_task_count: 1,
      schedule: "* * * * *",
    });
  });

  it("rejects invalid cron schedules", async () => {
    const workspace = join(tmp, "bad-schedule-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      schedule: "0 24 * * *",
    });

    expect(startResp.ok).toBe(false);
    expect(startResp.error?.message).toContain("params.schedule");
  });

  it("includes background loop metrics in daemon stats", async () => {
    const workspace = join(tmp, "stats-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "stats.json"), JSON.stringify({
      task_id: "daemon-stats-task",
      capability: "code.test",
      prompt: "Exercise loop stats",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-stats-done.txt', 'ok')\"",
      cycles: 1,
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));

    const statsResp = await daemonRpc(daemon.socketPath, "stats");
    expect(statsResp.ok).toBe(true);
    expect(statsResp.result).toMatchObject({
      loops: {
        total_sessions: 1,
        stopped: 1,
        total_cycles: 1,
        total_executed: 1,
        total_successful: 1,
        total_failed: 0,
        total_escalated: 0,
        total_tokens_consumed: 0,
        per_loop: [
          expect.objectContaining({
            loop_session_id: loopSessionId,
            status: "stopped",
            cycle_count: 1,
            executed_task_count: 1,
            successful_task_count: 1,
            failed_task_count: 0,
            escalated_task_count: 0,
            tokens_consumed: 0,
            avg_cycle_duration_ms: expect.any(Number),
          }),
        ],
      },
    });
  });

  it("creates a blocked kanban card when a background loop escalates", async () => {
    const workspace = join(tmp, "escalation-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "escalate.json"), JSON.stringify({
      task_id: "daemon-escalate-task",
      capability: "code.test",
      prompt: "Exercise loop escalation notification",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      verifyCommands: ["node -e \"process.exit(1)\""],
      maxIterations: 2,
      cycles: 1,
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.status === "stopped"
      && candidate.executed_task_count === 1
      && candidate.escalated_task_count === 1
    ));

    const statsResp = await daemonRpc(daemon.socketPath, "stats");
    expect(statsResp.ok).toBe(true);
    expect(statsResp.result).toMatchObject({
      loops: {
        total_escalated: 1,
        per_loop: [
          expect.objectContaining({
            loop_session_id: loopSessionId,
            escalated_task_count: 1,
          }),
        ],
      },
    });

    const eventsResp = await daemonRpc(daemon.socketPath, "kanban.events", { since: 0 });
    expect(eventsResp.ok).toBe(true);
    const events = (eventsResp.result as { events: Array<{ kind: string; payload: string | null }> }).events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "created" }),
      expect.objectContaining({ kind: "blocked" }),
    ]));
    expect(events.some((event) => event.payload?.includes("daemon-escalate-task"))).toBe(true);
    expect(events.some((event) => event.payload?.includes("Maximum iterations reached"))).toBe(true);
  });

  it("creates a blocked kanban card after three same-capability loop failures", async () => {
    const workspace = join(tmp, "failure-streak-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    for (let index = 1; index <= 3; index++) {
      await writeFile(join(workspace, "tasks", `streak-${index}.json`), JSON.stringify({
        task_id: `daemon-streak-task-${index}`,
        capability: "code.test",
        prompt: `Exercise loop failure streak ${index}`,
      }));
    }

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      verifyCommands: ["node -e \"process.exit(1)\""],
      maxIterations: 1,
      cycles: 1,
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    const loop = await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.status === "stopped"
      && candidate.executed_task_count === 3
      && candidate.escalated_task_count === 3
    ));
    expect(loop.failure_streaks).toEqual([
      expect.objectContaining({
        capability: "code.test",
        count: 3,
        lastTaskId: "daemon-streak-task-3",
        lastEscalatedAtCount: 3,
      }),
    ]);

    const eventsResp = await daemonRpc(daemon.socketPath, "kanban.events", { since: 0 });
    expect(eventsResp.ok).toBe(true);
    const events = (eventsResp.result as { events: Array<{ kind: string; payload: string | null }> }).events;
    expect(events.some((event) => event.payload?.includes("Loop failure streak: code.test"))).toBe(true);
    expect(events.some((event) => event.payload?.includes("3 consecutive code.test loop task failures"))).toBe(true);
  });

  it("stops a background polling loop when its goal command passes", async () => {
    const workspace = join(tmp, "goal-watch-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });
    await writeFile(join(workspace, "tasks", "goal.json"), JSON.stringify({
      task_id: "daemon-goal-task",
      capability: "code.test",
      prompt: "Exercise daemon background goal stopping",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-goal-done.txt', 'ok')\"",
      goalCommand: "node -e \"process.exit(require('fs').existsSync('daemon-goal-done.txt') ? 0 : 1)\"",
      intervalMs: 20,
      cycles: 5,
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    const loop = await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.status === "stopped" && candidate.executed_task_count === 1
    ));
    expect(loop).toMatchObject({
      loop_session_id: loopSessionId,
      status: "stopped",
      executed_task_count: 1,
    });

    const statusResp = await daemonRpc(daemon.socketPath, "loop.status", {
      workspacePath: workspace,
    });
    expect(statusResp.ok).toBe(true);
    expect((statusResp.result as { markdown: string }).markdown).toContain("goal: passed");
  });

  it("restores running background loops after daemon restart", async () => {
    const workspace = join(tmp, "restart-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-restart-done.txt', 'ok')\"",
      intervalMs: 20,
      profileRouting: daemonProfileRoutingFixture(),
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => candidate.status === "running");

    await daemon.close();
    daemon = null;

    const persistedBeforeRestart = JSON.parse(
      await readFile(
        join(tmp, "home", "loop-sessions.json"),
        "utf-8",
      ),
    ) as {
      sessions: Array<{
        loopSessionId: string;
        runOptions: { profileRouting?: unknown };
      }>;
    };
    expect(
      persistedBeforeRestart.sessions.find(
        (session) => session.loopSessionId === loopSessionId,
      )?.runOptions.profileRouting,
    ).toEqual(daemonProfileRoutingFixture());

    await writeFile(join(workspace, "tasks", "restart.json"), JSON.stringify({
      task_id: "daemon-restart-task",
      capability: "code.test",
      prompt: "Exercise daemon restart recovery",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const loop = await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => (
      candidate.executed_task_count >= 1
    ));
    expect(loop).toMatchObject({
      loop_session_id: loopSessionId,
      status: "running",
      executed_task_count: 1,
      profile: daemonProfileRoutingFixture(),
    });

    const statusResp = await daemonRpc(daemon.socketPath, "loop.status", {
      workspacePath: workspace,
    });
    expect(statusResp.ok).toBe(true);
    expect((statusResp.result as { markdown: string }).markdown).toContain("daemon-restart-task - success");

    const stopResp = await daemonRpc(daemon.socketPath, "loop.stop", { loopSessionId });
    expect(stopResp.ok).toBe(true);
  });

  it("does not resume explicitly stopping loops after daemon restart", async () => {
    const workspace = join(tmp, "stopped-workspace");
    await mkdir(join(workspace, "tasks"), { recursive: true });

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('daemon-stopped-done.txt', 'ok')\"",
      intervalMs: 1_000,
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    const stopResp = await daemonRpc(daemon.socketPath, "loop.stop", { loopSessionId });
    expect(stopResp.ok).toBe(true);

    await daemon.close();
    daemon = null;

    await writeFile(join(workspace, "tasks", "stopped.json"), JSON.stringify({
      task_id: "daemon-stopped-task",
      capability: "code.test",
      prompt: "Should not run after explicit stop",
    }));

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-loop-${randomUUID()}.sock` });
    await sleep(60);

    const listResp = await daemonRpc(daemon.socketPath, "loop.list");
    expect(listResp.ok).toBe(true);
    const loops = (listResp.result as { loops: LoopSessionRpcSummary[] }).loops;
    expect(loops.find((loop) => loop.loop_session_id === loopSessionId)).toMatchObject({
      status: "stopped",
      executed_task_count: 0,
    });
  });
});

function daemonRpc(
  socketPath: string,
  method: string,
  params?: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("daemon RPC timed out"));
    }, 5_000);

    sock.on("connect", () => {
      sock.write(encodeFrame({ id: 1, method, params }));
    });
    sock.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timer);
      sock.end();
      resolve(frames[0] as { ok: boolean; result?: unknown; error?: { message: string } });
    });
    sock.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

interface LoopSessionRpcSummary {
  loop_session_id: string;
  status: string;
  executed_task_count: number;
  escalated_task_count: number;
  failure_streaks?: Array<{
    capability: string;
    count: number;
    lastTaskId: string;
    lastEscalatedAtCount?: number;
  }>;
  schedule?: string;
}

async function waitForLoop(
  socketPath: string,
  loopSessionId: string,
  predicate: (session: LoopSessionRpcSummary) => boolean,
): Promise<LoopSessionRpcSummary> {
  const deadline = Date.now() + 2_000;
  let last: LoopSessionRpcSummary | undefined;
  while (Date.now() < deadline) {
    const resp = await daemonRpc(socketPath, "loop.list");
    if (!resp.ok) throw new Error(resp.error?.message ?? "loop.list failed");
    const loops = (resp.result as { loops: LoopSessionRpcSummary[] }).loops;
    last = loops.find((loop) => loop.loop_session_id === loopSessionId);
    if (last !== undefined && predicate(last)) return last;
    await sleep(20);
  }
  throw new Error(`loop session did not reach expected state: ${JSON.stringify(last)}`);
}

interface PersistedSessionSummary {
  loopSessionId: string;
  stopReason?: string;
  lastBudgetCheck?: { exceeded: boolean; limit?: string };
}

/**
 * Poll loop-sessions.json until the session satisfies the predicate. The
 * daemon persists after the RPC status flips, so a single read races the final
 * write on slow runners. Parse failures are retried (the daemon writes
 * atomically, but an older complete snapshot may still be current).
 */
async function waitForPersistedSession(
  path: string,
  loopSessionId: string,
  predicate: (session: PersistedSessionSummary) => boolean,
): Promise<PersistedSessionSummary> {
  const deadline = Date.now() + 2_000;
  let last: PersistedSessionSummary | undefined;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as { sessions: PersistedSessionSummary[] };
      last = parsed.sessions.find((session) => session.loopSessionId === loopSessionId);
      if (last !== undefined && predicate(last)) return last;
    } catch {
      // missing or mid-rotation file — retry until deadline
    }
    await sleep(20);
  }
  throw new Error(`persisted loop session did not reach expected state: ${JSON.stringify(last)}`);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function daemonProfileRoutingFixture() {
  return {
    profile_name: "mac-mini",
    reason: "pinned profile \"mac-mini\"",
    builder_agent_id: "claude-code",
    evaluator_agent_id: "kimi-code",
    builder_identity: {
      adapter_id: "claude-code",
      provider_id: "anthropic",
      model_id: "claude-current",
      evidence_source: "reported",
    },
    evaluator_identity: {
      adapter_id: "kimi-code",
      provider_id: "kimi",
      model_id: "kimi-code/k3",
      evidence_source: "reported",
    },
    independent: true,
    independence_reason: "reported provider or model differs",
  };
}
