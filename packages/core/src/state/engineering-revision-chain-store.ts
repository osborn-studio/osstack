import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AttentionOwner, AttentionStore } from "./attention-store.js";
import type { ChainDecision, ChainMode, ChainState, ShadowAction } from "../bridge/revision-chain.js";
import { LIVE_STOP_REASONS, RENEWABLE_STOP_REASONS, grantBindsChain, parseStoredGrant, type RevisionGrant } from "../bridge/revision-grant.js";

export type ReservationState = "reserved" | "dispatched" | "void";
export type IntentKind = "push" | "open_pr" | "check";
export type IntentState = "pending" | "confirmed" | "failed" | "uncertain";

export interface RevisionChain {
  chain_id: string; mode: ChainMode; root_mission_id: string; current_mission_id: string | null;
  repository: string; pr_number: number; branch: string; base_ref: string;
  published_head: string; published_base: string; grant_json: string; rounds_used: number;
  state: ChainState; stop_reason: string | null; review_deadline: number | null;
  budget_json: string | null; spent_json: string | null; trace_id: string;
  revision: number; created_at: number; updated_at: number;
}
export interface RevisionChainEvent { seq: number; chain_id: string; kind: string; payload_json: string; created_at: number }
export interface RevisionReservation {
  repository: string; pr_number: number; head_sha: string; chain_id: string; review_ids_json: string; feedback_digest: string;
  child_mission_id: string | null; state: ReservationState; settled_reason: string | null; created_at: number; updated_at: number;
}
export interface PublicationIntent {
  intent_id: string; chain_id: string; kind: IntentKind; repository: string; pr_number: number; branch: string;
  expected_old_head: string | null; new_head: string | null; expected_base_sha: string | null; child_mission_id: string | null;
  binding_json: string; state: IntentState; detail: string | null; created_at: number; updated_at: number;
}
export interface ShadowDecisionRow {
  chain_id: string; head_sha: string; base_sha: string; action: ShadowAction; reason: string; review_ids_json: string;
  feedback_digest: string | null; observed_at: number; created_at: number;
}

export interface NewChainInput {
  root_mission_id: string; repository: string; pr_number: number; branch: string; base_ref: string;
  published_head: string; published_base: string; trace_id: string; review_deadline?: number | null;
}
export interface NewLiveChainInput extends NewChainInput {
  grant: { rounds: 1 | 2 } & Record<string, unknown>;
  /** Start of the chain's wall-clock budget (ms). Kept in `budget_json`, not in the replaceable grant. Defaults to the creation time. */
  budget_origin?: number;
}
export interface ReplaceGrantResult { chain: RevisionChain; /** The published head already has a reservation, so it will not be revised again (appendix §5.1). */ head_consumed: boolean }
export interface ReserveInput { head: string; review_ids: readonly number[]; feedback_digest: string }
export interface NewIntentInput {
  kind: IntentKind; branch: string; expected_old_head?: string; new_head?: string; expected_base_sha?: string;
  child_mission_id?: string; binding?: Record<string, unknown>;
}

/** Stable error codes: `message` is the code, like the contained-Mission store. */
export class RevisionChainError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RevisionChainError"; }
}
const fail = (code: string): never => { throw new RevisionChainError(code); };

const IN_FLIGHT: ReadonlySet<ChainState> = new Set(["revision_reserved", "revising", "publishing"]);

