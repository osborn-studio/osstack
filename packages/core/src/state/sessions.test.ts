import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { insertRun, insertTask } from "./run-store.js";
import {
  SessionRepository,
  SessionVersionConflict,
  type SessionMessageInput,
} from "./sessions.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-sessions-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setup() {
  const path = join(tmp, "state.db");
  const db = openDb({ path });
  insertTask(db, path, { task_id: "task_01", title: "Relay task", created_at: 1 });
  insertRun(db, path, {
    run_id: "run_01",
    task_id: "task_01",
    session_id: "sess_01",
    agent_id: "codex-cli",
    capability_id: "codex-cli.code.write",
    phase: "code",
    started_at: 1,
  });
  return { db, path, repo: new SessionRepository(db, path) };
}

function createSession(repo: SessionRepository): void {
  repo.createSession({
    session_id: "sess_01",
    task_id: "task_01",
    run_id: "run_01",
    agent_id: "codex-cli",
    native_session_id: null,
    state: "starting",
    resume_supported: true,
    version: 1,
    updated_at: 2,
  });
}

function inboundMessage(messageId = "msg_01"): SessionMessageInput {
  return {
    message_id: messageId,
    session_id: "sess_01",
    turn_id: "turn_01",
    direction: "inbound",
    kind: "instruction.send",
    payload: { text: "采用方案 B" },
    state: "accepted",
    created_at: 4,
  };
}

describe("session persistence migration", () => {
  it("creates session, turn and message tables with lookup indexes", () => {
    const { db } = setup();
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'session_%' OR name='agent_sessions' ORDER BY name",
      ).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "agent_sessions",
        "session_messages",
        "session_turns",
      ]);
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_session_%' ORDER BY name",
      ).all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
        "idx_session_messages_session_state",
        "idx_session_turns_session_ordinal",
      ]));
    } finally {
      db.close();
    }
  });

  it("survives database reopen with the current schema version", () => {
    const { db, path, repo } = setup();
    createSession(repo);
    db.close();

    const reopened = openDb({ path });
    try {
      const restored = new SessionRepository(reopened, path).getSession("sess_01");
      expect(restored).toMatchObject({ session_id: "sess_01", version: 1 });
    } finally {
      reopened.close();
    }
  });
});

describe("SessionRepository", () => {
  it("captures a native id with compare-and-swap versioning", () => {
    const { db, repo } = setup();
    try {
      createSession(repo);
      const updated = repo.recordNativeSession("sess_01", "019f-thread", 1, 3);
      expect(updated).toMatchObject({
        native_session_id: "019f-thread",
        state: "idle",
        version: 2,
        updated_at: 3,
      });
      expect(() => repo.recordNativeSession("sess_01", "other", 1, 4)).toThrow(
        SessionVersionConflict,
      );
    } finally {
      db.close();
    }
  });

  it("applies an inbound message once and reports replay as duplicate", () => {
    const { db, repo } = setup();
    try {
      createSession(repo);
      repo.recordNativeSession("sess_01", "019f-thread", 1, 3);
      repo.appendTurn({
        turn_id: "turn_01",
        session_id: "sess_01",
        ordinal: 1,
        state: "awaiting_decision",
        assistant_text: "请选择 A 或 B",
        decision: { choices: ["A", "B"] },
        created_at: 3,
        updated_at: 3,
      });

      expect(repo.applyInbound(inboundMessage(), 2, 4)).toEqual({
        outcome: "applied",
        session_version: 3,
      });
      expect(repo.getMessage("msg_01")).toMatchObject({ state: "accepted", applied_at: null });
      repo.markMessageApplied("msg_01", 4.5);
      expect(repo.getMessage("msg_01")).toMatchObject({ state: "applied", applied_at: 4.5 });
      expect(repo.applyInbound(inboundMessage(), 2, 5)).toEqual({
        outcome: "duplicate",
        session_version: 3,
      });
      expect(() => repo.applyInbound({
        ...inboundMessage(),
        payload: { text: "不同内容" },
      }, 2, 5)).toThrow(/message_id collision/);
      expect(repo.latestSnapshot("sess_01")).toMatchObject({
        session_id: "sess_01",
        turn_id: "turn_01",
        assistant_text: "请选择 A 或 B",
        version: 3,
      });
    } finally {
      db.close();
    }
  });

  it("rejects a new message with a stale version and stores nothing", () => {
    const { db, repo } = setup();
    try {
      createSession(repo);
      repo.recordNativeSession("sess_01", "019f-thread", 1, 3);
      expect(() => repo.applyInbound(inboundMessage("msg_stale"), 1, 4)).toThrow(
        SessionVersionConflict,
      );
      expect(repo.getMessage("msg_stale")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("filters sessions by agent and state", () => {
    const { db, repo } = setup();
    try {
      createSession(repo);
      expect(repo.listSessions({ agent_id: "codex-cli", state: "starting" })).toHaveLength(1);
      expect(repo.listSessions({ agent_id: "claude-code" })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
