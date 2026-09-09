import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDb, SessionRepository, insertRun, insertTask } from "@osstack/core";
import type {
  AgentSessionEvent,
  AgentSessionInput,
  SessionCapableAdapter,
} from "@osstack/agents";
import { encodeFrame, FrameDecoder, type HermesEvent } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { main } from "./bin.js";

type RpcResponse = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

class FakeSessionAdapter implements SessionCapableAdapter {
  readonly id = "fake-session";
  readonly display_name = "Fake Session";
  readonly cost_tier = "low" as const;
  readonly resumed: AgentSessionInput[] = [];
  readonly started: string[] = [];
  readonly failedOnce = new Set<string>();

  capabilities() { return []; }
  async isAvailable() {
    return { available: true, status: "available" as const, last_checked_at: Date.now() / 1000 };
  }
  async *invoke(): AsyncIterable<HermesEvent> { yield* []; }
  sessionCapabilities() { return { resume: true, snapshot: true }; }
  async *startSession(task: { prompt: string }): AsyncIterable<AgentSessionEvent> {
    this.started.push(task.prompt);
    yield { type: "native_session.started", native_session_id: "native-secret-started" };
    yield task.prompt === "structured-start-event" ? { type: "decision.requested", ...structuredDecision } : {
      type: "assistant.message", message_id: "reply_started",
      text: task.prompt === "structured-start" ? JSON.stringify({ ostag_decision: structuredDecision }) : "CANARY_READY",
    };
    yield { type: "session.terminal", state: "completed" };
  }
  async *resumeSession(input: AgentSessionInput, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    this.resumed.push(input);
    yield { type: "native_session.started", native_session_id: input.native_session_id };
    yield { type: "session.state", state: "running" };
    if (input.prompt === "wait-for-cancel") {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      yield { type: "session.terminal", state: "cancelled" };
      return;
    }
    if (input.prompt === "structured-event" || input.prompt === "structured-directive") {
      yield input.prompt === "structured-event"
        ? { type: "decision.requested", ...structuredDecision }
        : { type: "assistant.message", message_id: "structured_reply", text: JSON.stringify({ ostag_decision: structuredDecision }) };
      yield { type: "session.terminal", state: "completed" };
      return;
    }
    if (input.prompt === "leak") {
      yield { type: "assistant.message", message_id: `reply_${input.message_id}`, text: input.native_session_id };
      return;
    }
    if (input.prompt === "fail-once" && !this.failedOnce.has(input.session_id)) {
      this.failedOnce.add(input.session_id);
      yield {
        type: "session.terminal",
        state: "failed",
        error_code: "auth_unavailable",
        summary: "agent authentication is unavailable",
      };
      return;
    }
    if (input.prompt === "decision") {
      yield {
        type: "assistant.message",
        message_id: `reply_${input.message_id}`,
        text: JSON.stringify({
          ostag_decision: {
            decision_id: "decision_canary",
            question: "请选择灰度方向",
            choices: [
              { choice_id: "a", label: "方案 A" },
              { choice_id: "b", label: "方案 B" },
            ],
          },
        }),
      };
      yield { type: "session.terminal", state: "completed" };
      return;
    }
    yield { type: "assistant.message", message_id: `reply_${input.message_id}`, text: `收到：${input.prompt}` };
    yield { type: "session.terminal", state: "completed" };
  }
}

let home: string;
let socketPath: string;
let handle: DaemonHandles;
let adapter: FakeSessionAdapter;

const structuredDecision = {
  decision_id: "phase_boundary",
  question: "Verification finished. Continue?",
  choices: [{ choice_id: "continue", label: "Continue" }],
  continuation: {
    version: 1 as const,
    gate_kind: "phase_continue" as const,
    phase: "verify",
    next_action: "Continue to the next authorized phase",
    evidence_refs: [{ evidence_id: "verification_1", sha256: "a".repeat(64) }],
  },
};

