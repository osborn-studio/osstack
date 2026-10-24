import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { FrameDecoder, encodeFrame } from "@osstack/hermes-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon, type DaemonHandles } from "./daemon.js";

let fixture: string;
let priorHome: string | undefined;
let daemon: DaemonHandles | undefined;

beforeEach(() => {
  fixture = createScratchDirSync("tests", "loop-recovery-retain");
  priorHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(fixture, "home");
  mkdirSync(join(fixture, "home"));
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  if (priorHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = priorHome;
  await rm(fixture, { recursive: true, force: true });
});

async function listLoops(socketPath: string): Promise<Array<{ status: string; stop_reason?: string; executed_task_count: number }>> {
  return await new Promise((resolve, reject) => {
    const client = connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { client.destroy(); reject(new Error("loop.list timed out")); }, 5_000);
    client.on("connect", () => client.write(encodeFrame({ id: 1, method: "loop.list" })));
    client.on("error", (error) => { clearTimeout(timer); reject(error); });
    client.on("data", (data) => {
      const response = decoder.push(data)[0] as { ok: boolean; result: { loops: Array<{ status: string; stop_reason?: string; executed_task_count: number }> }; error?: { message: string } } | undefined;
      if (!response) return;
      clearTimeout(timer);
      client.end();
      if (!response.ok) reject(new Error(response.error?.message ?? "loop.list failed"));
      else resolve(response.result.loops);
    });
  });
}

describe("daemon interrupted Loop recovery", () => {
  it.each(["running", "stopping"])("retains %s worker evidence and requires recovery instead of replay", async (status) => {
    const workspace = join(fixture, "repository");
    const worktreeRoot = join(fixture, "worktrees");
    const orphan = join(worktreeRoot, "interrupted-worker");
    mkdirSync(workspace);
    mkdirSync(worktreeRoot);
    mkdirSync(join(workspace, "tasks"));
    const git = (...args: string[]): string => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture");
    const branch = "osstack/loop/interrupted-worker";
    git("-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, orphan);
    const evidencePath = join(orphan, "uncommitted-result.txt");
    writeFileSync(evidencePath, "unconfirmed worker result");
    const replayMarker = join(fixture, "unexpected-replay.txt");
    writeFileSync(join(workspace, "tasks", "task.json"), JSON.stringify({
      task_id: "interrupted-task", capability: "code.test", prompt: "Do not replay after an unproven interruption",
    }));
    const runOptions = {
      workspacePath: workspace, useWorktree: true, worktreeRoot, sources: ["task_queue"],
      executeCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(replayMarker)}, 'replayed')`)}`,
    };
    writeFileSync(join(fixture, "home", "loop-sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        loopSessionId: "interrupted-loop", status, runOptions,
        intervalMs: 60_000, stopWhenIdle: false, startedAt: 1, updatedAt: 2,
        cycleCount: 2, discoveredTaskCount: 1, executedTaskCount: 0, skippedTaskCount: 0,
      }],
    }));

    daemon = await startDaemon({ socketPath: join(fixture, "d.sock"), adapters: [] });
    const loops = await listLoops(daemon.socketPath);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ status: "stopped", stop_reason: expect.stringContaining("recovery_required"), executed_task_count: 0 });
    expect(readFileSync(evidencePath, "utf8")).toBe("unconfirmed worker result");
    expect(git("branch", "--list", branch)).toContain(branch);
    expect(() => readFileSync(replayMarker)).toThrow();
    await daemon.close();
    daemon = undefined;
    const persisted = JSON.parse(readFileSync(join(fixture, "home", "loop-sessions.json"), "utf8")) as { sessions: Array<{ stopReason?: string }> };
    expect(persisted.sessions[0]?.stopReason).toContain("recovery_required");
  }, 15_000);
});
