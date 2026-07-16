import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import {
  AgentSessionRow,
  AgentSessionState,
  SessionMessageRow,
  SessionTurnRow,
  type AgentSessionRow as AgentSessionRowType,
  type AgentSessionState as AgentSessionStateType,
  type SessionMessageRow as SessionMessageRowType,
  type SessionTurnRow as SessionTurnRowType,
} from "./schema.js";

type RawSessionRow = Omit<AgentSessionRowType, "resume_supported"> & { resume_supported: number };

export interface SessionTurnInput extends Omit<SessionTurnRowType, "decision_json"> {
  decision: unknown | null;
}

export interface SessionMessageInput extends Omit<SessionMessageRowType, "payload_json" | "applied_at"> {
  payload: unknown;
  applied_at?: number | null;
}

export interface SessionFilter {
  agent_id?: string;
  state?: AgentSessionStateType;
  task_id?: string;
  limit?: number;
}

export interface ApplyMessageResult {
  outcome: "applied" | "duplicate";
  session_version: number;
}

export interface SessionSnapshot {
  session_id: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  runtime_id: string;
  state: AgentSessionStateType;
  version: number;
  turn_id: string | null;
  assistant_text: string;
  decision: unknown | null;
  updated_at: number;
}

export class SessionVersionConflict extends Error {
  constructor(
    readonly session_id: string,
    readonly expected_version: number,
    readonly actual_version: number | null,
  ) {
    super(
      `session ${session_id} version conflict: expected ${expected_version}, `
      + `actual ${actual_version ?? "missing"}`,
    );
    this.name = "SessionVersionConflict";
  }
}

export class SessionMessageIdConflict extends Error {
  constructor(readonly message_id: string) {
    super(`message_id collision for ${message_id}`);
    this.name = "SessionMessageIdConflict";
  }
}