function rpc(method: string, params?: unknown, timeoutMs = 5_000): Promise<RpcResponse> {
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
      resolve(frames[0] as RpcResponse);
    });
    sock.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function seedSession(
  id: string,
  state: "idle" | "completed" = "idle",
  resumeSupported = true,
): void {
  const db = openDb({ path: handle.dbPath });
  try {
    const taskId = `task_${id}`;
    const runId = `run_${id}`;
    insertTask(db, handle.dbPath, { task_id: taskId, title: `Relay ${id}`, created_at: 1 });
    insertRun(db, handle.dbPath, {
      run_id: runId,
      task_id: taskId,
      session_id: id,
      agent_id: adapter.id,
      capability_id: "fake.resume",
      phase: "code",
      started_at: 1,
    });
    const repo = new SessionRepository(db, handle.dbPath);
    repo.createSession({
      session_id: id,
      task_id: taskId,
      run_id: runId,
      agent_id: adapter.id,
      request_sha256: "a".repeat(64),
      native_session_id: `native-secret-${id}`,
      repo_path: `/tmp/repo-${id}`,
      state,
      resume_supported: resumeSupported,
      version: 2,
      updated_at: 2,
    });
    repo.appendTurn({
      turn_id: `turn_${id}`,
      session_id: id,
      ordinal: 1,
      state: "awaiting_decision",
      assistant_text: "请选择方向",
      decision: { choices: ["A", "B"] },
      created_at: 2,
      updated_at: 2,
    });
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "osstack-session-rpc-"));
  socketPath = join(home, "d.sock");
  process.env["OSSTACK_HOME"] = home;
  process.env["OSSTACK_SOCKET"] = socketPath;
  process.env["OSSTACK_UPDATE_CHECK"] = "0";
  adapter = new FakeSessionAdapter();
  handle = await startDaemon({ socketPath, adapters: [adapter] });
});

afterAll(async () => {
  await handle.close();
  rmSync(home, { recursive: true, force: true });
  delete process.env["OSSTACK_HOME"];
  delete process.env["OSSTACK_SOCKET"];
  delete process.env["OSSTACK_UPDATE_CHECK"];
});

