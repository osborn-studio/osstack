import { connect } from "node:net";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import type { AutonomyHealthReport } from "./autonomy-health.js";

// Regression (2026-08-13): `draining` was a one-way latch. A dip below the
// 2 GiB autonomy floor set it and nothing ever cleared it, so the daemon kept
// refusing sessions and task submissions for 12 h after the disk recovered —
// only a restart brought it back. An operator/upgrade drain must still never
// auto-clear, or `osstack upgrade` would resurrect the daemon mid-swap.

let tmp: string;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;
let drainRequired: boolean;

function fakeHealth(): AutonomyHealthReport {
  return {
    ok: !drainRequired,
    can_run_local: true,
    can_merge: true,
    can_push_deploy: true,
    drain_required: drainRequired,
    disk_free_bytes: drainRequired ? 1_000_000_000 : 50_000_000_000,
    checks: [],
    active_freezes: [],
    resumable_runs: [],
    proof_failures: [],
  } as unknown as AutonomyHealthReport;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-drain-recovery-"));
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  daemon = null;
  drainRequired = false;
});

afterEach(async () => {
  if (daemon) await daemon.close();
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  await rm(tmp, { recursive: true, force: true });
});

function daemonRpc(
  socketPath: string,
  method: string,
  params?: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message: string } }> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("daemon RPC timed out")); }, 5_000);
    sock.on("connect", () => { sock.write(encodeFrame({ id: 1, method, params })); });
    sock.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timer);
      sock.end();
      resolve(frames[0] as { ok: boolean; result?: unknown; error?: { code?: string; message: string } });
    });
    sock.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function draining(socketPath: string): Promise<boolean> {
  const resp = await daemonRpc(socketPath, "health");
  return (resp.result as { draining?: boolean }).draining === true;
}

async function start(): Promise<DaemonHandles> {
  return await startDaemon({
    socketPath: `/tmp/osstack-drain-${randomUUID()}.sock`,
    autonomyHealth: async () => fakeHealth(),
    // Long poll: these tests drive the health signal through the RPC so the
    // assertions never race the background poller.
    healthPollIntervalMs: 3_600_000,
  });
}

describe("daemon drain recovery", () => {
  it("clears a health-raised drain once the health signal recovers", async () => {
    daemon = await start();
    expect(await draining(daemon.socketPath)).toBe(false);

    drainRequired = true;
    await daemonRpc(daemon.socketPath, "autonomy.health");
    expect(await draining(daemon.socketPath)).toBe(true);

    drainRequired = false;
    await daemonRpc(daemon.socketPath, "autonomy.health");
    expect(await draining(daemon.socketPath)).toBe(false);
  });

  it("never auto-clears an operator drain (upgrade must stay quiesced)", async () => {
    daemon = await start();
    const drained = await daemonRpc(daemon.socketPath, "daemon.drain", { timeout_ms: 0 });
    expect(drained.ok).toBe(true);
    expect(await draining(daemon.socketPath)).toBe(true);

    // A healthy probe must NOT undo the operator's drain.
    drainRequired = false;
    await daemonRpc(daemon.socketPath, "autonomy.health");
    expect(await draining(daemon.socketPath)).toBe(true);

    // Only an explicit resume lifts it.
    await daemonRpc(daemon.socketPath, "daemon.resume");
    expect(await draining(daemon.socketPath)).toBe(false);
  });

  it("keeps an operator drain even after the health signal flaps bad then good", async () => {
    // The sequence that broke the first cut of this fix: an operator drain is
    // in place, a bad probe relabels it as health-raised, and the next good
    // probe lifts a drain the operator never released.
    daemon = await start();
    await daemonRpc(daemon.socketPath, "daemon.drain", { timeout_ms: 0 });
    expect(await draining(daemon.socketPath)).toBe(true);

    drainRequired = true;
    await daemonRpc(daemon.socketPath, "autonomy.health");
    drainRequired = false;
    await daemonRpc(daemon.socketPath, "autonomy.health");

    expect(await draining(daemon.socketPath)).toBe(true);
    await daemonRpc(daemon.socketPath, "daemon.resume");
    expect(await draining(daemon.socketPath)).toBe(false);
  });

  it("keeps refusing work while drained", async () => {
    daemon = await start();
    drainRequired = true;
    await daemonRpc(daemon.socketPath, "autonomy.health");

    const refused = await daemonRpc(daemon.socketPath, "session.start", {
      request_id: "req_drain_probe",
      prompt: "probe",
      title: "drain probe",
      agent_id: "claude-code",
      repo_path: "/tmp/osstack-drain-probe-repo",
    });
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("draining");
  });
});
