import { AttentionObserver } from "./attention-observer.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AttentionStore,
  attentionDigest,
  type AttentionOwner,
} from "./attention-store.js";
import type { AttentionReminderPolicy } from "./attention-reminders.js";
import { readAttentionReturnBrief, type AttentionReturnBrief } from "./attention-return-brief.js";
export type AttentionPosture = "attended" | "quiet" | "away";
export interface AttentionPostureResult {
  scope_id: string;
  actor: string;
  posture: AttentionPosture;
  previous: AttentionPosture | null;
  /** When the current posture was entered; null for a pre-49 posture kept unchanged. */
  entered_at: number | null;
  /** Present only when leaving `away` for `attended`. */
  return_brief: AttentionReturnBrief | null;
  execution_takeover: false;
}
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
    /** Present only on an overdue-decision reminder, never on the first notice. */
    reminder?: { sequence: number; age_ms: number };
  },
  signal: AbortSignal
) => Promise<void>;
type DeliveryTable = "attention_deliveries" | "attention_reminders";
type Claimed = Delivery & { table: DeliveryTable; sequence?: number; opened_at?: number; last_at?: number };
// Same eligibility for first notices and reminders: due and not in a quiet scope.
const claimable = (table: DeliveryTable) =>
  `SELECT d.* FROM ${table} d WHERE d.state='pending' AND d.next_at<=? AND NOT EXISTS(SELECT 1 FROM attention_postures p WHERE p.scope_id=d.scope_id AND p.posture='quiet') ORDER BY d.next_at,d.delivery_id LIMIT 1`;
