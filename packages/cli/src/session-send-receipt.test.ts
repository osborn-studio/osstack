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
  readonly started: string[] = [];
  failResume = false;
  failStop = false;
  capabilities() { return []; }
  async isAvailable() { return { available: true, status: "available" as const, last_checked_at: Date.now() / 1000 }; }
  async *invoke(): AsyncIterable<HermesEvent> { yield* []; }
  sessionCapabilities() { return { resume: true, snapshot: true }; }
  async *startSession(task: { prompt: string }): AsyncIterable<AgentSessionEvent> {
    this.started.push(task.prompt);
    yield { type: "native_session.started", native_session_id: "private-started-native" };
    yield { type: "assistant.message", message_id: "start-reply", text: "Session started" };
    yield { type: "session.terminal", state: "completed" };
  }
  async confirmStopped() {
    if (this.failStop) throw new Error("injected stop verifier failure");
    return { stopped: true as const, evidence: "fixture has no external producer" };
  }
  async *resumeSession(input: AgentSessionInput): AsyncIterable<AgentSessionEvent> {
    this.resumed.push(input);
    yield { type: "native_session.started", native_session_id: input.native_session_id };
    if (this.failResume) throw new Error("injected lost execution response");
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
let admissionBlocked: (() => Promise<void>) | undefined;
let unblockAdmission: (() => void) | undefined;
let cleanupAttempts = 0;
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
  daemon = await startDaemon({ socketPath: socket, adapters: [adapter], autonomyHealth: async () => {
    await admissionBlocked?.();
    return healthyAutonomyHealth();
  } });
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
  cleanupAttempts = 0;
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
    return { ...lock, release: async () => { cleanupAttempts++; throw new Error("injected physical cleanup failure"); } };
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
  unblockAdmission?.(); unblockAdmission = undefined; admissionBlocked = undefined;
  await daemon?.close(); daemon = undefined;
  // Test-owned lock cleanup only. This does not claim a product recovery route.
  await releaseFixture?.(); releaseFixture = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it("returns the committed send result despite cleanup failure and replays it after daemon restart", async () => {
  await fixture();
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const first = await rpc("session.send", request);
  const before = persisted();
  expect(before.message).toMatchObject({ state: "applied", applied_at: expect.any(Number) });
  expect(before.snapshot).toMatchObject({ state: "idle", version: 3, assistant_text: "Instruction complete" });
  expect(before.turns).toBe(2);
  expect(first).toMatchObject({ ok: true, result: { state: "applied", session_version: 3,
    events: expect.arrayContaining([{ type: "assistant.message", message_id: "reply", text: "Instruction complete" }]) } });
  const diagnostics = stderr.mock.calls.map(([chunk]) => String(chunk))
    .filter(line => line.startsWith('{"event":"session_cleanup_failed"'));
  expect(diagnostics).toHaveLength(1);
  expect(JSON.parse(diagnostics[0]!)).toEqual({ event: "session_cleanup_failed", session_id: "session", run_id: "run" });
  expect(diagnostics[0]).not.toContain(request.text);
  expect(diagnostics[0]).not.toContain("private-native");
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
  // This same-process daemon restart retains the fixture process and lock.
  // It proves DB-driven replay without admission, not OS reboot recovery.
  expect(await rpc("session.send", request)).toMatchObject(replay);
  expect(await rpc("session.send", next)).toMatchObject({ ok: false, error: { code: "admission_denied" } });
  expect(persisted()).toEqual(before);
  expect(adapter.resumed).toHaveLength(1);
});

it("preserves a duplicate receipt that appears while admission waits when cleanup fails", async () => {
  await fixture();
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { unblockAdmission = resolve; });
  admissionBlocked = async () => { entered(); await released; };
  const sending = rpc("session.send", request);
  await waiting;
  // Another trusted DB connection commits the original instruction while the
  // async admission check waits. Same-daemon concurrent RPCs are already fenced.
  const db = openDb({ path: daemon!.dbPath });
  try {
    const sessions = new SessionRepository(db, daemon!.dbPath);
    db.transaction(() => {
      sessions.applyInbound({ message_id: request.message_id, session_id: request.session_id,
        turn_id: request.turn_id, direction: "inbound", kind: "instruction.send", state: "accepted",
        payload: { text: request.text, requested_by: request.requested_by }, created_at: 2 }, 1, 2);
      sessions.completeInboundTurn({ message_id: request.message_id, expected_version: 2, applied_at: 3,
        turn: { turn_id: "completed-elsewhere", session_id: request.session_id, ordinal: 2,
          state: "idle", assistant_text: "Completed by original writer", decision: null, created_at: 2, updated_at: 3 } });
    })();
  } finally { db.close(); }
  unblockAdmission!(); admissionBlocked = undefined;
  const before = persisted();
  expect(await sending).toMatchObject({ ok: true, result: { state: "duplicate", session_version: 3 } });
  expect(cleanupAttempts).toBe(1);
  expect(await rpc("daemon.drain", { timeout_ms: 0 })).toMatchObject({ ok: true, result: {
    drained: false, active_runs: 0, execution_lease_holds: 1,
  } });
  expect(await rpc("session.send", request)).toMatchObject({ ok: true, result: { state: "duplicate", session_version: 3 } });
  expect(persisted()).toEqual(before);
  expect(adapter.resumed).toHaveLength(0);
});