function parseSession(row: RawSessionRow): AgentSessionRowType {
  return AgentSessionRow.parse({ ...row, resume_supported: row.resume_supported === 1 });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export class SessionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly path: string,
  ) {}

  createSession(row: AgentSessionRowType): void {
    const parsed = AgentSessionRow.parse(row);
    withWrite(this.db, this.path, (db) => {
      db.prepare(`
        INSERT INTO agent_sessions(
          session_id,task_id,run_id,agent_id,native_session_id,state,
          resume_supported,version,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        parsed.session_id, parsed.task_id, parsed.run_id, parsed.agent_id,
        parsed.native_session_id, parsed.state, parsed.resume_supported ? 1 : 0,
        parsed.version, parsed.updated_at,
      );
    });
  }

  getSession(sessionId: string): AgentSessionRowType | undefined {
    const row = this.db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as RawSessionRow | undefined;
    return row ? parseSession(row) : undefined;
  }

  recordNativeSession(
    sessionId: string,
    nativeSessionId: string,
    expectedVersion: number,
    updatedAt: number,
  ): AgentSessionRowType {
    return this.updateSession(
      sessionId,
      expectedVersion,
      updatedAt,
      "native_session_id = ?, state = 'idle'",
      [nativeSessionId],
    );
  }

  setState(
    sessionId: string,
    state: AgentSessionStateType,
    expectedVersion: number,
    updatedAt: number,
  ): AgentSessionRowType {
    AgentSessionState.parse(state);
    return this.updateSession(sessionId, expectedVersion, updatedAt, "state = ?", [state]);
  }

  appendTurn(input: SessionTurnInput): void {
    const { decision, ...stored } = input;
    const row = SessionTurnRow.parse({
      ...stored,
      decision_json: decision === null ? null : canonicalJson(decision),
    });
    withWrite(this.db, this.path, (db) => {
      db.prepare(`
        INSERT INTO session_turns(
          turn_id,session_id,ordinal,state,assistant_text,decision_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        row.turn_id, row.session_id, row.ordinal, row.state, row.assistant_text,
        row.decision_json, row.created_at, row.updated_at,
      );
    });
  }

  applyInbound(
    input: SessionMessageInput,
    expectedVersion: number,
    appliedAt: number,
  ): ApplyMessageResult {
    const { payload, ...stored } = input;
    const payloadJson = canonicalJson(payload);
    const row = SessionMessageRow.parse({
      ...stored,
      payload_json: payloadJson,
      applied_at: input.applied_at ?? null,
    });

    return withWrite(this.db, this.path, (db) => {
      const existing = db.prepare("SELECT * FROM session_messages WHERE message_id = ?")
        .get(row.message_id) as SessionMessageRowType | undefined;
      if (existing) {
        if (
          existing.session_id !== row.session_id
          || existing.turn_id !== row.turn_id
          || existing.kind !== row.kind
          || existing.payload_json !== payloadJson
        ) {
          throw new SessionMessageIdConflict(row.message_id);
        }
        const session = this.readSession(db, row.session_id);
        return { outcome: "duplicate", session_version: session.version };
      }

      const result = db.prepare(`
        UPDATE agent_sessions
        SET version = version + 1, updated_at = ?
        WHERE session_id = ? AND version = ?
      `).run(appliedAt, row.session_id, expectedVersion);
      if (result.changes !== 1) {
        const actual = db.prepare("SELECT version FROM agent_sessions WHERE session_id = ?")
          .get(row.session_id) as { version: number } | undefined;
        throw new SessionVersionConflict(row.session_id, expectedVersion, actual?.version ?? null);
      }

      db.prepare(`
        INSERT INTO session_messages(
          message_id,session_id,turn_id,direction,kind,payload_json,state,created_at,applied_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        row.message_id, row.session_id, row.turn_id, row.direction, row.kind,
        payloadJson, row.state, row.created_at, row.applied_at,
      );
      return { outcome: "applied", session_version: expectedVersion + 1 };
    });
  }

  markMessageApplied(messageId: string, appliedAt: number): void {
    withWrite(this.db, this.path, (db) => {
      const result = db.prepare(`
        UPDATE session_messages
        SET state = 'applied', applied_at = ?
        WHERE message_id = ? AND state = 'accepted'
      `).run(appliedAt, messageId);
      if (result.changes !== 1) {
        throw new Error(`message ${messageId} is missing or is not accepted`);
      }
    });
  }

  getMessage(messageId: string): SessionMessageRowType | undefined {
    const row = this.db.prepare("SELECT * FROM session_messages WHERE message_id = ?")
      .get(messageId) as SessionMessageRowType | undefined;
    return row ? SessionMessageRow.parse(row) : undefined;
  }

  latestSnapshot(sessionId: string): SessionSnapshot {
    const session = this.readSession(this.db, sessionId);
    const turn = this.db.prepare(`
      SELECT * FROM session_turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1
    `).get(sessionId) as SessionTurnRowType | undefined;
    const parsedTurn = turn ? SessionTurnRow.parse(turn) : undefined;
    return {
      session_id: session.session_id,
      task_id: session.task_id,
      run_id: session.run_id,
      agent_id: session.agent_id,
      runtime_id: session.agent_id,
      state: session.state,
      version: session.version,
      turn_id: parsedTurn?.turn_id ?? null,
      assistant_text: parsedTurn?.assistant_text ?? "",
      decision: parsedTurn?.decision_json ? JSON.parse(parsedTurn.decision_json) : null,
      updated_at: session.updated_at,
    };
  }

  listSessions(filter: SessionFilter = {}): AgentSessionRowType[] {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filter.agent_id !== undefined) {
      where.push("agent_id = ?");
      values.push(filter.agent_id);
    }
    if (filter.state !== undefined) {
      AgentSessionState.parse(filter.state);
      where.push("state = ?");
      values.push(filter.state);
    }
    if (filter.task_id !== undefined) {
      where.push("task_id = ?");
      values.push(filter.task_id);
    }
    const limit = filter.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("session list limit must be an integer between 1 and 200");
    }
    values.push(limit);
    const sql = `SELECT * FROM agent_sessions${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, session_id LIMIT ?`;
    return (this.db.prepare(sql).all(...values) as RawSessionRow[]).map(parseSession);
  }

  private updateSession(
    sessionId: string,
    expectedVersion: number,
    updatedAt: number,
    assignment: string,
    values: unknown[],
  ): AgentSessionRowType {
    return withWrite(this.db, this.path, (db) => {
      const result = db.prepare(`
        UPDATE agent_sessions
        SET ${assignment}, version = version + 1, updated_at = ?
        WHERE session_id = ? AND version = ?
      `).run(...values, updatedAt, sessionId, expectedVersion);
      if (result.changes !== 1) {
        const actual = db.prepare("SELECT version FROM agent_sessions WHERE session_id = ?")
          .get(sessionId) as { version: number } | undefined;
        throw new SessionVersionConflict(sessionId, expectedVersion, actual?.version ?? null);
      }
      return this.readSession(db, sessionId);
    });
  }

  private readSession(db: Database.Database, sessionId: string): AgentSessionRowType {
    const row = db.prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as RawSessionRow | undefined;
    if (!row) throw new SessionVersionConflict(sessionId, 0, null);
    return parseSession(row);
  }
}
