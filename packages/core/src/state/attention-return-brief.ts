import type Database from "better-sqlite3";

/** States in which a decision is still waiting on the owner. */
export const ATTENTION_WAITING_STATES = ["open", "answer_uncertain", "source_missing"] as const;
const WAITING_SQL = ATTENTION_WAITING_STATES.map((s) => `'${s}'`).join(",");
export const RETURN_BRIEF_DEFAULT_LIMIT = 20;
export const RETURN_BRIEF_MAX_LIMIT = 100;

export interface ReturnBriefSection<T> {
  /** Every matching fact, including the ones not listed. */
  total: number;
  /** total - items.length; never silently dropped. */
  omitted: number;
  items: T[];
}
export interface ReturnBriefWaiting {
  item_id: string;
  revision: number;
  state: string;
  question: string | null;
  opened_at: number;
  age_ms: number;
  /** Overdue reminders scheduled so far for this decision (0 when none). */
  reminder_count: number;
}
export interface ReturnBriefOpened {
  item_id: string;
  revision: number;
  state: string;
  question: string | null;
  opened_at: number;
}
export interface ReturnBriefResolved {
  item_id: string;
  revision: number;
  /** The state the decision settled into when it left the waiting set. */
  state: string;
  question: string | null;
  opened_at: number;
  resolved_at: number;
}
export interface ReturnBriefDeliveryProblem {
  delivery_id: string;
  kind: "first_notice" | "reminder";
  item_id: string;
  revision: number;
  sequence: number | null;
  error: string | null;
  dead_at: number;
}
export interface AttentionReturnBrief {
  schema_version: 1;
  scope_id: string;
  /** Inclusive on both ends. `since_known` is false for an away posture
   * entered before its start was recorded; changes are then read from the
   * beginning and stay bounded. */
  interval: { since: number | null; now: number; since_known: boolean };
  waiting_on_you: ReturnBriefSection<ReturnBriefWaiting>;
  changed_while_away: {
    opened: ReturnBriefSection<ReturnBriefOpened>;
    resolved: ReturnBriefSection<ReturnBriefResolved>;
  };
  delivery_problems: ReturnBriefSection<ReturnBriefDeliveryProblem> & {
    /** Dead letters recorded before their time was kept; reported, not placed. */
    undated: number;
  };
  /** A brief is information only. */
  execution_takeover: false;
  authority: "none";
}
export interface AttentionReturnBriefInput {
  scope_id: string;
  since: number | null;
  now: number;
  limit?: number;
}

