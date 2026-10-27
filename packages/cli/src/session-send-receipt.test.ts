import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { AgentSessionEvent, AgentSessionInput, SessionCapableAdapter } from "@osstack/agents";
import * as autonomy from "@osstack/autonomy";
import { createScratchDir, insertRun, insertTask, openDb, SessionRepository } from "@osstack/core";
import { encodeFrame, FrameDecoder, type HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, expect, it, vi } from "vitest";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";

class ReceiptAdapter implements SessionCapableAdapter {
  readonly id = "receipt-fixture";
  readonly display_name = "In-process receipt fixture";
  readonly cost_tier = "low" as const;
  readonly resumed: AgentSessionInput[] = [];
  capabilities() { return []; }
  async isAvailable() { return { available: true, status: "available" as const, last_checked_at: Date.now() / 1000 }; }
  async *invoke(): AsyncIterable<HermesEvent> { yield* []; }
  sessionCapabilities() { return { resume: true, snapshot: true }; }
  async *startSession(): AsyncIterable<AgentSessionEvent> { yield* []; throw new Error("fixture must resume"); }
  async confirmStopped() { return { stopped: true as const, evidence: "fixture has no external producer" }; }
  async *resumeSession(input: AgentSessionInput): AsyncIterable<AgentSessionEvent> {
    this.resumed.push(input);
    yield { type: "native_session.started", native_session_id: input.native_session_id };
    yield { type: "assistant.message", message_id: "reply", text: "Instruction complete" };
    yield { type: "session.terminal", state: "completed" };
  }
}

type Response = { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
let root: string | undefined;
let socket: string;
let daemon: DaemonHandles | undefined;
let adapter: ReceiptAdapter;
let releaseFixture: (() => Promise<void>) | undefined;
const request = {
  session_id: "session", runtime_id: "receipt-fixture", turn_id: "turn",
  message_id: "instruction", expected_version: 1, text: "Continue the task", requested_by: "owner",
};

function rpc(method: string, params: unknown = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = connect(socket);
    const decoder = new FrameDecoder();
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("RPC timeout")); }, 5_000);
    sock.on("connect", () => sock.write(encodeFrame({ id: 1, method, params })));
    sock.on("error", error => { clearTimeout(timer); reject(error); });
    sock.on("data", chunk => {
      const frames = decoder.push(chunk);
      if (frames.length === 0) return;
      clearTimeout(timer); sock.end(); resolve(frames[0] as Response);
    });
  });
}

async function boot() {
  daemon = await startDaemon({ socketPath: socket, adapters: [adapter], autonomyHealth: async () => healthyAutonomyHealth() });
}

