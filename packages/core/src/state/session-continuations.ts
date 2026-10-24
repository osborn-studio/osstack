import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { ContinuationGrantBody, SessionDecision, type ContinuationGrantStep } from "@osstack/protocol";
import { withWrite } from "./db.js";
import { SessionRepository, type SessionSnapshot } from "./sessions.js";
import type { SessionMessageRow } from "./schema.js";

export interface SessionContinuationGrantView {
  grant_id: string;
  session_id: string;
  body: ContinuationGrantBody;
  digest: string;
  key_id: string;
  signature: string;
  status: "active" | "completed" | "blocked" | "revoked";
  reason: string | null;
  step_index: number;
  checks_used: number;
  resumes_used: number;
  /** Retries consumed for the current step; reset only after its continue. */
  retries_used: number;
  expected_turn_id: string;
  expected_version: number;
  created_at: number;
  updated_at: number;
}
export interface SessionContinuationAttemptView {
  attempt_id: string;
  grant_id: string;
  step_index: number;
  source_turn_id: string;
  source_version: number;
  decision_sha256: string;
  status: "checking" | "reserved" | "applied" | "blocked" | "abandoned";
  check_result: { passed: boolean; details: unknown } | null;
  message_id: string | null;
  reservation_version: number | null;
  action: "continue" | "retry" | null;
  completed_turn_id: string | null;
  completed_version: number | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}
interface Blocked { outcome: "blocked"; grant: SessionContinuationGrantView; reason: string }
export type BeginContinuationCheckResult = Blocked
  | { outcome: "busy"; grant: SessionContinuationGrantView; attempt: SessionContinuationAttemptView }
  | { outcome: "checking"; grant: SessionContinuationGrantView; attempt: SessionContinuationAttemptView;
    session: SessionSnapshot; step: ContinuationGrantStep };
export type FinishContinuationCheckResult = Blocked
  | { outcome: "unchanged"; grant: SessionContinuationGrantView; attempt: SessionContinuationAttemptView }
  | { outcome: "reserved"; grant: SessionContinuationGrantView; attempt: SessionContinuationAttemptView;
    message: SessionMessageRow; prompt: string; reservation_version: number };

type RawGrant = Omit<SessionContinuationGrantView, "body"> & { body_json: string };
type RawAttempt = Omit<SessionContinuationAttemptView, "check_result"> & { check_result_json: string | null };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function timestamp(now: number): void {
  if (!Number.isFinite(now) || now < 0) throw new Error("continuation timestamp must be nonnegative epoch seconds");
}

/** Signature verification and runtime policy checks belong to the daemon. */
export class SessionContinuationRepository {
  private readonly sessions: SessionRepository;
  constructor(private readonly db: Database.Database, private readonly path: string) {
    this.sessions = new SessionRepository(db, path);
  }

  install(rawBody: unknown, digest: string, keyId: string, now: number, signature: string): SessionContinuationGrantView {
    timestamp(now);
    const body = ContinuationGrantBody.parse(rawBody);
    const bodyJson = canonical(body);
    if (sha(bodyJson) !== digest) throw new Error("continuation grant digest mismatch");
    if (!keyId || !signature) throw new Error("continuation grant key and signature are required");
    return withWrite(this.db, this.path, () => {
      const previous = this.get(body.grant_id);
      if (previous !== undefined) {
        if (canonical(previous.body) !== bodyJson || previous.digest !== digest || previous.key_id !== keyId
          || previous.signature !== signature) throw new Error("continuation grant ID conflict");
        return previous;
      }
      const issued = Date.parse(body.issued_at) / 1000;
      const expires = Date.parse(body.expires_at) / 1000;
      if (issued > now || expires <= now || expires <= issued || expires - issued > 86400) {
        throw new Error("continuation grant expired or outside its valid time window");
      }
      const session = this.sessions.getSession(body.session_id);
      if (session === undefined || session.agent_id !== body.runtime_id || session.repo_path !== body.repo_path
        || !session.resume_supported || !session.native_session_id) throw new Error("continuation session binding mismatch");
      const snapshot = this.sessions.latestSnapshot(body.session_id);
      if (snapshot.turn_id !== body.initial_turn_id || snapshot.version !== body.initial_version) {
        throw new Error("continuation initial cursor mismatch");
      }
      if (this.db.prepare("SELECT 1 FROM session_continuation_grants WHERE session_id = ? AND status = 'active'").get(body.session_id)) {
        throw new Error("session already has an active continuation grant");
      }
      if (this.hasUnresolvedReceipt(body.session_id)) throw new Error("continuation session has an unresolved receipt");
      this.db.prepare(`INSERT INTO session_continuation_grants
        (grant_id,session_id,body_json,digest,key_id,signature,status,expected_turn_id,expected_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'active',?,?,?,?)`).run(body.grant_id, body.session_id, bodyJson, digest, keyId, signature,
        body.initial_turn_id, body.initial_version, now, now);
      return this.requireGrant(body.grant_id);
    });
  }

