import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon as startRealDaemon, type DaemonHandles } from "./daemon.js";

// R2.2 — kernel policy gate wired into the daemon. Proves the observe-mode
// refusal now covers the daemon RPC path (loop.run) AND the persisted session
// scheduler, including a mid-session flip of .osstack/policy.yaml (the real
// makePolicyGate re-reads per consult — it must not cache).

let tmp: string;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-daemon-policy-"));
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

async function writePolicy(workspace: string, mode: "observe" | "propose" | "execute"): Promise<void> {
  await mkdir(join(workspace, ".osstack"), { recursive: true });
  await writeFile(join(workspace, ".osstack", "policy.yaml"), `schema_version: 1\nmode: ${mode}\n`);
}

async function seedTask(workspace: string): Promise<void> {
  execFileSync("git", ["init", workspace]);
  await mkdir(join(workspace, "tasks"), { recursive: true });
  await writeFile(join(workspace, "tasks", "task.json"), JSON.stringify({
    task_id: "policy-gate-task",
    capability: "code.test",
    prompt: "Exercise the daemon policy gate",
  }));
}

describe("daemon policy gate (R2.2)", () => {
  it("refuses loop.run under mode: observe with a policy_denied error and no evidence", async () => {
    const workspace = join(tmp, "observe-workspace");
    await seedTask(workspace);
    await writePolicy(workspace, "observe");

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-policy-${randomUUID()}.sock` });
    const runResp = await daemonRpc(daemon.socketPath, "loop.run", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('should-not-exist.txt', 'ok')\"",
    });

    expect(runResp.ok).toBe(false);
    expect(runResp.error?.code).toBe("policy_denied");
    expect(runResp.error?.message).toContain("policy mode is observe");
    // Refused before any side effect: no execution, no state file, no evidence.
    expect(existsSync(join(workspace, "should-not-exist.txt"))).toBe(false);
    expect(existsSync(join(workspace, "LOOP-STATE.json"))).toBe(false);

    const statsResp = await daemonRpc(daemon.socketPath, "stats");
    expect((statsResp.result as { total_runs: number }).total_runs).toBe(0);
  });

  it("allows loop.run under mode: execute", async () => {
    const workspace = join(tmp, "execute-workspace");
    await seedTask(workspace);
    await writePolicy(workspace, "execute");

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-policy-${randomUUID()}.sock` });
    const runResp = await daemonRpc(daemon.socketPath, "loop.run", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"require('fs').writeFileSync('policy-ok.txt', 'ok')\"",
    });

    expect(runResp.ok).toBe(true);
    expect(runResp.result).toMatchObject({
      completed_tasks: [expect.objectContaining({ task_id: "policy-gate-task", outcome: "success" })],
    });
    expect(existsSync(join(workspace, "policy-ok.txt"))).toBe(true);
  });

  it("stops a scheduled session on the next tick when policy.yaml is flipped to observe mid-session", async () => {
    const workspace = join(tmp, "flip-workspace");
    await seedTask(workspace);
    // No policy.yaml initially => allow. The session runs cycles until we flip.

    daemon = await startDaemon({ socketPath: `/tmp/osstack-daemon-policy-${randomUUID()}.sock` });
    const startResp = await daemonRpc(daemon.socketPath, "loop.start", {
      workspacePath: workspace,
      sources: ["task_queue"],
      executeCommand: "node -e \"process.exit(0)\"",
      intervalMs: 20,
    });
    expect(startResp.ok).toBe(true);
    const loopSessionId = (startResp.result as { loop_session_id: string }).loop_session_id;

    // Wait until at least one cycle has run under the (absent => allow) policy,
    // proving the gate was consulted and allowed before the flip.
    await waitForLoop(daemon.socketPath, loopSessionId, (session) => session.cycle_count >= 1);

    // Flip the policy file on disk mid-session. Because makePolicyGate re-reads
    // per consult (no caching), the very next tick must observe this and refuse.
    await writePolicy(workspace, "observe");

    const stopped = await waitForLoop(daemon.socketPath, loopSessionId, (session) => (
      session.status === "stopped" && (session.stop_reason ?? "").includes("policy_denied")
    ));
    expect(stopped.stop_reason).toContain("policy mode is observe");

    // The policy_denied stop_reason is persisted to loop-sessions.json.
    const saved = await waitForPersistedSession(
      join(tmp, "home", "loop-sessions.json"),
      loopSessionId,
      (session) => (session.stopReason ?? "").includes("policy_denied"),
    );
    expect(saved.stopReason).toContain("policy mode is observe");
  });
});