async function fixture() {
  root = await createScratchDir("tests", "send-receipt");
  socket = join(root, "d.sock");
  const repo = join(realpathSync(root), "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  vi.stubEnv("OSSTACK_HOME", root);
  vi.stubEnv("OSSTACK_SOCKET", socket);
  vi.stubEnv("OSSTACK_UPDATE_CHECK", "0");
  vi.stubEnv("OSSTACK_DASHBOARD_PORT", "0");
  vi.stubEnv("OSSTACK_ATTENTION", "0");
  vi.stubEnv("OSSTACK_ENGINEERING", "0");
  adapter = new ReceiptAdapter();
  await boot();
  const db = openDb({ path: daemon!.dbPath });
  try {
    insertTask(db, daemon!.dbPath, { task_id: "task", title: "Receipt fixture", created_at: 1 });
    insertRun(db, daemon!.dbPath, { run_id: "run", task_id: "task", session_id: "session", agent_id: adapter.id,
      capability_id: "code", phase: "execute", started_at: 1 });
    const sessions = new SessionRepository(db, daemon!.dbPath);
    sessions.createSession({ session_id: "session", task_id: "task", run_id: "run", agent_id: adapter.id,
      request_sha256: "a".repeat(64), native_session_id: "private-native", repo_path: repo, state: "idle",
      resume_supported: true, version: 1, updated_at: 1 });
    sessions.appendTurn({ turn_id: "turn", session_id: "session", ordinal: 1, state: "idle", assistant_text: "Ready",
      decision: null, created_at: 1, updated_at: 1 });
  } finally { db.close(); }
  // Fail only the physical cleanup boundary. Admission, SQLite transactions,
  // framing and replay use the real implementations and the real writer lock.
  const acquire = autonomy.acquireRepoWriteLock;
  vi.spyOn(autonomy, "acquireRepoWriteLock").mockImplementation(async (...args) => {
    const lock = await acquire(...args);
    releaseFixture = () => lock.release();
    return { ...lock, release: async () => { throw new Error("injected physical cleanup failure"); } };
  });
}

function persisted() {
  const db = openDb({ path: daemon!.dbPath });
  try {
    const sessions = new SessionRepository(db, daemon!.dbPath);
    return {
      message: sessions.getMessage(request.message_id),
      snapshot: sessions.latestSnapshot(request.session_id),
      turns: (db.prepare("SELECT count(*) AS count FROM session_turns").get() as { count: number }).count,
    };
  } finally { db.close(); }
}

afterEach(async () => {
  await daemon?.close(); daemon = undefined;
  // Test-owned lock cleanup only. This does not claim a product recovery route.
  await releaseFixture?.(); releaseFixture = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it("returns the committed send result despite cleanup failure and replays it after daemon restart", async () => {
  await fixture();
  const first = await rpc("session.send", request);
  const before = persisted();
  expect(before.message).toMatchObject({ state: "applied", applied_at: expect.any(Number) });
  expect(before.snapshot).toMatchObject({ state: "idle", version: 3, assistant_text: "Instruction complete" });
  expect(before.turns).toBe(2);
  expect(first).toMatchObject({ ok: true, result: { state: "applied", session_version: 3,
    events: expect.arrayContaining([{ type: "assistant.message", message_id: "reply", text: "Instruction complete" }]) } });
  expect(await rpc("daemon.drain", { timeout_ms: 0 })).toMatchObject({ ok: true, result: {
    drained: false, active_runs: 0, execution_lease_holds: 1,
  } });
  const replay = { ok: true, result: { state: "duplicate", session_version: 3 } };
  expect(await rpc("session.send", request)).toMatchObject(replay);
  expect(await rpc("session.send", { ...request, text: "Different instruction" })).toMatchObject({
    ok: false, error: { code: "message_id_conflict" },
  });
  await rpc("daemon.resume");
  const next = { ...request, message_id: "next", turn_id: before.snapshot.turn_id, expected_version: 3 };
  expect(await rpc("session.send", next)).toMatchObject({ ok: false, error: { code: "admission_denied" } });
  await daemon!.close(); daemon = undefined;
  await boot();
  // Replay must not acquire the writer lock. It is still held across this restart.
  expect(await rpc("session.send", request)).toMatchObject(replay);
  expect(await rpc("session.send", next)).toMatchObject({ ok: false, error: { code: "admission_denied" } });
  expect(persisted()).toEqual(before);
  expect(adapter.resumed).toHaveLength(1);
});

it.each(["accepted", "failed"] as const)("keeps the %s receipt uncertain when completion persistence and cleanup fail", async state => {
  await fixture();
  const db = openDb({ path: daemon!.dbPath });
  try {
    // Abort the real SQLite write after the adapter has completed. The enclosing
    // transaction must roll back both the new turn and its version increment.
    db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE OF state ON session_messages
      WHEN NEW.state = 'applied' BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END;`);
    if (state === "accepted") db.exec(`CREATE TRIGGER reject_failure BEFORE UPDATE OF state ON session_messages
      WHEN NEW.state = 'failed' BEGIN SELECT RAISE(ABORT, 'injected failure receipt failure'); END;`);
  } finally { db.close(); }
  expect(await rpc("session.send", request)).toMatchObject({ ok: false, error: { code: "delivery_uncertain" } });
  const before = persisted();
  expect(before.message).toMatchObject({ state, applied_at: null });
  expect(before.snapshot).toMatchObject({ turn_id: "turn", version: 2 });
  expect(before.turns).toBe(1);
  expect(await rpc("daemon.drain", { timeout_ms: 0 })).toMatchObject({ ok: true, result: {
    drained: false, active_runs: 0, execution_lease_holds: 1,
  } });
  await rpc("daemon.resume");
  expect(await rpc("session.send", request)).toMatchObject({ ok: false, error: { code: "delivery_uncertain" } });
  await daemon!.close(); daemon = undefined;
  await boot();
  expect(await rpc("session.send", request)).toMatchObject({ ok: false, error: { code: "delivery_uncertain" } });
  expect(persisted()).toEqual(before);
  expect(adapter.resumed).toHaveLength(1);
});