  get(id: string): SessionContinuationGrantView | undefined {
    const row = this.db.prepare("SELECT * FROM session_continuation_grants WHERE grant_id = ?").get(id) as RawGrant | undefined;
    if (row === undefined) return undefined;
    const { body_json, ...rest } = row;
    return { ...rest, body: ContinuationGrantBody.parse(JSON.parse(body_json)) };
  }
  forSession(sessionId: string): SessionContinuationGrantView | undefined {
    const row = this.db.prepare(`SELECT grant_id FROM session_continuation_grants WHERE session_id = ?
      ORDER BY (status = 'active') DESC, created_at DESC, grant_id DESC LIMIT 1`).get(sessionId) as { grant_id: string } | undefined;
    return row === undefined ? undefined : this.get(row.grant_id);
  }
  listActive(): SessionContinuationGrantView[] {
    return (this.db.prepare("SELECT grant_id FROM session_continuation_grants WHERE status = 'active' ORDER BY created_at, grant_id")
      .all() as Array<{ grant_id: string }>).map(({ grant_id }) => this.requireGrant(grant_id));
  }
  getAttempt(id: string): SessionContinuationAttemptView | undefined {
    const row = this.db.prepare("SELECT * FROM session_continuation_attempts WHERE attempt_id = ?").get(id) as RawAttempt | undefined;
    if (row === undefined) return undefined;
    const { check_result_json, ...rest } = row;
    return { ...rest, check_result: check_result_json === null ? null : JSON.parse(check_result_json) as SessionContinuationAttemptView["check_result"] };
  }

  beginCheck(id: string, now: number): BeginContinuationCheckResult {
    timestamp(now);
    return withWrite(this.db, this.path, () => {
      const grant = this.requireGrant(id);
      if (grant.status !== "active") return this.blocked(grant, grant.reason ?? `grant_${grant.status}`, now);
      if (now < Date.parse(grant.body.issued_at) / 1000 || now >= Date.parse(grant.body.expires_at) / 1000) {
        return this.blocked(grant, "expired", now);
      }
      const pending = this.db.prepare(`SELECT attempt_id FROM session_continuation_attempts
        WHERE grant_id = ? AND status IN ('checking','reserved')`).get(id) as { attempt_id: string } | undefined;
      if (pending !== undefined) return { outcome: "busy", grant, attempt: this.requireAttempt(pending.attempt_id) };
      const inspected = this.inspect(grant, now, true);
      if (!inspected.ok) return this.blocked(grant, inspected.reason, now);
      const attemptId = `cont_attempt_${sha(canonical([id, grant.checks_used + 1]))}`;
      this.db.prepare(`UPDATE session_continuation_grants SET checks_used = checks_used + 1, updated_at = ? WHERE grant_id = ?`).run(now, id);
      this.db.prepare(`INSERT INTO session_continuation_attempts
        (attempt_id,grant_id,step_index,source_turn_id,source_version,decision_sha256,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'checking',?,?)`).run(attemptId, id, grant.step_index, grant.expected_turn_id,
        grant.expected_version, inspected.decisionDigest, now, now);
      return { outcome: "checking", grant: this.requireGrant(id), attempt: this.requireAttempt(attemptId),
        session: inspected.session, step: inspected.step };
    });
  }