const question = (json: string): string | null => {
  try {
    const value = (JSON.parse(json) as { question?: unknown }).question;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};
const section = <T>(total: number, items: T[]): ReturnBriefSection<T> => ({
  total,
  omitted: Math.max(0, total - items.length),
  items,
});

/** Read-only, bounded return brief for one scope over [since, now]. Only
 * SELECTs; safe on a read-only connection and inside a caller's write. */
export function readAttentionReturnBrief(
  db: Database.Database,
  input: AttentionReturnBriefInput
): AttentionReturnBrief {
  const { scope_id: scope, since, now } = input;
  const limit = input.limit ?? RETURN_BRIEF_DEFAULT_LIMIT;
  if (typeof scope !== "string" || scope.length < 1 || scope.length > 4096)
    throw new Error("invalid_scope_id");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_now");
  if (since !== null && (!Number.isSafeInteger(since) || since < 0 || since > now))
    throw new Error("invalid_since");
  if (!Number.isInteger(limit) || limit < 1 || limit > RETURN_BRIEF_MAX_LIMIT)
    throw new Error("invalid_limit");
  const from = since ?? 0;
  // One snapshot: nested inside a caller's transaction this is a savepoint.
  return db.transaction(() => {
    const count = (sql: string, ...args: unknown[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n;

    const waitingTotal = count(
      `SELECT COUNT(*) n FROM attention_items WHERE scope_id=? AND state IN (${WAITING_SQL})`,
      scope
    );
    const waiting = (
      db
        .prepare(
          `SELECT i.item_id,i.revision,i.state,i.decision_json,i.created_at,COALESCE(r.sequence,0) reminder_count
       FROM attention_items i LEFT JOIN attention_reminders r ON r.scope_id=i.scope_id AND r.item_id=i.item_id
       WHERE i.scope_id=? AND i.state IN (${WAITING_SQL}) ORDER BY i.created_at,i.item_id LIMIT ?`
        )
        .all(scope, limit) as {
        item_id: string; revision: number; state: string; decision_json: string; created_at: number; reminder_count: number;
      }[]
    ).map((r) => ({
      item_id: r.item_id,
      revision: r.revision,
      state: r.state,
      question: question(r.decision_json),
      opened_at: r.created_at,
      age_ms: Math.max(0, now - r.created_at),
      reminder_count: r.reminder_count,
    }));

    const openedTotal = count(
      "SELECT COUNT(*) n FROM attention_items WHERE scope_id=? AND created_at BETWEEN ? AND ?",
      scope, from, now
    );
    const opened = (
      db
        .prepare(
          `SELECT item_id,revision,state,decision_json,created_at FROM attention_items
       WHERE scope_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at,item_id LIMIT ?`
        )
        .all(scope, from, now, limit) as {
        item_id: string; revision: number; state: string; decision_json: string; created_at: number;
      }[]
    ).map((r) => ({
      item_id: r.item_id,
      revision: r.revision,
      state: r.state,
      question: question(r.decision_json),
      opened_at: r.created_at,
    }));

    // A settlement whose decision re-entered the waiting set is not a
    // resolution; it is reported under waiting instead.
    const resolvedWhere = `FROM attention_item_settlements s JOIN attention_items i ON i.scope_id=s.scope_id AND i.item_id=s.item_id
       WHERE s.scope_id=? AND s.settled_at BETWEEN ? AND ? AND i.state NOT IN (${WAITING_SQL})`;
    const resolvedTotal = count(`SELECT COUNT(*) n ${resolvedWhere}`, scope, from, now);
    const resolved = (
      db
        .prepare(
          `SELECT s.item_id,s.revision,s.state,s.settled_at,i.decision_json,i.created_at ${resolvedWhere}
       ORDER BY s.settled_at,s.item_id LIMIT ?`
        )
        .all(scope, from, now, limit) as {
        item_id: string; revision: number; state: string; settled_at: number; decision_json: string; created_at: number;
      }[]
    ).map((r) => ({
      item_id: r.item_id,
      revision: r.revision,
      state: r.state,
      question: question(r.decision_json),
      opened_at: r.created_at,
      resolved_at: r.settled_at,
    }));

    const deadTotal = count(
      "SELECT COUNT(*) n FROM attention_dead_letters WHERE scope_id=? AND dead_at BETWEEN ? AND ?",
      scope, from, now
    );
    const dead = db
      .prepare(
        `SELECT delivery_id,kind,item_id,revision,sequence,error,dead_at FROM attention_dead_letters
       WHERE scope_id=? AND dead_at BETWEEN ? AND ? ORDER BY dead_at,delivery_id LIMIT ?`
      )
      .all(scope, from, now, limit) as ReturnBriefDeliveryProblem[];
    const undated = count(
      `SELECT COUNT(*) n FROM (SELECT delivery_id FROM attention_deliveries WHERE scope_id=? AND state='dead_letter'
       UNION ALL SELECT delivery_id FROM attention_reminders WHERE scope_id=? AND state='dead_letter') d
       WHERE NOT EXISTS(SELECT 1 FROM attention_dead_letters l WHERE l.delivery_id=d.delivery_id)`,
      scope, scope
    );

    return {
      schema_version: 1 as const,
      scope_id: scope,
      interval: { since, now, since_known: since !== null },
      waiting_on_you: section(waitingTotal, waiting),
      changed_while_away: {
        opened: section(openedTotal, opened),
        resolved: section(resolvedTotal, resolved),
      },
      delivery_problems: { ...section(deadTotal, dead), undated },
      execution_takeover: false as const,
      authority: "none" as const,
    };
  })();
}