describe("governed session RPC", () => {
  it.each(["structured-event", "structured-directive"])("persists %s without treating it as approval", async (text) => {
    const sessionId = `sess_${text}`;
    seedSession(sessionId);
    expect(await rpc("session.send", {
      session_id: sessionId, runtime_id: adapter.id, turn_id: `turn_${sessionId}`,
      message_id: `msg_${text}`, expected_version: 2, text,
    })).toMatchObject({ ok: true });
    const expectedWait = {
      reason: "phase_continue", request_source: "agent_reported", automatic_continuation: false,
      continuation: structuredDecision.continuation,
    };
    expect(await rpc("session.status", { session_id: sessionId })).toMatchObject({
      ok: true, result: { state: "awaiting_decision", wait: expectedWait },
    });
    expect(await rpc("session.snapshot", { session_id: sessionId })).toMatchObject({
      ok: true, result: { decision: structuredDecision, wait: expectedWait },
    });
    // The state, including the request evidence, survives reopening the store.
    const db = openDb({ path: handle.dbPath });
    try {
      expect(new SessionRepository(db, handle.dbPath).latestSnapshot(sessionId).decision).toEqual(structuredDecision);
    } finally { db.close(); }
    expect(adapter.resumed.filter((input) => input.session_id === sessionId)).toHaveLength(1);
  });

  it.each(["structured-start", "structured-start-event"])("preserves %s on the first session turn", async (prompt) => {
    const response = await rpc("session.start", {
      request_id: prompt, agent_id: adapter.id, repo_path: home,
      title: "Structured handoff", prompt,
    });
    expect(response).toMatchObject({ ok: true, result: { decision: structuredDecision } });
    expect(await rpc("session.snapshot", { session_id: response.result?.["session_id"] })).toMatchObject({
      ok: true, result: { wait: { reason: "phase_continue", automatic_continuation: false } },
    });
  });

  it("tracks a resumed turn for drain and cancellation", async () => {
    seedSession("sess_cancel");
    const sending = rpc("session.send", {
      session_id: "sess_cancel", runtime_id: adapter.id, turn_id: "turn_sess_cancel",
      message_id: "msg_cancel", expected_version: 2, text: "wait-for-cancel",
    });
    await vi.waitFor(() => expect(adapter.resumed.some((input) => input.session_id === "sess_cancel")).toBe(true));
    expect(await rpc("run.status", { run_id: "run_sess_cancel" })).toMatchObject({ ok: true, result: { active: true } });
    expect(await rpc("session.snapshot", { session_id: "sess_cancel" })).toMatchObject({ ok: true, result: { wait: null } });
    expect(await rpc("task.cancel", { run_id: "run_sess_cancel" })).toMatchObject({ ok: true });
    expect(await sending).toMatchObject({ ok: false, error: { code: "agent_failed" } });
    expect(await rpc("session.snapshot", { session_id: "sess_cancel" })).toMatchObject({
      ok: true, result: { wait: { reason: "delivery_failed", message_id: "msg_cancel" } },
    });
  });

  it("refuses a new instruction while the daemon is drained", async () => {
    seedSession("sess_drained");
    await rpc("daemon.drain", { timeout_ms: 0 });
    try {
      expect(await rpc("session.send", {
        session_id: "sess_drained", runtime_id: adapter.id, turn_id: "turn_sess_drained",
        message_id: "msg_drained", expected_version: 2, text: "go",
      })).toMatchObject({ ok: false, error: { code: "draining" } });
      expect(adapter.resumed.some((input) => input.session_id === "sess_drained")).toBe(false);
    } finally { await rpc("daemon.resume"); }
  });

  it("starts and persists a real resumable session without exposing its native id", async () => {
    const started = await rpc("session.start", {
      request_id: "request_rpc_start",
      prompt: "只回复 CANARY_READY",
      title: "Relay canary",
      agent_id: adapter.id,
      repo_path: home,
    });

    expect(started).toMatchObject({
      ok: true,
      result: {
        runtime_id: adapter.id,
        state: "idle",
        version: 3,
        resume_supported: true,
        resume_ready: true,
        assistant_text: "CANARY_READY",
      },
    });
    expect(adapter.started).toContain("只回复 CANARY_READY");
    expect(JSON.stringify(started)).not.toContain("native-secret-started");
    const sessionId = String(started.result?.["session_id"]);
    expect(await rpc("session.snapshot", { session_id: sessionId })).toMatchObject({
      ok: true,
      result: { runtime_id: adapter.id, assistant_text: "CANARY_READY" },
    });
    expect(await rpc("session.start", {
      request_id: "request_rpc_start",
      prompt: "只回复 CANARY_READY",
      title: "Relay canary",
      agent_id: adapter.id,
      repo_path: home,
    })).toMatchObject({
      ok: true,
      result: { session_id: sessionId, assistant_text: "CANARY_READY", version: 3 },
    });
    expect(adapter.started.filter((prompt) => prompt === "只回复 CANARY_READY")).toHaveLength(1);
    expect(await rpc("session.start", {
      request_id: "request_rpc_start",
      prompt: "不同的请求内容",
      title: "Relay canary",
      agent_id: adapter.id,
      repo_path: home,
    })).toMatchObject({
      ok: false,
      error: { code: "request_id_conflict" },
    });
    expect(adapter.started.filter((prompt) => prompt === "只回复 CANARY_READY")).toHaveLength(1);
  });

  it("lists and snapshots sessions without exposing native ids", async () => {
    seedSession("sess_list");
    const listed = await rpc("session.list");
    const snapshot = await rpc("session.snapshot", { session_id: "sess_list" });

    expect(listed.ok).toBe(true);
    expect(listed.result?.["sessions"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: "sess_list", runtime_id: adapter.id }),
    ]));
    expect(JSON.stringify(listed)).not.toContain("native-secret");
    expect(snapshot).toMatchObject({
      ok: true,
      result: {
        session_id: "sess_list",
        runtime_id: adapter.id,
        turn_id: "turn_sess_list",
        assistant_text: "请选择方向",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("native-secret");
    expect(await rpc("session.list", { limit: 201 })).toMatchObject({
      ok: false, error: { code: "bad_request" },
    });
  });

  it("applies an instruction once and reports an identical replay as duplicate", async () => {
    seedSession("sess_apply");
    const params = {
      session_id: "sess_apply",
      runtime_id: adapter.id,
      turn_id: "turn_sess_apply",
      message_id: "msg_apply",
      expected_version: 2,
      text: "采用方案 B",
      requested_by: "owner",
    };

    const first = await rpc("session.send", params);
    const replay = await rpc("session.send", params);
    const snapshot = await rpc("session.snapshot", { session_id: "sess_apply" });

    expect(first).toMatchObject({ ok: true, result: { state: "applied", session_version: 4 } });
    expect(replay).toMatchObject({ ok: true, result: { state: "duplicate", session_version: 4 } });
    expect(snapshot).toMatchObject({
      ok: true,
      result: { state: "idle", version: 4, assistant_text: "收到：采用方案 B" },
    });
    const db = openDb({ path: handle.dbPath });
    try {
      expect(new SessionRepository(db, handle.dbPath).getMessage("msg_apply")).toMatchObject({
        state: "applied",
      });
    } finally {
      db.close();
    }
    expect(adapter.resumed.filter((input) => input.session_id === "sess_apply")).toHaveLength(1);
    expect(adapter.resumed.find((input) => input.session_id === "sess_apply")?.context).toMatchObject({
      repo_path: "/tmp/repo-sess_apply",
      requested_by: "owner",
    });
    expect(JSON.stringify(first)).not.toContain("native-secret");
  });

  it("keeps a failed adapter instruction recoverable instead of applying an empty turn", async () => {
    seedSession("sess_retry");
    const params = {
      session_id: "sess_retry",
      runtime_id: adapter.id,
      turn_id: "turn_sess_retry",
      message_id: "msg_retry",
      expected_version: 2,
      text: "fail-once",
    };

    const failed = await rpc("session.send", params);
    const afterFailure = await rpc("session.snapshot", { session_id: "sess_retry" });
    const retried = await rpc("session.send", params);

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "agent_failed",
        message: "agent failed while applying the instruction (auth_unavailable)",
      },
    });
    expect(afterFailure).toMatchObject({
      ok: true,
      result: {
        state: "idle",
        version: 3,
        turn_id: "turn_sess_retry",
        assistant_text: "请选择方向",
      },
    });
    expect(retried).toMatchObject({
      ok: true,
      result: { state: "applied", session_version: 4 },
    });
    const db = openDb({ path: handle.dbPath });
    try {
      expect(new SessionRepository(db, handle.dbPath).getMessage("msg_retry")).toMatchObject({
        state: "applied",
      });
    } finally {
      db.close();
    }
  });

  it("turns an exact bounded OStag decision directive into awaiting_decision", async () => {
    seedSession("sess_decision");
    const response = await rpc("session.send", {
      session_id: "sess_decision",
      runtime_id: adapter.id,
      turn_id: "turn_sess_decision",
      message_id: "msg_decision",
      expected_version: 2,
      text: "decision",
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: "applied",
        events: [{
          type: "session.state",
          state: "running",
        }, {
          type: "decision.requested",
          decision_id: "decision_canary",
          question: "请选择灰度方向",
          choices: [
            { choice_id: "a", label: "方案 A" },
            { choice_id: "b", label: "方案 B" },
          ],
        }, {
          type: "session.terminal",
          state: "completed",
        }],
      },
    });
    expect(await rpc("session.snapshot", { session_id: "sess_decision" })).toMatchObject({
      ok: true,
      result: {
        state: "awaiting_decision",
        assistant_text: "请选择灰度方向",
        decision: { decision_id: "decision_canary" },
      },
    });
  });

  it("rejects stale versions, wrong turns, terminal sessions and oversized messages", async () => {
    seedSession("sess_guards");
    seedSession("sess_terminal", "completed");
    seedSession("sess_unsupported", "idle", false);
    const base = {
      session_id: "sess_guards",
      runtime_id: adapter.id,
      turn_id: "turn_sess_guards",
      message_id: "msg_guard",
      expected_version: 2,
      text: "继续",
    };

    expect(await rpc("session.send", { ...base, expected_version: 1 })).toMatchObject({
      ok: false, error: { code: "version_conflict" },
    });
    expect(await rpc("session.send", { ...base, turn_id: "turn_wrong" })).toMatchObject({
      ok: false, error: { code: "turn_conflict" },
    });
    expect(await rpc("session.send", {
      ...base,
      session_id: "sess_terminal",
      turn_id: "turn_sess_terminal",
    })).toMatchObject({ ok: false, error: { code: "session_terminal" } });
    expect(await rpc("session.send", { ...base, text: "x".repeat(16_001) })).toMatchObject({
      ok: false, error: { code: "bad_request" },
    });
    expect(await rpc("session.send", {
      ...base,
      session_id: "sess_unsupported",
      turn_id: "turn_sess_unsupported",
    })).toMatchObject({ ok: false, error: { code: "resume_unsupported" } });
    expect(await rpc("session.status", { session_id: "sess_missing" })).toMatchObject({
      ok: false, error: { code: "not_found" },
    });
  });

  it("collapses concurrent duplicate delivery into one adapter resume", async () => {
    seedSession("sess_concurrent");
    const params = {
      session_id: "sess_concurrent",
      runtime_id: adapter.id,
      turn_id: "turn_sess_concurrent",
      message_id: "msg_concurrent",
      expected_version: 2,
      text: "继续执行",
    };
    const responses = await Promise.all([
      rpc("session.send", params),
      rpc("session.send", params),
    ]);

    expect(responses.map((item) => item.result?.["state"]).sort()).toEqual(["applied", "duplicate"]);
    expect(adapter.resumed.filter((input) => input.session_id === "sess_concurrent")).toHaveLength(1);
  });

  it("fails closed on an accepted reservation left by daemon interruption", async () => {
    seedSession("sess_recover");
    const db = openDb({ path: handle.dbPath });
    try {
      new SessionRepository(db, handle.dbPath).applyInbound({
        message_id: "msg_recover",
        session_id: "sess_recover",
        turn_id: "turn_sess_recover",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "恢复后继续" },
        state: "accepted",
        created_at: 3,
      }, 2, 3);
    } finally {
      db.close();
    }

    const response = await rpc("session.send", {
      session_id: "sess_recover",
      runtime_id: adapter.id,
      turn_id: "turn_sess_recover",
      message_id: "msg_recover",
      expected_version: 2,
      text: "恢复后继续",
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "delivery_uncertain" },
    });
    expect(adapter.resumed.filter((input) => input.session_id === "sess_recover")).toHaveLength(0);
    expect(await rpc("session.snapshot", { session_id: "sess_recover" })).toMatchObject({
      ok: true, result: { wait: { reason: "delivery_uncertain", message_id: "msg_recover", automatic_continuation: false } },
    });
  });

  it("keeps an uncertain delivery visible when a newer message fails", async () => {
    seedSession("sess_shadow");
    const db = openDb({ path: handle.dbPath });
    try {
      const repo = new SessionRepository(db, handle.dbPath);
      for (const [messageId, version, createdAt] of [
        ["msg_uncertain", 2, 3], ["msg_newer_failed", 3, 4],
      ] as const) {
        repo.applyInbound({
          message_id: messageId, session_id: "sess_shadow", turn_id: "turn_sess_shadow",
          direction: "inbound", kind: "instruction.send", payload: { text: "go" },
          state: "accepted", created_at: createdAt,
        }, version, createdAt);
      }
      repo.markMessageFailed("msg_newer_failed");
    } finally { db.close(); }
    expect(await rpc("session.snapshot", { session_id: "sess_shadow" })).toMatchObject({
      ok: true, result: { wait: { reason: "delivery_uncertain", message_id: "msg_uncertain", automatic_continuation: false } },
    });
  });

  it("exposes list, status, snapshot and send through the CLI", async () => {
    seedSession("sess_cli");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await main(["session", "list", "--json"])).toBe(0);
      expect(await main(["session", "status", "sess_cli", "--json"])).toBe(0);
      expect(await main(["session", "snapshot", "sess_cli", "--json"])).toBe(0);
      expect(await main([
        "session", "send", "sess_cli",
        "--runtime", adapter.id,
        "--turn", "turn_sess_cli",
        "--message-id", "msg_cli",
        "--expected-version", "2",
        "--text", "按批准方案继续",
        "--json",
      ])).toBe(0);
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("native-secret");
    } finally {
      log.mockRestore();
    }
  });

  it("starts a resumable session through the CLI without exposing its native id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await main([
        "session", "start",
        "--request-id", "request_cli_start",
        "--agent", adapter.id,
        "--repo", home,
        "--title", "CLI relay canary",
        "--text", "只回复 CANARY_READY",
        "--json",
      ])).toBe(0);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("CANARY_READY");
      expect(output).not.toContain("native-secret-started");
    } finally {
      log.mockRestore();
    }
  });

  it("fails closed when an adapter tries to expose protected native metadata", async () => {
    seedSession("sess_leak");
    const response = await rpc("session.send", {
      session_id: "sess_leak",
      runtime_id: adapter.id,
      turn_id: "turn_sess_leak",
      message_id: "msg_leak",
      expected_version: 2,
      text: "leak",
    });

    expect(response).toMatchObject({ ok: false, error: { code: "adapter_protocol" } });
    expect(JSON.stringify(response)).not.toContain("native-secret");
  });

  it("rejects instructions addressed to a different runtime before invoking the adapter", async () => {
    seedSession("sess_runtime_guard");
    const resumesBefore = adapter.resumed.length;

    const response = await rpc("session.send", {
      session_id: "sess_runtime_guard",
      runtime_id: "another-runtime",
      turn_id: "turn_sess_runtime_guard",
      message_id: "msg_runtime_guard",
      expected_version: 2,
      text: "继续",
    });

    expect(response).toMatchObject({ ok: false, error: { code: "runtime_mismatch" } });
    expect(adapter.resumed).toHaveLength(resumesBefore);
  });
});
