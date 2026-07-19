import { connect } from "node:net";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "./daemon.js";

// G1.1 (incident 2026-07-18) — daemon integration proof that an explicit
// agent_id override which cannot be honored FAILS CLOSED at the RPC surface:
// agent_override_failed error, and NO task/run is created.

let tmp: string;
let oldHome: string | undefined;
let daemon: DaemonHandles | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-daemon-override-"));
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

describe("daemon task.submit agent override (G1.1)", () => {
  it("fails closed with agent_override_failed and creates NO task/run", async () => {
    daemon = await startDaemon({ socketPath: `/tmp/osstack-override-${randomUUID()}.sock` });
    const resp = await daemonRpc(daemon.socketPath, "task.submit", {
      prompt: "override probe", kind: "code.review", agent_id: "no-such-agent",
    });
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("agent_override_failed");
    expect(resp.error?.message).toContain("agent_not_found");

    const stats = await daemonRpc(daemon.socketPath, "stats");
    expect((stats.result as { total_runs: number }).total_runs).toBe(0);
  });
});
