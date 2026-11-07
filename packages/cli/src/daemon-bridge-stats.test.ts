import { connect } from "node:net";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "./daemon.js";

let tmp: string;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-daemon-bridgestats-"));
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  daemon = null;
});
afterEach(async () => {
  if (daemon) await daemon.close();
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"]; else process.env["OSSTACK_HOME"] = oldHome;
  await rm(tmp, { recursive: true, force: true });
});

function daemonRpc(socketPath: string, method: string): Promise<{ ok: boolean; result?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("daemon RPC timed out")); }, 5_000);
    sock.on("connect", () => { sock.write(encodeFrame({ id: 1, method })); });
    sock.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timer); sock.end();
      resolve(frames[0] as { ok: boolean; result?: Record<string, unknown> });
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

describe("daemon stats bridge section", () => {
  it("reports an empty bridge section on a daemon without bridge activity and keeps the rest of stats", async () => {
    daemon = await startDaemon({ socketPath: `/tmp/osstack-bstats-${randomUUID()}.sock` });
    const resp = await daemonRpc(daemon.socketPath, "stats");
    expect(resp.ok).toBe(true);
    const r = resp.result!;
    expect(r["total_runs"]).toBe(0);
    expect(r).toHaveProperty("rpc");
    const bridge = r["bridge"] as { available: boolean; chains: { total: number }; deferred: Record<string, { value: null; reason: string }> };
    expect(bridge.available).toBe(true);
    expect(bridge.chains.total).toBe(0);
    expect(bridge.deferred["cycle_duration_ms"]!.value).toBeNull();
    expect(JSON.stringify(bridge).length).toBeLessThan(4000);
  });
});