/** The only surface the shadow reconciler receives. No reservation, dispatch or intent method is reachable. */
export interface ShadowChainWriter {
  createShadowChain(input: NewChainInput, now: number): RevisionChain;
  applyShadowDecision(chainId: string, ifRevision: number, decision: ChainDecision, now: number): RevisionChain;
  appendEvent(chainId: string, kind: string, payload: unknown, now: number): number;
  get(chainId: string): RevisionChain;
  shadowDecisions(chainId: string): ShadowDecisionRow[];
  listOpenShadowChains(limit?: number, after?: { created_at: number; chain_id: string }): RevisionChain[];
  /** Read-only lookups for chain discovery: the shadow chain rooted at a Mission, and the one on a (repository, PR), in any state. */
  shadowChainForMission(rootMissionId: string): RevisionChain | undefined;
  shadowChainForPr(repository: string, prNumber: number): RevisionChain | undefined;
}
export function shadowChainWriter(store: RevisionChainStore): ShadowChainWriter {
  return {
    createShadowChain: (input, now) => store.createShadowChain(input, now),
    applyShadowDecision: (chainId, ifRevision, decision, now) => {
      if (decision.kind === "reserve") fail("bridge_shadow_write_denied");
      return store.applyDecision(chainId, ifRevision, decision, now);
    },
    appendEvent: (chainId, kind, payload, now) => store.appendEvent(chainId, kind, payload, now),
    get: chainId => store.get(chainId),
    shadowDecisions: chainId => store.shadowDecisions(chainId),
    listOpenShadowChains: (limit, after) => store.listOpen("shadow", limit, after),
    shadowChainForMission: rootMissionId => store.chainForMission(rootMissionId, "shadow"),
    shadowChainForPr: (repository, prNumber) => store.chainForPr(repository, prNumber, "shadow"),
  };
}

/** Ledger for revision chains. Synchronous; every write is one `BEGIN IMMEDIATE` transaction under the
 * daemon owner fence, and starts no process and makes no git or network call. */