  finishCheck(attemptId: string, result: { passed: boolean; details: unknown }, now: number): FinishContinuationCheckResult {
    timestamp(now);
    if (typeof result.passed !== "boolean") throw new Error("continuation check result must include passed boolean");
    return withWrite(this.db, this.path, () => {
      const attempt = this.requireAttempt(attemptId);
      const grant = this.requireGrant(attempt.grant_id);
      if (attempt.status !== "checking") return { outcome: "unchanged", grant, attempt };
      this.db.prepare("UPDATE session_continuation_attempts SET check_result_json = ?, updated_at = ? WHERE attempt_id = ?")
        .run(JSON.stringify({ passed: result.passed, details: result.details ?? null }), now, attemptId);
      const inspected = this.inspect(grant, now, false);
      let reason = inspected.ok ? null : inspected.reason;
      if (inspected.ok && (attempt.step_index !== grant.step_index || attempt.source_turn_id !== grant.expected_turn_id
        || attempt.source_version !== grant.expected_version || attempt.decision_sha256 !== inspected.decisionDigest)) reason = "request_changed";
      if (reason !== null) return this.blockAttempt(attempt, reason, now);
      const step = grant.body.steps[attempt.step_index]!;
      const action = result.passed ? "continue" : "retry";
      const prompt = result.passed ? step.instruction : step.retry_instruction;
      if (prompt === undefined || (!result.passed && grant.retries_used >= step.max_retries)) {
        return this.blockAttempt(attempt, "checks_failed", now);
      }
      if (grant.resumes_used >= grant.body.max_resumes) return this.blockAttempt(attempt, "resumes_exhausted", now);
      const messageId = `cont_message_${sha(attemptId)}`;
      // Reservation, budget consumption and attempt transition share a transaction.
      const receipt = this.sessions.applyInbound({ message_id: messageId, session_id: grant.session_id,
        turn_id: attempt.source_turn_id, direction: "inbound", kind: "instruction.send", state: "accepted",
        payload: { text: prompt, requested_by: `agent:collaborator:${grant.grant_id}` }, created_at: now }, attempt.source_version, now);
      if (receipt.outcome !== "applied") throw new Error("continuation message reservation collision");
      this.db.prepare(`UPDATE session_continuation_attempts SET status = 'reserved', message_id = ?,
        reservation_version = ?, action = ?, updated_at = ? WHERE attempt_id = ?`)
        .run(messageId, receipt.session_version, action, now, attemptId);
      this.db.prepare(`UPDATE session_continuation_grants SET resumes_used = resumes_used + 1,
        retries_used = retries_used + ?, updated_at = ? WHERE grant_id = ?`).run(action === "retry" ? 1 : 0, now, grant.grant_id);
      return { outcome: "reserved", grant: this.requireGrant(grant.grant_id), attempt: this.requireAttempt(attemptId),
        message: this.sessions.getMessage(messageId)!, prompt, reservation_version: receipt.session_version };
    });
  }