it("retains admission when the adapter stop verifier throws without changing the failed receipt", async () => {
  await fixture();
  adapter.failResume = true; adapter.failStop = true;
  expect(await rpc("session.send", request)).toMatchObject({ ok: false, error: { code: "agent_failed" } });
  expect(cleanupAttempts).toBe(0);
  expect(persisted().message).toMatchObject({ state: "failed", applied_at: null });
  expect(await rpc("daemon.drain", { timeout_ms: 0 })).toMatchObject({ ok: true, result: {
    drained: false, active_runs: 0, execution_lease_holds: 1,
  } });
  await rpc("daemon.resume");
  expect(await rpc("session.send", request)).toMatchObject({ ok: false, error: { code: "delivery_uncertain" } });
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

it("preserves a completed Session start and clears its active marker when cleanup fails", async () => {
  await fixture();
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const params = { request_id: "start-once", agent_id: adapter.id, repo_path: join(realpathSync(root!), "repo"),
    title: "Start receipt", prompt: "Private start prompt" };
  const first = await rpc("session.start", params);
  const db = openDb({ path: daemon!.dbPath });
  let startedSession: { session_id: string; run_id: string; state: string; version: number };
  try {
    startedSession = db.prepare("SELECT session_id,run_id,state,version FROM agent_sessions WHERE session_id != 'session'")
      .get() as typeof startedSession;
    expect(startedSession).toMatchObject({ state: "idle", version: 3 });
    expect(db.prepare("SELECT outcome FROM runs WHERE run_id = ?").get(startedSession.run_id)).toEqual({ outcome: "completed" });
  } finally { db.close(); }
  expect(await rpc("health")).toMatchObject({ ok: true, result: { active_runs: 0 } });
  expect(first).toMatchObject({ ok: true, result: { session_id: startedSession.session_id, state: "idle", version: 3,
    assistant_text: "Session started" } });
  const diagnostics = stderr.mock.calls.map(([chunk]) => String(chunk))
    .filter(line => line.startsWith('{"event":"session_cleanup_failed"'));
  expect(diagnostics).toHaveLength(1);
  expect(JSON.parse(diagnostics[0]!)).toEqual({ event: "session_cleanup_failed",
    session_id: startedSession.session_id, run_id: startedSession.run_id });
  expect(diagnostics[0]).not.toContain(params.prompt);
  expect(diagnostics[0]).not.toContain("private-started-native");
  expect(await rpc("daemon.drain", { timeout_ms: 0 })).toMatchObject({ ok: true, result: {
    drained: false, active_runs: 0, execution_lease_holds: 1,
  } });
  await rpc("daemon.resume");
  expect(await rpc("session.start", params)).toMatchObject({ ok: true, result: {
    session_id: startedSession.session_id, state: "idle", version: 3,
  } });
  expect(adapter.started).toEqual([params.prompt]);
});