/** Local owner UX state; posture never changes any execution authority. */
export class AttentionExperience {
  /** Reminder rows are claimed only while this process has reminders
   * enabled; a disabled process leaves queued rows for a later re-enable. */
  constructor(readonly store: AttentionStore, readonly owner: AttentionOwner,
    private readonly options: { reminders?: boolean } = {}) {}
  /** Record a posture. Re-asserting the current posture keeps its start, so a
   * repeated `away` does not shorten the interval. Leaving `away` for
   * `attended` also returns the read-only return brief for that interval,
   * computed in the same transaction. Neither grants any authority. */
  posture(
    scope: string,
    actor: string,
    posture: AttentionPosture,
    now = Date.now(),
    options: { limit?: number } = {}
  ): AttentionPostureResult {
    this.actor(actor);
    if (!["attended", "quiet", "away"].includes(posture))
      throw new Error("invalid_posture");
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_now");
    return this.store.write(this.owner, () => {
      this.scope(scope);
      const db = this.store.db;
      const prior = db
        .prepare("SELECT posture,entered_at FROM attention_postures WHERE scope_id=? AND actor=?")
        .get(scope, actor) as { posture: AttentionPosture; entered_at: number | null } | undefined;
      const enteredAt = prior?.posture === posture ? prior.entered_at : now;
      db.prepare(
        `INSERT INTO attention_postures(scope_id,actor,posture,entered_at) VALUES(?,?,?,?)
         ON CONFLICT(scope_id,actor) DO UPDATE SET posture=excluded.posture,entered_at=excluded.entered_at`
      ).run(scope, actor, posture, enteredAt);
      const returning = prior?.posture === "away" && posture === "attended";
      return {
        scope_id: scope,
        actor,
        posture,
        previous: prior?.posture ?? null,
        entered_at: enteredAt,
        return_brief: returning
          ? readAttentionReturnBrief(db, {
              scope_id: scope,
              // A clock that moved backwards cannot produce a negative interval.
              since: prior.entered_at === null ? null : Math.min(prior.entered_at, now),
              now,
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            })
          : null,
        execution_takeover: false as const,
      };
    });
  }
  /** Read-only preview of a return brief without changing posture: over
   * [since, now], or over the actor's current away interval. */
  returnBrief(
    scope: string,
    actor: string,
    options: { since?: number; limit?: number } = {},
    now = Date.now()
  ): AttentionReturnBrief {
    this.actor(actor);
    this.scope(scope);
    let since: number | null;
    if (options.since !== undefined) since = options.since;
    else {
      const row = this.store.db
        .prepare("SELECT posture,entered_at FROM attention_postures WHERE scope_id=? AND actor=?")
        .get(scope, actor) as { posture: string; entered_at: number | null } | undefined;
      if (row?.posture !== "away") throw new Error("since_required");
      since = row.entered_at === null ? null : Math.min(row.entered_at, now);
    }
    return readAttentionReturnBrief(this.store.db, {
      scope_id: scope,
      since,
      now,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
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
  recoverDeliveries(now = Date.now()): void {
    this.store.write(this.owner, () => {
      for (const table of ["attention_deliveries", "attention_reminders"] as const) {
        this.store.db
          .prepare(
            `INSERT OR IGNORE INTO attention_dead_letters(delivery_id,kind,scope_id,item_id,revision,sequence,error,dead_at)
             SELECT delivery_id,?,scope_id,item_id,revision,${table === "attention_reminders" ? "sequence" : "NULL"},'interrupted_delivery',?
             FROM ${table} WHERE state='sending' AND attempts>=5`
          )
          .run(table === "attention_reminders" ? "reminder" : "first_notice", now);
        this.store.db
          .prepare(
            `UPDATE ${table} SET state=CASE WHEN attempts>=5 THEN 'dead_letter' ELSE 'pending' END,error='interrupted_delivery' WHERE state='sending'`
          )
          .run();
      }
    });
  }
  /** Queue at most one reminder per call: the oldest open decision that is
   * overdue and whose previous reminder has settled and backed off. Quiet
   * scopes neither schedule nor reset. A revision change while the decision
   * stays unresolved keeps the schedule; a reminder superseded by that change
   * counts as settled. Resolved decisions are removed unless a send is in
   * flight, whose receipt must still settle on its own row. */
  scheduleReminders(policy: AttentionReminderPolicy, now = Date.now()) {
    const { overdueMs, backoffMaxMs } = policy;
    if (!Number.isInteger(overdueMs) || overdueMs < 1 || !Number.isInteger(backoffMaxMs) || backoffMaxMs < overdueMs)
      throw new Error("invalid_attention_reminder_policy");
    return this.store.write(this.owner, () => {
      const db = this.store.db;
      const cleared = db.prepare(`DELETE FROM attention_reminders AS r WHERE r.state<>'sending' AND NOT EXISTS(
        SELECT 1 FROM attention_items i WHERE i.item_id=r.item_id AND i.scope_id=r.scope_id AND i.state IN ('open','source_missing'))`).run().changes;
      // A stored delay from an older policy is clamped into the current bounds.
      const due = db.prepare(`SELECT i.item_id,i.scope_id,i.revision,i.created_at,r.sequence,r.delay_ms FROM attention_items i
        LEFT JOIN attention_reminders r ON r.scope_id=i.scope_id AND r.item_id=i.item_id
        WHERE i.state='open' AND i.created_at<=?
          AND NOT EXISTS(SELECT 1 FROM attention_postures p WHERE p.scope_id=i.scope_id AND p.posture='quiet')
          AND (r.item_id IS NULL OR (r.state IN ('delivered','dead_letter','superseded') AND ?-r.last_at>=MIN(MAX(r.delay_ms,?),?)))
        ORDER BY i.created_at,i.item_id LIMIT 1`).get(now - overdueMs, now, overdueMs, backoffMaxMs) as
        { item_id: string; scope_id: string; revision: number; created_at: number; sequence: number | null; delay_ms: number | null } | undefined;
      if (!due) return { scheduled: null, cleared };
      const sequence = (due.sequence ?? 0) + 1;
      const delay = due.delay_ms === null ? overdueMs
        : Math.min(backoffMaxMs, Math.min(Math.max(due.delay_ms, overdueMs), backoffMaxMs) * 2);
      const deliveryId = `${due.item_id}:${due.revision}:r${sequence}`;
      db.prepare(`INSERT INTO attention_reminders(delivery_id,scope_id,item_id,revision,opened_at,sequence,last_at,delay_ms,next_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,item_id) DO UPDATE SET delivery_id=excluded.delivery_id,revision=excluded.revision,
        sequence=excluded.sequence,last_at=excluded.last_at,delay_ms=excluded.delay_ms,state='pending',attempts=0,next_at=excluded.next_at,error=NULL`)
        .run(deliveryId, due.scope_id, due.item_id, due.revision, due.created_at, sequence, now, delay, now);
      return { scheduled: { item_id: due.item_id, scope_id: due.scope_id, sequence, age_ms: now - due.created_at }, cleared };
    });
  }
  async drain(sender: AttentionSender, now = Date.now(), timeoutMs = 5000): Promise<void> {
    await this.drainOne(sender, now, timeoutMs);
  }
  /** Local idempotent transports only. A timeout may still have delivered the
   * same delivery_id; this does not authorize retrying public messages.
   * maxItems bounds all claimed work, including superseded projections.
   */
  async drainBatch(sender: AttentionSender, options: {
    maxItems?: number;
    maxDurationMs?: number;
    signal?: AbortSignal;
  } = {}) {
    const maxItems = options.maxItems ?? 20;
    const maxDurationMs = options.maxDurationMs ?? 1000;
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100 ||
        !Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 10_000) {
      throw new Error("invalid_delivery_batch_bounds");
    }
    const started = performance.now();
    const result = { processed: 0, attempted: 0, delivered: 0, retried: 0,
      deadLetters: 0, superseded: 0, stale: 0, cancelled: 0,
      stopped: "limit" as "limit" | "empty" | "deadline" | "aborted" };
    while (result.processed < maxItems) {
      if (options.signal?.aborted) { result.stopped = "aborted"; break; }
      const remaining = maxDurationMs - (performance.now() - started);
      // Node timers have a minimum delay of one millisecond. Do not claim work
      // when even that minimum timer cannot fit in the remaining budget.
      if (remaining < 1) { result.stopped = "deadline"; break; }
      let budgetTimerExpired = false;
      const outcome = await this.drainOne(sender, Date.now(), Math.min(5000, Math.ceil(remaining)), options.signal,
        () => { budgetTimerExpired = remaining <= 5000; });
      if (outcome === "idle") { result.stopped = "empty"; break; }
      result.processed++;
      if (outcome === "superseded") result.superseded++;
      else {
        result.attempted++;
        if (outcome === "dead_letter") result.deadLetters++;
        else result[outcome]++;
      }
      // A timer can fire before the monotonic clock reaches its nominal deadline.
      // Once the batch-budget timer fires, do not claim another receipt.
      // A shorter per-send timeout can still leave budget for the next receipt.
      if (budgetTimerExpired) { result.stopped = "deadline"; break; }
    }
    if (options.signal?.aborted) result.stopped = "aborted";
    // Counts use the same eligibility predicate as claim; quiet and delayed
    // retries remain persisted but are not currently deliverable.
    const due = this.store.db.prepare(`SELECT COUNT(*) n, MIN(d.next_at) oldest
      FROM (SELECT scope_id,state,next_at FROM attention_deliveries${this.options.reminders
        ? " UNION ALL SELECT scope_id,state,next_at FROM attention_reminders" : ""}) d
      WHERE d.state='pending' AND d.next_at<=?
      AND NOT EXISTS(SELECT 1 FROM attention_postures p WHERE p.scope_id=d.scope_id AND p.posture='quiet')`
    ).get(Date.now()) as { n: number; oldest: number | null };
    return { ...result, remainingDue: due.n, oldestDueAt: due.oldest };
  }
  private async drainOne(
    sender: AttentionSender,
    now = Date.now(),
    timeoutMs: number,
    signal?: AbortSignal,
    onTimeout?: () => void
  ): Promise<"idle" | "superseded" | "delivered" | "retried" | "dead_letter" | "stale" | "cancelled"> {
    const db = this.store.db;
    const row = this.store.write(this.owner, () => {
      const first = db.prepare(claimable("attention_deliveries")).get(now) as Delivery | undefined;
      const reminder = this.options.reminders
        ? db.prepare(claimable("attention_reminders")).get(now) as Claimed | undefined
        : undefined;
      const d: Claimed | undefined =
        reminder && (!first || reminder.next_at < first.next_at ||
          (reminder.next_at === first.next_at && reminder.delivery_id < first.delivery_id))
          ? { ...reminder, table: "attention_reminders" }
          : first && { ...first, table: "attention_deliveries" };
      if (d) {
        const item = this.store.getItem(d.scope_id, d.item_id);
        if (
          !item ||
          item.revision !== d.revision ||
          !["open", "answer_uncertain", "source_missing"].includes(item.state)
        ) {
          db.prepare(
            `UPDATE ${d.table} SET state='superseded' WHERE delivery_id=?`
          ).run(d.delivery_id);
          return "superseded" as const;
        }
      }
      if (d)
        db.prepare(
          `UPDATE ${d.table} SET state='sending',attempts=attempts+1 WHERE delivery_id=? AND state='pending'`
        ).run(d.delivery_id);
      return d;
    });
    if (row === "superseded") return "superseded";
    if (!row) return "idle";
    const item = this.store.getItem(row.scope_id, row.item_id);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let error: string | null = null;
    let onAbort: (() => void) | undefined;
    let cancelled = false;
    try {
      if (!item) throw new Error("source_missing");
      await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error("delivery_aborted");
          return sender(
            {
              delivery_id: row.delivery_id,
              scope_id: row.scope_id,
              item_id: row.item_id,
              question: item.decision.question,
              state: item.state,
              ...(row.table === "attention_reminders"
                ? { reminder: { sequence: row.sequence!, age_ms: row.last_at! - row.opened_at! } }
                : {}),
            },
            controller.signal
          );
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => { cancelled = true; controller.abort(); reject(new Error("delivery_aborted")); };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
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
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    let changed: number;
    try {
    const next = cancelled ? "pending" : error
      ? row.attempts + 1 >= 5
        ? "dead_letter"
        : "pending"
      : "delivered";
    const updated = this.store.write(this.owner, () => {
      const result = db
        .prepare(
          `UPDATE ${row.table} SET state=?,next_at=?,error=?,attempts=attempts-? WHERE delivery_id=? AND attempts=? AND state='sending'`
        )
        .run(
          next,
          now + Math.min(300000, 1000 * 2 ** row.attempts),
          cancelled ? "delivery_cancelled_indeterminate" : error,
          cancelled ? 1 : 0,
          row.delivery_id,
          row.attempts + 1
        );
      // Keep when it dead-lettered: a reminder row is reused per sequence.
      if (result.changes === 1 && next === "dead_letter")
        db.prepare(
          `INSERT OR IGNORE INTO attention_dead_letters(delivery_id,kind,scope_id,item_id,revision,sequence,error,dead_at) VALUES(?,?,?,?,?,?,?,?)`
        ).run(row.delivery_id, row.table === "attention_reminders" ? "reminder" : "first_notice",
          row.scope_id, row.item_id, row.revision, row.sequence ?? null, error, now);
      return result;
    });
    changed = updated.changes;
    } catch (e) {
      if (e instanceof Error && e.message === "stale_owner") return "stale";
      throw e;
    }
    if (changed !== 1) return "stale";
    if (cancelled) return "cancelled";
    return error ? row.attempts + 1 >= 5 ? "dead_letter" : "retried" : "delivered";
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
