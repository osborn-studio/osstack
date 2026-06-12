// Daemon RPC smoke tests — boots a real daemon on a throwaway socket +
// OSSTACK_HOME, then exercises the single-shot surface the upgrade tooling
// depends on (version handshake, drain, duplicate-instance guard).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { DaemonAlreadyRunningError } from "./daemon-lock.js";
import { VERSION } from "./version.js";

let home: string;
let socketPath: string;
let handle: DaemonHandles;

function rpc(method: string, params?: unknown, timeoutMs = 5_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("rpc timeout")); }, timeoutMs);
    sock.on("connect", () => sock.write(encodeFrame({ id: 1, method, params })));
    sock.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timer);
      sock.end();
      resolve(frames[0]);
    });
    sock.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

type Resp = { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } };

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "osstack-daemon-test-"));
  socketPath = join(home, "d.sock");
  process.env["OSSTACK_HOME"] = home;
  process.env["OSSTACK_UPDATE_CHECK"] = "0";
  handle = await startDaemon({ socketPath });
});

afterAll(async () => {
  await handle.close();
  rmSync(home, { recursive: true, force: true });
  delete process.env["OSSTACK_HOME"];
  delete process.env["OSSTACK_UPDATE_CHECK"];
});

describe("daemon RPC surface", () => {
  it("version reports the package version + protocol", async () => {
    const resp = (await rpc("version")) as Resp;
    expect(resp.ok).toBe(true);
    expect(resp.result?.["version"]).toBe(VERSION);
    expect(resp.result?.["protocol_version"]).toBe(1);
  });

  it("health includes update fields and draining flag", async () => {
    const resp = (await rpc("health")) as Resp;
    expect(resp.ok).toBe(true);
    expect(resp.result?.["draining"]).toBe(false);
    expect(resp.result).toHaveProperty("update_available");
    expect(resp.result).toHaveProperty("latest_version");
  });

  it("update.status returns current version and (empty) cache", async () => {
    const resp = (await rpc("update.status")) as Resp;
    expect(resp.ok).toBe(true);
    expect(resp.result?.["current"]).toBe(VERSION);
  });

  it("unknown method → unknown_method error", async () => {
    const resp = (await rpc("nope.nope")) as Resp;
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("unknown_method");
  });

  it("kanban.create + kanban.board round-trip", async () => {
    const created = (await rpc("kanban.create", { title: "smoke card" })) as Resp;
    expect(created.ok).toBe(true);
    const board = (await rpc("kanban.board")) as Resp;
    expect(board.ok).toBe(true);
  });

  it("task.submit without prompt → bad_request", async () => {
    const resp = (await rpc("task.submit", {})) as Resp;
    expect(resp.ok).toBe(false);
    expect(resp.error?.code).toBe("bad_request");
  });

  it("daemon.drain flips draining and rejects new submissions", async () => {
    const drained = (await rpc("daemon.drain", { timeout_ms: 1_000 }, 10_000)) as Resp;
    expect(drained.ok).toBe(true);
    expect(drained.result?.["drained"]).toBe(true);

    const rejected = (await rpc("task.submit", { prompt: "should be rejected" })) as Resp;
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("draining");

    const resumed = (await rpc("daemon.resume")) as Resp;
    expect(resumed.ok).toBe(true);
    expect(resumed.result?.["draining"]).toBe(false);
  });

  it("second daemon on the same OSSTACK_HOME is refused", async () => {
    await expect(startDaemon({ socketPath: join(home, "d2.sock") }))
      .rejects.toThrow(DaemonAlreadyRunningError);
  });
});
