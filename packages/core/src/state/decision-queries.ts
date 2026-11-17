import type Database from "better-sqlite3";

export interface DecisionQuery {
  scope_id?: string;
  after: string;
  inclusive?: boolean;
  limit: number;
  read_scopes: readonly string[];
}
export interface DecisionRow {
  id: string;
  scope_id: string | null;
  waiting_since: number | null;
  revision: string | null;
  summary: string;
  state: string;
  reason: string | null;
  kind: string;
  details_json: string;
}
/** Bounded SELECT-only supplements to stores whose existing lists are single-scope,
 * capped without a cursor, or recovery-specific. Construction does not claim an owner,
 * migrate, refresh a projection, or read a repository. */
export class DecisionQueries {
  constructor(readonly db: Database.Database) {}
  session(q: DecisionQuery): DecisionRow[] {
    // created_at is projection time, not the time the Session entered the wait.
    return this.rows(`SELECT item_id id,scope_id,NULL waiting_since,CAST(revision AS TEXT)||':'||content_hash revision,
      json_extract(decision_json,'$.question') summary,state,NULL reason,'session' kind,decision_json details_json
      FROM attention_items WHERE state='open' AND item_id>${q.inclusive ? "=" : ""}? AND (? IS NULL OR scope_id=?)
      ORDER BY item_id LIMIT ?`, q.after, q.scope_id ?? null, q.scope_id ?? null, q.limit);
  }
  contained_mission(q: DecisionQuery): DecisionRow[] { return this.missions(q, false); }
  ci_repair(q: DecisionQuery): DecisionRow[] { return this.missions(q, true); }
  private missions(q: DecisionQuery, ci: boolean): DecisionRow[] {
    if (q.read_scopes.length === 0) return [];
    return this.rows(`SELECT m.mission_id id,m.scope_id,CAST(m.revision AS TEXT) revision,m.state,
      json_extract(m.spec_json,'$.goal') summary,m.spec_json details_json,'mission' kind,
      (SELECT json_extract(e.payload_json,'$.reason') FROM engineering_contained_events e
        WHERE e.mission_id=m.mission_id AND e.kind='halted' ORDER BY e.seq DESC LIMIT 1) reason,
      (SELECT e.created_at FROM engineering_contained_events e WHERE e.mission_id=m.mission_id
        AND json_extract(e.payload_json,'$.to')=m.state
        AND json_extract(e.payload_json,'$.from')<>m.state ORDER BY e.seq DESC LIMIT 1) waiting_since
      FROM engineering_contained_missions m WHERE m.state IN ('awaiting_decision','needs_reconciliation','stop_unknown')
      AND m.scope_id IN (${q.read_scopes.map(() => "?").join(",")})
      AND m.mission_id>${q.inclusive ? "=" : ""}? AND (? IS NULL OR m.scope_id=?)
      AND ${ci ? "" : "NOT "}COALESCE((m.state='awaiting_decision' AND json_type(m.spec_json,'$.ci_repair')='object'
        AND (SELECT json_extract(e.payload_json,'$.reason') FROM engineering_contained_events e
          WHERE e.mission_id=m.mission_id AND e.kind='halted' ORDER BY e.seq DESC LIMIT 1)='publication_pending'),0)
      ORDER BY m.mission_id LIMIT ?`, ...q.read_scopes, q.after, q.scope_id ?? null, q.scope_id ?? null, q.limit);
  }
  revision_chain(q: DecisionQuery): DecisionRow[] {
    if (q.read_scopes.length === 0) return [];
    return this.rows(`SELECT c.chain_id id,m.scope_id,CAST(c.revision AS TEXT) revision,c.state,
      c.state summary,c.stop_reason reason,c.mode kind,
      json_object('uncertain',EXISTS(SELECT 1 FROM engineering_publication_intents i WHERE i.chain_id=c.chain_id AND i.kind='push' AND i.state='uncertain'),
        'unsettled',EXISTS(SELECT 1 FROM engineering_publication_intents i WHERE i.chain_id=c.chain_id AND i.kind='push' AND i.state IN ('pending','uncertain'))) details_json,
      (SELECT e.created_at FROM engineering_revision_chain_events e WHERE e.chain_id=c.chain_id AND e.kind='transition'
        AND json_extract(e.payload_json,'$.to')=c.state AND json_extract(e.payload_json,'$.from')<>c.state
        ORDER BY e.seq DESC LIMIT 1) waiting_since
      FROM engineering_revision_chains c JOIN engineering_contained_missions m ON m.mission_id=c.root_mission_id
      WHERE c.state IN ('ready_for_human','awaiting_decision') AND m.scope_id IN (${q.read_scopes.map(() => "?").join(",")})
      AND c.chain_id>${q.inclusive ? "=" : ""}? AND (? IS NULL OR m.scope_id=?) ORDER BY c.chain_id LIMIT ?`,
      ...q.read_scopes, q.after, q.scope_id ?? null, q.scope_id ?? null, q.limit);
  }
  autonomy(q: DecisionQuery): DecisionRow[] {
    return this.rows(`SELECT a.autonomy_run_id id,${this.scopeForTask("a.task_id")} scope_id,
      CAST(a.revision AS TEXT) revision,a.state,'Autonomy approval' summary,NULL reason,'autonomy' kind,
      COALESCE(a.approval_json,'{}') details_json,
      (SELECT t.occurred_at*1000 FROM autonomy_run_transitions t WHERE t.autonomy_run_id=a.autonomy_run_id
        AND t.to_state='awaiting_approval' AND t.from_state<>'awaiting_approval' ORDER BY t.seq DESC LIMIT 1) waiting_since
      FROM autonomy_run_projection a WHERE a.state='awaiting_approval' AND a.autonomy_run_id>${q.inclusive ? "=" : ""}?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM attention_scopes s WHERE s.task_id=a.task_id AND s.scope_id=?))
      ORDER BY a.autonomy_run_id LIMIT ?`, q.after, q.scope_id ?? null, q.scope_id ?? null, q.limit);
  }
  hermes(q: DecisionQuery): DecisionRow[] {
    return this.rows(`SELECT h.*,${this.scopeForTask("r.task_id")} scope_id FROM (
      SELECT 'approval:'||approval_id id,run_id,requested_at*1000 waiting_since,NULL revision,action_summary summary,
        status state,NULL reason,'approval' kind,json_object('run_id',run_id,'risk',risk,'resolved_at',resolved_at,'choice',choice) details_json FROM approvals WHERE status='pending'
      UNION ALL SELECT 'clarify:'||clarify_id id,run_id,requested_at*1000 waiting_since,NULL revision,question summary,
        status state,NULL reason,'clarify' kind,json_object('run_id',run_id,'resolved_at',resolved_at,'answer',answer) details_json FROM clarifies WHERE status='pending'
      ) h JOIN runs r ON r.run_id=h.run_id WHERE h.id>${q.inclusive ? "=" : ""}?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM attention_scopes s WHERE s.task_id=r.task_id AND s.scope_id=?))
      ORDER BY h.id LIMIT ?`, q.after, q.scope_id ?? null, q.scope_id ?? null, q.limit);
  }
  loop(q: DecisionQuery): DecisionRow[] {
    // The journal has no decision receipt. A later execution of the same task in
    // the same loop supersedes the escalation; loop.stopped does not resolve it.
    return this.rows(`SELECT * FROM (SELECT e.event_id id,${this.scopeForTask("r.task_id")} scope_id,e.created_at waiting_since,
      NULL revision,COALESCE(json_extract(e.payload_json,'$.reason'),'Loop escalation') summary,
      'escalated' state,NULL reason,'loop' kind,e.payload_json details_json
      FROM events e JOIN runs r ON r.run_id=e.run_id WHERE e.type='loop.escalated' AND e.event_id>${q.inclusive ? "=" : ""}?
      AND NOT EXISTS(SELECT 1 FROM events n WHERE n.session_id=e.session_id
        AND n.type IN ('loop.execute.done','loop.escalated')
        AND json_extract(n.payload_json,'$.task_id')=json_extract(e.payload_json,'$.task_id')
        AND (n.created_at>e.created_at OR (n.run_id=e.run_id AND n.seq>e.seq)))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM attention_scopes s WHERE s.task_id=r.task_id AND s.scope_id=?))
      UNION ALL
      SELECT 'card:'||c.card_id id,${this.scopeForTask("c.task_id")} scope_id,
        (SELECT k.created_at*1000 FROM kanban_card_events k WHERE k.card_id=c.card_id AND k.kind='blocked'
          AND json_extract(k.payload,'$.from')<>'blocked' ORDER BY k.event_id DESC LIMIT 1) waiting_since,
        NULL revision,COALESCE(c.blocked_reason,c.title) summary,'escalated' state,NULL reason,'loop_card' kind,'{}' details_json
      FROM kanban_cards c WHERE c.status='blocked' AND c.assignee='osstack-loop'
        AND c.card_id GLOB 'card_loop_*' AND c.task_id LIKE 'loop:%' AND 'card:'||c.card_id>${q.inclusive ? "=" : ""}?
        AND (? IS NULL OR EXISTS(SELECT 1 FROM attention_scopes s WHERE s.task_id=c.task_id AND s.scope_id=?))
      ) ORDER BY id LIMIT ?`, q.after, q.scope_id ?? null, q.scope_id ?? null,
      q.after, q.scope_id ?? null, q.scope_id ?? null, q.limit);
  }
  private scopeForTask(task: string): string {
    // Ambiguous or unbound local sources have no single scope. An explicit
    // scope filter uses EXISTS instead of assigning one arbitrarily.
    return `(SELECT CASE WHEN COUNT(*)=1 THEN MIN(scope_id) ELSE NULL END FROM attention_scopes WHERE task_id=${task})`;
  }
  private rows(sql: string, ...args: unknown[]): DecisionRow[] { return this.db.prepare(sql).all(...args) as DecisionRow[]; }
}
