import { isEngineeringCancelledBeforeDispatch, type EngineeringStore, type SessionRepository } from "@osstack/core";
import { EngineeringRpcRequests } from "@osstack/protocol";
import type { EngineeringAccess } from "./engineering-access.js";
import type { ExecutionLease } from "./governed-execution.js";

type Session = NonNullable<ReturnType<SessionRepository["getSession"]>>;
type Dispatch = ReturnType<EngineeringStore["commitDispatch"]>;
type Admission = { lease: ExecutionLease; controller: AbortController; release(): Promise<void> };
export interface EngineeringHostPorts {
  getSession(id: string): Session | undefined;
  qualified(session: Session): boolean;
  draining(): boolean;
  active(sessionId: string): boolean;
  acquire(session: Session, messageId: string): Promise<Admission>;
  execute(dispatch: Dispatch, session: Session, admission: Admission): Promise<void>;
  stop(input: { runId: string; sessionId: string; messageIds: readonly string[] }): boolean;
}

/** No second sender/outbox. This host only drives first dispatch of the existing receipt. */
export class EngineeringHost {
  private readonly pending = new Map<string, Promise<void>>();
  private closed = false;
  private readonly blocked = new Map<string, { attempts: number; nextAt: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursor: { created_at: number; action_id: string } | undefined;
  private missionCursor: { created_at: number; mission_id: string } | undefined;
  constructor(readonly store: EngineeringStore, readonly access: EngineeringAccess, private readonly ports: EngineeringHostPorts) {}

  async handle(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error("engineering_unavailable");
    if (!(method in EngineeringRpcRequests)) throw new Error("unknown_method");
    const schema = EngineeringRpcRequests[method as keyof typeof EngineeringRpcRequests];
    const parsed = schema.safeParse(params);
    if (!parsed.success) throw new Error("bad_request");
    const { credential, ...input } = parsed.data;
    const actor = this.access.authenticate(credential);
    // Reparse under the concrete schema below: the wire union cannot infer the method correlation.
    if (method === "engineering.adopt") {
      if (this.ports.draining()) throw new Error("draining");
      const p = EngineeringRpcRequests["engineering.adopt"].parse(params);
      if (!actor.read_scopes.includes(p.scope_id)) throw new Error("permission_denied");
      const scope = this.store.attention.getScope(p.scope_id);
      const session = this.ports.getSession(p.session_id);
      if (!scope || scope.task_id !== p.task_id || !session || session.task_id !== scope.task_id || session.run_id !== p.run_id) throw new Error("permission_denied");
      if (!this.ports.qualified(session)) throw new Error("executor_not_qualified");
      this.access.assertOutsideRepository(session.repo_path);
      const { credential: _credential, ...request } = p;
      return this.store.adopt(actor, request);
    }
    if (!("mission_id" in input)) throw new Error("bad_request");
    const mission = this.store.readableMission(actor, input.mission_id);
    this.access.assertOutsideCanonicalRepository(mission.repo_path);
    switch (method) {
      case "engineering.observe": {
        const { credential: _credential, ...p } = EngineeringRpcRequests[method].parse(params);
        return this.store.observe(actor, p);
      }
      case "engineering.decide": {
        const { credential: _credential, ...p } = EngineeringRpcRequests[method].parse(params);
        // Read-only receipt replay is allowed while drained or at capacity. The
        // domain still verifies actor/scope and the complete immutable payload.
        const replay = this.store.db.prepare("SELECT 1 FROM engineering_requests WHERE principal_id=? AND client_session_id=? AND request_id=? AND operation='decide'").get(actor.principal_id, actor.client_session_id, p.action_id);
        if (!replay && this.ports.draining()) throw new Error("draining");
        if (!replay && this.pending.size >= 16) throw new Error("engineering_busy");
        const result = this.store.decide(actor, p);
        if (!result.replay) {
          const phase = this.store.getDispatch(result.message_id);
          if (phase) this.schedule(phase.action_id);
        }
        return result;
      }
      case "engineering.defer": {
        const { credential: _credential, ...p } = EngineeringRpcRequests[method].parse(params);
        return this.store.defer(actor, p);
      }
      case "engineering.cancel": {
        const { credential: _credential, ...p } = EngineeringRpcRequests[method].parse(params);
        const result = this.store.cancel(actor, p);
        if (!result.replay) {
          const cancelledMessages = this.cancelledAdmissions(result.mission.mission_id, result.action_ids);
          const requested = this.ports.stop({ runId: result.run_id, sessionId: result.session_id,
            messageIds: [...result.committed_message_ids, ...cancelledMessages] });
          const provenUnstarted = result.committed_message_ids.length === 0 && cancelledMessages.length > 0
            && cancelledMessages.length === result.action_ids.length;
          // A queue reservation proven never dispatched needs no speculative
          // Worker-stop receipt. Preserve the exact non-dispatch evidence.
          if (!provenUnstarted) this.store.recordStopReceipt(result.mission.mission_id, result.stop_intent_id, "stop_unknown", {
            abort_requested: requested,
            reason: requested ? "abort is a request; containment exit is not proven" : "no live invocation in this daemon; prior worker exit is unknown",
          });
        }
        return result;
      }
      case "engineering.endObservation": {
        const { credential: _credential, ...p } = EngineeringRpcRequests[method].parse(params);
        const result = this.store.endObservation(actor, p);
        if (!result.replay) {
          // Ending observation may release only an original queue reservation
          // proven never dispatched. It must not stop a committed Worker.
          const messages = this.cancelledAdmissions(result.mission.mission_id, result.action_ids);
          if (messages.length) this.ports.stop({ runId: result.run_id, sessionId: result.session_id, messageIds: messages });
        }
        return result;
      }
      case "engineering.reconcile": {
        const { credential: _credential, ...p } = EngineeringRpcRequests[method].parse(params);
        return this.store.reconcile(actor, p);
      }
      default: throw new Error("unknown_method");
    }
  }

  private cancelledAdmissions(missionId: string, actionIds: readonly string[]): string[] {
    const messages: string[] = [];
    for (const actionId of actionIds) {
      const phase = this.store.db.prepare("SELECT message_id FROM attention_dispatch_phases WHERE mission_id=? AND action_id=? AND phase='cancelled_before_dispatch'").get(missionId, actionId) as { message_id: string } | undefined;
      if (phase && isEngineeringCancelledBeforeDispatch(this.store.db, phase.message_id)) messages.push(phase.message_id);
    }
    return messages;
  }
  /** No model polling. Bounded pages let a denied old action coexist with later work. */
  start(): void {
    if (this.closed || this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  private tick(): void {
    if (this.closed || this.ports.draining()) return;
    this.recover();
    try {
      const rows = this.store.listActiveMissions(16, this.missionCursor);
      for (const row of rows) {
        try { this.store.refresh(row.mission_id); } catch { /* Retain original source obligations. */ }
      }
      const last = rows.at(-1);
      this.missionCursor = rows.length === 16 && last ? { created_at: last.created_at, mission_id: last.mission_id } : undefined;
    } catch { /* Fencing failures cannot become observer or dispatch authority. */ }
  }
  /** Only persisted reserved phases are eligible, never committed/legacy. */
  recover(): void {
    if (this.closed || this.ports.draining()) return;
    try {
      const rows = this.store.listReserved(16, this.cursor);
      for (const row of rows) this.schedule(row.action_id);
      const last = rows.at(-1);
      this.cursor = rows.length === 16 && last ? { created_at: last.created_at, action_id: last.action_id } : undefined;
    } catch { /* A stale owner or unavailable database cannot authorize dispatch. */ }
  }
  private schedule(actionId: string): void {
    if (this.closed || this.ports.draining() || this.pending.has(actionId) || this.pending.size >= 16 || (this.blocked.get(actionId)?.nextAt ?? 0) > Date.now()) return;
    // Let the durable received response become observable before expensive admission.
    const pending = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.dispatch(actionId))
      .catch(error => {
        const reason = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "admission_denied";
        const attempts = Math.min((this.blocked.get(actionId)?.attempts ?? 0) + 1, 7);
        this.blocked.set(actionId, { attempts, nextAt: Date.now() + Math.min(60_000, 1000 * 2 ** (attempts - 1)) });
        // The durable store deduplicates each reason. A denied old owner must
        // neither spin on writer admission nor disappear behind a swallowed error.
        try { this.store.recordDispatchBlocked(actionId, reason); } catch { /* A stale owner cannot write diagnostics. */ }
      })
      .finally(() => this.pending.delete(actionId));
    this.pending.set(actionId, pending);
  }
  private async dispatch(actionId: string): Promise<void> {
    if (this.closed || this.ports.draining()) return;
    const row = this.store.getReserved(actionId);
    if (!row) { this.blocked.delete(actionId); return; }
    // Cheap read-only rejection comes before any health probe, semaphore or
    // repository writer lock. The final post-admission checks still run below.
    const preliminaryActor = this.access.refresh(row.owner_principal_id, row.client_session_id);
    this.store.preflightDispatch(actionId, preliminaryActor);
    const session = this.ports.getSession(row.session_id);
    if (!session || !this.ports.qualified(session)) throw new Error("executor_not_qualified");
    if (this.ports.active(session.session_id)) throw new Error("session_busy");
    this.access.assertOutsideRepository(session.repo_path);
    const admission = await this.ports.acquire(session, row.message_id);
    let handedOff = false;
    try {
      if (this.closed || this.ports.draining() || admission.controller.signal.aborted) return;
      // The latest authority is read after asynchronous admission, immediately before synchronous CAS.
      const actor = this.access.refresh(row.owner_principal_id, row.client_session_id);
      this.access.assertOutsideRepository(session.repo_path);
      const dispatch = this.store.commitDispatch(actionId, actor);
      this.blocked.delete(actionId);
      handedOff = true;
      // A pilot reply turn has a host-enforced five-minute wall-clock budget.
      // Abort requests cancellation; the existing helper retains admission if
      // actual adapter exit remains unproved.
      const deadline = setTimeout(() => admission.controller.abort(), 300_000);
      deadline.unref();
      try { await this.ports.execute(dispatch, session, admission); }
      finally { clearTimeout(deadline); }
    } finally { if (!handedOff) await admission.release(); }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.pending.values());
  }
}
