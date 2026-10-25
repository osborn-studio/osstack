import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  EngineeringAdoptRequest, EngineeringObserveRequest, EngineeringDecideRequest,
  EngineeringDeferRequest, EngineeringCancelRequest, EngineeringEndObservationRequest,
  EngineeringReconcileRequest, SessionDecision, type EngineeringDecisionRef,
} from "@osstack/protocol";
import { AttentionActions } from "./attention-actions.js";
import { AttentionStore, attentionDigest, type AttentionOwner, type AttentionItem } from "./attention-store.js";
import { getEngineeringDispatchPhase, isEngineeringCancelledBeforeDispatch } from "./engineering-dispatch.js";
import { SessionRepository, type SessionSnapshot } from "./sessions.js";

/** Supplied by the trusted host after credential authentication. Never parse
 * this interface from request JSON or infer its grants from Worker text. */
export interface EngineeringPrincipal {
  principal_id: string; client_session_id: string;
  read_scopes: string[]; write_scopes: string[]; stop_scopes: string[]; operator_scopes: string[];
}
export interface EngineeringMission {
  mission_id: string; scope_id: string; task_id: string; run_id: string; session_id: string;
  repo_path: string; source_instance_id: string; source_generation: number;
  owner_principal_id: string; owner_client_session_id: string; goal: string; completion_level: "observed_turn";
  state: "observing" | "awaiting_decision" | "answer_recorded" | "needs_reconciliation" | "completed" | "failed" | "cancel_requested" | "observation_ended";
  revision: number; stop_intent_id: string | null; created_at: number; updated_at: number; observed_at: number;
  policy_digest: string; observation_proof_json: string | null;
}
interface WaitRow {
  wait_id: string; mission_id: string; item_id: string; revision: number; decision_ref_json: string;
  state: "open" | "deferred" | "answer_recorded" | "delivery_unknown" | "cleared" | "superseded" | "needs_reconciliation" | "cancelled_before_dispatch";
  action_id: string | null; revisit_at: number | null; reason: string | null; reminder_sent: number; created_at: number; updated_at: number;
}
export interface EngineeringWait extends Omit<WaitRow, "decision_ref_json"> {
  decision_ref: EngineeringDecisionRef; decision: SessionDecision;
  interaction_token?: string; token_expires_at?: number;
}
export interface EngineeringActionReceipt {
  mission: EngineeringMission; action_id: string; message_id: string; state: string; replay: boolean; reservation_version: number;
}
export interface EngineeringStopResult {
  mission: EngineeringMission; replay: boolean; stop_intent_id: string;
  run_id: string; session_id: string; action_ids: string[]; committed_message_ids: string[];
}
export interface EngineeringHostEvidence { liveSend(sessionId: string): string | undefined }
type SourceStatus = "available" | "unavailable" | "identity_mismatch" | "not_observing";
class EngineeringSourceFault extends Error {
  constructor(readonly category: "unavailable" | "identity", readonly reason: string) { super(category === "identity" ? "source_changed" : "source_unavailable"); }
}
export interface EngineeringObservationProof {
  kind: "observed_turn"; action_id: string; message_id: string; source_instance_id: string;
  source_generation: number; completed_turn_id: string; session_version: number; output_sha256: string;
}
interface StoredRequest { payload_hash: string; operation: string; mission_id: string; response_json: string }
interface TokenRow { principal_id: string; client_session_id: string; mission_id: string; mission_revision: number; wait_id: string; item_id: string; item_revision: number; content_hash: string; issued_at: number; expires_at: number }
interface ActionRow { action_id: string; scope_id: string; item_id: string; message_id: string; state: string; payload_hash: string; created_at: number; updated_at: number }
/** Opaque, process-local, single-consumption capability; never serialize it. */
export interface EngineeringDispatchPermit { readonly message_id: string; readonly daemon_generation: number }
const terminal = new Set(["completed", "failed", "cancel_requested", "observation_ended"]);
const cleared = new Set(["cleared", "superseded", "cancelled_before_dispatch"]);
const POLICY_DIGEST = attentionDigest({ profile: "trusted_process_session_adoption_v1", completion_level: "observed_turn", automatic_unknown_retry: false });

export function engineeringSourceIdentity(sessionId: string, nativeSessionId: string): string {
  if (!nativeSessionId) throw Error("executor_not_qualified");
  return `v1:${attentionDigest({ session_id: sessionId, native_session_id: nativeSessionId })}`;
}

/** Synchronous domain operations execute under the daemon's existing owner
 * fence. No process, network, Adapter, or model calls occur in this store. */
