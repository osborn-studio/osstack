import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insertRun, insertTask, openDb, SessionRepository } from "@osstack/core";
import type {
  AgentSessionEvent,
  AgentSessionInput,
  SessionCapableAdapter,
} from "@osstack/agents";
import { encodeFrame, FrameDecoder, type HermesEvent } from "@osstack/hermes-adapter";
import { startDaemon, type DaemonHandles } from "./daemon.js";

class RelayAdapter implements SessionCapableAdapter {
  readonly id = "relay-integration";
  readonly display_name = "Relay integration";
  readonly cost_tier = "low" as const;
  readonly resumed: AgentSessionInput[] = [];

  capabilities() { return []; }
  async isAvailable() {
    return { available: true, status: "available" as const, last_checked_at: 1 };
  }
  async *invoke(): AsyncIterable<HermesEvent> { yield* []; }
  sessionCapabilities() { return { resume: true, snapshot: true }; }
  async *startSession(): AsyncIterable<AgentSessionEvent> { yield* []; }
  async *resumeSession(input: AgentSessionInput): AsyncIterable<AgentSessionEvent> {
    this.resumed.push(input);
    yield { type: "native_session.started", native_session_id: input.native_session_id };
    yield { type: "assistant.message", message_id: `reply-${input.message_id}`, text: "继续完成测试" };
    yield { type: "session.terminal", state: "completed" };
  }
}

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  delete process.env["OSSTACK_HOME"];
  delete process.env["OSSTACK_SOCKET"];
  delete process.env["OSSTACK_UPDATE_CHECK"];
});

function rpc(socketPath: string, method: string, params?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const decoder = new FrameDecoder();
    socket.on("connect", () => socket.write(encodeFrame({ id: 1, method, params })));
    socket.on("data", (chunk) => {
      const frames = decoder.push(chunk);
      if (frames.length > 0) {
        socket.end();
        resolve(frames[0] as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

function seed(handle: DaemonHandles, adapter: RelayAdapter): void {
  const db = openDb({ path: handle.dbPath });
  try {
    insertTask(db, handle.dbPath, { task_id: "task-relay", title: "Relay", created_at: 1 });
    insertRun(db, handle.dbPath, {
      run_id: "run-relay", task_id: "task-relay", session_id: "session-relay",
      agent_id: adapter.id, capability_id: "relay.resume", phase: "code", started_at: 1,
    });
    const sessions = new SessionRepository(db, handle.dbPath);
    sessions.createSession({
      session_id: "session-relay", task_id: "task-relay", run_id: "run-relay",
      agent_id: adapter.id, native_session_id: "native-codex-thread-secret", state: "idle",
      resume_supported: true, version: 2, updated_at: 2,
    });
    sessions.appendTurn({
      turn_id: "turn-relay", session_id: "session-relay", ordinal: 1,
      state: "awaiting_decision", assistant_text: "请选择方案", decision: null,
      created_at: 2, updated_at: 2,
    });
  } finally {
    db.close();
  }
}

describe("Copilot Relay daemon restart contract", () => {
  it("resumes the same native session after restart and applies a Feishu message only once", async () => {
    const home = mkdtempSync(join(tmpdir(), "osstack-copilot-relay-"));
    homes.push(home);
    const socketPath = join(home, "daemon.sock");
    process.env["OSSTACK_HOME"] = home;
    process.env["OSSTACK_SOCKET"] = socketPath;
    process.env["OSSTACK_UPDATE_CHECK"] = "0";
    const adapter = new RelayAdapter();

    let daemon = await startDaemon({ socketPath, adapters: [adapter] });
    seed(daemon, adapter);
    await daemon.close();

    daemon = await startDaemon({ socketPath, adapters: [adapter] });
    const params = {
      session_id: "session-relay", runtime_id: adapter.id,
      turn_id: "turn-relay", message_id: "feishu-message-1",
      expected_version: 2, text: "采用方案 A",
    };
    const applied = await rpc(socketPath, "session.send", params);
    await daemon.close();

    daemon = await startDaemon({ socketPath, adapters: [adapter] });
    const replay = await rpc(socketPath, "session.send", params);
    const snapshot = await rpc(socketPath, "session.snapshot", { session_id: "session-relay" });
    await daemon.close();

    expect(applied).toMatchObject({ ok: true, result: { state: "applied", session_version: 4 } });
    expect(replay).toMatchObject({ ok: true, result: { state: "duplicate", session_version: 4 } });
    expect(snapshot).toMatchObject({
      ok: true,
      result: {
        session_id: "session-relay", runtime_id: adapter.id,
        version: 4, assistant_text: "继续完成测试",
      },
    });
    expect(adapter.resumed).toHaveLength(1);
    expect(adapter.resumed[0]?.native_session_id).toBe("native-codex-thread-secret");
    expect(JSON.stringify([applied, replay, snapshot])).not.toContain("native-codex-thread-secret");
  });
});