  /** Call inside the same outer transaction as SessionRepository.completeInboundTurn. */
  completeAttempt(attemptId: string, newTurnId: string, newVersion: number, now: number): SessionContinuationGrantView {
    timestamp(now);
    return withWrite(this.db, this.path, () => {
      const attempt = this.requireAttempt(attemptId);
      const grant = this.requireGrant(attempt.grant_id);
      if (attempt.status === "applied") {
        if (attempt.completed_turn_id !== newTurnId || attempt.completed_version !== newVersion) throw new Error("continuation completion conflict");
        return grant;
      }
      const session = this.sessions.latestSnapshot(grant.session_id);
      const receipt = attempt.message_id === null ? undefined : this.sessions.getMessage(attempt.message_id);
      if (attempt.status !== "reserved" || attempt.reservation_version === null || newVersion !== attempt.reservation_version + 1
        || newTurnId === attempt.source_turn_id || session.turn_id !== newTurnId || session.version !== newVersion || receipt?.state !== "applied"
        || receipt.session_id !== grant.session_id || receipt.turn_id !== attempt.source_turn_id
        || attempt.step_index !== grant.step_index || grant.expected_turn_id !== attempt.source_turn_id
        || grant.expected_version !== attempt.source_version) throw new Error("continuation completion cursor or receipt conflict");
      const nextStep = grant.step_index + (attempt.action === "continue" ? 1 : 0);
      // A concurrent revoke cannot undo a real receipt, nor may completion revive it.
      // Check wall time as well as the daemon's abort timer: an event-loop stall
      // can deliver a completed event before a delayed timeout callback runs.
      let status = grant.status;
      let reason = grant.reason;
      if (status === "active") {
        if (now >= Date.parse(grant.body.expires_at) / 1000) {
          status = "blocked";
          reason = "expired";
        } else if (now >= receipt.created_at + grant.body.turn_timeout_ms / 1000) {
          status = "blocked";
          reason = "turn_timeout";
        } else if (nextStep >= grant.body.steps.length) status = "completed";
      }
      this.db.prepare(`UPDATE session_continuation_attempts SET status = 'applied', completed_turn_id = ?,
        completed_version = ?, updated_at = ? WHERE attempt_id = ?`).run(newTurnId, newVersion, now, attemptId);
      this.db.prepare(`UPDATE session_continuation_grants SET step_index = ?, retries_used = ?, expected_turn_id = ?,
        expected_version = ?, status = ?, reason = ?, updated_at = ? WHERE grant_id = ?`).run(nextStep,
        attempt.action === "continue" ? 0 : grant.retries_used, newTurnId, newVersion, status, reason, now, grant.grant_id);
      return this.requireGrant(grant.grant_id);
    });
  }

  failAttempt(id: string, reason: string, now: number): SessionContinuationGrantView {
    timestamp(now);
    return withWrite(this.db, this.path, () => {
      const attempt = this.requireAttempt(id);
      if (attempt.status === "applied" || attempt.status === "blocked" || attempt.status === "abandoned") return this.requireGrant(attempt.grant_id);
      return this.blockAttempt(attempt, reason, now).grant;
    });
  }
  block(id: string, reason: string, now: number): SessionContinuationGrantView {
    timestamp(now);
    return withWrite(this.db, this.path, () => {
      this.db.prepare(`UPDATE session_continuation_grants SET status = 'blocked', reason = ?, updated_at = ?
        WHERE grant_id = ? AND status = 'active'`).run(reason, now, id);
      return this.requireGrant(id);
    });
  }
  revoke(id: string, now: number): SessionContinuationGrantView {
    timestamp(now);
    return withWrite(this.db, this.path, () => {
      this.db.prepare(`UPDATE session_continuation_grants SET status = 'revoked', reason = 'revoked', updated_at = ?
        WHERE grant_id = ? AND status = 'active'`).run(now, id);
      return this.requireGrant(id);
    });
  }
  recover(now: number): { abandoned: number; blocked: number } {
    timestamp(now);
    return withWrite(this.db, this.path, () => {
      const abandoned = this.db.prepare(`UPDATE session_continuation_attempts SET status = 'abandoned',
        reason = 'interrupted_check', updated_at = ? WHERE status = 'checking'`).run(now).changes;
      const reserved = this.db.prepare("SELECT attempt_id FROM session_continuation_attempts WHERE status = 'reserved'")
        .all() as Array<{ attempt_id: string }>;
      for (const { attempt_id } of reserved) this.blockAttempt(this.requireAttempt(attempt_id), "delivery_uncertain", now);
      const active = this.db.prepare("SELECT grant_id FROM session_continuation_grants WHERE status='active'").all() as {grant_id:string}[];
      for (const row of active) {
        try { const grant=this.requireGrant(row.grant_id); if(Date.parse(grant.body.expires_at)/1000<=now)this.block(grant.grant_id,"expired",now); }
        catch { this.db.prepare("UPDATE session_continuation_grants SET status='blocked',reason='corrupt_grant',updated_at=? WHERE grant_id=?").run(now,row.grant_id); }
      }
      return { abandoned, blocked: reserved.length };
    });
  }

