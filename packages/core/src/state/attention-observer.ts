import { classifyAttentionWait, type WaitInput } from "../attention.js";
import { realpathSync } from "node:fs";
import { projectAttentionRun } from "./attention-run-projection.js";
import {
  attentionDigest,
  type AttentionStore,
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
      db.prepare("UPDATE attention_run_cursors SET gap=COALESCE(gap,'source_missing'),generation=?,updated_at=? WHERE scope_id=?")
        .run(this.owner.generation, now, scope.scope_id);
      db.prepare("UPDATE attention_subjects SET sampled_at=?,generation=?,payload_json=? WHERE scope_id=?")
        .run(now, this.owner.generation, JSON.stringify({ state: "source_missing", reason: "source_missing",
          process_liveness: "unknown", gap: "history_gap", event_replay: { complete: false, caught_up: false, gap: "source_missing", completeness_scope: "unverified_retention" } }), scope.scope_id);
      return;
    }
    // A scan advances a durable keyset, then restarts from the beginning. New IDs
    // inserted behind the cursor are picked up on the next pass, never evicted.
    const rows = db
      .prepare(
        `SELECT '0:'||s.session_id AS key,s.session_id AS id,'session' AS kind FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
      WHERE s.task_id=? AND r.tenant_id IS NULL AND '0:'||s.session_id>?
      UNION ALL SELECT '1:'||r.run_id,r.run_id,'run' FROM runs r WHERE r.task_id=? AND r.tenant_id IS NULL AND '1:'||r.run_id>?
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
          ...(row.kind === "run" ? { event_replay: { complete: false, caught_up: false,
            gap: admitted ? "not_sampled" : "capacity_exceeded", completeness_scope: "unverified_retention" } } : {}),
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
            projectAttentionRun(this.store, this.owner, scope, subject.subject_id, now);
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
        if (error instanceof Error && error.message === "stale_owner") throw error;
        this.store.assertOwner(this.owner);
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
      WHERE s.task_id=? AND r.tenant_id IS NULL AND NOT EXISTS(SELECT 1 FROM attention_subjects a WHERE a.scope_id=? AND a.kind='session' AND a.subject_id=s.session_id)
      UNION ALL SELECT 1 FROM runs r WHERE r.task_id=? AND r.tenant_id IS NULL AND NOT EXISTS(SELECT 1 FROM attention_subjects a WHERE a.scope_id=? AND a.kind='run' AND a.subject_id=r.run_id) LIMIT 1`
      )
      .get(scope.task_id, scope.scope_id, scope.task_id, scope.scope_id);

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
    this.store.assertOwner(this.owner);
    if (s.kind === "run" && payload && typeof payload === "object")
      payload = { event_replay: { complete: false, caught_up: false, gap: "invalid_source", completeness_scope: "unverified_retention" }, ...payload };
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
        "SELECT 1 FROM attention_subjects WHERE scope_id=? AND (sampled_at<? OR generation<>? OR CASE WHEN json_valid(payload_json) THEN (json_extract(payload_json,'$.reason') IS NOT NULL AND json_extract(payload_json,'$.reason')<>'snapshot_only' OR json_extract(payload_json,'$.gap')='history_gap') ELSE 1 END) LIMIT 1"
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
        facts: (() => {
          try { return JSON.parse(payload_json) as unknown; }
          catch { return { state: "unknown", reason: "invalid_source", gap: "history_gap",
            ...(r.kind === "run" ? { event_replay: { complete: false, caught_up: false, gap: "invalid_source", completeness_scope: "unverified_retention" } } : {}) }; }
        })(),
      })),
      limitations: [
        "No complete mutable-source history",
        "Process liveness unknown",
        "Coverage is observation, not execution ownership",
      ],
    };
  }
}
