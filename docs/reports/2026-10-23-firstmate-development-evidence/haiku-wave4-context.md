请做最后一轮范围明确的 Haiku 5.5 复审，不调用工具。上一轮4个确定P1已确认修复，但因未提供相关源码提出 C1-C4。这里补全关键调用链及实际回归源码，请给出每项已排除/确认/条件未满足，若未排除必须给出由所给代码可达的具体序列。不要仅因不包括整个 monorepo 就阻断。
C1: daemon 在 SupervisionService.handle 前分派 attention.answer/abandon-receipt（给出完整handleSingle的Attention分支）。
C2: sessions.applyInbound 对存在message返回duplicate而不分派；daemon对原accepted/failed拒绝重放。新增真实socket用例验证abandon原ID不resume，新明确指令可resume。
C3: latestSnapshot没有turn时返回null而非undefined；现在 awaiting_decision 且 decision=null 明确拒绝。旧turn gate不是全局签名权限源，新turn代表当前来源状态；历史risk item仍保留，普通文字不证明已审批。执行的既有权限不依赖标签。请仅审新增人工路线是否错误绕过其声明的当前决策门禁。
C4: completeInboundTurn在同事务中落新turn并accepted→applied；失败才保留failed/accepted未知，阻止重放是刻意的安全行为。不开Attention时未知指令也被阻止；人工可显式启用Attention并register scope后作abandoned_unknown处置，这不是透明自动恢复。不是要兼容旧的不确定失败自动重试。
此外修复run缺失coverage，Loop容量释放后重新准入/显式release保持，handoff过期仍返回historical receipt而不续期。CI格式校验在reader已存在，源码附上。withWrite使用better-sqlite3嵌套savepoint，实际集成测试已运行通过。请重点看剩余P1，不重复已接受P2（无retention、30秒一条通知、release后历史item状态不再refresh、非多租户、无离线watchdog）。允许明确保留非阻断P2。输出简洁中文，最后明确有无已确认的阻断问题。

--- packages/core/src/state/sessions.ts ---
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

export interface CompleteInboundTurnInput {
  turn: SessionTurnInput;
  message_id: string;
  expected_version: number;
  applied_at: number;
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
          session_id,task_id,run_id,agent_id,request_sha256,native_session_id,
          repo_path,state,resume_supported,version,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        parsed.session_id, parsed.task_id, parsed.run_id, parsed.agent_id,
        parsed.request_sha256, parsed.native_session_id, parsed.repo_path, parsed.state,
        parsed.resume_supported ? 1 : 0, parsed.version, parsed.updated_at,
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

  markMessageFailed(messageId: string): void {
    withWrite(this.db, this.path, (db) => {
      const result = db.prepare(`
        UPDATE session_messages
        SET state = 'failed', applied_at = NULL
        WHERE message_id = ? AND state = 'accepted'
      `).run(messageId);
      if (result.changes !== 1) {
        throw new Error(`message ${messageId} is missing or is not accepted`);
      }
    });
  }

  retryFailedMessage(messageId: string): void {
    withWrite(this.db, this.path, (db) => {
      const result = db.prepare(`
        UPDATE session_messages
        SET state = 'accepted', applied_at = NULL
        WHERE message_id = ? AND state = 'failed'
      `).run(messageId);
      if (result.changes !== 1) {
        throw new Error(`message ${messageId} is missing or is not failed`);
      }
    });
  }

