import { connect } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  tmp = mkdtempSync(join(tmpdir(), "osstack-daemon-daily-"));
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

/**
 * Seed a repo registry with one non-git-repo entry. Offline by construction:
 * the GitHub adapter finds no git remote (the path is not a repo), degrades to
 * a per-repo warning, and never makes a network call — so a scheduled tick
 * writes a real dated brief with no `gh`/network dependency.
 */
async function seedRegistry(): Promise<string> {
  const registry = join(tmp, "repos.json");
  const repo = join(tmp, "repo-a");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# repo-a\n");
  await writeFile(
    registry,
    JSON.stringify(
      [
        {
          repo_id: "repo-a",
          name: "repo-a",
          path: repo,
          role: "app",
          priority: 50,
          verify_commands: ["true"],
          loop_doc_path: "docs/LOOP.md",
          enabled: true,
        },
      ],
      null,
      2,
    ),
    "utf8",
  );
  return registry;
}

describe("daemon daily RPC (R2.3)", () => {
  it("schedules a session whose tick writes a dated brief", async () => {
    const registry = await seedRegistry();
    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });

    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 20,
    });
    expect(scheduleResp.ok).toBe(true);
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;
    expect(sessionId).toMatch(/^daily_session_[0-9a-f]{8}$/);

    const session = await waitForDaily(daemon.socketPath, sessionId, (candidate) => candidate.tick_count >= 1);
    expect(session).toMatchObject({
      daily_session_id: sessionId,
      status: "running",
      interval_ms: 20,
      last_result_status: "ok",
    });
    expect(session.consecutive_failure_count).toBe(0);
    expect(session.last_brief_path).toBeDefined();

    // The dated brief was written to $OSSTACK_HOME/daily-briefs/, byte-compatible
    // with a manual run (same runDailyBrief core).
    const date = new Date().toISOString().slice(0, 10);
    const briefPath = join(tmp, "home", "daily-briefs", `${date}.json`);
    await expect(readFile(briefPath, "utf8")).resolves.toContain("repo-a");
  });

  it("records the schedule expression verbatim while the interval drives execution", async () => {
    const registry = await seedRegistry();
    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });

    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 20,
      schedule: "every morning at 7",
    });
    expect(scheduleResp.ok).toBe(true);
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;
    const session = await waitForDaily(daemon.socketPath, sessionId, (candidate) => candidate.tick_count >= 1);
    expect(session.schedule).toBe("every morning at 7");
  });

  it("still ticks in an observe-mode workspace (daily is read-only, not observe-gated)", async () => {
    const registry = await seedRegistry();
    // Pin the registered repo's workspace policy to observe — where a naive
    // gate would look. daily reads only, so the scheduled brief must still be
    // produced, proving daily is intentionally NOT observe-gated. Note this
    // guards the "no gate at all on the daily tick" invariant; a future gate
    // reading policy from a different location (cwd / OSSTACK_HOME) would need
    // its own regression case.
    const policyDir = join(tmp, "repo-a", ".osstack");
    await mkdir(policyDir, { recursive: true });
    await writeFile(join(policyDir, "policy.yaml"), "mode: observe\n", "utf8");

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 20,
    });
    expect(scheduleResp.ok).toBe(true);
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;
    const session = await waitForDaily(daemon.socketPath, sessionId, (candidate) => candidate.tick_count >= 1);
    expect(session.status).toBe("running");
    expect(session.last_result_status).toBe("ok");
  });

  it("lists scheduled sessions with the daily.list shape", async () => {
    const registry = await seedRegistry();
    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 50,
    });
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;

    const listResp = await daemonRpc(daemon.socketPath, "daily.list");
    expect(listResp.ok).toBe(true);
    const daily = (listResp.result as { daily: DailyRpcSummary[] }).daily;
    expect(daily).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          daily_session_id: sessionId,
          registry_path: registry,
          status: "running",
          interval_ms: 50,
          tick_count: expect.any(Number),
          consecutive_failure_count: 0,
        }),
      ]),
    );
  });

  it("unschedules a session, stops it, and persists the stop reason", async () => {
    const registry = await seedRegistry();
    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 1_000,
    });
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;

    const stopResp = await daemonRpc(daemon.socketPath, "daily.stop", { dailySessionId: sessionId });
    expect(stopResp.ok).toBe(true);

    const stopped = await waitForDaily(daemon.socketPath, sessionId, (candidate) => candidate.status === "stopped");
    expect(stopped.stop_reason).toBe("stopped by request");

    const saved = await waitForPersistedDaily(
      join(tmp, "home", "daily-sessions.json"),
      sessionId,
      (s) => s.stopReason !== undefined,
    );
    expect(saved.stopReason).toBe("stopped by request");
  });

  it("counts consecutive failures and auto-stops after five", async () => {
    const registry = await seedRegistry();
    // Force every tick to fail: a regular FILE at the briefs dir path makes the
    // brief's mkdir/writeFile throw deterministically (offline, no runner).
    await mkdir(join(tmp, "home"), { recursive: true });
    writeFileSync(join(tmp, "home", "daily-briefs"), "not a directory");

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 10,
    });
    expect(scheduleResp.ok).toBe(true);
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;

    const stopped = await waitForDaily(daemon.socketPath, sessionId, (candidate) => candidate.status === "stopped");
    expect(stopped.consecutive_failure_count).toBe(5);
    expect(stopped.tick_count).toBe(5);
    expect(stopped.stop_reason).toContain("5 consecutive failures");
    expect(stopped.last_result_status).toBe("error");
  });

  it("restores a running session after daemon restart and it keeps ticking", async () => {
    const registry = await seedRegistry();
    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 20,
    });
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;
    const before = await waitForDaily(daemon.socketPath, sessionId, (candidate) => candidate.tick_count >= 1);

    await daemon.close();
    daemon = null;

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const after = await waitForDaily(
      daemon.socketPath,
      sessionId,
      (candidate) => candidate.status === "running" && candidate.tick_count > before.tick_count,
    );
    expect(after).toMatchObject({ daily_session_id: sessionId, status: "running", interval_ms: 20 });

    const stopResp = await daemonRpc(daemon.socketPath, "daily.stop", { dailySessionId: sessionId });
    expect(stopResp.ok).toBe(true);
  });

  it("does not resume an explicitly stopped session after restart", async () => {
    const registry = await seedRegistry();
    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const scheduleResp = await daemonRpc(daemon.socketPath, "daily.schedule", {
      registryPath: registry,
      intervalMs: 1_000,
    });
    const sessionId = (scheduleResp.result as { daily_session_id: string }).daily_session_id;
    await daemonRpc(daemon.socketPath, "daily.stop", { dailySessionId: sessionId });
    await waitForDaily(daemon.socketPath, sessionId, (candidate) => candidate.status === "stopped");

    await daemon.close();
    daemon = null;

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    await sleep(60);
    const listResp = await daemonRpc(daemon.socketPath, "daily.list");
    const daily = (listResp.result as { daily: DailyRpcSummary[] }).daily;
    expect(daily.find((s) => s.daily_session_id === sessionId)).toMatchObject({ status: "stopped" });
  });

  it("rejects a schedule missing the interval", async () => {
    const registry = await seedRegistry();
    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-daily-${randomUUID()}.sock` });
    const resp = await daemonRpc(daemon.socketPath, "daily.schedule", { registryPath: registry });
    expect(resp.ok).toBe(false);
    expect(resp.error?.message).toContain("intervalMs");
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

interface DailyRpcSummary {
  daily_session_id: string;
  status: string;
  interval_ms: number;
  schedule?: string;
  tick_count: number;
  consecutive_failure_count: number;
  last_brief_path?: string;
  last_result_status?: string;
  stop_reason?: string;
}

async function waitForDaily(
  socketPath: string,
  sessionId: string,
  predicate: (session: DailyRpcSummary) => boolean,
): Promise<DailyRpcSummary> {
  const deadline = Date.now() + 2_000;
  let last: DailyRpcSummary | undefined;
  while (Date.now() < deadline) {
    const resp = await daemonRpc(socketPath, "daily.list");
    if (!resp.ok) throw new Error(resp.error?.message ?? "daily.list failed");
    const daily = (resp.result as { daily: DailyRpcSummary[] }).daily;
    last = daily.find((session) => session.daily_session_id === sessionId);
    if (last !== undefined && predicate(last)) return last;
    await sleep(15);
  }
  throw new Error(`daily session did not reach expected state: ${JSON.stringify(last)}`);
}

interface PersistedDailySummary {
  dailySessionId: string;
  stopReason?: string;
  status?: string;
}

async function waitForPersistedDaily(
  path: string,
  sessionId: string,
  predicate: (session: PersistedDailySummary) => boolean,
): Promise<PersistedDailySummary> {
  const deadline = Date.now() + 2_000;
  let last: PersistedDailySummary | undefined;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as { sessions: PersistedDailySummary[] };
      last = parsed.sessions.find((session) => session.dailySessionId === sessionId);
      if (last !== undefined && predicate(last)) return last;
    } catch {
      // missing or mid-rotation file — retry until deadline
    }
    await sleep(15);
  }
  throw new Error(`persisted daily session did not reach expected state: ${JSON.stringify(last)}`);
}
