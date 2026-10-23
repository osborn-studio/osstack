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