  completeInboundTurn(input: CompleteInboundTurnInput): AgentSessionRowType {
    AgentSessionState.parse(input.turn.state);
    const { decision, ...storedTurn } = input.turn;
    const turn = SessionTurnRow.parse({
      ...storedTurn,
      decision_json: decision === null ? null : canonicalJson(decision),
    });

    return withWrite(this.db, this.path, (db) => {
      const message = db.prepare(`
        SELECT session_id, state FROM session_messages WHERE message_id = ?
      `).get(input.message_id) as {
        session_id: string;
        state: SessionMessageRowType["state"];
      } | undefined;
      if (
        message === undefined
        || message.session_id !== turn.session_id
        || message.state !== "accepted"
      ) {
        throw new Error(
          `message ${input.message_id} is missing, belongs to another session, or is not accepted`,
        );
      }

      const updated = db.prepare(`
        UPDATE agent_sessions
        SET state = ?, version = version + 1, updated_at = ?
        WHERE session_id = ? AND version = ?
      `).run(
        turn.state,
        input.applied_at,
        turn.session_id,
        input.expected_version,
      );
      if (updated.changes !== 1) {
        const actual = db.prepare("SELECT version FROM agent_sessions WHERE session_id = ?")
          .get(turn.session_id) as { version: number } | undefined;
        throw new SessionVersionConflict(
          turn.session_id,
          input.expected_version,
          actual?.version ?? null,
        );
      }

      db.prepare(`
        INSERT INTO session_turns(
          turn_id,session_id,ordinal,state,assistant_text,decision_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        turn.turn_id,
        turn.session_id,
        turn.ordinal,
        turn.state,
        turn.assistant_text,
        turn.decision_json,
        turn.created_at,
        turn.updated_at,
      );

      const applied = db.prepare(`
        UPDATE session_messages
        SET state = 'applied', applied_at = ?
        WHERE message_id = ? AND state = 'accepted'
      `).run(input.applied_at, input.message_id);
      if (applied.changes !== 1) {
        throw new Error(`message ${input.message_id} could not be marked applied`);
      }
      return this.readSession(db, turn.session_id);
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

--- packages/core/src/state/db.ts ---
// SQLite connection management.
//
// Decisions locked in plan v0.6:
//   - better-sqlite3 (synchronous, single connection per daemon process)
//   - WAL mode for concurrent reader/writer safety
//   - synchronous=NORMAL (WAL-safe, faster than FULL)
//   - 64 MiB page cache
//   - foreign_keys ON (so ON DELETE CASCADE works for runs/events on task delete)
//
// CRITICAL GAP G1 (plan v0.6 §8.3): disk-full must never cause a silent task
// write loss. Every write goes through preflightDiskSpace(), which throws
// DiskFullError before any INSERT/UPDATE can corrupt or stall a transaction.

import Database from "better-sqlite3";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

/** Default safety threshold for disk-full preflight (100 MiB). */
export const DEFAULT_MIN_FREE_BYTES = 100 * 1024 * 1024;

/** Cache size in -kibibyte units. negative = KiB (per SQLite docs). 64 MiB. */
const PAGE_CACHE_KIB = -65536;

export class DiskFullError extends Error {
  readonly path: string;
  readonly freeBytes: number;
  readonly minFreeBytes: number;
  constructor(path: string, freeBytes: number, minFreeBytes: number) {
    super(
      `Disk full preflight failed for ${path}: ${freeBytes} bytes free, ` +
      `need ≥${minFreeBytes}. Refusing write so Hermes can be notified.`,
    );
    this.name = "DiskFullError";
    this.path = path;
    this.freeBytes = freeBytes;
    this.minFreeBytes = minFreeBytes;
  }
}

export interface OpenDbOptions {
  /** Absolute path to the SQLite file (parent dir must exist). */
  path: string;
  /** When false, opens read-only. */
  readwrite?: boolean;
  /** Override the disk-full safety threshold (bytes). */
  minFreeBytes?: number;
}

/**
 * Run a free-space check against the filesystem holding `path`. Throws
 * DiskFullError if below threshold; otherwise returns free byte count.
 * Skips the check (returns Infinity) if statfsSync is unsupported on the
 * platform — better to allow writes than to crash a daemon on a kernel quirk.
 */
export function preflightDiskSpace(
  path: string,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): number {
  let stats: { bsize: number; bavail: number };
  try {
    stats = statfsSync(dirname(path));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  const free = Number(stats.bsize) * Number(stats.bavail);
  if (free < minFreeBytes) throw new DiskFullError(path, free, minFreeBytes);
  return free;
}

/**
 * Open the osstack state database, apply pragmas, and run pending migrations.
 * Caller owns the lifetime — pair every openDb() with a db.close() in shutdown.
 */
export function openDb(opts: OpenDbOptions): Database.Database {
  const { path, readwrite = true, minFreeBytes = DEFAULT_MIN_FREE_BYTES } = opts;
  if (readwrite) preflightDiskSpace(path, minFreeBytes);

  const db = new Database(path, { readonly: !readwrite });

  // Pragmas are applied per-connection in SQLite. Apply on every open.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma(`cache_size = ${PAGE_CACHE_KIB}`);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  if (readwrite) runMigrations(db);
  return db;
}

/**
 * Apply pending migrations idempotently. `user_version` PRAGMA tracks progress.
 * The migrations themselves are CREATE IF NOT EXISTS-safe, but the version
 * pragma is what guarantees we only apply forward.
 */
export function runMigrations(db: Database.Database): void {
  const currentRow = db.pragma("user_version", { simple: true }) as number;
  let current = Number(currentRow);
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.id}`);
      db.exec("COMMIT");
      current = m.id;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  if (current !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Migration state inconsistent: user_version=${current}, expected=${CURRENT_SCHEMA_VERSION}`,
    );
  }
}

/**
 * Run a function inside a transaction with preflight. Use for any write path
 * called from the daemon hot loop. Wraps better-sqlite3's transaction() so
 * disk-space errors fire BEFORE BEGIN, not mid-transaction.
 */
export function withWrite<T>(
  db: Database.Database,
  path: string,
  fn: (db: Database.Database) => T,
  minFreeBytes: number = DEFAULT_MIN_FREE_BYTES,
): T {
  preflightDiskSpace(path, minFreeBytes);
  const tx = db.transaction(fn);
  return tx(db);
}

--- packages/core/src/state/attention-actions.ts ---
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SessionDecision } from "@osstack/protocol";
import { withWrite } from "./db.js";
import { SessionRepository, type SessionMessageInput } from "./sessions.js";
import {
  AttentionStore,
  attentionDigest,
  type AttentionOwner,
} from "./attention-store.js";
/** Common human reservation, serialized with collaborator writes in the same DB. */
export function reserveSessionInstruction(
  db: Database.Database,
  path: string,
  message: SessionMessageInput,
  version: number,
  now: number,
  takeover = false,
  takeoverGrantId?: string
) {
  return withWrite(db, path, () => {
    const sessions = new SessionRepository(db, path);
    if (sessions.getMessage(message.message_id))
      return sessions.applyInbound(message, version, now);
    if (
      db
        .prepare(
          "SELECT 1 FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') AND message_id NOT IN (SELECT message_id FROM attention_receipt_resolutions) LIMIT 1"
        )
        .get(message.session_id)
    )
      throw new Error("delivery_uncertain");
    if (
      db
        .prepare(
          "SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved') LIMIT 1"
        )
        .get(message.session_id)
    )
      throw new Error("continuation_in_flight");
    const grant = db
      .prepare(
        "SELECT grant_id FROM session_continuation_grants WHERE session_id=? AND status='active'"
      )
      .get(message.session_id) as { grant_id: string } | undefined;
    if (grant && takeover && takeoverGrantId !== grant.grant_id)
      throw new Error("takeover_grant_changed");
    if (grant && !takeover) throw new Error("grant_owned");
    const snapshot = sessions.latestSnapshot(message.session_id);
    if (snapshot.state === "awaiting_decision" && snapshot.decision === null)
      throw new Error("invalid_decision");
    const decision = SessionDecision.safeParse(snapshot.decision);
    const raw = snapshot.decision as Record<string, unknown> | null;
    const legacy =
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).every((k) => ["question", "choices"].includes(k)) &&
      Array.isArray(raw["choices"]) &&
      raw["choices"].every((v) => typeof v === "string") &&
      (raw["question"] === undefined || typeof raw["question"] === "string");
    if (snapshot.decision !== null && !decision.success && !legacy)
      throw new Error("invalid_decision");

    if (
      decision.success &&
      ["risk_approval", "task_authorization"].includes(
        decision.data.continuation?.gate_kind ?? ""
      )
    )
      throw new Error("signed_approval_required");
    if (grant)
      db.prepare(
        "UPDATE session_continuation_grants SET status='blocked',reason='human_takeover',updated_at=? WHERE grant_id=?"
      ).run(now, grant.grant_id);
    return sessions.applyInbound(message, version, now);
  });
}
export interface AttentionAnswer {
  scope_id: string;
  item_id: string;
  action_id: string;
  revision: number;
  content_hash: string;
  text: string;
  takeover: boolean;
  takeover_grant_id?: string;
}
interface Action {
  action_id: string;
  scope_id: string;
  item_id: string;
  payload_hash: string;
  message_id: string;
  state: string;
  created_at: number;
  updated_at: number;
}
export class AttentionActions {
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner) {}
  reserve(input: AttentionAnswer, now = Date.now()) {
    if (
      !input.action_id ||
      input.action_id.length > 256 ||
      !input.text.trim() ||
      input.text.length > 16000
    )
      throw new Error("invalid_answer");
    return this.store.write(this.owner, () => {
      const db = this.store.db;
      const digest = attentionDigest(input);
      const prior = db
        .prepare("SELECT * FROM attention_actions WHERE action_id=?")
        .get(input.action_id) as Action | undefined;
      if (prior) {
        if (prior.payload_hash !== digest)
          throw new Error("action_id_conflict");
        return {
          ...this.reconcile(prior, now),
          replay: true,
          reservation_version: 0,
        };
      }
      const item = this.store.getItem(input.scope_id, input.item_id);
      const scope = this.store.getScope(input.scope_id);
      if (!item || !scope) throw new Error("not_found");
      if (
        item.state !== "open" ||
        item.revision !== input.revision ||
        item.content_hash !== input.content_hash
      )
        throw new Error("stale_item");
      if (
        db
          .prepare("SELECT 1 FROM attention_actions WHERE item_id=?")
          .get(item.item_id)
      )
        throw new Error("action_already_reserved");
      const repo = new SessionRepository(db, this.store.path);
      const source = repo.getSession(item.session_id);
      const latest = repo.latestSnapshot(item.session_id);
      if (source && source.state !== "awaiting_decision")
        throw new Error("session_not_awaiting_decision");
      if (
        !source ||
        source.task_id !== scope.task_id ||
        realpathSync(source.repo_path) !== scope.repo_path ||
        latest.turn_id !== item.turn_id ||
        source.version !== item.source_version ||
        attentionDigest(SessionDecision.parse(latest.decision)) !==
          item.content_hash
      )
        throw new Error("source_changed");
      if (
        !db
          .prepare(
            "SELECT 1 FROM tasks t JOIN runs r ON r.task_id=t.task_id WHERE t.task_id=? AND r.run_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL"
          )
          .get(scope.task_id, source.run_id)
      )
        throw new Error("source_changed");
      const messageId = `attention-${randomUUID()}`;
      const reservation = reserveSessionInstruction(
        db,
        this.store.path,
        {
          message_id: messageId,
          session_id: item.session_id,
          turn_id: item.turn_id,
          direction: "inbound",
          kind: "instruction.send",
          payload: { text: input.text },
          state: "accepted",
          created_at: now / 1000,
        },
        source.version,
        now / 1000,
        input.takeover,
        input.takeover_grant_id
      );
      db.prepare(
        "INSERT INTO attention_actions VALUES(?,?,?,?,?,'reserved',?,?)"
      ).run(
        input.action_id,
        input.scope_id,
        input.item_id,
        digest,
        messageId,
        now,
        now
      );
      db.prepare(
        "UPDATE attention_items SET state='answer_reserved',revision=revision+1,updated_at=? WHERE item_id=?"
      ).run(now, item.item_id);
      return {
        action_id: input.action_id,
        scope_id: input.scope_id,
        item_id: input.item_id,
        payload_hash: digest,
        message_id: messageId,
        state: "reserved",
        created_at: now,
        updated_at: now,
        replay: false,
        reservation_version: reservation.session_version,
      };
    });
  }
  replay(input: AttentionAnswer, applyingMessageId?: string) {
    const prior = this.store.db
      .prepare("SELECT * FROM attention_actions WHERE action_id=?")
      .get(input.action_id) as Action | undefined;
    if (!prior) return undefined;
    if (prior.payload_hash !== attentionDigest(input))
      throw new Error("action_id_conflict");
    if (prior.message_id === applyingMessageId)
      return { ...prior, state: "in_flight", replay: true };
    return { ...this.reconcile(prior), replay: true };
  }
  abandon(
    input: {
      scope_id: string;
      session_id: string;
      message_id: string;
      expected_version: number;
      reason: string;
      evidence_sha256: string;
    },
    now = Date.now()
  ) {
    if (
      !input.reason ||
      input.reason.length > 1000 ||
      !/^[a-f0-9]{64}$/.test(input.evidence_sha256)
    )
      throw new Error("resolution_evidence_required");
    return this.store.write(this.owner, () => {
      const db = this.store.db;
      const session = new SessionRepository(db, this.store.path).getSession(
        input.session_id
      );
      if (!session || session.version !== input.expected_version)
        throw new Error("version_conflict");
      const scope = this.store.getScope(input.scope_id);
      if (
        !scope ||
        scope.task_id !== session.task_id ||
        scope.repo_path !== realpathSync(session.repo_path)
      )
        throw new Error("scope_mismatch");
      const message = db
        .prepare(
          "SELECT state FROM session_messages WHERE message_id=? AND session_id=? AND direction='inbound'"
        )
        .get(input.message_id, input.session_id) as
        | { state: string }
        | undefined;
      if (!message || !["accepted", "failed"].includes(message.state))
        throw new Error("receipt_not_uncertain");
      if (
        db
          .prepare(
            "SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved')"
          )
          .get(input.session_id)
      )
        throw new Error("continuation_in_flight");
      const prior = db
        .prepare(
          "SELECT * FROM attention_receipt_resolutions WHERE message_id=?"
        )
        .get(input.message_id) as
        | { reason: string; evidence_sha256: string }
        | undefined;
      if (
        prior &&
        (prior.reason !== input.reason ||
          prior.evidence_sha256 !== input.evidence_sha256)
      )
        throw new Error("resolution_conflict");
      db.prepare(
        "INSERT OR IGNORE INTO attention_receipt_resolutions VALUES(?,?,?,'abandoned_unknown',?,?,?)"
      ).run(
        input.message_id,
        input.session_id,
        input.expected_version,
        input.reason,
        input.evidence_sha256,
        now
      );
      db.prepare(
        "UPDATE attention_actions SET state='abandoned_unknown',updated_at=? WHERE message_id=?"
      ).run(now, input.message_id);
      db.prepare(
        "UPDATE attention_items SET state='answer_abandoned',revision=revision+1,updated_at=? WHERE item_id IN (SELECT item_id FROM attention_actions WHERE message_id=?) AND state<>'answer_abandoned'"
      ).run(now, input.message_id);
      return {
        disposition: "abandoned_unknown",
        message_id: input.message_id,
        replayed: false,
        execution_outcome: "unknown",
        next_action:
          "New manual instruction only; original message is never resent",
      };
    });
  }
  recover(): void {
    const rows = this.store.db
      .prepare(
        "SELECT * FROM attention_actions WHERE state IN ('reserved','uncertain')"
      )
      .all() as Action[];
    for (const row of rows) this.reconcile(row);
  }
  reconcile(action: Action, now = Date.now()): Action {
    return this.store.write(this.owner, () => {
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM attention_receipt_resolutions WHERE message_id=?"
          )
          .get(action.message_id)
      )
        return { ...action, state: "abandoned_unknown" };
      const receipt = this.store.db
        .prepare("SELECT state FROM session_messages WHERE message_id=?")
        .get(action.message_id) as { state: string } | undefined;
      const state =
        receipt?.state === "applied"
          ? "applied"
          : receipt?.state === "failed"
          ? "uncertain"
          : "uncertain";
      this.store.db
        .prepare(
          "UPDATE attention_actions SET state=?,updated_at=? WHERE action_id=?"
        )
        .run(state, now, action.action_id);
      this.store.db
        .prepare(
          "UPDATE attention_items SET state=?,revision=revision+1,updated_at=? WHERE item_id=? AND state<>?"
        )
        .run(
          state === "applied" ? "answer_applied" : "answer_uncertain",
          now,
          action.item_id,
          state === "applied" ? "answer_applied" : "answer_uncertain"
        );
      return { ...action, state, updated_at: now };
    });
  }
}

--- packages/core/src/state/attention-actions.test.ts ---
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import {
  AttentionActions,
  reserveSessionInstruction,
} from "./attention-actions.js";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "actions-")));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    `INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)`
  );
  db.prepare(
    `INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES('s','t','r','codex-cli',?,?,'awaiting_decision',1,1,1,'native')`
  ).run("a".repeat(64), root);
  const decision = { decision_id: "d", question: "Choose?", choices: [] };
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)"
  ).run(JSON.stringify(decision));
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root);
  const item = store.projectDecision(owner, {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "turn",
    sourceVersion: 1,
    decision,
    now: 1,
  });
  const input = {
    scope_id: scope.scope_id,
    item_id: item.item_id,
    action_id: "a",
    revision: item.revision,
    content_hash: item.content_hash,
    text: "A",
    takeover: false,
  };
  return { db, path, input, actions: new AttentionActions(store, owner) };
}
it("reserves once, returns uncertainty on retry, and prevents replacement IDs after ambiguous delivery", () => {
  const { actions, input, db } = setup();
  const first = actions.reserve(input);
  const second = actions.reserve(input);
  expect(second.message_id).toBe(first.message_id);
  expect(second.state).toBe("uncertain");
  expect(() => actions.reserve({ ...input, action_id: "b" })).toThrow();
  expect(() => actions.reserve({ ...input, text: "B" })).toThrow(
    "action_id_conflict"
  );
  expect(
    (
      db.prepare("SELECT COUNT(*) n FROM session_messages").get() as {
        n: number;
      }
    ).n
  ).toBe(1);
});
it("reconciles an applied exact receipt without claiming task completion", () => {
  const { actions, input, db } = setup();
  const a = actions.reserve(input);
  db.prepare(
    "UPDATE session_messages SET state='applied' WHERE message_id=?"
  ).run(a.message_id);
  expect(actions.reserve(input).state).toBe("applied");
  expect(
    (
      db.prepare("SELECT status FROM tasks WHERE task_id='t'").get() as {
        status: string;
      }
    ).status
  ).toBe("running");
});
it("serializes a direct send against an inbox reservation", () => {
  const { actions, input, db, path } = setup();
  actions.reserve(input);
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "other",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "B" },
        state: "accepted",
        created_at: 2,
      },
      2,
      2
    )
  ).toThrow("delivery_uncertain");
});
it("requires a signed approval route for risk gates", () => {
  const { actions, input, db } = setup();
  db.exec(
    `UPDATE session_turns SET decision_json='{"decision_id":"d","question":"Choose?","choices":[],"continuation":{"version":1,"gate_kind":"risk_approval","phase":"deploy","next_action":"deploy","evidence_refs":[]}}'`
  );
  expect(() => actions.reserve(input)).toThrow("source_changed");
  expect(db.prepare("SELECT 1 FROM attention_actions").get()).toBeUndefined();
});
it("refuses terminal session revival and recovers crash-window reservations", () => {
  const { actions, input, db } = setup();
  db.exec("UPDATE agent_sessions SET state='cancelled'");
  expect(() => actions.reserve(input)).toThrow("session_not_awaiting_decision");
  db.exec("UPDATE agent_sessions SET state='awaiting_decision'");
  actions.reserve(input);
  actions.recover();
  expect(
    (db.prepare("SELECT state FROM attention_items").get() as { state: string })
      .state
  ).toBe("answer_uncertain");
});
it("requires risk approval even when source digest is unchanged, and provides explicit abandonment without replay", () => {
  const { actions, input, db, path } = setup();
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({
      decision_id: "d",
      question: "Deploy?",
      choices: [],
      continuation: {
        version: 1,
        gate_kind: "risk_approval",
        phase: "deploy",
        next_action: "deploy",
        evidence_refs: [],
      },
    })
  );
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "risk",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("signed_approval_required");
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({ decision_id: "d", question: "Choose?", choices: [] })
  );
  const reserved = actions.reserve(input);
  actions.recover();
  expect(
    actions.abandon({
      scope_id: input.scope_id,
      session_id: "s",
      message_id: reserved.message_id,
      expected_version: 2,
      reason:
        "Owner inspected uncertain effects; discard original instruction without replay",
      evidence_sha256: "a".repeat(64),
    })
  ).toMatchObject({ disposition: "abandoned_unknown", replayed: false });
  expect(actions.reserve(input).state).toBe("abandoned_unknown");
  expect(
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "new-manual",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "Inspect current state only" },
        state: "accepted",
        created_at: 3,
      },
      2,
      3
    ).session_version
  ).toBe(3);
});
it("rejects malformed structured risk decisions on the direct manual path", () => {
  const { db, path } = setup();
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({
      decision_id: "risk",
      choices: [],
      continuation: { gate_kind: "risk_approval" },
    })
  );
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "m",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("invalid_decision");
  expect(db.prepare("SELECT 1 FROM session_messages").get()).toBeUndefined();
});

it("rejects an awaiting-decision turn with no decision on the direct path", () => {
  const { db, path } = setup();
  db.exec("UPDATE session_turns SET decision_json=NULL");
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "missing",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("invalid_decision");
  expect(db.prepare("SELECT 1 FROM session_messages").get()).toBeUndefined();
});

--- packages/core/src/state/attention-observer.ts ---
import { classifyAttentionWait, type WaitInput } from "../attention.js";
import { realpathSync } from "node:fs";
import {
  attentionDigest,
  AttentionStore,
  type AttentionOwner,
  type AttentionScope,
} from "./attention-store.js";
interface Subject {
  scope_id: string;
  kind: string;
  subject_id: string;
  binding_hash: string;
  source_version: number;
  ordinal_cursor: number;
  admitted: number;
  discovered_at: number;
  sampled_at: number;
  generation: number;
  payload_json: string;
}
interface Source {
  session_id: string;
  run_id: string;
  request_sha256: string;
  agent_id: string;
  native_session_id: string | null;
  repo_path: string;
  version: number;
  state: string;
}
interface Turn {
  turn_id: string;
  ordinal: number;
  decision_json: string | null;
  state: string;
}
/** Bounded synchronous transactions; no adapter, network, or model port. */
export class AttentionObserver {
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner) {}
  tick(now = Date.now()): void {
    if (!Number.isFinite(now)) throw new Error("invalid_clock");
    this.store.assertOwner(this.owner);
    for (const scope of this.store.listScopes()) {
      try {
        this.store.write(this.owner, () => this.scan(scope, now));
      } catch (error) {
        if (error instanceof Error && error.message === "stale_owner")
          throw error;
        this.store.write(this.owner, () =>
          this.store.db
            .prepare(
              "UPDATE attention_scopes SET error=?,scan_complete=0 WHERE scope_id=?"
            )
            .run(
              error instanceof Error
                ? error.message.slice(0, 300)
                : "source_error",
              scope.scope_id
            )
        );
      }
    }
  }
  private scan(scope: AttentionScope, now: number): void {
    const db = this.store.db;
    const task = db
      .prepare(
        "SELECT created_at FROM tasks WHERE task_id=? AND tenant_id IS NULL"
      )
      .get(scope.task_id) as { created_at: number } | undefined;
    if (
      !task ||
      attentionDigest([
        this.owner.home_id,
        scope.task_id,
        scope.repo_path,
        task.created_at,
      ]) !== scope.scope_id
    ) {
      db.prepare(
        "UPDATE attention_items SET state='source_missing',revision=revision+1 WHERE scope_id=? AND state='open'"
      ).run(scope.scope_id);
      db.prepare(
        "UPDATE attention_scopes SET error='source_missing',scan_complete=0 WHERE scope_id=?"
      ).run(scope.scope_id);
      return;
    }
    // A scan advances a durable keyset, then restarts from the beginning. New IDs
    // inserted behind the cursor are picked up on the next pass, never evicted.
    const rows = db
      .prepare(
        `SELECT '0:'||s.session_id AS key,s.session_id AS id,'session' AS kind FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
      WHERE s.task_id=? AND r.tenant_id IS NULL AND '0:'||s.session_id>?
      UNION ALL SELECT '1:'||r.run_id,r.run_id,'run' FROM runs r WHERE r.task_id=? AND r.tenant_id IS NULL AND '1:'||r.run_id>? AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.run_id=r.run_id AND s.task_id=r.task_id)
      ORDER BY key LIMIT 250`
      )
      .all(
        scope.task_id,
        scope.discovery_after,
        scope.task_id,
        scope.discovery_after
      ) as { key: string; id: string; kind: string }[];
    for (const row of rows) {
      if (
        db
          .prepare(
            "SELECT 1 FROM attention_subjects WHERE scope_id=? AND kind=? AND subject_id=? AND admitted=1"
          )
          .get(scope.scope_id, row.kind, row.id)
      )
        continue;
      const count = (
        db
          .prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1")
          .get() as { n: number }
      ).n;
      const prior = db
        .prepare(
          "SELECT payload_json FROM attention_subjects WHERE scope_id=? AND kind=? AND subject_id=?"
        )
        .get(scope.scope_id, row.kind, row.id) as
        | { payload_json: string }
        | undefined;
      if (prior) {
        try {
          if (JSON.parse(prior.payload_json).reason === "owner_released")
            continue;
        } catch {
          /* Rebuild corrupt observation metadata from its source. */
        }
      }
      let source: Source | undefined;
      let sourceError = false;
      try {
        source =
          row.kind === "session" ? this.source(scope, row.id) : undefined;
      } catch {
        sourceError = true;
      }
      const bound = row.kind === "run" || source !== undefined;
      const admitted = bound && count < 100 ? 1 : 0;
      db.prepare(
        `INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,kind,subject_id) DO UPDATE SET
        admitted=excluded.admitted,binding_hash=excluded.binding_hash,source_version=excluded.source_version,sampled_at=excluded.sampled_at,generation=excluded.generation,payload_json=excluded.payload_json`
      ).run(
        scope.scope_id,
        row.kind,
        row.id,
        source
          ? this.binding(source)
          : attentionDigest([scope.scope_id, row.kind, row.id]),
        source?.version ?? 0,
        admitted,
        now,
        now,
        this.owner.generation,
        JSON.stringify({
          state: source?.state ?? "unknown",
          awaiting_decision: source?.state === "awaiting_decision",
          reason: sourceError
            ? "source_error"
            : !bound
            ? "binding_unknown"
            : !admitted
            ? "capacity_exceeded"
            : "snapshot_only",
          unresolved_receipts: source ? this.receipts(source.session_id) : [],
        })
      );
    }
    const subjects = db
      .prepare(
        "SELECT * FROM attention_subjects WHERE scope_id=? AND admitted=1 ORDER BY kind,subject_id"
      )
      .all(scope.scope_id) as Subject[];
    for (const subject of subjects) {
      try {
        db.transaction(() => {
          if (subject.kind === "run") {
            const run = db
              .prepare(
                "SELECT phase,outcome FROM runs WHERE run_id=? AND task_id=? AND tenant_id IS NULL"
              )
              .get(subject.subject_id, scope.task_id);
            this.update(subject, now, {
              state: run ?? "source_missing",
              reason: run ? "snapshot_only" : "source_missing",
              repo_binding: "unverified",
              process_liveness: "unknown",
              gap: "snapshot_only",
            });
            return;
          }
          if (subject.kind !== "session") return;
          const source = this.source(scope, subject.subject_id);
          if (!source) {
            this.store.markMissing(
              this.owner,
              scope.scope_id,
              subject.subject_id
            );
            this.update(subject, now, {
              state: "source_missing",
              reason: "source_missing",
            });
            return;
          }
          if (
            this.binding(source) !== subject.binding_hash ||
            source.version < subject.source_version
          ) {
            this.update(subject, now, {
              state: source.state,
              reason: "source_binding_conflict",
            });
            return;
          }
          const turns = db
            .prepare(
              "SELECT turn_id,ordinal,state,decision_json FROM session_turns WHERE session_id=? AND ordinal>? ORDER BY ordinal LIMIT 50"
            )
            .all(source.session_id, subject.ordinal_cursor) as Turn[];
          const latest = db
            .prepare(
              "SELECT turn_id,ordinal,state,decision_json FROM session_turns WHERE session_id=? ORDER BY ordinal DESC LIMIT 1"
            )
            .get(source.session_id) as Turn | undefined;
          let cursor = subject.ordinal_cursor;
          let gap =
            JSON.parse(subject.payload_json).gap === "history_gap" ||
            (latest?.ordinal ?? 0) < cursor;
          for (const turn of turns) {
            if (turn.ordinal !== cursor + 1) gap = true;
            try {
              this.project(scope, source, turn, now);
            } catch {
              gap = true;
            }
            cursor = turn.ordinal;
          }
          if (latest && latest.ordinal <= cursor) {
            try {
              this.project(scope, source, latest, now);
            } catch {
              gap = true;
            }
          }
          const backlogged = latest !== undefined && latest.ordinal > cursor;
          db.prepare(
            "UPDATE attention_subjects SET source_version=?,ordinal_cursor=? WHERE scope_id=? AND kind=? AND subject_id=?"
          ).run(
            source.version,
            cursor,
            scope.scope_id,
            subject.kind,
            subject.subject_id
          );
          const unresolved = this.receipts(source.session_id);
          if (["completed", "failed", "cancelled"].includes(source.state))
            db.prepare(
              "UPDATE attention_items SET state='source_closed',revision=revision+1 WHERE scope_id=? AND session_id=? AND state='open'"
            ).run(scope.scope_id, source.session_id);
          // Only an applied receipt referencing this exact origin turn establishes
          // external continuation. Authorization/risk obligations remain unresolved.
          const items = (
            db
              .prepare(
                "SELECT item_id FROM attention_items WHERE scope_id=? AND session_id=? AND state='open'"
              )
              .all(scope.scope_id, source.session_id) as { item_id: string }[]
          )
            .map((r) => this.store.getItem(scope.scope_id, r.item_id)!)
            .filter(
              (i) =>
                i.session_id === source.session_id &&
                i.state === "open" &&
                !["risk_approval", "task_authorization"].includes(
                  i.decision.continuation?.gate_kind ?? ""
                )
            );
          for (const item of items) {
            const applied = db
              .prepare(
                "SELECT message_id FROM session_messages WHERE session_id=? AND turn_id=? AND direction='inbound' AND state='applied' ORDER BY created_at,message_id LIMIT 1"
              )
              .get(source.session_id, item.turn_id) as
              | { message_id: string }
              | undefined;
            if (applied)
              db.prepare(
                "UPDATE attention_items SET state='continued_externally',external_message_id=?,revision=revision+1 WHERE item_id=?"
              ).run(applied.message_id, item.item_id);
          }
          this.update(subject, now, {
            state: source.state,
            awaiting_decision: source.state === "awaiting_decision",
            version: source.version,
            turn_id: latest?.turn_id ?? null,
            process_liveness: "unknown",
            gap: gap ? "history_gap" : "mutable_snapshot_no_complete_event_log",
            reason: backlogged ? "history_backlog" : null,
            unresolved_receipts: unresolved,
            wait: this.wait(source, latest?.turn_id ?? null, now),
          });
        })();
      } catch (error) {
        this.update(subject, now, {
          state: "unknown",
          reason: "invalid_source",
          detail:
            error instanceof Error
              ? error.message.slice(0, 120)
              : "invalid_source",
        });
      }
    }
    const complete = rows.length < 250;
    const undiscovered = db
      .prepare(
        `SELECT 1 FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
      WHERE s.task_id=? AND r.tenant_id IS NULL AND NOT EXISTS(SELECT 1 FROM attention_subjects a WHERE a.scope_id=? AND a.kind='session' AND a.subject_id=s.session_id) LIMIT 1`
      )
      .get(scope.task_id, scope.scope_id);

    db.prepare(
      "UPDATE attention_scopes SET discovery_after=?,scan_complete=?,sampled_at=?,deadline=?,generation=?,error=NULL WHERE scope_id=?"
    ).run(
      complete ? "" : rows.at(-1)!.key,
      complete && !undiscovered ? 1 : 0,
      now,
      now + 65000,
      this.owner.generation,
      scope.scope_id
    );
  }
  private source(scope: AttentionScope, id: string): Source | undefined {
    const row = this.store.db
      .prepare(
        `SELECT s.* FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id JOIN tasks t ON t.task_id=s.task_id
      WHERE s.session_id=? AND s.task_id=? AND r.tenant_id IS NULL AND t.tenant_id IS NULL`
      )
      .get(id, scope.task_id) as Source | undefined;
    try {
      return row && realpathSync(row.repo_path) === scope.repo_path
        ? row
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private binding(source: Source): string {
    return attentionDigest([
      source.session_id,
      source.run_id,
      source.request_sha256,
      source.agent_id,
      source.repo_path,
    ]);
  }
  private project(
    scope: AttentionScope,
    source: Source,
    turn: Turn,
    now: number
  ): void {
    if (turn.decision_json === null) return;
    if (turn.decision_json.length > 16384)
      throw new Error("oversized_decision");
    this.store.projectDecision(this.owner, {
      scopeId: scope.scope_id,
      sessionId: source.session_id,
      turnId: turn.turn_id,
      sourceVersion: source.version,
      decision: JSON.parse(turn.decision_json),
      now,
    });
  }
  private wait(source: Source, turnId: string | null, now: number) {
    const db = this.store.db;
    const input: WaitInput = {
      state: source.state,
      turnId,
      version: source.version,
      now,
    };
    const g = db
      .prepare(
        "SELECT grant_id,status,expected_turn_id,expected_version,body_json FROM session_continuation_grants WHERE session_id=? AND status='active'"
      )
      .get(source.session_id) as
      | {
          grant_id: string;
          status: string;
          expected_turn_id: string;
          expected_version: number;
          body_json: string;
        }
      | undefined;
    try {
      if (g)
        input.grant = {
          id: g.grant_id,
          status: g.status,
          turnId: g.expected_turn_id,
          version: g.expected_version,
          expires: Date.parse(JSON.parse(g.body_json).expires_at),
        };
    } catch {
      return { reason: "grant_unreadable", owner: "unknown", blocked: true };
    }
    const attempt = db
      .prepare(
        "SELECT a.* FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved') ORDER BY a.created_at LIMIT 1"
      )
      .get(source.session_id) as
      | {
          status: string;
          source_turn_id: string;
          source_version: number;
          reservation_version: number | null;
          message_id: string | null;
        }
      | undefined;
    if (attempt)
      input.attempt = {
        state: attempt.status,
        sourceTurn: attempt.source_turn_id,
        sourceVersion: attempt.source_version,
        ...(attempt.reservation_version === null
          ? {}
          : { reservationVersion: attempt.reservation_version }),
        ...(attempt.message_id === null
          ? {}
          : { messageId: attempt.message_id }),
      };
    const message = db
      .prepare(
        "SELECT message_id,state FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') AND message_id NOT IN (SELECT message_id FROM attention_receipt_resolutions) ORDER BY CASE state WHEN 'accepted' THEN 0 ELSE 1 END,created_at LIMIT 1"
      )
      .get(source.session_id) as
      | { message_id: string; state: string }
      | undefined;
    if (message)
      input.message = { id: message.message_id, state: message.state };
    return {
      ...classifyAttentionWait(input),
      grant_id: g?.grant_id ?? null,
      message_id: message?.message_id ?? null,
    };
  }
  private receipts(id: string): unknown[] {
    return this.store.db
      .prepare(
        "SELECT message_id,state FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') AND message_id NOT IN (SELECT message_id FROM attention_receipt_resolutions) ORDER BY created_at LIMIT 10"
      )
      .all(id);
  }
  private update(s: Subject, now: number, payload: unknown): void {
    let old: { gap?: string } = {};
    try {
      old = JSON.parse(s.payload_json) as { gap?: string };
    } catch {
      old = { gap: "history_gap" };
    }
    if (old.gap === "history_gap" && payload && typeof payload === "object")
      payload = { ...payload, gap: "history_gap" };
    this.store.db
      .prepare(
        "UPDATE attention_subjects SET sampled_at=?,generation=?,payload_json=? WHERE scope_id=? AND kind=? AND subject_id=?"
      )
      .run(
        now,
        this.owner.generation,
        JSON.stringify(payload),
        s.scope_id,
        s.kind,
        s.subject_id
      );
  }
  inventory(scopeId: string, now = Date.now(), after = "", limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid_limit");
    const scope = this.store.getScope(scopeId);
    if (!scope) throw new Error("not_found");
    const db = this.store.db;
    const counts = db
      .prepare(
        "SELECT COUNT(*) total,COALESCE(SUM(admitted),0) admitted FROM attention_subjects WHERE scope_id=?"
      )
      .get(scopeId) as { total: number; admitted: number };
    const rows = db
      .prepare(
        "SELECT * FROM attention_subjects WHERE scope_id=? AND kind||':'||subject_id>? ORDER BY kind,subject_id LIMIT ?"
      )
      .all(scopeId, after, limit + 1) as Subject[];
    const current = db
      .prepare("SELECT generation FROM daemon_owner WHERE singleton=1")
      .get() as { generation: number };
    const faulty = db
      .prepare(
        "SELECT 1 FROM attention_subjects WHERE scope_id=? AND (sampled_at<? OR generation<>? OR json_extract(payload_json,'$.reason') IS NOT NULL AND json_extract(payload_json,'$.reason')<>'snapshot_only' OR json_extract(payload_json,'$.gap')='history_gap') LIMIT 1"
      )
      .get(scopeId, now - 65000, current.generation);
    const coverage =
      now < scope.sampled_at
        ? "unknown"
        : scope.generation !== current.generation || now > scope.deadline
        ? "uncovered"
        : !scope.scan_complete ||
          scope.error ||
          counts.total > counts.admitted ||
          faulty
        ? "degraded"
        : "covered";
    return {
      scope,
      coverage,
      subject_total: counts.total,
      admitted: counts.admitted,
      returned: Math.min(limit, rows.length),
      truncated: rows.length > limit,
      next_after:
        rows.length > limit
          ? `${rows[limit - 1]!.kind}:${rows[limit - 1]!.subject_id}`
          : null,
      subjects: rows.slice(0, limit).map(({ payload_json, ...r }) => ({
        ...r,
        facts: JSON.parse(payload_json),
      })),
      limitations: [
        "No complete mutable-source history",
        "Process liveness unknown",
        "Coverage is observation, not execution ownership",
      ],
    };
  }
}

--- packages/core/src/state/attention-experience.ts ---
import { AttentionObserver } from "./attention-observer.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AttentionStore,
  attentionDigest,
  type AttentionOwner,
} from "./attention-store.js";
interface Delivery {
  delivery_id: string;
  scope_id: string;
  item_id: string;
  revision: number;
  state: string;
  attempts: number;
  next_at: number;
  error: string | null;
}
export type AttentionSender = (
  message: {
    delivery_id: string;
    scope_id: string;
    item_id: string;
    question: string;
    state: string;
  },
  signal: AbortSignal
) => Promise<void>;
/** Local owner UX state; posture never changes any execution authority. */
export class AttentionExperience {
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner) {}
  posture(
    scope: string,
    actor: string,
    posture: "attended" | "quiet" | "away"
  ): void {
    this.actor(actor);
    if (!["attended", "quiet", "away"].includes(posture))
      throw new Error("invalid_posture");
    this.store.write(this.owner, () => {
      this.scope(scope);
      this.store.db
        .prepare(
          "INSERT INTO attention_postures VALUES(?,?,?) ON CONFLICT(scope_id,actor) DO UPDATE SET posture=excluded.posture"
        )
        .run(scope, actor, posture);
    });
  }
  brief(scope: string, actor: string) {
    this.actor(actor);
    this.scope(scope);
    const db = this.store.db;
    const items = db
      .prepare(
        `SELECT i.item_id,i.revision,i.state,i.decision_json,i.created_at FROM attention_items i LEFT JOIN attention_seen s ON s.scope_id=i.scope_id AND s.item_id=i.item_id AND s.actor=?
   WHERE i.scope_id=? AND COALESCE(s.revision,0)<i.revision ORDER BY CASE WHEN i.state LIKE '%uncertain%' THEN 0 WHEN json_extract(i.decision_json,'$.continuation.gate_kind') IN ('risk_approval','task_authorization') THEN 1 WHEN i.state='open' THEN 2 ELSE 3 END,i.created_at,i.item_id LIMIT 3`
      )
      .all(actor, scope) as {
      item_id: string;
      revision: number;
      state: string;
      decision_json: string;
      created_at: number;
    }[];
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM attention_items i LEFT JOIN attention_seen s ON s.scope_id=i.scope_id AND s.item_id=i.item_id AND s.actor=? WHERE i.scope_id=? AND COALESCE(s.revision,0)<i.revision`
        )
        .get(actor, scope) as { n: number }
    ).n;
    const dead = (
      db
        .prepare(
          "SELECT COUNT(*) n FROM attention_deliveries WHERE scope_id=? AND state='dead_letter'"
        )
        .get(scope) as { n: number }
    ).n;
    return {
      scope_id: scope,
      actor,
      total,
      dead_letters: dead,
      items: items.map(({ decision_json, ...r }) => ({
        ...r,
        question: JSON.parse(decision_json).question,
      })),
      read_is_not_seen: true,
    };
  }
  seen(
    scope: string,
    actor: string,
    revisions: { item_id: string; revision: number }[]
  ): void {
    this.actor(actor);
    if (revisions.length > 100) throw new Error("too_many_items");
    this.store.write(this.owner, () => {
      this.scope(scope);
      for (const r of revisions) {
        const item = this.store.getItem(scope, r.item_id);
        if (!item || item.revision !== r.revision)
          throw new Error("stale_item");
        this.store.db
          .prepare(
            "INSERT INTO attention_seen VALUES(?,?,?,?) ON CONFLICT(scope_id,actor,item_id) DO UPDATE SET revision=MAX(revision,excluded.revision)"
          )
          .run(scope, actor, r.item_id, r.revision);
      }
    });
  }
  enqueue(scope: string): void {
    this.store.write(this.owner, () => {
      this.scope(scope);
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO attention_deliveries(delivery_id,scope_id,item_id,revision)
    SELECT item_id||':'||revision,scope_id,item_id,revision FROM attention_items WHERE scope_id=? AND state IN ('open','answer_uncertain','source_missing')`
        )
        .run(scope);
    });
  }
  recoverDeliveries(): void {
    this.store.write(this.owner, () =>
      this.store.db
        .prepare(
          "UPDATE attention_deliveries SET state=CASE WHEN attempts>=5 THEN 'dead_letter' ELSE 'pending' END,error='interrupted_delivery' WHERE state='sending'"
        )
        .run()
    );
  }
  async drain(
    sender: AttentionSender,
    now = Date.now(),
    timeoutMs = 5000
  ): Promise<void> {
    const db = this.store.db;
    const row = this.store.write(this.owner, () => {
      const d = db
        .prepare(
          `SELECT d.* FROM attention_deliveries d WHERE d.state='pending' AND d.next_at<=? AND NOT EXISTS(SELECT 1 FROM attention_postures p WHERE p.scope_id=d.scope_id AND p.posture='quiet') ORDER BY d.next_at,d.delivery_id LIMIT 1`
        )
        .get(now) as Delivery | undefined;
      if (d) {
        const item = this.store.getItem(d.scope_id, d.item_id);
        if (
          !item ||
          item.revision !== d.revision ||
          !["open", "answer_uncertain", "source_missing"].includes(item.state)
        ) {
          db.prepare(
            "UPDATE attention_deliveries SET state='superseded' WHERE delivery_id=?"
          ).run(d.delivery_id);
          return undefined;
        }
      }
      if (d)
        db.prepare(
          "UPDATE attention_deliveries SET state='sending',attempts=attempts+1 WHERE delivery_id=? AND state='pending'"
        ).run(d.delivery_id);
      return d;
    });
    if (!row) return;
    const item = this.store.getItem(row.scope_id, row.item_id);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let error: string | null = null;
    try {
      if (!item) throw new Error("source_missing");
      await Promise.race([
        Promise.resolve().then(() =>
          sender(
            {
              delivery_id: row.delivery_id,
              scope_id: row.scope_id,
              item_id: row.item_id,
              question: item.decision.question,
              state: item.state,
            },
            controller.signal
          )
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("delivery_timeout"));
          }, timeoutMs);
        }),
      ]);
    } catch (e) {
      error =
        e instanceof Error && e.message === "delivery_timeout"
          ? "delivery_timeout"
          : "delivery_failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.store.write(this.owner, () =>
      db
        .prepare(
          "UPDATE attention_deliveries SET state=?,next_at=?,error=? WHERE delivery_id=? AND attempts=? AND state='sending'"
        )
        .run(
          error
            ? row.attempts + 1 >= 5
              ? "dead_letter"
              : "pending"
            : "delivered",
          now + Math.min(300000, 1000 * 2 ** row.attempts),
          error,
          row.delivery_id,
          row.attempts + 1
        )
    );
  }
  foreground(
    scope: string,
    subjects: { subject_id: string; source_version: number }[],
    now = Date.now()
  ) {
    if (
      !Array.isArray(subjects) ||
      subjects.length < 1 ||
      subjects.length > 100 ||
      new Set(subjects.map((s) => s.subject_id)).size !== subjects.length
    )
      throw new Error("invalid_subject_set");
    const token = randomBytes(32).toString("hex");
    const clientId = randomUUID();
    this.store.write(this.owner, () => {
      this.scope(scope);
      this.validateSubjects(scope, subjects);
      this.store.db
        .prepare(
          "INSERT INTO attention_foregrounds(client_id,token_hash,scope_id,generation,expires_at,subjects_json) VALUES(?,?,?,?,?,?)"
        )
        .run(
          clientId,
          attentionDigest(token),
          scope,
          this.owner.generation,
          now + 120000,
          JSON.stringify(subjects)
        );
    });
    return {
      client_id: clientId,
      token,
      expires_at: now + 120000,
      role: "foreground_owner",
    };
  }
  handoff(scope: string, client: string, token: string, now = Date.now()) {
    return this.store.write(this.owner, () => {
      const row = this.authenticate(scope, client, token, now, true);
      const prior = this.store.db
        .prepare("SELECT * FROM attention_handoffs WHERE client_id=?")
        .get(client) as
        | {
            receipt_id: string;
            client_id: string;
            scope_id: string;
            generation: number;
            subjects_json: string;
            created_at: number;
            valid_until: number;
          }
        | undefined;
      if (prior) {
        let currentlyValid =
          new AttentionObserver(this.store, this.owner).inventory(scope, now)
            .coverage === "covered";
        try {
          this.validateSubjects(scope, JSON.parse(row.subjects_json));
        } catch {
          currentlyValid = false;
        }
        return {
          ...prior,
          execution_takeover: false,
          process_liveness: "unknown",
          valid_until: (prior as { valid_until: number }).valid_until,
          expired: now > (prior as { valid_until: number }).valid_until,
          currently_valid:
            currentlyValid &&
            now <= (prior as { valid_until: number }).valid_until,
        };
      }
      if (row.expires_at < now) throw new Error("invalid_foreground");
      const s = this.scope(scope);
      if (
        new AttentionObserver(this.store, this.owner).inventory(scope, now)
          .coverage !== "covered"
      )
        throw new Error("coverage_not_ready");
      if (
        !s.scan_complete ||
        s.generation !== this.owner.generation ||
        s.deadline < now ||
        s.sampled_at > now ||
        s.error ||
        this.store.db
          .prepare(
            "SELECT 1 FROM attention_subjects WHERE scope_id=? AND (admitted=0 OR sampled_at<?) LIMIT 1"
          )
          .get(scope, now - 65000)
      )
        throw new Error("coverage_not_ready");
      const subjects = JSON.parse(row.subjects_json) as {
        subject_id: string;
        source_version: number;
      }[];
      this.validateSubjects(scope, subjects);
      const receipt = {
        receipt_id: randomUUID(),
        client_id: client,
        scope_id: scope,
        generation: this.owner.generation,
        subjects_json: row.subjects_json,
        created_at: now,
        valid_until: s.deadline,
      };
      this.store.db
        .prepare("INSERT INTO attention_handoffs VALUES(?,?,?,?,?,?,?)")
        .run(
          receipt.receipt_id,
          client,
          scope,
          this.owner.generation,
          row.subjects_json,
          now,
          s.deadline
        );
      this.store.db
        .prepare(
          "UPDATE attention_foregrounds SET handed_off=1 WHERE client_id=?"
        )
        .run(client);
      return {
        ...receipt,
        execution_takeover: false,
        process_liveness: "unknown",
        valid_until: s.deadline,
      };
    });
  }
  turnEnd(
    scope: string,
    client: string,
    token: string,
    role: string,
    now = Date.now()
  ) {
    return this.store.write(this.owner, () => {
      if (role !== "foreground_owner") throw new Error("wrong_role");
      const row = this.authenticate(scope, client, token, now, true);
      if (row.reminder_sent || row.handed_off) return { reminder: null };
      this.store.db
        .prepare(
          "UPDATE attention_foregrounds SET reminder_sent=1 WHERE client_id=?"
        )
        .run(client);
      return {
        reminder:
          "Foreground ended. Check attention coverage and explicitly hand off unresolved work.",
        continues: false,
        offline_detection: false,
        foreground_expired: row.expires_at < now,
      };
    });
  }
  private authenticate(
    scope: string,
    client: string,
    token: string,
    now: number,
    allowExpired = false
  ) {
    const row = this.store.db
      .prepare(
        "SELECT * FROM attention_foregrounds WHERE client_id=? AND scope_id=?"
      )
      .get(client, scope) as
      | {
          token_hash: string;
          generation: number;
          expires_at: number;
          subjects_json: string;
          handed_off: number;
          reminder_sent: number;
        }
      | undefined;
    if (
      typeof token !== "string" ||
      token.length !== 64 ||
      !row ||
      !timingSafeEqual(
        Buffer.from(row.token_hash),
        Buffer.from(attentionDigest(token))
      ) ||
      row.generation !== this.owner.generation ||
      (!allowExpired && row.expires_at < now)
    )
      throw new Error("invalid_foreground");
    return row;
  }
  private validateSubjects(
    scope: string,
    subjects: { subject_id: string; source_version: number }[]
  ): void {
    for (const s of subjects) {
      const row = this.store.db
        .prepare(
          "SELECT source_version,admitted,payload_json FROM attention_subjects WHERE scope_id=? AND kind='session' AND subject_id=?"
        )
        .get(scope, s.subject_id) as
        | { source_version: number; admitted: number; payload_json: string }
        | undefined;
      const live = this.store.db
        .prepare("SELECT version FROM agent_sessions WHERE session_id=?")
        .get(s.subject_id) as { version: number } | undefined;
      if (
        !row ||
        row.admitted !== 1 ||
        row.source_version !== s.source_version ||
        live?.version !== s.source_version ||
        JSON.parse(row.payload_json).reason ||
        JSON.parse(row.payload_json).gap === "history_gap" ||
        (JSON.parse(row.payload_json).unresolved_receipts ?? []).length > 0
      )
        throw new Error("subject_not_covered");
    }
  }
  private scope(scope: string) {
    const s = this.store.getScope(scope);
    if (!s) throw new Error("not_found");
    return s;
  }
  private actor(actor: string): void {
    if (typeof actor !== "string" || actor.length < 1 || actor.length > 256)
      throw new Error("invalid_actor");
  }
}

--- packages/cli/src/supervision-service.ts ---
import { AttentionInbox } from "@osstack/protocol";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AttentionStore,
  AttentionObserver,
  AttentionExperience,
  AttentionActions,
  attentionDigest,
  type AttentionSender,
} from "@osstack/core";
/** The daemon has already acquired its kernel process lock before construction. */
export class SupervisionService {
  readonly store: AttentionStore;
  readonly observer: AttentionObserver;
  readonly experience: AttentionExperience;
  private delivering = false;
  private deliveryDone: Promise<void> | undefined;
  private ciReader: import("@osstack/github").AttentionCiReader | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    db: Database.Database,
    path: string,
    readonly sender?: AttentionSender
  ) {
    this.store = new AttentionStore(db, path);
    this.observer = new AttentionObserver(
      this.store,
      this.store.claimOwner(randomUUID())
    );
    this.experience = new AttentionExperience(this.store, this.observer.owner);
    this.experience.recoverDeliveries();
    new AttentionActions(this.store, this.observer.owner).recover();
  }
  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), 30000);
    this.timer.unref();
  }
  private scan(): void {
    try {
      this.observer.tick();
      const loops = this.store.db
        .prepare(
          "SELECT scope_id,subject_id,payload_json FROM attention_subjects WHERE kind='loop' AND admitted=1"
        )
        .all() as {
        scope_id: string;
        subject_id: string;
        payload_json: string;
      }[];
      for (const row of loops) {
        const path = JSON.parse(row.payload_json).state_path;
        void this.handle("attention.loop", {
          scope_id: row.scope_id,
          loop_id: row.subject_id,
          state_path: path,
        }).catch(() => {
          /* previous sample expires */
        });
      }
      for (const scope of this.store.listScopes())
        this.experience.enqueue(scope.scope_id);
      if (this.sender && !this.delivering) {
        this.delivering = true;
        this.deliveryDone = this.experience
          .drain(this.sender)
          .catch(() => {
            /* delivery state retained */
          })
          .finally(() => {
            this.delivering = false;
          });
      }
    } catch {
      /* coverage expires even if timer is alive */
    }
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.deliveryDone;
  }
  async handle(method: string, params: unknown): Promise<unknown> {
    if (!params || typeof params !== "object")
      throw new Error("explicit_scope_required");
    const p = params as Record<string, unknown>;
    const str = (key: string) => {
      const value = p[key];
      if (typeof value !== "string" || !value || value.length > 4096)
        throw new Error(`invalid_${key}`);
      return value;
    };
    if (method === "attention.watch") {
      if (p["default_tenant"] !== true)
        throw new Error("explicit_default_tenant_required");
      const scope = this.store.registerScope(
        this.observer.owner,
        str("task_id"),
        str("repo_path")
      );
      this.observer.tick();
      return this.observer.inventory(scope.scope_id);
    }
    const scopeId = str("scope_id");
    if (!this.store.getScope(scopeId)) throw new Error("not_found");
    if (method === "attention.release") {
      this.store.release(
        this.observer.owner,
        scopeId,
        str("kind"),
        str("subject_id"),
        Number(p["expected_version"])
      );
      return {
        released: true,
        execution_affected: false,
        coverage: "uncovered",
      };
    }
    if (method === "attention.loop") {
      const { readAttentionLoop } = await import("./attention-loop-source.js");
      const path = str("state_path");
      const id = str("loop_id");
      const facts = await readAttentionLoop({
        repo: this.store.getScope(scopeId)!.repo_path,
        path,
        loop_id: id,
      });
      this.store.write(this.observer.owner, () => {
        const binding = attentionDigest([path, id]);
        const old = this.store.db
          .prepare(
            "SELECT binding_hash,admitted,payload_json FROM attention_subjects WHERE scope_id=? AND kind='loop' AND subject_id=?"
          )
          .get(scopeId, id) as
          | { binding_hash: string; admitted: number; payload_json: string }
          | undefined;
        if (old && old.binding_hash !== binding)
          throw new Error("loop_binding_conflict");
        const count = (
          this.store.db
            .prepare(
              "SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1"
            )
            .get() as { n: number }
        ).n;
        const released =
          old && JSON.parse(old.payload_json).reason === "owner_released";
        const admitted = released
          ? 0
          : old?.admitted === 1 || count < 100
          ? 1
          : 0;
        this.store.db
          .prepare(
            `INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'loop',?,?,0,?,?,?,?,?) ON CONFLICT(scope_id,kind,subject_id) DO UPDATE SET admitted=excluded.admitted,payload_json=excluded.payload_json,sampled_at=excluded.sampled_at,generation=excluded.generation`
          )
          .run(
            scopeId,
            id,
            binding,
            admitted,
            Date.now(),
            Date.now(),
            this.observer.owner.generation,
            JSON.stringify({
              ...facts,
              state_path: path,
              reason: released
                ? "owner_released"
                : !admitted
                ? "capacity_exceeded"
                : facts.state === "source_missing"
                ? "source_missing"
                : facts.recovery_required
                ? "recovery_required"
                : "snapshot_only",
            })
          );
      });
      return facts;
    }
    if (method === "attention.ci") {
      const { AttentionCiReader } = await import("@osstack/github");
      this.ciReader ??= new AttentionCiReader();
      return await this.ciReader.read({
        repo: str("github_repo"),
        pr: p["pr"],
        head: str("head"),
        required: p["required"],
      });
    }
    if (method === "attention.brief")
      return this.experience.brief(scopeId, str("actor"));
    if (method === "attention.posture") {
      const posture = str("posture");
      if (!["quiet", "away", "attended"].includes(posture))
        throw new Error("invalid_posture");
      this.experience.posture(
        scopeId,
        str("actor"),
        posture as "quiet" | "away" | "attended"
      );
      return { posture };
    }
    if (method === "attention.seen") {
      if (!Array.isArray(p["revisions"])) throw new Error("invalid_revisions");
      this.experience.seen(scopeId, str("actor"), p["revisions"]);
      return { marked: true };
    }
    if (method === "attention.foreground") {
      if (!Array.isArray(p["subjects"])) throw new Error("invalid_subjects");
      return this.experience.foreground(scopeId, p["subjects"]);
    }
    if (method === "attention.handoff")
      return this.experience.handoff(scopeId, str("client_id"), str("token"));
    if (method === "attention.turn-end")
      return this.experience.turnEnd(
        scopeId,
        str("client_id"),
        str("token"),
        str("role")
      );
    if (method === "attention.deliveries")
      return this.store.db
        .prepare(
          "SELECT * FROM attention_deliveries WHERE scope_id=? AND delivery_id>? ORDER BY delivery_id LIMIT 100"
        )
        .all(scopeId, typeof p["after"] === "string" ? p["after"] : "");
    if (method === "attention.inventory")
      return this.observer.inventory(
        scopeId,
        Date.now(),
        typeof p["after"] === "string" ? p["after"] : ""
      );
    if (method === "attention.inbox") {
      const items = this.store.listItems(
        scopeId,
        typeof p["after"] === "string" ? p["after"] : ""
      );
      const counts = this.store.db
        .prepare(
          "SELECT state,COUNT(*) total FROM attention_items WHERE scope_id=? GROUP BY state"
        )
        .all(scopeId);
      return AttentionInbox.parse({
        schema_version: 1,
        execution_takeover: false,
        scope_id: scopeId,
        items,
        counts,
        next_after: items.length === 100 ? items.at(-1)!.item_id : null,
        coverage: this.observer.inventory(scopeId).coverage,
      });
    }
    if (method === "attention.get") {
      const item = this.store.getItem(scopeId, str("item_id"));
      if (!item) throw new Error("not_found");
      return item;
    }
    throw new Error("unsupported_attention_method");
  }
}

--- packages/github/src/attention-ci.ts ---
import { z } from "zod";
import { defaultCommandRunner, type CommandRunner } from "./branch-scanner.js";
const Input = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    pr: z.number().int().positive(),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    required: z.array(z.string().min(1).max(256)).max(100),
  })
  .strict();
const Snapshot = z.object({
  headRefOid: z.string(),
  statusCheckRollup: z.array(
    z.object({
      name: z.string().optional(),
      context: z.string().optional(),
      status: z.string().optional(),
      conclusion: z.string().nullable().optional(),
      state: z.string().optional(),
    })
  ),
});
export interface AttentionCiResult {
  state: "unknown" | "pending" | "failed" | "passed";
  head: string;
  sampled_at: number;
  reason: string;
  required: string[];
}
/** Separate bounded read queue. Results are informational, never merge authority. */
export class AttentionCiReader {
  private active = 0;
  private cache = new Map<
    string,
    { until: number; result: AttentionCiResult }
  >();
  constructor(readonly runner: CommandRunner = defaultCommandRunner) {}
  async read(raw: unknown, now = Date.now()): Promise<AttentionCiResult> {
    const input = Input.parse(raw);
    const key = JSON.stringify(input);
    const cached = this.cache.get(key);
    if (cached && now >= cached.result.sampled_at && now < cached.until)
      return cached.result;
    const unknown = (reason: string): AttentionCiResult => ({
      state: "unknown",
      head: input.head,
      sampled_at: now,
      reason,
      required: input.required,
    });
    if (this.active >= 2) return unknown("queue_capacity");
    this.active++;
    let result: AttentionCiResult;
    try {
      const data = Snapshot.parse(
        JSON.parse(
          await this.runner.run("gh", [
            "pr",
            "view",
            String(input.pr),
            "--repo",
            input.repo,
            "--json",
            "headRefOid,statusCheckRollup",
          ])
        )
      );
      if (data.headRefOid !== input.head) result = unknown("head_changed");
      else if (input.required.length === 0)
        result = unknown("required_checks_unspecified");
      else {
        const values = input.required.map((name) =>
          data.statusCheckRollup.filter((c) => (c.name ?? c.context) === name)
        );
        const missing = values.some((v) => v.length !== 1);
        const checks = values.flat();
        const failed = checks.some((c) =>
          [
            "FAILURE",
            "ERROR",
            "CANCELLED",
            "TIMED_OUT",
            "ACTION_REQUIRED",
          ].includes((c.conclusion ?? c.state ?? "").toUpperCase())
        );
        const passed = checks.every(
          (c) => (c.conclusion ?? c.state ?? "").toUpperCase() === "SUCCESS"
        );
        result = {
          state: missing
            ? "unknown"
            : failed
            ? "failed"
            : passed
            ? "passed"
            : "pending",
          head: input.head,
          sampled_at: now,
          reason: missing
            ? "missing_or_ambiguous_required_check"
            : "exact_head_snapshot_only",
          required: input.required,
        };
      }
    } catch {
      result = unknown("credentials_network_rate_limit_or_invalid_source");
    } finally {
      this.active--;
    }
    if (this.cache.size >= 100)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      until: now + (result.state === "unknown" ? 60000 : 15000),
      result,
    });
    return result;
  }
}

--- daemon.ts handleSessionSend + execution + handleSingle attention branch ---
async function handleSessionSend(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<SingleResponse> {
  const p = parseSessionSendParams(req.params);
  if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
  // Completed receipt replay remains read-only while drained; no new/retried
  // instruction may reserve a message or invoke an adapter during an upgrade.
  if (ctx.draining && ctx.sessions.getMessage(p.message_id)?.state !== "applied") {
    return singleErr(req.id, "draining", "daemon is not accepting session instructions");
  }

  const session = ctx.sessions.getSession(p.session_id);
  if (session === undefined) return singleErr(req.id, "not_found", "session not found");
  if (p.runtime_id !== session.agent_id) {
    return singleErr(req.id, "runtime_mismatch", "session belongs to another runtime");
  }
  // Idempotency wins over moving state: a retry may arrive after the first
  // delivery already appended a newer turn or completed the conversation.
  // Let the repository compare the complete canonical envelope before any
  // current-turn/current-state guards reject it.
  const existingMessage = ctx.sessions.getMessage(p.message_id);
  let recoveredReservationVersion: number | undefined;
  if (existingMessage !== undefined) {
    try {
      const replay = ctx.sessions.applyInbound({
        message_id: p.message_id,
        session_id: p.session_id,
        turn_id: p.turn_id,
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
        state: "accepted",
        created_at: Date.now() / 1000,
      }, p.expected_version, Date.now() / 1000);
      if (existingMessage.state === "applied") {
        return singleOk(req.id, { state: replay.outcome, session_version: replay.session_version });
      }
      if (replay.session_version !== p.expected_version + 1) {
        return singleErr(req.id, "version_conflict", "accepted message cannot be recovered safely");
      }
      if (existingMessage.state === "accepted") {
        return ctx.activeSessionSends.has(session.session_id)
          ? singleErr(req.id, "session_busy", "session is already applying another instruction")
          : singleErr(
              req.id,
              "delivery_uncertain",
              "the previous delivery may have reached the agent; inspect the session before using a new message_id",
            );
      }
      if (existingMessage.state !== "failed") {
        return singleErr(req.id, "version_conflict", "reserved message is not retryable");
      }
      return singleErr(req.id, "delivery_uncertain", "Failed execution may have had side effects; reconcile the existing receipt before retrying");
    } catch (err) {
      if (err instanceof SessionMessageIdConflict) {
        return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
      }
      throw err;
    }
  }
  if (recoveredReservationVersion === undefined && TERMINAL_SESSION_STATES.has(session.state)) {
    return singleErr(req.id, "session_terminal", `session state=${session.state}`);
  }
  if (!session.resume_supported || session.native_session_id === null) {
    return singleErr(req.id, "resume_unsupported", "session cannot be resumed");
  }
  const snapshot = ctx.sessions.latestSnapshot(p.session_id);
  if (recoveredReservationVersion === undefined && snapshot.turn_id !== p.turn_id) {
    return singleErr(req.id, "turn_conflict", "message does not target the current turn");
  }
  const adapter = ctx.adapters.get(session.agent_id);
  if (adapter === undefined || !isSessionCapableAdapter(adapter) || !adapter.sessionCapabilities().resume) {
    return singleErr(req.id, "resume_unsupported", "agent does not support resume");
  }
  if (ctx.activeSessionSends.has(session.session_id)) {
    return singleErr(req.id, "session_busy", "session is already applying another instruction");
  }

  let applied: { outcome: "applied" | "duplicate"; session_version: number };
  const now = Date.now() / 1000;
  if (recoveredReservationVersion !== undefined) {
    applied = { outcome: "applied", session_version: recoveredReservationVersion };
  } else {
    try {
      applied = reserveSessionInstruction(ctx.db, ctx.dbPath, {
        message_id: p.message_id,
        session_id: p.session_id,
        turn_id: p.turn_id,
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
        state: "accepted",
        created_at: now,
      }, p.expected_version, now);
    } catch (err) {
      if (err instanceof SessionVersionConflict) {
        return singleErr(req.id, "version_conflict", "session version changed; refresh before retrying");
      }
      if (err instanceof SessionMessageIdConflict) {
        return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
      }
      if (err instanceof Error && ["delivery_uncertain", "continuation_in_flight", "grant_owned", "signed_approval_required", "invalid_decision"].includes(err.message)) return singleErr(req.id, err.message, "Refresh the decision and use its authorized owner route");
      throw err;
    }
  }
  if (applied.outcome === "duplicate") {
    return singleOk(req.id, { state: "duplicate", session_version: applied.session_version });
  }

  return await executeReservedSessionTurn(ctx, req, p, session, adapter, applied.session_version);
}

/** Private port: only an already persisted reservation may invoke the runtime. */
async function executeReservedSessionTurn(
  ctx: DaemonContext,
  req: DaemonRequest,
  p: SessionSendParams,
  session: NonNullable<ReturnType<SessionRepository["getSession"]>>,
  adapter: SessionCapableAdapter,
  reservationVersion: number,
  options: {
    controller?: AbortController;
    completed?: (turnId: string, version: number, now: number) => void;
  } = {},
): Promise<SingleResponse> {
  if (session.native_session_id === null) return singleErr(req.id, "resume_unsupported", "session cannot resume");
  const applied = { session_version: reservationVersion };
  ctx.activeSessionSends.set(session.session_id,p.message_id);
  const controller = options.controller ?? new AbortController();
  const now = Date.now() / 1000;
  ctx.activeRuns.set(session.run_id, controller);
  try {
    const failReservedMessage = (
      code: string,
      message: string,
    ): SingleResponse => {
      try {
        ctx.sessions.markMessageFailed(p.message_id);
      } catch {
        return singleErr(
          req.id,
          "delivery_uncertain",
          "the agent failed and the reservation could not be finalized; inspect the session before retrying",
        );
      }
      return singleErr(req.id, code, message);
    };
    const context: Record<string, unknown> = {};
    if (session.repo_path !== "") context["repo_path"] = session.repo_path;
    if (p.requested_by !== undefined) context["requested_by"] = p.requested_by;
    const input: AgentSessionInput = {
      session_id: session.session_id,
      task_id: session.task_id,
      run_id: session.run_id,
      turn_id: p.turn_id,
      native_session_id: session.native_session_id,
      expected_version: applied.session_version,
      message_id: p.message_id,
      prompt: p.text,
      ...(Object.keys(context).length === 0 ? {} : { context }),
    };
    const publicEvents: AgentSessionEvent[] = [];
    let assistantText = "";
    let decision: unknown = null;
    let terminalCompleted = false;
    try {
      for await (const rawEvent of adapter.resumeSession(input, controller.signal)) {
        const event = AgentSessionEventSchema.parse(rawEvent);
        if (event.type === "native_session.started") {
          if (event.native_session_id !== session.native_session_id) {
            return failReservedMessage(
              "adapter_protocol",
              "agent resumed an unexpected native session",
            );
          }
          continue;
        }
        if (JSON.stringify(event).includes(session.native_session_id)) {
          return failReservedMessage(
            "adapter_protocol",
            "agent output contained protected session metadata",
          );
        }
        if (event.type === "session.terminal") {
          if (event.state !== "completed") {
            const rawCode = event.error_code ?? "unknown";
            const safeCode = /^[a-z0-9_]{1,64}$/.test(rawCode) ? rawCode : "unknown";
            return failReservedMessage(
              "agent_failed",
              `agent failed while applying the instruction (${safeCode})`,
            );
          }
          terminalCompleted = true;
        }
        if (event.type === "assistant.message") {
          // Controlled results are opaque data; their adapter emits decisions separately.
          const directive = isControlledSessionAdapter(adapter) ? undefined : parseDecisionDirective(event.text);
          if (directive !== undefined) {
            publicEvents.push(directive);
            decision = {
              decision_id: directive.decision_id,
              question: directive.question,
              choices: directive.choices,
              ...(directive.continuation === undefined ? {} : { continuation: directive.continuation }),
            };
            assistantText = directive.question;
            continue;
          }
          assistantText += event.text;
        }
        publicEvents.push(event);
        if (event.type === "decision.requested") decision = {
          decision_id: event.decision_id,
          question: event.question,
          choices: event.choices,
          ...(event.continuation === undefined ? {} : { continuation: event.continuation }),
        };
      }
      if (!terminalCompleted) {
        return failReservedMessage(
          "agent_failed",
          "agent ended without completing the instruction",
        );
      }
    } catch {
      return failReservedMessage(
        "agent_failed",
        "agent failed while applying the instruction",
      );
    }

    const finalState = publicEvents.some((event) => event.type === "decision.requested")
      ? "awaiting_decision"
      : "idle";
    const completedAt = Date.now() / 1000;
    const turnId = `turn_${randomUUID()}`;
    const updatedSession = ctx.db.transaction(() => {
      const updated = ctx.sessions.completeInboundTurn({
        turn: {
          turn_id: turnId,
          session_id: session.session_id,
          ordinal: (ctx.db.prepare(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM session_turns WHERE session_id = ?",
          ).get(session.session_id) as { ordinal: number }).ordinal,
          state: finalState,
          assistant_text: assistantText,
          decision,
          created_at: now,
          updated_at: completedAt,
        },
        message_id: p.message_id,
        expected_version: applied.session_version,
        applied_at: completedAt,
      });
      options.completed?.(turnId, updated.version, completedAt);
      return updated;
    })();
    return singleOk(req.id, {
      state: "applied",
      session_version: updatedSession.version,
      events: publicEvents,
    });
  } finally {
    ctx.activeSessionSends.delete(session.session_id);
    if (ctx.activeRuns.get(session.run_id) === controller) ctx.activeRuns.delete(session.run_id);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Single-shot methods
// ──────────────────────────────────────────────────────────────────────

async function handleSingle(ctx: DaemonContext, req: DaemonRequest): Promise<SingleResponse | null> {
  if (req.method.startsWith("attention.")) {
    if (!ctx.supervision) return singleErr(req.id,"attention_disabled","Start daemon with OSSTACK_ATTENTION=1 to opt in");
    if (ctx.draining) return singleErr(req.id,"draining","Daemon is draining");
    try {
      if(req.method==="attention.abandon-receipt") {
        const p=req.params as {scope_id:string;session_id:string;message_id:string;expected_version:number;reason:string;evidence_sha256:string;acknowledge_unknown_effects:boolean};
        if(!p||p.acknowledge_unknown_effects!==true)throw new Error("explicit_unknown_effects_ack_required");
        if(ctx.activeSessionSends.has(p.session_id))throw new Error("delivery_in_flight");
        return singleOk(req.id,new AttentionActions(ctx.supervision.store,ctx.supervision.observer.owner).abandon(p));
      }
      if (req.method === "attention.answer") {
        const p=req.params as {scope_id:string;item_id:string;action_id:string;revision:number;content_hash:string;text:string;takeover:boolean};
        if (!p || typeof p.takeover!=="boolean" || typeof p.text!=="string")throw new Error("bad_request");
        const item=ctx.supervision.store.getItem(p.scope_id,p.item_id);if(!item)throw new Error("not_found");
        const actions=new AttentionActions(ctx.supervision.store,ctx.supervision.observer.owner);
        const replay=actions.replay(p,ctx.activeSessionSends.get(item.session_id));if(replay)return singleOk(req.id,replay);
        const session=ctx.sessions.getSession(item.session_id);if(!session)throw new Error("source_missing");
        const adapter=ctx.adapters.get(session.agent_id);
        if(!session.resume_supported||!session.native_session_id||!adapter||!isSessionCapableAdapter(adapter)||!adapter.sessionCapabilities().resume)throw new Error("resume_unsupported");
        if(ctx.activeSessionSends.has(session.session_id))throw new Error("session_busy");
        const action=actions.reserve(p);
        if(action.replay)return singleOk(req.id,action);
        const execution=await executeReservedSessionTurn(ctx,req,{session_id:session.session_id,runtime_id:session.agent_id,turn_id:item.turn_id,message_id:action.message_id,expected_version:action.reservation_version-1,text:p.text},session,adapter,action.reservation_version);
        return singleOk(req.id,{...actions.reconcile(action),execution_error:execution.error?.code??null});
      }
      return singleOk(req.id,await ctx.supervision.handle(req.method,req.params));
    } catch(error) {return singleErr(req.id,error instanceof Error?error.message:"attention_error","Attention request failed; refresh source facts before retrying");}
  }

--- session-rpc.test.ts complete attention RPC tests ---
 shares the exact governed session receipt", async () => {
  seedSession("attention");const db=openDb({path:handle.dbPath});
  db.prepare("UPDATE agent_sessions SET repo_path=?,state='awaiting_decision' WHERE session_id='attention'").run(realpathSync(home));
  db.prepare("UPDATE session_turns SET decision_json=? WHERE session_id='attention'").run(JSON.stringify(structuredDecision));db.close();
  const watched=await rpc("attention.watch",{task_id:"task_attention",repo_path:home,default_tenant:true});
  expect(watched.ok).toBe(true);const scope=(watched.result!["scope"] as {scope_id:string}).scope_id;
  const inbox=await rpc("attention.inbox",{scope_id:scope});const item=(inbox.result!["items"] as Array<Record<string,unknown>>)[0]!;
  expect(item["state"]).toBe("open");const params={scope_id:scope,item_id:item["item_id"],action_id:"answer-once",revision:item["revision"],content_hash:item["content_hash"],text:"continue",takeover:false};
  const before=adapter.resumed.length;expect(await rpc("attention.answer",params)).toMatchObject({ok:true,result:{state:"applied"}});
  expect(await rpc("attention.answer",params)).toMatchObject({ok:true,result:{state:"applied",replay:true}});
  expect(adapter.resumed.length-before).toBe(1);
  expect(await rpc("attention.brief",{scope_id:scope,actor:"owner"})).toMatchObject({ok:true,result:{total:1}});
});

it("never resumes an abandoned receipt when its original direct message ID is replayed",async()=>{
  const id="abandoned-rpc";seedSession(id);const db=openDb({path:handle.dbPath});
  db.prepare("UPDATE agent_sessions SET repo_path=? WHERE session_id=?").run(realpathSync(home),id);
  const sessions=new SessionRepository(db,handle.dbPath);
  sessions.applyInbound({message_id:"old-abandoned",session_id:id,turn_id:"turn_"+id,direction:"inbound",kind:"instruction.send",payload:{text:"original"},state:"accepted",created_at:3},2,3);db.close();
  const watch=await rpc("attention.watch",{task_id:"task_"+id,repo_path:home,default_tenant:true});const scope=(watch.result!["scope"] as {scope_id:string}).scope_id;
  const before=adapter.resumed.length;
  expect(await rpc("attention.abandon-receipt",{scope_id:scope,session_id:id,message_id:"old-abandoned",expected_version:3,reason:"Owner inspected effects; abandon original instruction",evidence_sha256:"a".repeat(64),acknowledge_unknown_effects:true})).toMatchObject({ok:true,result:{disposition:"abandoned_unknown",replayed:false}});
  expect(await rpc("session.send",{session_id:id,runtime_id:adapter.id,turn_id:"turn_"+id,message_id:"old-abandoned",expected_version:2,text:"original"})).toMatchObject({ok:false,error:{code:"delivery_uncertain"}});
  expect(adapter.resumed.length).toBe(before);
  expect(await rpc("session.send",{session_id:id,runtime_id:adapter.id,turn_id:"turn_"+id,message_id:"new-owner-instruction",expected_version:3,text:"Inspect current state"})).toMatchObject({ok:true,result:{state:"applied"}});
  expect(adapter.resumed.length).toBe(before+1);
});
it("readmits capacity-limited Loop snapshots but preserves an explicit release",async()=>{
  const id="loop-admission-rpc";seedSession(id);const db=openDb({path:handle.dbPath});
  db.prepare("UPDATE agent_sessions SET repo_path=? WHERE session_id=?").run(realpathSync(home),id);
  const watch=await rpc("attention.watch",{task_id:"task_"+id,repo_path:home,default_tenant:true});const scope=(watch.result!["scope"] as {scope_id:string}).scope_id;
  const path=join(home,"attention-loop.json");writeFileSync(path,JSON.stringify({loop_id:id,started_at:new Date().toISOString(),updated_at:new Date().toISOString(),completed_tasks:[],pending:[],in_progress:[],decisions:[]}));
  const params={scope_id:scope,loop_id:id,state_path:path};expect((await rpc("attention.loop",params)).ok).toBe(true);
  db.prepare("UPDATE attention_subjects SET admitted=0 WHERE kind='loop' AND subject_id=?").run(id);
  expect((await rpc("attention.loop",params)).ok).toBe(true);
  expect(db.prepare("SELECT admitted FROM attention_subjects WHERE kind='loop' AND subject_id=?").get(id)).toEqual({admitted:1});
  expect((await rpc("attention.release",{scope_id:scope,kind:"loop",subject_id:id,expected_version:0})).ok).toBe(true);
  expect((await rpc("attention.loop",params)).ok).toBe(true);
  const row=db.prepare("SELECT admitted,payload_json FROM attention_subjects WHERE kind='loop' AND subject_id=?").get(id) as {admitted:number;payload_json:string};
  expect(row.admitted).toBe(0);expect(JSON.parse(row.payload_json).reason).toBe("owner_released");db.close();
});
