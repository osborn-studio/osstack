import { connect } from "node:net";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "./daemon.js";

let tmp: string;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;

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
    });

    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;
    await waitForLoop(daemon.socketPath, loopSessionId, (candidate) => candidate.status === "running");

    await daemon.close();
    daemon = null;

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