export class EngineeringStore {
  private readonly permits = new WeakSet<EngineeringDispatchPermit>();
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner, private readonly hostEvidence?: EngineeringHostEvidence) {}
  get db(): Database.Database { return this.attention.db; }
  getMission(missionId: string): EngineeringMission {
    const row = this.db.prepare("SELECT * FROM engineering_missions WHERE mission_id=?").get(missionId) as EngineeringMission | undefined;
    if (!row) throw Error("not_found"); return row;
  }
  getDispatch(messageId: string) { return getEngineeringDispatchPhase(this.db, messageId); }
  listReserved(limit = 100, after?: { created_at: number; action_id: string }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error("invalid_limit");
    if (after && (!Number.isSafeInteger(after.created_at) || after.created_at < 0 || !after.action_id || after.action_id.length > 256)) throw Error("invalid_cursor");
    return this.db.prepare(`SELECT p.action_id,p.mission_id,m.owner_principal_id,p.client_session_id,m.session_id,p.message_id,p.created_at
      FROM attention_dispatch_phases p JOIN engineering_missions m ON m.mission_id=p.mission_id
      WHERE p.phase='reserved' AND m.stop_intent_id IS NULL AND m.state NOT IN ('completed','failed','cancel_requested','observation_ended')
      AND (p.created_at>? OR (p.created_at=? AND p.action_id>?))
      ORDER BY p.created_at,p.action_id LIMIT ?`).all(after?.created_at ?? -1, after?.created_at ?? -1, after?.action_id ?? "", limit) as Array<{ action_id: string; mission_id: string; owner_principal_id: string; client_session_id: string; session_id: string; message_id: string; created_at: number }>;
  }
  getReserved(actionId: string) {
    return this.db.prepare(`SELECT p.action_id,p.mission_id,m.owner_principal_id,p.client_session_id,m.session_id,p.message_id,p.created_at
      FROM attention_dispatch_phases p JOIN engineering_missions m ON m.mission_id=p.mission_id
      WHERE p.action_id=? AND p.phase='reserved' AND m.stop_intent_id IS NULL AND m.state NOT IN ('completed','failed','cancel_requested','observation_ended')`).get(actionId) as ReturnType<EngineeringStore["listReserved"]>[number] | undefined;
  }
  listActiveMissions(limit = 16, after?: { created_at: number; mission_id: string }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (after && (!Number.isSafeInteger(after.created_at) || after.created_at < 0 || !after.mission_id))) throw Error("invalid_limit");
    return this.db.prepare(`SELECT mission_id,created_at FROM engineering_missions WHERE state NOT IN ('completed','failed','cancel_requested','observation_ended')
      AND (created_at>? OR (created_at=? AND mission_id>?)) ORDER BY created_at,mission_id LIMIT ?`).all(after?.created_at ?? -1, after?.created_at ?? -1, after?.mission_id ?? "", limit) as Array<{ mission_id: string; created_at: number }>;
  }
  private write<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) throw Error("durability_required");
    return this.attention.write(this.owner, fn);
  }
  private access(principal: EngineeringPrincipal, scope: string, right: "read" | "write" | "stop" | "operator"): void {
    if (!principal.principal_id || !principal.client_session_id || !principal[`${right}_scopes`].includes(scope)) throw Error("permission_denied");
  }
  readableMission(principal: EngineeringPrincipal, missionId: string): EngineeringMission {
    const mission = this.db.prepare("SELECT * FROM engineering_missions WHERE mission_id=?").get(missionId) as EngineeringMission | undefined;
    if (!mission) throw Error("permission_denied");
    this.access(principal, mission.scope_id, "read"); return mission;
  }
  private readable(principal: EngineeringPrincipal, missionId: string): EngineeringMission { return this.readableMission(principal, missionId); }
  private steer(principal: EngineeringPrincipal, mission: EngineeringMission): void {
    this.access(principal, mission.scope_id, "read"); this.access(principal, mission.scope_id, "write");
    if (mission.owner_principal_id !== principal.principal_id) throw Error("permission_denied");
  }
  private controlBudget(missionId: string): void {
    if ((this.db.prepare("SELECT COUNT(*) n FROM engineering_requests WHERE mission_id=? AND operation NOT IN ('cancel','endObservation')").get(missionId) as { n: number }).n >= 256) throw Error("budget_exhausted");
  }
  private cas(mission: EngineeringMission, revision: number): void {
    if (mission.revision !== revision) throw Error("version_conflict");
    if (terminal.has(mission.state)) throw Error("mission_terminal");
  }
  private clock(now: number): void { if (!Number.isSafeInteger(now) || now < 0) throw Error("invalid_clock"); }
  private event(missionId: string, kind: string, actor: string | null, payload: unknown, now: number): number {
    return Number(this.db.prepare("INSERT INTO engineering_events(mission_id,kind,actor,payload_json,created_at) VALUES(?,?,?,?,?)").run(missionId, kind, actor, JSON.stringify(payload), now).lastInsertRowid);
  }
  private bump(missionId: string, state: EngineeringMission["state"], now: number): EngineeringMission {
    this.db.prepare("UPDATE engineering_missions SET state=?,revision=revision+1,updated_at=? WHERE mission_id=?").run(state, now, missionId);
    return this.getMission(missionId);
  }
  private request(principal: EngineeringPrincipal, requestId: string, operation: string, payload: unknown): StoredRequest | undefined {
    const row = this.db.prepare("SELECT * FROM engineering_requests WHERE principal_id=? AND client_session_id=? AND request_id=?").get(principal.principal_id, principal.client_session_id, requestId) as StoredRequest | undefined;
    if (row && (row.operation !== operation || row.payload_hash !== attentionDigest(payload))) throw Error("action_conflict");
    return row;
  }
  private saveRequest(principal: EngineeringPrincipal, requestId: string, operation: string, payload: unknown, missionId: string, result: unknown, now: number): void {
    this.db.prepare("INSERT INTO engineering_requests VALUES(?,?,?,?,?,?,?,?)").run(principal.principal_id, principal.client_session_id, requestId, operation, attentionDigest(payload), missionId, JSON.stringify(result), now);
  }
  /** Completion is durable Session evidence even while the repository cannot be
   * observed. Keep its identity checks entirely inside the database transaction. */
  private databaseSource(mission: Pick<EngineeringMission, "scope_id" | "task_id" | "run_id" | "session_id" | "source_instance_id" | "repo_path">) {
    const sessions = new SessionRepository(this.db, this.attention.path); const session = sessions.getSession(mission.session_id);
    const scope = this.attention.getScope(mission.scope_id);
    if (!session || !scope) throw new EngineeringSourceFault("unavailable", "source_unavailable");
    if (session.task_id !== mission.task_id || session.run_id !== mission.run_id || scope.task_id !== mission.task_id
      || !session.native_session_id || engineeringSourceIdentity(session.session_id, session.native_session_id) !== mission.source_instance_id
      || scope.repo_path !== mission.repo_path) throw new EngineeringSourceFault("identity", "source_identity_changed");
    if (!this.db.prepare("SELECT 1 FROM tasks t JOIN runs r ON r.task_id=t.task_id WHERE t.task_id=? AND r.run_id=? AND r.session_id=? AND r.agent_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL").get(mission.task_id, mission.run_id, mission.session_id, session.agent_id)) throw new EngineeringSourceFault("identity", "source_scope_changed");
    return { session, snapshot: sessions.latestSnapshot(mission.session_id) };
  }
  private source(mission: Pick<EngineeringMission, "scope_id" | "task_id" | "run_id" | "session_id" | "source_instance_id" | "repo_path">) {
    const source = this.databaseSource(mission);
    let canonical: string;
    try { canonical = realpathSync(source.session.repo_path); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && ["ENOENT", "EIO", "ENOTDIR", "ESTALE", "ENODEV", "EBUSY", "EACCES", "EPERM"].includes(String(error.code))) throw new EngineeringSourceFault("unavailable", "repository_unavailable");
      throw error;
    }
    if (canonical !== mission.repo_path) throw new EngineeringSourceFault("identity", "repository_identity_changed");
    return source;
  }
  private sourceIssue(missionId: string, reason: string, category: string, now: number): void {
    if (!this.db.prepare("SELECT 1 FROM engineering_events WHERE mission_id=? AND kind='source_observation_error' AND json_extract(payload_json,'$.reason')=?").get(missionId, reason)) this.event(missionId, "source_observation_error", null, { reason, category }, now);
  }
  private liveMessage(sessionId: string, messageId: string): boolean { return this.hostEvidence?.liveSend(sessionId) === messageId; }
  private ordinaryDecision(value: unknown): SessionDecision {
    const decision = SessionDecision.parse(value);
    const gate = decision.continuation?.gate_kind;
    if (gate === "risk_approval" || gate === "task_authorization") throw Error("signed_approval_required");
    if (gate === "phase_continue") throw Error("executor_not_qualified");
    return decision;
  }
  private ref(item: AttentionItem): EngineeringDecisionRef {
    return { kind: "session_decision", scope_id: item.scope_id, item_id: item.item_id, item_revision: item.revision, session_id: item.session_id,
      turn_id: item.turn_id, decision_id: item.decision_id, source_version: item.source_version, content_hash: item.content_hash };
  }
  private addWait(mission: EngineeringMission, snapshot: SessionSnapshot, now: number): void {
    if (!snapshot.turn_id) throw Error("source_unavailable");
    const decision = this.ordinaryDecision(snapshot.decision);
    const itemId = attentionDigest([mission.scope_id, mission.session_id, snapshot.turn_id, decision.decision_id]);
    const existing = this.db.prepare("SELECT mission_id FROM engineering_waits WHERE item_id=?").get(itemId) as { mission_id: string } | undefined;
    if (existing) {
      if (existing.mission_id !== mission.mission_id) throw Error("authority_already_adopted");
      return;
    }
    const item = this.attention.projectDecision(this.owner, { scopeId: mission.scope_id, sessionId: mission.session_id, turnId: snapshot.turn_id, sourceVersion: snapshot.version, decision, now });
    const prior = this.db.prepare("SELECT mission_id FROM engineering_waits WHERE item_id=?").get(item.item_id) as { mission_id: string } | undefined;
    if (prior && prior.mission_id !== mission.mission_id) throw Error("authority_already_adopted");
    if (prior) return;
    if ((this.db.prepare("SELECT COUNT(*) n FROM engineering_waits WHERE mission_id=?").get(mission.mission_id) as { n: number }).n >= 64) throw Error("budget_exhausted");
    const waitId = randomUUID();
    this.db.prepare("INSERT INTO engineering_waits VALUES(?,?,?,1,?,'open',NULL,NULL,NULL,0,?,?)").run(waitId, mission.mission_id, item.item_id, JSON.stringify(this.ref(item)), now, now);
    this.event(mission.mission_id, "decision_observed", null, { wait_id: waitId, decision_ref: this.ref(item) }, now);
  }
  private waits(missionId: string): WaitRow[] { return this.db.prepare("SELECT * FROM engineering_waits WHERE mission_id=? ORDER BY created_at,wait_id LIMIT 100").all(missionId) as WaitRow[]; }
  private wait(missionId: string, waitId: string): WaitRow {
    const wait = this.db.prepare("SELECT * FROM engineering_waits WHERE mission_id=? AND wait_id=?").get(missionId, waitId) as WaitRow | undefined;
    if (!wait) throw Error("not_found"); return wait;
  }
  private setWait(wait: WaitRow, state: WaitRow["state"], now: number): void {
    if (wait.state !== state) this.db.prepare("UPDATE engineering_waits SET state=?,revision=revision+1,updated_at=? WHERE wait_id=?").run(state, now, wait.wait_id);
  }
  adopt(principal: EngineeringPrincipal, value: EngineeringAdoptRequest, now = Date.now()) {
    const input = EngineeringAdoptRequest.parse(value); this.clock(now);
    this.access(principal, input.scope_id, "read");
    return this.write(() => {
      const prior = this.request(principal, input.request_id, "adopt", input);
      if (prior) return { mission: this.readable(principal, prior.mission_id), replay: true };
      this.access(principal, input.scope_id, "write");
      const sessions = new SessionRepository(this.db, this.attention.path); const session = sessions.getSession(input.session_id);
      if (!session || !session.resume_supported || !session.native_session_id) throw Error("executor_not_qualified");
      const scope = this.attention.getScope(input.scope_id);
      if (!scope || scope.task_id !== input.task_id) throw Error("scope_mismatch");
      const mission: EngineeringMission = { mission_id: randomUUID(), scope_id: input.scope_id, task_id: input.task_id, run_id: input.run_id, session_id: input.session_id,
        repo_path: scope.repo_path, source_instance_id: engineeringSourceIdentity(session.session_id, session.native_session_id), source_generation: 1,
        owner_principal_id: principal.principal_id, owner_client_session_id: principal.client_session_id, goal: input.goal, completion_level: "observed_turn", state: "awaiting_decision", revision: 1,
        stop_intent_id: null, created_at: now, updated_at: now, observed_at: now, policy_digest: POLICY_DIGEST, observation_proof_json: null };
      const { snapshot } = this.source(mission);
      if (snapshot.state !== "awaiting_decision") throw Error("session_not_awaiting_decision");
      this.ordinaryDecision(snapshot.decision);
      if (this.db.prepare("SELECT 1 FROM engineering_missions WHERE session_id=? AND state NOT IN ('completed','failed','cancel_requested','observation_ended')").get(input.session_id)) throw Error("source_already_adopted");
      if ((this.db.prepare("SELECT COUNT(*) n FROM engineering_missions").get() as { n: number }).n >= 1000) throw Error("budget_exhausted");
      this.db.prepare(`INSERT INTO engineering_missions VALUES(@mission_id,@scope_id,@task_id,@run_id,@session_id,@repo_path,@source_instance_id,@source_generation,@owner_principal_id,@owner_client_session_id,@goal,@completion_level,@state,@revision,@stop_intent_id,@created_at,@updated_at,@observed_at,@policy_digest,@observation_proof_json)`).run(mission);
      this.addWait(mission, snapshot, now); this.event(mission.mission_id, "session_adopted", principal.principal_id, { session_id: mission.session_id, source_instance_id: mission.source_instance_id, completion_level: "observed_turn" }, now);
      this.saveRequest(principal, input.request_id, "adopt", input, mission.mission_id, {}, now);
      return { mission, replay: false };
    });
  }
  observe(principal: EngineeringPrincipal, value: EngineeringObserveRequest, now = Date.now()) {
    const input = EngineeringObserveRequest.parse(value); this.clock(now);
    const readable = this.readable(principal, input.mission_id);
    return this.attention.write(this.owner, () => {
      const sourceStatus = this.refresh(readable.mission_id, now);
      const mission = this.getMission(input.mission_id);
      let snapshot: SessionSnapshot | null = null;
      const sessions = new SessionRepository(this.db, this.attention.path);
      if (sourceStatus !== "unavailable" && sessions.getSession(mission.session_id)) snapshot = sessions.latestSnapshot(mission.session_id);
      const waits = this.waits(mission.mission_id).map((wait): EngineeringWait => {
        const { decision_ref_json, ...rest } = wait;
        const decision_ref = JSON.parse(decision_ref_json) as EngineeringDecisionRef;
        const item = this.attention.getItem(mission.scope_id, wait.item_id);
        if (!item) throw Error("source_unavailable");
        const result: EngineeringWait = { ...rest, decision_ref, decision: item.decision };
        if (!terminal.has(mission.state) && ["open", "deferred"].includes(wait.state) && principal.principal_id === mission.owner_principal_id && principal.write_scopes.includes(mission.scope_id)) {
          const token = randomBytes(32).toString("base64url"); const expires = now + 5 * 60_000;
          this.db.prepare("DELETE FROM engineering_interactions WHERE expires_at<?").run(now);
          this.db.prepare("DELETE FROM engineering_interactions WHERE mission_id=? AND rowid IN (SELECT rowid FROM engineering_interactions WHERE mission_id=? ORDER BY issued_at DESC,rowid DESC LIMIT -1 OFFSET 31)").run(mission.mission_id, mission.mission_id);
          this.db.prepare("INSERT INTO engineering_interactions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(attentionDigest(token), principal.principal_id, principal.client_session_id, mission.mission_id, mission.revision, wait.wait_id, item.item_id, decision_ref.item_revision, decision_ref.content_hash, now, expires);
          result.interaction_token = token; result.token_expires_at = expires;
        }
        return result;
      });
      const limit = input.limit ?? 50; const rows = this.db.prepare("SELECT seq,kind,actor,payload_json,created_at FROM engineering_events WHERE mission_id=? AND seq>? ORDER BY seq LIMIT ?").all(mission.mission_id, input.cursor ?? 0, limit + 1) as Array<{ seq: number; kind: string; actor: string | null; payload_json: string; created_at: number }>;
      const events = rows.slice(0, limit).map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(payload_json) as unknown }));
      return { mission, waits, events, cursor: events.at(-1)?.seq ?? input.cursor ?? 0, has_more: rows.length > limit, source_status: sourceStatus,
        cost_evidence: { status: "unknown" as const, hard_cap_enforced: false as const, reason: "provider_usage_not_metered_by_adoption_pilot" as const },
        snapshot_digest: snapshot ? attentionDigest(snapshot) : null, source_version: snapshot?.version ?? null, turn_id: snapshot?.turn_id ?? null,
        observation_proof: mission.observation_proof_json ? JSON.parse(mission.observation_proof_json) as EngineeringObservationProof : null };
    });
  }
  decide(principal: EngineeringPrincipal, value: EngineeringDecideRequest, now = Date.now()): EngineeringActionReceipt {
    const input = EngineeringDecideRequest.parse(value); this.clock(now); this.readable(principal, input.mission_id);
    return this.write(() => {
      let mission = this.readable(principal, input.mission_id);
      const prior = this.request(principal, input.action_id, "decide", input);
      if (prior) return this.receipt(mission, input.action_id, true);
      this.steer(principal, mission); this.cas(mission, input.if_revision); this.controlBudget(mission.mission_id);
      const wait = this.wait(mission.mission_id, input.wait_id);
      if (!["open", "deferred"].includes(wait.state) || wait.action_id) throw Error("stale_decision");
      const ref = JSON.parse(wait.decision_ref_json) as EngineeringDecisionRef;
      if (attentionDigest(ref) !== attentionDigest(input.decision_ref)) throw Error("stale_decision");
      const token = this.db.prepare("SELECT * FROM engineering_interactions WHERE token_hash=?").get(attentionDigest(input.interaction_token)) as TokenRow | undefined;
      if (!token || token.principal_id !== principal.principal_id || token.client_session_id !== principal.client_session_id || token.mission_id !== mission.mission_id
        || token.mission_revision !== input.if_revision || token.wait_id !== wait.wait_id || token.item_id !== ref.item_id || token.item_revision !== ref.item_revision || token.content_hash !== ref.content_hash) throw Error("interaction_mismatch");
      if (now < token.issued_at || now > token.expires_at) throw Error("interaction_expired");
      const { session, snapshot } = this.source(mission);
      if (session.version !== ref.source_version || snapshot.turn_id !== ref.turn_id || attentionDigest(SessionDecision.parse(snapshot.decision)) !== ref.content_hash) throw Error("stale_decision");
      const decision = this.ordinaryDecision(snapshot.decision);
      let text: string;
      if (input.answer.kind === "choice") {
        const choiceId = input.answer.choice_id; const choice = decision.choices.find(c => c.choice_id === choiceId);
        if (!choice) throw Error("invalid_choice"); text = choice.label;
      } else {
        if (decision.choices.length > 0 || (decision.continuation && decision.continuation.gate_kind !== "external_input")) throw Error("explicit_choice_required");
        text = input.answer.text;
      }
      const reservation = new AttentionActions(this.attention, this.owner).reserve({ scope_id: mission.scope_id, item_id: ref.item_id, action_id: input.action_id, revision: ref.item_revision, content_hash: ref.content_hash, text, takeover: false }, now);
      if (reservation.replay || reservation.reservation_version !== ref.source_version + 1) throw Error("action_conflict");
      this.db.prepare(`INSERT INTO attention_dispatch_phases VALUES(?,?,?,?,?,1,'reserved',?,1,?,?,?,?,NULL,NULL,NULL,?,?)`).run(input.action_id, reservation.message_id, mission.mission_id, principal.principal_id, principal.client_session_id,
        mission.source_instance_id, ref.turn_id, ref.source_version, reservation.reservation_version, this.owner.generation, now, now);
      this.db.prepare("UPDATE engineering_waits SET state='answer_recorded',action_id=?,revision=revision+1,updated_at=? WHERE wait_id=?").run(input.action_id, now, wait.wait_id);
      this.event(mission.mission_id, "answer_recorded", principal.principal_id, { action_id: input.action_id, message_id: reservation.message_id, wait_id: wait.wait_id, decision_ref: ref, client_session_id: principal.client_session_id, interaction_token_hash: attentionDigest(input.interaction_token), payload_digest: attentionDigest(input.answer) }, now);
      mission = this.bump(mission.mission_id, "answer_recorded", now);
      this.saveRequest(principal, input.action_id, "decide", input, mission.mission_id, { action_id: input.action_id }, now);
      return { mission, action_id: input.action_id, message_id: reservation.message_id, state: "reserved", replay: false, reservation_version: reservation.reservation_version };
    });
  }
  private receipt(mission: EngineeringMission, actionId: string, replay: boolean): EngineeringActionReceipt {
    const action = this.db.prepare("SELECT a.* FROM attention_actions a JOIN engineering_waits w ON w.action_id=a.action_id WHERE a.action_id=? AND w.mission_id=?").get(actionId, mission.mission_id) as ActionRow | undefined;
    if (!action) throw Error("not_found");
    const phase = this.getDispatch(action.message_id);
    const message = new SessionRepository(this.db, this.attention.path).getMessage(action.message_id);
    const resolved = this.db.prepare("SELECT 1 FROM attention_receipt_resolutions WHERE message_id=?").get(action.message_id);
    const state = phase?.phase === "cancelled_before_dispatch"
      ? isEngineeringCancelledBeforeDispatch(this.db, action.message_id) ? "cancelled_before_dispatch" : "needs_reconciliation"
      : resolved ? "abandoned_unknown"
      : phase?.phase === "reserved" ? action.state === "reserved" && message?.state === "accepted" ? "reserved" : "needs_reconciliation"
      : message?.state === "applied" ? "applied"
      : phase?.phase === "dispatch_committed" && message?.state === "accepted" && this.liveMessage(mission.session_id, action.message_id) ? "in_flight" : "uncertain";
    return { mission, action_id: actionId, message_id: action.message_id, state, replay, reservation_version: phase?.reservation_version ?? 0 };
  }
  commitDispatch(actionId: string, principal: EngineeringPrincipal, now = Date.now()) {
    this.clock(now);
    return this.write(() => {
      const prepared = this.preflightDispatch(actionId, principal);
      const changed = this.db.prepare("UPDATE attention_dispatch_phases SET phase='dispatch_committed',committed_by_generation=?,updated_at=? WHERE action_id=? AND phase='reserved'").run(this.owner.generation, now, actionId);
      if (changed.changes !== 1) throw Error("dispatch_already_committed");
      const phase = this.getDispatch(prepared.message_id)!;
      this.event(phase.mission_id, "dispatch_committed", principal.principal_id, { action_id: actionId, message_id: prepared.message_id, daemon_generation: this.owner.generation }, now);
      const permit: EngineeringDispatchPermit = Object.freeze({ message_id: prepared.message_id, daemon_generation: this.owner.generation }); this.permits.add(permit);
      return { permit, ...prepared };
    });
  }
  /** Cheap read-only qualification before asynchronous admission. commitDispatch
   * repeats every predicate inside the owner-fenced FULL write transaction. */
  preflightDispatch(actionId: string, principal: EngineeringPrincipal) {
      this.attention.assertOwner(this.owner);
      if (this.db.pragma("synchronous", { simple: true }) !== 2) throw Error("durability_required");
      const phase = this.db.prepare("SELECT * FROM attention_dispatch_phases WHERE action_id=?").get(actionId) as ReturnType<EngineeringStore["getDispatch"]>;
      if (!phase) throw Error("dispatch_gate_required");
      const mission = this.readable(principal, phase.mission_id); this.steer(principal, mission);
      if (phase.principal_id !== principal.principal_id || phase.client_session_id !== principal.client_session_id) throw Error("permission_denied");
      if (phase.phase !== "reserved") throw Error(phase.phase === "dispatch_committed" ? "dispatch_already_committed" : "cancelled_original_answer");
      if (terminal.has(mission.state) || mission.stop_intent_id) throw Error("cancelled_original_answer");
      if (mission.policy_digest !== POLICY_DIGEST) throw Error("policy_changed");
      const { session, snapshot } = this.source(mission);
      const action = this.db.prepare("SELECT * FROM attention_actions WHERE action_id=?").get(actionId) as ActionRow | undefined;
      const message = new SessionRepository(this.db, this.attention.path).getMessage(phase.message_id);
      const wait = this.db.prepare("SELECT * FROM engineering_waits WHERE action_id=? AND mission_id=?").get(actionId, mission.mission_id) as WaitRow | undefined;
      if (!action || action.state !== "reserved" || action.scope_id !== mission.scope_id || action.message_id !== phase.message_id || !message || message.state !== "accepted"
        || message.session_id !== mission.session_id || message.turn_id !== phase.original_turn_id || !wait || wait.state !== "answer_recorded" || wait.item_id !== action.item_id
        || phase.protocol_version !== 1 || phase.source_instance_id !== mission.source_instance_id || phase.source_generation !== mission.source_generation
        || session.version !== phase.reservation_version || snapshot.turn_id !== phase.original_turn_id || snapshot.state !== "awaiting_decision") throw Error("needs_reconciliation");
      if (this.db.prepare("SELECT 1 FROM attention_receipt_resolutions WHERE message_id=?").get(phase.message_id)) throw Error("receipt_resolved");
      const ref = JSON.parse(wait.decision_ref_json) as EngineeringDecisionRef;
      const decision = this.ordinaryDecision(snapshot.decision);
      if (attentionDigest(decision) !== ref.content_hash || ref.source_version !== phase.source_version) throw Error("source_changed");
      const payload = JSON.parse(message.payload_json) as { text?: unknown };
      if (typeof payload.text !== "string" || action.payload_hash !== attentionDigest({ scope_id: mission.scope_id, item_id: ref.item_id, action_id: actionId, revision: ref.item_revision, content_hash: ref.content_hash, text: payload.text, takeover: false })) throw Error("payload_changed");
      return { session_id: mission.session_id, message_id: message.message_id, turn_id: phase.original_turn_id, reservation_version: phase.reservation_version, text: payload.text, action_id: actionId };
  }
  recordDispatchBlocked(actionId: string, reason: string, now = Date.now()): void {
    if (!/^[a-z_]{1,64}$/.test(reason)) throw Error("invalid_block_reason");
    this.write(() => {
      const phase = this.db.prepare("SELECT * FROM attention_dispatch_phases WHERE action_id=?").get(actionId) as ReturnType<EngineeringStore["getDispatch"]>;
      if (!phase || phase.phase !== "reserved") return;
      const count = this.db.prepare("SELECT COUNT(*) n FROM engineering_events WHERE mission_id=? AND kind='dispatch_blocked' AND json_extract(payload_json,'$.action_id')=?").get(phase.mission_id, actionId) as { n: number };
      if (count.n >= 16 || this.db.prepare("SELECT 1 FROM engineering_events WHERE mission_id=? AND kind='dispatch_blocked' AND json_extract(payload_json,'$.action_id')=? AND json_extract(payload_json,'$.reason')=?").get(phase.mission_id, actionId, reason)) return;
      this.event(phase.mission_id, "dispatch_blocked", null, { action_id: actionId, reason }, now);
    });
  }
  consumeDispatchPermit(permit: EngineeringDispatchPermit | undefined, messageId: string): void {
    this.attention.assertOwner(this.owner);
    if (!permit || permit.message_id !== messageId || permit.daemon_generation !== this.owner.generation || !this.permits.delete(permit)) throw Error("dispatch_gate_required");
  }
  defer(principal: EngineeringPrincipal, value: EngineeringDeferRequest, now = Date.now()) {
    const input = EngineeringDeferRequest.parse(value); this.clock(now); this.readable(principal, input.mission_id);
    return this.write(() => {
      const mission = this.readable(principal, input.mission_id);
      if (this.request(principal, input.request_id, "defer", input)) return { mission, replay: true };
      this.steer(principal, mission); this.cas(mission, input.if_revision); this.controlBudget(mission.mission_id);
      const { snapshot } = this.source(mission);
      const wait = this.wait(mission.mission_id, input.wait_id); const revisit = Date.parse(input.revisit_at);
      if (wait.revision !== input.wait_revision || !["open", "deferred"].includes(wait.state) || wait.action_id) throw Error("stale_decision");
      const ref = JSON.parse(wait.decision_ref_json) as EngineeringDecisionRef;
      if (snapshot.turn_id !== ref.turn_id || snapshot.version !== ref.source_version || attentionDigest(SessionDecision.parse(snapshot.decision)) !== ref.content_hash) throw Error("stale_decision");
      if (revisit <= now || revisit > now + 7 * 86400_000) throw Error("invalid_revisit_at");
      this.db.prepare("UPDATE engineering_waits SET state='deferred',revision=revision+1,revisit_at=?,reason=?,reminder_sent=0,updated_at=? WHERE wait_id=?").run(revisit, input.reason, now, wait.wait_id);
      this.event(mission.mission_id, "decision_deferred", principal.principal_id, { wait_id: wait.wait_id, revisit_at: input.revisit_at, reason: input.reason }, now);
      const updated = this.bump(mission.mission_id, mission.state, now); this.saveRequest(principal, input.request_id, "defer", input, mission.mission_id, {}, now);
      return { mission: updated, replay: false };
    });
  }
  cancel(principal: EngineeringPrincipal, value: EngineeringCancelRequest, now = Date.now()): EngineeringStopResult { return this.end(principal, EngineeringCancelRequest.parse(value), false, now); }
  endObservation(principal: EngineeringPrincipal, value: EngineeringEndObservationRequest, now = Date.now()): EngineeringStopResult { return this.end(principal, EngineeringEndObservationRequest.parse(value), true, now); }
  private end(principal: EngineeringPrincipal, input: EngineeringCancelRequest, observationOnly: boolean, now: number): EngineeringStopResult {
    this.clock(now); this.readable(principal, input.mission_id);
    return this.write(() => {
      const mission = this.readable(principal, input.mission_id); const operation = observationOnly ? "endObservation" : "cancel";
      const prior = this.request(principal, input.request_id, operation, input);
      if (prior) return { ...(JSON.parse(prior.response_json) as EngineeringStopResult), mission, replay: true };
      const isOwner = mission.owner_principal_id === principal.principal_id;
      if (observationOnly) {
        if (!isOwner) { this.access(principal, mission.scope_id, "operator"); this.access(principal, mission.scope_id, "stop"); }
      } else {
        this.access(principal, mission.scope_id, "stop");
        if (!isOwner) this.access(principal, mission.scope_id, "operator");
      }
      if (mission.revision !== input.if_revision) throw Error("version_conflict");
      const phases = this.db.prepare("SELECT * FROM attention_dispatch_phases WHERE mission_id=?").all(mission.mission_id) as NonNullable<ReturnType<EngineeringStore["getDispatch"]>>[];
      const committedIds = phases.filter(phase => phase.phase === "dispatch_committed"
        && new SessionRepository(this.db, this.attention.path).getMessage(phase.message_id)?.state !== "applied").map(phase => phase.message_id);
      if (mission.state === "completed" || mission.state === "failed") throw Error("mission_terminal");
      if (terminal.has(mission.state) && (observationOnly || committedIds.length === 0)) throw Error("mission_terminal");
      // Retain the first durable intent. A bounded later attempt may request stop
      // only for this Mission's unresolved committed messages, never a later send.
      const stopAttempts = (this.db.prepare("SELECT COUNT(*) n FROM engineering_requests WHERE mission_id=? AND operation='cancel'").get(mission.mission_id) as { n: number }).n;
      if (!observationOnly && stopAttempts >= 8) throw Error("stop_attempt_budget_exhausted");
      const intent = mission.stop_intent_id ?? randomUUID();
      const kind = observationOnly ? "observation_ended" : stopAttempts > 0 ? "stop_retry_requested" : "stop_requested";
      const eventSeq = this.event(mission.mission_id, kind, principal.principal_id, { stop_intent_id: intent, request_id: input.request_id, run_id: mission.run_id, session_id: mission.session_id, action_ids: phases.map(p => p.action_id), owner_generation: this.owner.generation, reason: input.reason ?? null }, now);
      if (mission.stop_intent_id === null) this.db.prepare("UPDATE engineering_missions SET stop_intent_id=? WHERE mission_id=?").run(intent, mission.mission_id);
      for (const phase of phases) {
        if (phase.phase !== "reserved") continue;
        const action = this.db.prepare("SELECT state,message_id FROM attention_actions WHERE action_id=?").get(phase.action_id) as { state: string; message_id: string } | undefined;
        const message = new SessionRepository(this.db, this.attention.path).getMessage(phase.message_id);
        if (!action || action.state !== "reserved" || action.message_id !== phase.message_id || message?.state !== "accepted" || message.session_id !== mission.session_id
          || this.db.prepare("SELECT 1 FROM attention_receipt_resolutions WHERE message_id=?").get(phase.message_id)) continue;
        const proof = { version: 1, prior_phase: "reserved", action_id: phase.action_id, message_id: phase.message_id, stop_intent_id: intent, event_seq: eventSeq, owner_generation: this.owner.generation };
        this.db.prepare("UPDATE attention_dispatch_phases SET phase='cancelled_before_dispatch',stop_intent_id=?,proof_json=?,updated_at=? WHERE action_id=? AND phase='reserved'").run(intent, JSON.stringify(proof), now, phase.action_id);
        this.db.prepare("UPDATE attention_actions SET state='cancelled_before_dispatch',updated_at=? WHERE action_id=?").run(now, phase.action_id);
        this.db.prepare("UPDATE attention_items SET state='answer_cancelled',revision=revision+1,updated_at=? WHERE item_id IN (SELECT item_id FROM attention_actions WHERE action_id=?)").run(now, phase.action_id);
        this.db.prepare("UPDATE engineering_waits SET state='cancelled_before_dispatch',revision=revision+1,updated_at=? WHERE action_id=?").run(now, phase.action_id);
      }
      const updated = this.bump(mission.mission_id, observationOnly ? "observation_ended" : "cancel_requested", now);
      const result: EngineeringStopResult = { mission: updated, replay: false, stop_intent_id: intent, run_id: mission.run_id, session_id: mission.session_id, action_ids: phases.map(p => p.action_id), committed_message_ids: committedIds };
      this.saveRequest(principal, input.request_id, operation, input, mission.mission_id, result, now); return result;
    });
  }
  recordStopReceipt(missionId: string, intentId: string, status: "stop_requested" | "stop_unknown", evidence: unknown, now = Date.now()): void {
    this.write(() => {
      const mission = this.getMission(missionId);
      if (mission.stop_intent_id !== intentId) throw Error("stop_intent_changed");
      const kind = status === "stop_unknown" ? "stop_unknown" : "stop_request_acknowledged";
      const payload = { stop_intent_id: intentId, evidence };
      if (!this.db.prepare("SELECT 1 FROM engineering_events WHERE mission_id=? AND kind=? AND payload_json=?").get(missionId, kind, JSON.stringify(payload))) this.event(missionId, kind, null, payload, now);
    });
  }
  reconcile(principal: EngineeringPrincipal, value: EngineeringReconcileRequest, now = Date.now()) {
    const input = EngineeringReconcileRequest.parse(value); this.clock(now); const initial = this.readable(principal, input.mission_id);
    if (input.kind === "query_action") return this.attention.write(this.owner, () => this.receipt(initial, input.action_id, true));
    return this.write(() => {
      const mission = this.readable(principal, input.mission_id);
      if (this.request(principal, input.request_id, "dispose_wait", input)) return { mission, replay: true };
      this.steer(principal, mission); this.cas(mission, input.if_revision); this.controlBudget(mission.mission_id);
      const wait = this.wait(mission.mission_id, input.wait_id);
      if (wait.revision !== input.wait_revision || wait.action_id || cleared.has(wait.state)) throw Error("receipt_requires_reconciliation");
      if (this.db.prepare("SELECT 1 FROM attention_actions WHERE item_id=?").get(wait.item_id)) throw Error("receipt_requires_reconciliation");
      const { snapshot } = this.source(mission);
      if (snapshot.version !== input.observed_source_version || snapshot.turn_id !== input.observed_turn_id || attentionDigest(snapshot) !== input.observed_snapshot_digest) throw Error("source_changed");
      const item = this.attention.getItem(mission.scope_id, wait.item_id); if (!item) throw Error("source_unavailable"); this.ordinaryDecision(item.decision);
      this.setWait(wait, "superseded", now);
      this.event(mission.mission_id, "steering_recorded", principal.principal_id, { wait_id: wait.wait_id, disposition: input.disposition, observed_snapshot_digest: input.observed_snapshot_digest, reason: input.reason, delivery_verified: false }, now);
      const updated = this.bump(mission.mission_id, "observing", now); this.saveRequest(principal, input.request_id, "dispose_wait", input, mission.mission_id, {}, now);
      return { mission: updated, replay: false };
    });
  }
  /** Must be called from the same transaction that marks the original message
   * applied and writes its new Session turn. Do not access the repository here:
   * refresh observes it later before projecting Mission completion. */
  recordCompletion(messageId: string, completedTurnId: string, sessionVersion: number, now = Date.now()): void {
    if (!this.db.inTransaction) throw Error("completion_transaction_required");
    this.attention.assertOwner(this.owner);
    const phase = this.getDispatch(messageId); if (!phase) return;
    if (phase.phase !== "dispatch_committed") throw Error("dispatch_inconsistent");
    const mission = this.getMission(phase.mission_id); const { snapshot } = this.databaseSource(mission);
    if (phase.source_instance_id !== mission.source_instance_id || phase.source_generation !== mission.source_generation) throw Error("source_changed");
    const message = new SessionRepository(this.db, this.attention.path).getMessage(messageId);
    if (message?.state !== "applied" || message.session_id !== mission.session_id || snapshot.turn_id !== completedTurnId || snapshot.version !== sessionVersion || sessionVersion !== phase.reservation_version + 1) throw Error("completion_mismatch");
    const proof: EngineeringObservationProof = { kind: "observed_turn", action_id: phase.action_id, message_id: messageId, source_instance_id: phase.source_instance_id, source_generation: phase.source_generation, completed_turn_id: completedTurnId, session_version: sessionVersion, output_sha256: attentionDigest(snapshot.assistant_text) };
    const prior = this.db.prepare("SELECT proof_json FROM engineering_completions WHERE action_id=?").get(phase.action_id) as { proof_json: string } | undefined;
    if (prior && prior.proof_json !== JSON.stringify(proof)) throw Error("completion_mismatch");
    if (!prior) {
      this.db.prepare("INSERT INTO engineering_completions VALUES(?,?,?,?,?,?,?)").run(phase.action_id, messageId, mission.mission_id, completedTurnId, sessionVersion, JSON.stringify(proof), now);
      this.event(mission.mission_id, "answer_applied", null, proof, now);
    }
    this.db.prepare("UPDATE attention_actions SET state='applied',updated_at=? WHERE action_id=? AND message_id=? AND state<>'applied'").run(now, phase.action_id, messageId);
    this.db.prepare("UPDATE attention_items SET state='answer_applied',revision=revision+1,updated_at=? WHERE item_id IN (SELECT item_id FROM attention_actions WHERE action_id=? AND message_id=?) AND state<>'answer_applied'").run(now, phase.action_id, messageId);
  }
  /** Deterministic bounded projection; empty polls neither invoke a model nor
   * increment the Mission's intent revision. */
  refresh(missionId: string, now = Date.now()): SourceStatus {
    this.clock(now);
    return this.attention.write(this.owner, () => {
      let mission = this.getMission(missionId); if (terminal.has(mission.state)) return "not_observing";
      let snapshot: SessionSnapshot;
      try { snapshot = this.source(mission).snapshot; }
      catch (error) {
        if (!(error instanceof EngineeringSourceFault)) throw error;
        this.sourceIssue(missionId, error.reason, error.category, now);
        if (error.category === "unavailable") return "unavailable";
        for (const wait of this.waits(missionId)) if (!cleared.has(wait.state)) this.setWait(wait, "needs_reconciliation", now);
        if (mission.state !== "needs_reconciliation") this.bump(missionId, "needs_reconciliation", now); return "identity_mismatch";
      }
      let uncertain = false;
      for (const wait of this.waits(missionId)) {
        if (cleared.has(wait.state)) continue;
        if (wait.state === "needs_reconciliation") { uncertain = true; continue; }
        if (wait.state === "deferred" && wait.revisit_at !== null && now >= wait.revisit_at && now >= wait.updated_at && wait.reminder_sent === 0) {
          this.db.prepare("UPDATE engineering_waits SET reminder_sent=1 WHERE wait_id=? AND reminder_sent=0").run(wait.wait_id);
          this.event(missionId, "decision_reminder_due", null, { wait_id: wait.wait_id, revisit_at: wait.revisit_at, reminder_budget: 1 }, now);
        }
        if (wait.action_id) {
          const action = this.db.prepare("SELECT * FROM attention_actions WHERE action_id=?").get(wait.action_id) as ActionRow | undefined;
          if (!action) { this.setWait(wait, "needs_reconciliation", now); uncertain = true; continue; }
          const phase = this.getDispatch(action.message_id); const completion = this.db.prepare("SELECT proof_json FROM engineering_completions WHERE action_id=?").get(wait.action_id) as { proof_json: string } | undefined;
          if (completion && new SessionRepository(this.db, this.attention.path).getMessage(action.message_id)?.state === "applied") { this.setWait(wait, "cleared", now); continue; }
          if (phase?.phase === "cancelled_before_dispatch" && isEngineeringCancelledBeforeDispatch(this.db, action.message_id)) { this.setWait(wait, "cancelled_before_dispatch", now); continue; }
          if (phase?.phase === "dispatch_committed" && new SessionRepository(this.db, this.attention.path).getMessage(action.message_id)?.state === "accepted" && this.liveMessage(mission.session_id, action.message_id)) {
            this.setWait(wait, "answer_recorded", now); continue;
          }
          const receipt = new AttentionActions(this.attention, this.owner).reconcile(action, now);
          if (receipt.state === "reserved") continue;
          this.setWait(wait, "delivery_unknown", now); uncertain = true;
        } else {
          const ref = JSON.parse(wait.decision_ref_json) as EngineeringDecisionRef;
          const parsed = SessionDecision.safeParse(snapshot.decision);
          if (snapshot.turn_id !== ref.turn_id || snapshot.version !== ref.source_version || !parsed.success || attentionDigest(parsed.data) !== ref.content_hash) {
            this.setWait(wait, "needs_reconciliation", now); uncertain = true; this.sourceIssue(missionId, "decision_source_changed", "decision", now);
          }
        }
      }
      if (snapshot.state === "awaiting_decision" && snapshot.decision) {
        try { this.addWait(mission, snapshot, now); }
        catch (error) {
          const reason = error instanceof Error && error.name === "ZodError" ? "invalid_decision" : error instanceof Error ? error.message : "";
          if (!["signed_approval_required", "executor_not_qualified", "decision_content_conflict", "authority_already_adopted", "budget_exhausted", "source_unavailable", "invalid_decision"].includes(reason)) throw error;
          uncertain = true; this.sourceIssue(missionId, reason, "decision", now);
        }
      }
      const waits = this.waits(missionId); const unclosed = waits.some(wait => !cleared.has(wait.state));
      const completion = this.db.prepare("SELECT proof_json FROM engineering_completions WHERE mission_id=? AND completed_turn_id=? AND session_version=?").get(missionId, snapshot.turn_id, snapshot.version) as { proof_json: string } | undefined;
      if (!uncertain && !unclosed && !mission.stop_intent_id && completion && snapshot.decision === null && ["idle", "completed"].includes(snapshot.state)) {
        this.db.prepare("UPDATE engineering_missions SET observation_proof_json=? WHERE mission_id=?").run(completion.proof_json, missionId);
        mission = this.bump(missionId, "completed", now); this.event(missionId, "observation_completed", null, JSON.parse(completion.proof_json), now);
      } else {
        const state = uncertain ? "needs_reconciliation" : waits.some(w => ["open", "deferred"].includes(w.state)) ? "awaiting_decision" : waits.some(w => w.state === "answer_recorded") ? "answer_recorded" : "observing";
        if (mission.state !== state) this.bump(missionId, state, now);
      }
      // FULL durability applies to the shared connection. Empty one-second
      // watchdog ticks must not issue a persistent heartbeat every time.
      if (now >= mission.observed_at + 60_000) this.db.prepare("UPDATE engineering_missions SET observed_at=? WHERE mission_id=?").run(now, missionId);
      return "available";
    });
  }
}