export class RevisionChainStore {
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner) {}
  get db(): Database.Database { return this.attention.db; }

  get(chainId: string): RevisionChain {
    const row = this.db.prepare("SELECT * FROM engineering_revision_chains WHERE chain_id=?").get(chainId) as RevisionChain | undefined;
    return row ?? fail("not_found");
  }
  events(chainId: string, afterSeq = 0, limit = 100): RevisionChainEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail("invalid_limit");
    return this.db.prepare("SELECT * FROM engineering_revision_chain_events WHERE chain_id=? AND seq>? ORDER BY seq LIMIT ?").all(chainId, afterSeq, limit) as RevisionChainEvent[];
  }
  shadowDecisions(chainId: string): ShadowDecisionRow[] {
    return this.db.prepare("SELECT * FROM engineering_shadow_decisions WHERE chain_id=? ORDER BY created_at,head_sha,action").all(chainId) as ShadowDecisionRow[];
  }
  reservations(chainId: string): RevisionReservation[] {
    return this.db.prepare("SELECT * FROM engineering_revision_reservations WHERE chain_id=? ORDER BY created_at,head_sha").all(chainId) as RevisionReservation[];
  }
  intents(chainId: string): PublicationIntent[] {
    return this.db.prepare("SELECT * FROM engineering_publication_intents WHERE chain_id=? ORDER BY created_at,intent_id").all(chainId) as PublicationIntent[];
  }
  confirmedPushHeads(chainId: string): string[] {
    return (this.db.prepare("SELECT new_head FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state='confirmed' ORDER BY created_at,intent_id").all(chainId) as Array<{ new_head: string }>).map(r => r.new_head);
  }
  chainForMission(rootMissionId: string, mode: ChainMode = "shadow"): RevisionChain | undefined {
    return this.db.prepare("SELECT * FROM engineering_revision_chains WHERE root_mission_id=? AND mode=?").get(rootMissionId, mode) as RevisionChain | undefined;
  }
  chainForPr(repository: string, prNumber: number, mode: ChainMode = "shadow"): RevisionChain | undefined {
    return this.db.prepare("SELECT * FROM engineering_revision_chains WHERE repository=? AND pr_number=? AND mode=? ORDER BY created_at,chain_id LIMIT 1").get(repository, prNumber, mode) as RevisionChain | undefined;
  }
  /** Non-closed chains of one mode in (created_at, chain_id) order, for cursor scans. */
  listOpen(mode: ChainMode, limit = 100, after?: { created_at: number; chain_id: string }): RevisionChain[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit");
    return this.db.prepare(`SELECT * FROM engineering_revision_chains WHERE mode=? AND state NOT IN ('closed','awaiting_decision')
      AND (created_at>? OR (created_at=? AND chain_id>?)) ORDER BY created_at,chain_id LIMIT ?`)
      .all(mode, after?.created_at ?? -1, after?.created_at ?? -1, after?.chain_id ?? "", limit) as RevisionChain[];
  }

  createShadowChain(input: NewChainInput, now: number): RevisionChain {
    return this.create("shadow", input, { kind: "shadow_hypothetical" }, now);
  }
  createLiveChain(input: NewLiveChainInput, now: number): RevisionChain {
    return this.create("live", input, { ...input.grant, kind: "live" }, now, input.budget_origin ?? now);
  }

  /** One transaction: the chain write, its event and (shadow) its decision row. Revision mismatch throws `version_conflict`. */
  applyDecision(chainId: string, ifRevision: number, decision: ChainDecision, now: number): RevisionChain {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      this.validateDecision(chain, decision);
      switch (decision.kind) {
        case "none": return chain;
        case "reserve": return this.reserveInner(chain, { head: decision.head, review_ids: decision.review_ids, feedback_digest: decision.feedback_digest }, now).chain;
        case "would_reserve": {
          if (chain.mode !== "shadow") fail("shadow_decision_shadow_only");
          const inserted = this.shadowDecision(chain, decision.head, decision.base, "would_reserve", "changes_requested", decision.review_ids, decision.feedback_digest, now);
          if (inserted) this.event(chainId, "observation_cycle", { action: "would_reserve", head: decision.head, review_ids: decision.review_ids, discards: decision.discards }, now);
          return decision.back_to_review ? this.update(chain, { state: "awaiting_review" }, "changes_requested_after_ready", decision, now) : chain;
        }
        case "transition": case "stop": {
          const patch: Patch = { state: decision.to };
          if (decision.kind === "stop") patch.stop_reason = decision.reason;
          if (decision.kind === "transition" && decision.published_head !== undefined) {
            patch.published_head = decision.published_head;
            if (decision.published_base !== undefined) patch.published_base = decision.published_base;
          }
          const next = this.update(chain, patch, decision.reason, decision, now);
          if (decision.shadow_action) {
            this.shadowDecision(chain, decision.head, decision.base, decision.shadow_action, decision.reason, decision.review_ids, null, now);
          }
          return next;
        }
      }
    });
  }

  reserve(chainId: string, ifRevision: number, input: ReserveInput, now: number): { chain: RevisionChain; reservation: RevisionReservation } {
    this.clock(now);
    return this.write(() => this.reserveInner(this.checked(chainId, ifRevision), input, now));
  }
  dispatch(chainId: string, ifRevision: number, head: string, childMissionId: string, now: number): { chain: RevisionChain; reservation: RevisionReservation } {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.state !== "revision_reserved") fail("state_denied");
      const res = this.reservation(chain, head);
      if (res.state !== "reserved") fail("reservation_not_reserved");
      // Reservation first: the chain's current_mission_id trigger requires the dispatched row to exist.
      this.db.prepare("UPDATE engineering_revision_reservations SET state='dispatched',child_mission_id=?,updated_at=? WHERE repository=? AND pr_number=? AND head_sha=?")
        .run(childMissionId, now, chain.repository, chain.pr_number, head);
      const next = this.update(chain, { state: "revising", current_mission_id: childMissionId }, "dispatched", { head, base: chain.published_base }, now);
      return { chain: next, reservation: this.reservation(chain, head) };
    });
  }
  /** Void an in-flight reservation. A chain still in a dispatch state stops for a human; a settled chain is untouched. */
  voidReservation(chainId: string, ifRevision: number, head: string, reason: string, now: number): { chain: RevisionChain; reservation: RevisionReservation } {
    this.clock(now);
    if (!reason || reason.length > 64) fail("invalid_reason");
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      const res = this.reservation(chain, head);
      if (res.state === "void") fail("reservation_void");
      this.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason=?,updated_at=? WHERE repository=? AND pr_number=? AND head_sha=?")
        .run(reason, now, chain.repository, chain.pr_number, head);
      const next = IN_FLIGHT.has(chain.state)
        ? this.update(chain, { state: "awaiting_decision", stop_reason: reason }, reason, { head, base: chain.published_base }, now)
        : chain;
      return { chain: next, reservation: this.reservation(chain, head) };
    });
  }
  /** Clear current_mission_id; the database requires the child to be terminal with the stop proven. */
  clearCurrentMission(chainId: string, ifRevision: number, now: number): RevisionChain {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.current_mission_id === null) fail("no_current_mission");
      return this.update(chain, { current_mission_id: null }, "current_mission_cleared", { head: chain.published_head, base: chain.published_base }, now);
    });
  }

  recordIntent(chainId: string, ifRevision: number, input: NewIntentInput, now: number): { chain: RevisionChain; intent: PublicationIntent } {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live") fail("bridge_shadow_write_denied");
      if (chain.state !== "revising" && chain.state !== "publishing") fail("state_denied");
      if (input.kind === "push") {
        // The intent must extend exactly what the chain published, on the chain's branch, for its dispatched child.
        const dispatched = chain.current_mission_id !== null && this.db.prepare(
          "SELECT 1 FROM engineering_revision_reservations WHERE chain_id=? AND child_mission_id=? AND state='dispatched'").get(chainId, chain.current_mission_id);
        if (input.branch !== chain.branch || input.expected_old_head !== chain.published_head || input.expected_base_sha !== chain.published_base
          || !input.new_head || input.child_mission_id === undefined || input.child_mission_id !== chain.current_mission_id || !dispatched) fail("intent_binding_mismatch");
      }
      const intentId = `pi_${randomUUID()}`;
      const binding = JSON.stringify(input.binding ?? {});
      this.db.prepare(`INSERT INTO engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,
        expected_base_sha,child_mission_id,binding_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
        .run(intentId, chainId, input.kind, chain.repository, chain.pr_number, input.branch, input.expected_old_head ?? null, input.new_head ?? null,
          input.expected_base_sha ?? null, input.child_mission_id ?? null, binding, now, now);
      const next = input.kind === "push" && chain.state === "revising"
        ? this.update(chain, { state: "publishing" }, "push_intent_recorded", { head: input.new_head ?? chain.published_head, base: chain.published_base }, now)
        : chain;
      return { chain: next, intent: this.intent(intentId) };
    });
  }
  /** Settle an intent. A confirmed push in `publishing` moves published_head/base and returns the chain to review in the same
   * transaction; an uncertain push stops the chain for a human. */
  settleIntent(intentId: string, to: "confirmed" | "failed" | "uncertain", now: number, detail?: string): { chain: RevisionChain; intent: PublicationIntent } {
    this.clock(now);
    if (detail !== undefined && detail.length > 1024) fail("invalid_detail");
    return this.write(() => {
      const before = this.intent(intentId);
      this.db.prepare("UPDATE engineering_publication_intents SET state=?,detail=?,updated_at=? WHERE intent_id=?").run(to, detail ?? null, now, intentId);
      let chain = this.get(before.chain_id);
      const bound = before.kind === "push" && chain.state === "publishing" && chain.published_head === before.expected_old_head
        && chain.published_base === before.expected_base_sha && chain.branch === before.branch && chain.current_mission_id === before.child_mission_id;
      if (bound) {
        if (to === "confirmed") {
          chain = this.update(chain, { state: "awaiting_review", published_head: before.new_head!, published_base: before.expected_base_sha! }, "push_confirmed",
            { head: before.new_head!, base: before.expected_base_sha! }, now);
        } else if (to === "uncertain") {
          chain = this.update(chain, { state: "awaiting_decision", stop_reason: "intent_uncertain" }, "intent_uncertain", { head: before.new_head!, base: chain.published_base }, now);
        }
      }
      return { chain, intent: this.intent(intentId) };
    });
  }


  /** Run `fn` inside one `BEGIN IMMEDIATE` under the owner fence. Store methods called from `fn` become savepoints, so a
   * dispatch can span the chain store and the Mission store (both live on `attention.db`) and roll back together. `fn` must be
   * synchronous and make no I/O. */
  transaction<T>(fn: () => T): T { return this.write(fn); }

  /** Replace a live chain's grant (appendix §5.1 "再授"). Only for `awaiting_review`/`ready_for_human`, or `awaiting_decision`
   * stopped by `rounds_exhausted`/`grant_expired`/`grant_invalid`/`budget_exhausted`, with no unsettled push intent. The new grant
   * keeps the binding and scope, never lowers the allowance or a budget limit, and must carry `renews = {chain, ifRevision}`.
   * Authenticity (signature, live PR facts, principal) is the caller's; the store enforces monotonicity and the state contract. */
  replaceGrant(chainId: string, ifRevision: number, grant: RevisionGrant, now: number): ReplaceGrantResult {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live") fail("bridge_shadow_write_denied");
      if (chain.state === "closed") fail("chain_terminal");
      const next = (() => { try { return parseStoredGrant(JSON.stringify(grant)); } catch { return fail("grant_invalid"); } })();
      const old = (() => { try { return parseStoredGrant(chain.grant_json); } catch { return fail("chain_grant_unreadable"); } })();
      const reason = chain.stop_reason ?? "";
      const stopped = chain.state === "awaiting_decision" && RENEWABLE_STOP_REASONS.has(reason);
      if (!stopped && chain.state !== "awaiting_review" && chain.state !== "ready_for_human") fail("state_denied");
      if (this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state IN ('pending','uncertain') LIMIT 1").get(chainId)) fail("intent_unsettled");
      if (!grantBindsChain(next, chain) || next.scope_id !== old.scope_id || next.protected_set_digest !== old.protected_set_digest
        || next.renews?.chain_id !== chainId || next.renews.revision !== ifRevision || next.grant_id === old.grant_id) fail("grant_binding_mismatch");
      if (next.rounds < old.rounds || chain.rounds_used > next.rounds || next.budget.max_executor_seconds < old.budget.max_executor_seconds
        || next.budget.max_container_seconds < old.budget.max_container_seconds || next.budget.max_wall_clock_hours < old.budget.max_wall_clock_hours) fail("grant_not_monotonic");
      if (next.expires_at <= now || next.issued_at > now) fail("grant_expired");
      if (reason === "rounds_exhausted" && next.rounds <= chain.rounds_used) fail("rounds_not_raised");
      if (reason === "budget_exhausted" && !(next.budget.max_executor_seconds > old.budget.max_executor_seconds
        || next.budget.max_container_seconds > old.budget.max_container_seconds || next.budget.max_wall_clock_hours > old.budget.max_wall_clock_hours)) fail("budget_not_raised");
      let to: ChainState = chain.state;
      if (stopped) {
        if (chain.current_mission_id === null) to = "awaiting_review";
        else {
          const child = this.db.prepare("SELECT m.state state,m.stop_obligation stop,c.state claim FROM engineering_contained_missions m LEFT JOIN engineering_workspace_claims c ON c.mission_id=m.mission_id WHERE m.mission_id=?")
            .get(chain.current_mission_id) as { state: string; stop: number; claim: string | null } | undefined;
          if (!child) fail("not_found");
          else if (["pr_opened", "cancelled", "abandoned", "failed"].includes(child.state)) {
            if (child.stop !== 0) fail("child_stop_unproven");
            if (child.claim === "active") fail("child_claim_unreleased");
            to = "awaiting_review";
          } else {
            // The child was parked by the grant or budget stop, not cancelled: resume the state it was stopped from.
            const pushed = this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND child_mission_id=? LIMIT 1").get(chainId, chain.current_mission_id);
            to = pushed ? "publishing" : "revising";
          }
        }
      }
      const headConsumed = Boolean(this.db.prepare("SELECT 1 FROM engineering_revision_reservations WHERE repository=? AND pr_number=? AND head_sha=?").get(chain.repository, chain.pr_number, chain.published_head));
      const updated = this.update(chain, { state: to, grant_json: JSON.stringify(grant), review_deadline: next.issued_at + next.review_deadline_ms }, "grant_replaced",
        { head: chain.published_head, base: chain.published_base }, now);
      this.event(chainId, "grant_replaced", {
        grant_id: next.grant_id, from_grant_id: old.grant_id, rounds: { from: old.rounds, to: next.rounds }, expires_at: next.expires_at, budget: next.budget,
        restored_state: to, head_consumed: headConsumed,
      }, now);
      return { chain: updated, head_consumed: headConsumed };
    });
  }

  /** Stop a live chain for a human (appendix §4.4): any non-terminal, non-stopped state -> `awaiting_decision(reason)`. */
  stopLive(chainId: string, ifRevision: number, reason: string, now: number): RevisionChain {
    this.clock(now);
    const base = reason.split(":")[0] ?? "";
    if (reason.length > 64 || !/^[a-z_]+(:[A-Za-z0-9_.-]{1,48})?$/.test(reason)
      || !((LIVE_STOP_REASONS as readonly string[]).includes(reason) || (base === "publish_refused" && reason.includes(":")))) fail("invalid_reason");
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live") fail("bridge_shadow_write_denied");
      if (chain.state === "closed" || chain.state === "awaiting_decision") fail("state_denied");
      return this.update(chain, { state: "awaiting_decision", stop_reason: reason }, reason, { head: chain.published_head, base: chain.published_base }, now);
    });
  }

  /** Close a live chain (human abandon or takeover, appendix §5.1). Any in-flight reservation is voided in the same transaction; the
   * caller requests cancellation of the current child afterwards. */
  closeLive(chainId: string, ifRevision: number, reason: string, now: number): RevisionChain {
    this.clock(now);
    if (!/^[a-z_]+(:[A-Za-z0-9_.-]{1,48})?$/.test(reason) || reason.length > 64) fail("invalid_reason");
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live") fail("bridge_shadow_write_denied");
      if (chain.state === "closed") fail("chain_terminal");
      this.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason=?,updated_at=? WHERE chain_id=? AND state IN ('reserved','dispatched')")
        .run(`chain_closed:${reason}`.slice(0, 64), now, chainId);
      return this.update(chain, { state: "closed" }, reason, { head: chain.published_head, base: chain.published_base }, now);
    });
  }

  appendEvent(chainId: string, kind: string, payload: unknown, now: number): number {
    this.clock(now);
    return this.write(() => { this.get(chainId); return this.event(chainId, kind, payload, now); });
  }

  private create(mode: ChainMode, input: NewChainInput, grant: Record<string, unknown>, now: number, budgetOrigin?: number): RevisionChain {
    this.clock(now);
    for (const v of [input.root_mission_id, input.repository, input.branch, input.base_ref, input.published_head, input.published_base, input.trace_id]) {
      if (typeof v !== "string" || v.length === 0 || v.length > 1024) fail("invalid_chain");
    }
    if (!Number.isSafeInteger(input.pr_number) || input.pr_number < 1) fail("invalid_chain");
    const deadline = input.review_deadline ?? null;
    if (deadline !== null && (!Number.isSafeInteger(deadline) || deadline < 0)) fail("invalid_chain");
    if (budgetOrigin !== undefined && (!Number.isSafeInteger(budgetOrigin) || budgetOrigin < 0)) fail("invalid_chain");
    const budgetJson = budgetOrigin === undefined ? null : JSON.stringify({ origin: budgetOrigin });
    const spentJson = budgetOrigin === undefined ? null : JSON.stringify({ allocations: {} });
    return this.write(() => {
      const chainId = `rc_${randomUUID()}`;
      this.db.prepare(`INSERT INTO engineering_revision_chains(chain_id,mode,root_mission_id,repository,pr_number,branch,base_ref,published_head,published_base,
        grant_json,rounds_used,state,review_deadline,budget_json,spent_json,trace_id,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,'awaiting_review',?,?,?,?,1,?,?)`)
        .run(chainId, mode, input.root_mission_id, input.repository, input.pr_number, input.branch, input.base_ref, input.published_head, input.published_base,
          JSON.stringify(grant), deadline, budgetJson, spentJson, input.trace_id, now, now);
      this.event(chainId, "chain_created", { mode, repository: input.repository, pr_number: input.pr_number, head: input.published_head, base: input.published_base }, now);
      return this.get(chainId);
    });
  }

  private reserveInner(chain: RevisionChain, input: ReserveInput, now: number): { chain: RevisionChain; reservation: RevisionReservation } {
    if (chain.mode !== "live") fail("bridge_shadow_write_denied");
    if (chain.state !== "awaiting_review" && chain.state !== "ready_for_human") fail("state_denied");
    const rounds = (JSON.parse(chain.grant_json) as { rounds?: unknown }).rounds;
    if (typeof rounds !== "number" || chain.rounds_used >= rounds) fail("rounds_exhausted");
    if (!input.head || input.head.length > 128 || !input.feedback_digest || input.review_ids.length === 0) fail("invalid_reservation");
    if (this.db.prepare("SELECT 1 FROM engineering_revision_reservations WHERE chain_id=? AND state IN ('reserved','dispatched')").get(chain.chain_id)) fail("chain_busy");
    if (this.db.prepare("SELECT 1 FROM engineering_revision_reservations WHERE repository=? AND pr_number=? AND head_sha=?").get(chain.repository, chain.pr_number, input.head)) fail("head_already_reserved");
    if (input.head !== chain.published_head) fail("head_mismatch");
    this.db.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,review_ids_json,feedback_digest,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'reserved',?,?)`).run(chain.repository, chain.pr_number, input.head, chain.chain_id, JSON.stringify([...input.review_ids]), input.feedback_digest, now, now);
    const next = this.update(chain, { state: "revision_reserved", rounds_used: chain.rounds_used + 1 }, "reserved", { head: input.head, base: chain.published_base }, now);
    return { chain: next, reservation: this.reservation(chain, input.head) };
  }

  /** A decision was computed against some chain row; refuse it unless it still describes this one (revision alone does not
   * protect a caller that re-reads the chain after deciding). */
  private validateDecision(chain: RevisionChain, d: ChainDecision): void {
    if (d.kind === "none") return;
    // Every decision names the chain state it was computed from; a decision about an earlier state is never applied.
    if (d.from_head !== chain.published_head || d.from_base !== chain.published_base) fail("stale_decision");
    const refSame = d.base_ref === undefined || d.base_ref === chain.base_ref;
    const onPublished = d.head === chain.published_head && d.base === chain.published_base && refSame;
    const stale = (): never => fail("stale_decision");
    switch (d.kind) {
      case "reserve": case "would_reserve": if (!onPublished) stale(); return;
      case "transition":
        if (d.to === "closed") return;
        if (d.published_head !== undefined) {
          // Accepting a new head: live only, and only for a head a confirmed push intent produced.
          if (chain.mode !== "live" || d.base !== chain.published_base || !refSame || !this.confirmedPushHeads(chain.chain_id).includes(d.published_head)) stale();
          return;
        }
        if (!onPublished) stale();
        return;
      case "stop":
        if (d.reason === "attribution_unknown" || d.reason === "external_write" || d.reason === "head_regressed") { if (d.head === chain.published_head) stale(); }
        else if (d.reason === "base_changed") { if (d.base === chain.published_base && refSame && d.head === chain.published_head) stale(); }
        else if (!onPublished) stale();
        return;
    }
  }

  private update(chain: RevisionChain, patch: Patch, reason: string, at: { head: string; base: string }, now: number): RevisionChain {
    const next = { ...chain, ...patch };
    const stop = next.state === "awaiting_decision" ? (patch.stop_reason ?? chain.stop_reason) : null;
    // grant_json is named in the SET list only for a re-grant, so every other update stays clear of the grant triggers.
    const grant = patch.grant_json !== undefined;
    this.db.prepare(`UPDATE engineering_revision_chains SET state=?,stop_reason=?,published_head=?,published_base=?,rounds_used=?,current_mission_id=?,
      ${grant ? "grant_json=?,review_deadline=?," : ""}revision=revision+1,updated_at=? WHERE chain_id=? AND revision=?`)
      .run(next.state, stop, next.published_head, next.published_base, next.rounds_used, next.current_mission_id,
        ...(grant ? [patch.grant_json, patch.review_deadline ?? chain.review_deadline] : []), now, chain.chain_id, chain.revision);
    this.event(chain.chain_id, "transition", { from: chain.state, to: next.state, reason, head: at.head, base: at.base, ...(stop ? { stop_reason: stop } : {}) }, now);
    return this.get(chain.chain_id);
  }
  private shadowDecision(chain: RevisionChain, head: string, base: string, action: ShadowAction, reason: string,
    reviewIds: readonly number[], digest: string | null, now: number): boolean {
    return this.db.prepare(`INSERT INTO engineering_shadow_decisions(chain_id,head_sha,base_sha,action,reason,review_ids_json,feedback_digest,observed_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chain_id,head_sha,action) DO NOTHING`)
      .run(chain.chain_id, head, base, action, reason, JSON.stringify([...reviewIds]), digest, now, now).changes === 1;
  }
  private checked(chainId: string, ifRevision: number): RevisionChain {
    const chain = this.get(chainId);
    if (chain.revision !== ifRevision) fail("version_conflict");
    return chain;
  }
  private reservation(chain: RevisionChain, head: string): RevisionReservation {
    const row = this.db.prepare("SELECT * FROM engineering_revision_reservations WHERE repository=? AND pr_number=? AND head_sha=? AND chain_id=?")
      .get(chain.repository, chain.pr_number, head, chain.chain_id) as RevisionReservation | undefined;
    return row ?? fail("reservation_not_found");
  }
  private intent(intentId: string): PublicationIntent {
    const row = this.db.prepare("SELECT * FROM engineering_publication_intents WHERE intent_id=?").get(intentId) as PublicationIntent | undefined;
    return row ?? fail("not_found");
  }
  private event(chainId: string, kind: string, payload: unknown, now: number): number {
    if (!kind || kind.length > 64) fail("invalid_event");
    const json = JSON.stringify(payload);
    if (json.length > 32768) fail("event_too_large");
    return Number(this.db.prepare("INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,?,?,?)").run(chainId, kind, json, now).lastInsertRowid);
  }
  /** BEGIN IMMEDIATE so a racing reconciler waits for the write lock instead of failing on a stale read snapshot. */
  private write<T>(fn: () => T): T {
    if (this.db.pragma("synchronous", { simple: true }) !== 2) fail("durability_required");
    return this.db.transaction(() => { this.attention.assertOwner(this.owner); return fn(); }).immediate();
  }
  private clock(now: number): void { if (!Number.isSafeInteger(now) || now < 0) fail("invalid_clock"); }
}

interface Patch {
  state?: ChainState; stop_reason?: string | null; published_head?: string; published_base?: string;
  rounds_used?: number; current_mission_id?: string | null; grant_json?: string; review_deadline?: number | null;
}

/** Upgrade holds for revision chains: reservations and intents recovery would still visit. */
export function revisionChainUpgradeHolds(db: Database.Database): number {
  const has = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  let holds = 0;
  if (has("engineering_revision_reservations")) {
    holds += (db.prepare("SELECT COUNT(*) n FROM engineering_revision_reservations WHERE state IN ('reserved','dispatched')").get() as { n: number }).n;
  }
  if (has("engineering_publication_intents")) {
    holds += (db.prepare("SELECT COUNT(*) n FROM engineering_publication_intents WHERE state IN ('pending','uncertain')").get() as { n: number }).n;
  }
  return holds;
}