  private inspect(grant: SessionContinuationGrantView, now: number, consumeCheck: boolean):
    { ok: false; reason: string } | { ok: true; session: SessionSnapshot; step: ContinuationGrantStep; decisionDigest: string } {
    const deny = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
    if (grant.status !== "active") return deny(grant.reason ?? `grant_${grant.status}`);
    if (now < Date.parse(grant.body.issued_at) / 1000 || now >= Date.parse(grant.body.expires_at) / 1000) return deny("expired");
    if (consumeCheck && grant.checks_used >= grant.body.max_checks) return deny("checks_exhausted");
    if (grant.resumes_used >= grant.body.max_resumes) return deny("resumes_exhausted");
    const bound = this.sessions.getSession(grant.session_id);
    if (bound === undefined || bound.agent_id !== grant.body.runtime_id || bound.repo_path !== grant.body.repo_path
      || !bound.resume_supported || !bound.native_session_id) return deny("session_binding_changed");
    const session = this.sessions.latestSnapshot(grant.session_id);
    if (session.turn_id !== grant.expected_turn_id || session.version !== grant.expected_version) return deny("cursor_changed");
    const turn = this.db.prepare("SELECT state FROM session_turns WHERE turn_id = ?").get(session.turn_id) as { state: string } | undefined;
    if (session.state !== "awaiting_decision" || turn?.state !== "awaiting_decision") return deny("session_not_awaiting_decision");
    if (this.hasUnresolvedReceipt(grant.session_id)) return deny("unresolved_receipt");
    const step = grant.body.steps[grant.step_index];
    const parsed = SessionDecision.safeParse(session.decision);
    if (step === undefined || !parsed.success || parsed.data.continuation?.gate_kind !== "phase_continue"
      || parsed.data.continuation.phase !== step.phase) return deny("decision_not_authorized");
    return { ok: true, session, step, decisionDigest: sha(canonical(parsed.data)) };
  }
  private hasUnresolvedReceipt(sessionId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM session_messages WHERE session_id = ? AND direction = 'inbound'
      AND state IN ('accepted','failed') LIMIT 1`).get(sessionId) !== undefined;
  }
  private blocked(grant: SessionContinuationGrantView, reason: string, now: number): Blocked {
    return { outcome: "blocked", grant: this.block(grant.grant_id, reason, now), reason };
  }
  private blockAttempt(attempt: SessionContinuationAttemptView, reason: string, now: number): Blocked {
    this.db.prepare(`UPDATE session_continuation_attempts SET status = 'blocked', reason = ?, updated_at = ?
      WHERE attempt_id = ? AND status IN ('checking','reserved')`).run(reason, now, attempt.attempt_id);
    return this.blocked(this.requireGrant(attempt.grant_id), reason, now);
  }
  private requireGrant(id: string): SessionContinuationGrantView {
    const grant = this.get(id);
    if (grant === undefined) throw new Error(`continuation grant not found: ${id}`);
    return grant;
  }
  private requireAttempt(id: string): SessionContinuationAttemptView {
    const attempt = this.getAttempt(id);
    if (attempt === undefined) throw new Error(`continuation attempt not found: ${id}`);
    return attempt;
  }
}
