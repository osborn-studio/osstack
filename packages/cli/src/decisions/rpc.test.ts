import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "../daemon.js";
import { healthyAutonomyHealth } from "../test-healthy-autonomy.js";

let daemon: DaemonHandles | undefined;
let root: string | undefined;
afterEach(async () => { await daemon?.close(); daemon = undefined; vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function rpc(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemon!.socketPath); const decoder = new FrameDecoder();
    const timer = setTimeout(() => { socket.destroy(); reject(Error("timeout")); }, 5000);
    socket.on("connect", () => socket.write(encodeFrame({ id: 1, method, params })));
    socket.on("error", error => { clearTimeout(timer); socket.destroy(); reject(error); });
    socket.on("data", chunk => { const frames = decoder.push(chunk); if (frames.length) { clearTimeout(timer); socket.end(); resolve(frames[0] as Awaited<ReturnType<typeof rpc>>); } });
  });
}
it("serves decisions.list through the daemon socket and rejects invalid parameters", async () => {
  root = mkdtempSync(join(tmpdir(), "decisions-rpc-"));
  vi.stubEnv("OSSTACK_HOME", root);
  vi.stubEnv("OSSTACK_ATTENTION", "0"); vi.stubEnv("OSSTACK_ENGINEERING", "0"); vi.stubEnv("OSSTACK_CONTAINED_MISSIONS", "0");
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  daemon = await startDaemon({ socketPath: join(root, "d.sock"), adapters: [], autonomyHealth: async () => healthyAutonomyHealth() });
  const response = await rpc("decisions.list", {});
  expect(response).toMatchObject({ ok: true, result: { items: [], next_cursor: null, failures: [
    { source: "contained_mission", code: "source_unavailable" },
    { source: "ci_repair", code: "source_unavailable" },
    { source: "revision_chain", code: "source_unavailable" },
  ] } });
  expect(await rpc("decisions.list", { limit: 101 })).toMatchObject({ ok: false, error: { code: "bad_request" } });
});