interface LoopSessionRpcSummary {
  loop_session_id: string;
  status: string;
  cycle_count: number;
  executed_task_count: number;
  stop_reason?: string;
}

interface PersistedSessionSummary {
  loopSessionId: string;
  stopReason?: string;
}

function daemonRpc(
  socketPath: string,
  method: string,
  params?: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message: string } }> {
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
      resolve(frames[0] as { ok: boolean; result?: unknown; error?: { code?: string; message: string } });
    });
    sock.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForLoop(
  socketPath: string,
  loopSessionId: string,
  predicate: (session: LoopSessionRpcSummary) => boolean,
): Promise<LoopSessionRpcSummary> {
  const deadline = Date.now() + 3_000;
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

async function waitForPersistedSession(
  path: string,
  loopSessionId: string,
  predicate: (session: PersistedSessionSummary) => boolean,
): Promise<PersistedSessionSummary> {
  const deadline = Date.now() + 3_000;
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


it("requires a host graph identity and denies its authorization before a Loop effect", async () => {
  const workspace = join(tmp, "graph-repo");
  await seedTask(workspace);
  await writePolicy(workspace, "execute");
  const identity = {};
  daemon = await startDaemon({ socketPath: `/tmp/g10-${randomUUID()}.sock`,
    graphIdentities: new Map([[identity, { workspacePath: workspace, authorize: async () => { throw new Error("graph grant denied"); } }]]),
  });
  await expect(daemon.acquireGraphAdmission({ principal: "admin" }, { runId: "forged" })).rejects.toThrow("trusted graph identity");
  await expect(daemon.acquireGraphAdmission(identity, { runId: "denied" })).rejects.toThrow("graph grant denied");
  expect(existsSync(join(workspace, "LOOP-STATE.json"))).toBe(false);
});

it("holds daemon Loop behind a graph lease for a second worktree and aborts queued admission", async () => {
  const workspace = join(tmp, "contended-repo"); await seedTask(workspace);
  execFileSync("git", ["-C", workspace, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"]);
  const second = join(tmp, "other-worktree"); execFileSync("git", ["-C", workspace, "worktree", "add", second]);
  await writePolicy(workspace, "execute");
  const identity = {};
  daemon = await startDaemon({ socketPath: `/tmp/g10-${randomUUID()}.sock`,
    graphIdentities: new Map([[identity, { workspacePath: workspace, authorize: async () => {} }]]),
  });
  const lease = await daemon.acquireGraphAdmission(identity, { runId: "held" });
  const abort = new AbortController();
  const queued = daemon.acquireGraphAdmission(identity, { runId: "queued", signal: abort.signal });
  const rejected = expect(queued).rejects.toThrow(); abort.abort(); await rejected;
  const pending = daemonRpc(daemon.socketPath, "loop.run", { workspacePath: second, sources: [] });
  await sleep(40); expect(existsSync(join(second, "LOOP-STATE.json"))).toBe(false);
  await lease.release(); expect((await pending).ok).toBe(true);
});

const startDaemon = (options: Parameters<typeof startRealDaemon>[0]) => startRealDaemon({ autonomyHealth: async () => healthyAutonomyHealth(), ...options });
