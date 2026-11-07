import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AttentionOwner, AttentionStore } from "./attention-store.js";
import type { ChainDecision, ChainMode, ChainState, ShadowAction } from "../bridge/revision-chain.js";
import { LIVE_STOP_REASONS, REFRESHABLE_STOP_REASONS, SAME_CHILD_RESUMABLE, grantBindsChain, parseStoredGrant, type RevisionGrant } from "../bridge/revision-grant.js";

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
/** One revision child's slice of the chain budget (appendix §5.2 "预算"). `*_used` is charged before each launch and refunded down to the actual time afterwards. */
export interface ChildAllocation { executor_seconds: number; container_seconds: number; executor_used: number; container_used: number }
export type LaunchKind = "executor" | "container";
const TERMINAL_CHILD = "('pr_opened','cancelled','abandoned','failed')";
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
  /** `clockMs` is the store's own notion of "now" for grant-expiry checks (design 8.7.1); the `now` arguments stay the ledger timestamps. */
  constructor(readonly attention: AttentionStore, readonly owner: AttentionOwner, private readonly clockMs: () => number = Date.now) {}
  get db(): Database.Database { return this.attention.db; }

  get(chainId: string): RevisionChain {
    const row = this.db.prepare("SELECT * FROM engineering_revision_chains WHERE chain_id=?").get(chainId) as RevisionChain | undefined;
    return row ?? fail("not_found");
  }
  events(chainId: string, afterSeq = 0, limit = 100): RevisionChainEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail("invalid_limit");
    return this.db.prepare("SELECT * FROM engineering_revision_chain_events WHERE chain_id=? AND seq>? ORDER BY seq LIMIT ?").all(chainId, afterSeq, limit) as RevisionChainEvent[];
  }
  /** The receipt range is bound to an intent, not to the age of its chain. */
  pushRangeEvent(chainId: string, intentId: string): RevisionChainEvent | undefined {
    return this.db.prepare("SELECT * FROM engineering_revision_chain_events WHERE chain_id=? AND kind='push_range' AND json_extract(payload_json, '$.intent_id')=? ORDER BY seq DESC LIMIT 1").get(chainId, intentId) as RevisionChainEvent | undefined;
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
  /** Keyset page across all chains, including stopped and closed chains. */
  pendingPushIntents(afterIntentId = '', limit = 10): PublicationIntent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit");
    return this.db.prepare("SELECT * FROM engineering_publication_intents WHERE kind='push' AND state='pending' AND intent_id>? ORDER BY intent_id LIMIT ?")
      .all(afterIntentId, limit) as PublicationIntent[];
  }
  /** Bounded restart scan for evidence delivery, including closed live chains. */
  unsettledCheckIntents(afterIntentId = '', limit = 10): PublicationIntent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit");
    return this.db.prepare(`SELECT i.* FROM engineering_publication_intents i
      JOIN engineering_revision_chains c ON c.chain_id=i.chain_id
      WHERE i.kind='check' AND i.state IN ('pending','uncertain') AND c.mode='live' AND i.intent_id>?
      ORDER BY i.intent_id LIMIT ?`).all(afterIntentId, limit) as PublicationIntent[];
  }
  getIntent(intentId: string): PublicationIntent { return this.intent(intentId); }
  confirmedPushHeads(chainId: string): string[] {
    return (this.db.prepare("SELECT new_head FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state='confirmed' ORDER BY created_at,intent_id").all(chainId) as Array<{ new_head: string }>).map(r => r.new_head);
  }
  /** Live: `new_head` of the confirmed push intent that extends exactly what the chain has published, if the chain has not reflected it yet.
   * This is the only value a caller may hand `decideChainStep` as `confirmed_push_head` (TLA+ D3). */
  nextConfirmedPushHead(chainId: string): string | undefined {
    const chain = this.get(chainId);
    const row = this.db.prepare(`SELECT new_head FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state='confirmed'
      AND expected_old_head=? AND expected_base_sha=? ORDER BY created_at,intent_id LIMIT 1`).get(chainId, chain.published_head, chain.published_base) as { new_head: string } | undefined;
    return row?.new_head;
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
          if (decision.kind === "transition" && decision.to === "closed" && chain.mode === "live") {
            patch.stop_reason = decision.reason;
            this.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason=?,updated_at=? WHERE chain_id=? AND state IN ('reserved','dispatched')")
              .run(`chain_closed:${decision.reason}`.slice(0, 64), now, chainId);
          }
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
      this.assertGrantLive(chain);
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
      if (input.kind === "push" && chain.state !== "revising" && chain.state !== "publishing") fail("state_denied");
      if (input.kind === "push") {
        this.assertGrantLive(chain);
        // D2: one push receipt at a time. A second pending intent could settle `uncertain` after the chain moved on, and an
        // uncertain one may still land on the remote.
        const open = this.db.prepare("SELECT state FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state IN ('pending','uncertain') ORDER BY state LIMIT 1").get(chainId) as { state: string } | undefined;
        if (open) fail(open.state === "pending" ? "push_intent_pending" : "push_intent_uncertain");
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
   * transaction. A push receipt that is not confirmed stops the chain for a human:
   * - `uncertain` stops any chain that is not already stopped or closed, whether or not the intent is still the one in flight
   *   (design 8.7 step 5; TLA+ D1), so a late uncertain verdict can never leave a running chain beside a possible remote write;
   * - `failed` stops a chain whose round is in flight for this intent's child (design 8.7 step 2; appendix 5.3 steps 2-3 and 5, and
   *   4.4 `child_failed`/`publish_refused`). "No release record, so git never ran" (appendix 2 item 2) makes the intent `failed` but is
   *   no licence to retry in place: a retry is a new intent after a human decision, and D2 allows it only once this one is settled.
   * A confirmed push also settles its dispatched reservation as `published` when the child is already terminal with the stop proven
   * (appendix 4.1 item 1 and item 3 row `awaiting_decision`); while the child still runs the caller voids it in the same transaction as
   * the child's terminal state (appendix 5.3 step 6 items 3 and 5). */
  settleIntent(intentId: string, to: "confirmed" | "failed" | "uncertain", now: number, detail?: string): { chain: RevisionChain; intent: PublicationIntent } {
    this.clock(now);
    if (detail !== undefined && detail.length > 1024) fail("invalid_detail");
    return this.write(() => {
      const before = this.intent(intentId);
      this.db.prepare("UPDATE engineering_publication_intents SET state=?,detail=?,updated_at=? WHERE intent_id=?").run(to, detail ?? null, now, intentId);
      let chain = this.get(before.chain_id);
      const bound = before.kind === "push" && chain.state === "publishing" && chain.published_head === before.expected_old_head
        && chain.published_base === before.expected_base_sha && chain.branch === before.branch && chain.current_mission_id === before.child_mission_id;
      const at = { head: before.new_head ?? chain.published_head, base: chain.published_base };
      if (to === "confirmed") {
        if (bound) {
          chain = this.update(chain, { state: "awaiting_review", published_head: before.new_head!, published_base: before.expected_base_sha! }, "push_confirmed",
            { head: before.new_head!, base: before.expected_base_sha! }, now);
        } else if (before.kind === "push" && chain.state === "awaiting_decision"
          && chain.current_mission_id === before.child_mission_id && chain.published_head === before.expected_old_head
          && chain.published_base === before.expected_base_sha && chain.branch === before.branch) {
          // The caller proved the remote receipt before confirming. Keep the human stop while recording the landed head.
          chain = this.update(chain, { published_head: before.new_head! }, "receipt_confirmed_while_stopped",
            { head: before.new_head!, base: chain.published_base }, now);
        }
        // A closed chain's active reservations were already voided by the close itself (closeLive or a decided close).
        if (before.kind === "push" && chain.state !== "closed") this.settlePublishedReservation(before, bound, now);
      } else if (before.kind === "push" && chain.state !== "awaiting_decision" && chain.state !== "closed") {
        if (to === "uncertain") {
          chain = this.update(chain, { state: "awaiting_decision", stop_reason: "intent_uncertain" }, "intent_uncertain", at, now);
        } else if (IN_FLIGHT.has(chain.state) && chain.current_mission_id === before.child_mission_id) {
          chain = this.update(chain, { state: "awaiting_decision", stop_reason: "intent_failed" }, "intent_failed", at, now);
        }
      }
      return { chain, intent: this.intent(intentId) };
    });
  }


  /** Run `fn` inside one `BEGIN IMMEDIATE` under the owner fence. Store methods called from `fn` become savepoints, so a
   * dispatch can span the chain store and the Mission store (both live on `attention.db`) and roll back together. `fn` must be
   * synchronous and make no I/O. */
  transaction<T>(fn: () => T): T { return this.write(fn); }

  /** A confirmed revision starts a fresh review window. This write is part of the caller's confirmation transaction. */
  resetReviewDeadline(chainId: string, ifRevision: number, deadline: number, now: number): RevisionChain {
    this.clock(now);
    if (!Number.isSafeInteger(deadline) || deadline <= now) fail("invalid_deadline");
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live" || chain.state !== "awaiting_review") fail("state_denied");
      this.db.prepare("UPDATE engineering_revision_chains SET review_deadline=?,revision=revision+1,updated_at=? WHERE chain_id=? AND revision=?")
        .run(deadline, now, chainId, ifRevision);
      this.event(chainId, "review_deadline_reset", { deadline }, now);
      return this.get(chainId);
    });
  }

  /** A check belongs to a child that is already opened on a confirmed push. */
  recordCheckIntent(chainId: string, childMissionId: string, newHead: string, now: number): PublicationIntent {
    this.clock(now);
    return this.write(() => {
      const chain = this.get(chainId);
      if (chain.mode !== "live") fail("check_binding_mismatch");
      if (!this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND child_mission_id=? AND new_head=? AND state='confirmed'")
        .get(chainId, childMissionId, newHead)) fail("check_push_unconfirmed");
      if (!this.db.prepare("SELECT 1 FROM engineering_contained_missions WHERE mission_id=? AND state='pr_opened'").get(childMissionId)) fail("check_child_not_opened");
      const pending = this.db.prepare(`SELECT * FROM engineering_publication_intents
        WHERE chain_id=? AND kind='check' AND child_mission_id=? AND new_head=? AND state='pending'
          AND json_extract(binding_json,'$.external_id')=? ORDER BY created_at,intent_id LIMIT 1`)
        .get(chainId, childMissionId, newHead, childMissionId) as PublicationIntent | undefined;
      if (pending) return pending;
      return this.recordIntent(chainId, chain.revision, { kind: "check", branch: chain.branch, new_head: newHead, child_mission_id: childMissionId,
        binding: { external_id: childMissionId } }, now).intent;
    });
  }

  /** Replace a live chain's grant (appendix §5.1 "再授"). Only for `awaiting_review`/`ready_for_human`, or `awaiting_decision`
   * stopped by a reason in `REFRESHABLE_STOP_REASONS`, with no unsettled push intent. The new grant
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
      const stopped = chain.state === "awaiting_decision" && REFRESHABLE_STOP_REASONS.has(reason);
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
      let spentJson: string | undefined; let topUp: { executor_seconds: number; container_seconds: number } | undefined;
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
            if (this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND child_mission_id=? AND state='confirmed' LIMIT 1").get(chainId, chain.current_mission_id)) fail("round_landed");
            // The child remains stopped until its human decision passes the resume guard.
            to = "awaiting_decision";
            // A budget stop parked this child with its slice used up: the raise the human just signed becomes more slice for the same child (used is kept).
            if (reason === "budget_exhausted") {
              const allocations = this.allocationsOf(chain);
              const slice = allocations[chain.current_mission_id];
              if (slice) {
                topUp = { executor_seconds: next.budget.max_executor_seconds - old.budget.max_executor_seconds, container_seconds: next.budget.max_container_seconds - old.budget.max_container_seconds };
                allocations[chain.current_mission_id] = { ...slice, executor_seconds: slice.executor_seconds + topUp.executor_seconds, container_seconds: slice.container_seconds + topUp.container_seconds };
                spentJson = JSON.stringify({ allocations });
              }
            }
          }
        }
      }
      const headConsumed = Boolean(this.db.prepare("SELECT 1 FROM engineering_revision_reservations WHERE repository=? AND pr_number=? AND head_sha=?").get(chain.repository, chain.pr_number, chain.published_head));
      const updated = this.update(chain, { state: to, ...(to === "awaiting_decision" && stopped ? { stop_reason: "child_halted" } : {}), grant_json: JSON.stringify(grant), review_deadline: next.issued_at + next.review_deadline_ms, ...(spentJson !== undefined ? { spent_json: spentJson } : {}) }, "grant_replaced",
        { head: chain.published_head, base: chain.published_base }, now);
      this.event(chainId, "grant_replaced", {
        grant_id: next.grant_id, from_grant_id: old.grant_id, rounds: { from: old.rounds, to: next.rounds }, expires_at: next.expires_at, budget: next.budget,
        restored_state: to, head_consumed: headConsumed, ...(topUp ? { top_up: topUp } : {}),
      }, now);
      return { chain: updated, head_consumed: headConsumed };
    });
  }

  /** Resume a stopped round only after its child and push receipts are known to be safe. */
  resumeChild(chainId: string, ifRevision: number, input: {
    child_mission_id: string; expected_stop_reason: string; decision: string;
  }, now: number): RevisionChain {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live" || chain.state !== "awaiting_decision" || chain.stop_reason !== input.expected_stop_reason
        || !SAME_CHILD_RESUMABLE.has(chain.stop_reason ?? "")) fail(`chain_not_resumable:${chain.stop_reason ?? chain.state}`);
      if (chain.current_mission_id !== input.child_mission_id) fail("not_current_child");
      if (!this.db.prepare("SELECT 1 FROM engineering_revision_reservations WHERE chain_id=? AND child_mission_id=? AND state='dispatched'")
        .get(chainId, input.child_mission_id)) fail("reservation_not_dispatched");
      const child = (this.db.prepare("SELECT state,revision,stop_obligation FROM engineering_contained_missions WHERE mission_id=?")
        .get(input.child_mission_id) as { state: string; revision: number; stop_obligation: number } | undefined) ?? fail("child_stop_unproven");
      if (child.stop_obligation !== 0 || ["stop_unknown", "cancel_requested", "cancelled", "abandoned", "failed", "pr_opened"].includes(child.state)
        || this.db.prepare("SELECT 1 FROM engineering_host_processes WHERE mission_id=? AND state<>'stopped' LIMIT 1").get(input.child_mission_id)) fail("child_stop_unproven");
      if (!this.db.prepare("SELECT 1 FROM engineering_workspace_claims WHERE mission_id=? AND state='active'").get(input.child_mission_id)) fail("child_claim_released");
      const halt = this.db.prepare("SELECT json_extract(payload_json,'$.reason') reason FROM engineering_contained_events WHERE mission_id=? AND kind='halted' ORDER BY seq DESC LIMIT 1")
        .get(input.child_mission_id) as { reason: unknown } | undefined;
      const reason = typeof halt?.reason === "string" ? halt.reason : "";
      const allowed = child.state === "needs_reconciliation" && (reason.startsWith("orphaned_") || reason === "stop_evidence_recovered")
        ? ["discard_changes", "adopt_worktree"].includes(input.decision)
        : child.state === "awaiting_decision" && (
          (reason === "repair_cycles_exhausted" && input.decision === "extra_repair")
          || ((reason.startsWith("publication_failed:") || reason.startsWith("revalidation_failed:")) && input.decision === "approve_publication")
          || (reason === "workspace_recovered" && input.decision === "resume_workspace")
          || ((reason === "budget_exhausted" || reason.startsWith("grant_stopped:")) && ["resume_budget", "resume_grant"].includes(input.decision)));
      if (!allowed) fail("decision_not_allowed");
      if (this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state IN ('pending','uncertain') LIMIT 1").get(chainId)) fail("intent_unsettled");
      if (this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND child_mission_id=? AND state='confirmed' LIMIT 1")
        .get(chainId, input.child_mission_id)) fail("round_landed");
      this.assertGrantLive(chain);
      const resumed = this.update(chain, { state: "revising", stop_reason: null }, "child_resumed", { head: chain.published_head, base: chain.published_base }, now);
      this.event(chainId, "child_resumed", { child: input.child_mission_id, decision: input.decision, from_reason: chain.stop_reason,
        child_state: child.state, child_revision: child.revision }, now);
      this.event(chainId, "round_resumed", { child: input.child_mission_id, from_reason: chain.stop_reason }, now);
      return resumed;
    });
  }

  /** A recovered push has already landed; confirmation reopens review without another push. */
  resumeLanded(chainId: string, ifRevision: number, intentId: string, now: number): RevisionChain {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live" || !["awaiting_decision", "revising", "publishing"].includes(chain.state)
        || (chain.state === "awaiting_decision" && chain.stop_reason !== "intent_uncertain" && !SAME_CHILD_RESUMABLE.has(chain.stop_reason ?? ""))) fail("confirm_route_changed");
      const intent = this.intent(intentId);
      if (intent.chain_id !== chainId || intent.kind !== "push" || intent.state !== "confirmed"
        || intent.child_mission_id !== chain.current_mission_id || intent.new_head !== chain.published_head
        || intent.expected_base_sha !== chain.published_base) fail("confirm_route_changed");
      const latest = this.db.prepare("SELECT intent_id FROM engineering_publication_intents WHERE chain_id=? AND child_mission_id=? AND kind='push' ORDER BY created_at DESC,intent_id DESC LIMIT 1")
        .get(chainId, intent.child_mission_id) as { intent_id: string } | undefined;
      if (latest?.intent_id !== intentId) fail("confirm_route_changed");
      if (this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state IN ('pending','uncertain') LIMIT 1").get(chainId)) fail("intent_unsettled");
      if (!this.db.prepare("SELECT 1 FROM engineering_revision_reservations WHERE chain_id=? AND child_mission_id=? AND head_sha=? AND state='dispatched'")
        .get(chainId, intent.child_mission_id, intent.expected_old_head)) fail("confirm_route_changed");
      const child = this.db.prepare("SELECT state,candidate_head,stop_obligation FROM engineering_contained_missions WHERE mission_id=?")
        .get(intent.child_mission_id) as { state: string; candidate_head: string | null; stop_obligation: number } | undefined;
      if (child?.state !== "delivering" || child.candidate_head !== intent.new_head || child.stop_obligation !== 0
        || this.db.prepare("SELECT 1 FROM engineering_host_processes WHERE mission_id=? AND state<>'stopped' LIMIT 1").get(intent.child_mission_id)) fail("confirm_route_changed");
      const resumed = this.update(chain, { state: "awaiting_review", stop_reason: null }, "round_confirmed_after_recovery",
        { head: chain.published_head, base: chain.published_base }, now);
      this.event(chainId, "round_confirmed_after_recovery", { intent_id: intentId, child: intent.child_mission_id, head: intent.new_head }, now);
      return resumed;
    });
  }

  /** Replace a resumable stop with the proven terminal outcome of its child. */
  restopLive(chainId: string, ifRevision: number, to: "child_cancelled" | "child_failed", now: number): RevisionChain {
    this.clock(now);
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live" || chain.state !== "awaiting_decision" || !SAME_CHILD_RESUMABLE.has(chain.stop_reason ?? "")) fail("state_denied");
      if (!chain.current_mission_id) fail("not_current_child");
      const child = this.db.prepare("SELECT state,stop_obligation FROM engineering_contained_missions WHERE mission_id=?")
        .get(chain.current_mission_id) as { state: string; stop_obligation: number } | undefined;
      if (child?.stop_obligation !== 0 || (to === "child_cancelled" ? !["cancelled", "abandoned"].includes(child.state) : child.state !== "failed")) fail("child_stop_unproven");
      return this.update(chain, { stop_reason: to }, to, { head: chain.published_head, base: chain.published_base }, now);
    });
  }

  /** Stop a live chain for a human. Proven external history also supersedes a prior human stop. */
  stopLive(chainId: string, ifRevision: number, reason: string, now: number): RevisionChain {
    this.clock(now);
    const base = reason.split(":")[0] ?? "";
    if (reason.length > 64 || !/^[a-z_]+(:[A-Za-z0-9_.-]{1,48})?$/.test(reason)
      || !((LIVE_STOP_REASONS as readonly string[]).includes(reason) || (base === "publish_refused" && reason.includes(":")))) fail("invalid_reason");
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live") fail("bridge_shadow_write_denied");
      if (chain.state === "closed" || (chain.state === "awaiting_decision" && reason !== "external_write")) fail("state_denied");
      if (chain.state === "awaiting_decision" && chain.stop_reason === reason) return chain;
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

  /** Every child's slice of this chain's budget. */
  allocations(chainId: string): Record<string, ChildAllocation> { return this.allocationsOf(this.get(chainId)); }

  /** What a new child could still be given: the grant's totals minus every slice, where a child that is terminal with its stop proven only
   * counts what it actually used (the unspent rest is returned), and any other child counts its whole slice. */
  remainingBudget(chainId: string): { executor_seconds: number; container_seconds: number } {
    const chain = this.get(chainId);
    if (chain.mode !== "live") fail("bridge_shadow_write_denied");
    const limits = this.budgetOf(chain);
    let executor = limits.max_executor_seconds; let container = limits.max_container_seconds;
    for (const [child, slice] of Object.entries(this.allocationsOf(chain))) {
      const settled = this.db.prepare(`SELECT 1 FROM engineering_contained_missions WHERE mission_id=? AND state IN ${TERMINAL_CHILD} AND stop_obligation=0`).get(child);
      executor -= settled ? slice.executor_used : slice.executor_seconds;
      container -= settled ? slice.container_used : slice.container_seconds;
    }
    return { executor_seconds: Math.max(0, executor), container_seconds: Math.max(0, container) };
  }

  /** Give the chain's current child its slice. Part of the dispatch transaction: the child must already be `current_mission_id`, may have only one
   * slice, and the slice must fit what remains of the grant's budget (`budget_exhausted`). */
  allocateChild(chainId: string, ifRevision: number, childMissionId: string, slice: { executor_seconds: number; container_seconds: number }, now: number): RevisionChain {
    this.clock(now);
    for (const v of [slice.executor_seconds, slice.container_seconds]) if (!Number.isSafeInteger(v) || v < 1) fail("invalid_allocation");
    return this.write(() => {
      const chain = this.checked(chainId, ifRevision);
      if (chain.mode !== "live") fail("bridge_shadow_write_denied");
      if (chain.current_mission_id !== childMissionId) fail("allocation_child_mismatch");
      const allocations = this.allocationsOf(chain);
      if (allocations[childMissionId]) fail("allocation_exists");
      const left = this.remainingBudget(chainId);
      if (slice.executor_seconds > left.executor_seconds || slice.container_seconds > left.container_seconds) fail("budget_exhausted");
      allocations[childMissionId] = { ...slice, executor_used: 0, container_used: 0 };
      this.event(chainId, "child_allocated", { child: childMissionId, ...slice }, now);
      return this.update(chain, { spent_json: JSON.stringify({ allocations }) }, "child_allocated", { head: chain.published_head, base: chain.published_base }, now);
    });
  }

  /** Charge `seconds` against the child's slice before a launch. The slice never goes over: `budget_exhausted`. Only a live, non-closed chain whose
   * current child this is can be charged. */
  chargeLaunch(chainId: string, childMissionId: string, kind: LaunchKind, seconds: number, now: number): ChildAllocation {
    this.clock(now);
    if (!Number.isSafeInteger(seconds) || seconds < 1) fail("invalid_allocation");
    return this.write(() => {
      const chain = this.get(chainId);
      if (chain.mode !== "live") fail("bridge_shadow_write_denied");
      if (chain.current_mission_id !== childMissionId) fail("allocation_child_mismatch");
      const allocations = this.allocationsOf(chain);
      const slice = allocations[childMissionId] ?? fail("allocation_missing");
      const used = kind === "executor" ? slice.executor_used : slice.container_used;
      const cap = kind === "executor" ? slice.executor_seconds : slice.container_seconds;
      if (used + seconds > cap) fail("budget_exhausted");
      const next = kind === "executor" ? { ...slice, executor_used: used + seconds } : { ...slice, container_used: used + seconds };
      allocations[childMissionId] = next;
      this.update(chain, { spent_json: JSON.stringify({ allocations }) }, "launch_charged", { head: chain.published_head, base: chain.published_base }, now);
      return next;
    });
  }

  /** Give back the unused part of a charge once the launch ended. Never below zero; the slice itself is not changed. */
  refundLaunch(chainId: string, childMissionId: string, kind: LaunchKind, seconds: number, now: number): ChildAllocation {
    this.clock(now);
    if (!Number.isSafeInteger(seconds) || seconds < 0) fail("invalid_allocation");
    return this.write(() => {
      const chain = this.get(chainId);
      const allocations = this.allocationsOf(chain);
      const slice = allocations[childMissionId] ?? fail("allocation_missing");
      const next = kind === "executor" ? { ...slice, executor_used: Math.max(0, slice.executor_used - seconds) } : { ...slice, container_used: Math.max(0, slice.container_used - seconds) };
      allocations[childMissionId] = next;
      this.update(chain, { spent_json: JSON.stringify({ allocations }) }, "launch_refunded", { head: chain.published_head, base: chain.published_base }, now);
      return next;
    });
  }

  private allocationsOf(chain: RevisionChain): Record<string, ChildAllocation> {
    if (chain.spent_json === null) return {};
    try {
      const raw = (JSON.parse(chain.spent_json) as { allocations?: unknown }).allocations;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("spent_unreadable");
      const out: Record<string, ChildAllocation> = {};
      for (const [child, v] of Object.entries(raw as Record<string, Partial<ChildAllocation>>)) {
        const fields = [v.executor_seconds, v.container_seconds, v.executor_used, v.container_used];
        if (!fields.every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return fail("spent_unreadable");
        out[child] = { executor_seconds: v.executor_seconds!, container_seconds: v.container_seconds!, executor_used: v.executor_used!, container_used: v.container_used! };
      }
      return out;
    } catch (error) { return error instanceof RevisionChainError ? fail(error.code) : fail("spent_unreadable"); }
  }
  private budgetOf(chain: RevisionChain) {
    try { return parseStoredGrant(chain.grant_json).budget; } catch { return fail("chain_grant_unreadable"); }
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
    this.assertGrantLive(chain);
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
    const denied = (): never => fail("transition_denied");
    // D12: only the targets decideChainStep can produce, per source state. A stopped or closed chain is only ever closed here;
    // leaving `awaiting_decision` for a live state is a human decision (and `update` refuses it while a push receipt is unsettled, D1).
    // (A closed chain is refused by the database, `chain_terminal`.)
    const stopped = chain.state === "awaiting_decision";
    switch (d.kind) {
      case "reserve": case "would_reserve": if (!onPublished) stale(); return;
      case "transition":
        if (d.to === "closed") { if (d.published_head !== undefined || d.published_base !== undefined) stale(); return; } // closing never carries a new head
        if (stopped) denied();
        if (d.published_head !== undefined) {
          // Accepting a new head: live only, and only the head of the confirmed push intent that extends exactly the published
          // head and base (D3). An earlier confirmed head an outsider force-pushed back to is not a legitimate head.
          if (chain.mode !== "live" || d.base !== chain.published_base || !refSame || d.published_head !== d.head || (d.published_base ?? d.base) !== d.base
            || !this.db.prepare(`SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state='confirmed'
              AND new_head=? AND expected_old_head=? AND expected_base_sha=?`).get(chain.chain_id, d.published_head, chain.published_head, d.base)) stale();
          if (d.to !== "awaiting_review") denied();
          return;
        }
        if (!onPublished) stale();
        if (!((d.to === "ready_for_human" && chain.state === "awaiting_review") || (d.to === "awaiting_review" && chain.state === "ready_for_human"))) denied();
        return;
      case "stop":
        if (stopped) denied();
        if (d.reason === "attribution_unknown" || d.reason === "external_write" || d.reason === "head_regressed") { if (d.head === chain.published_head) stale(); }
        else if (d.reason === "base_changed") { if (d.base === chain.published_base && refSame && d.head === chain.published_head) stale(); }
        else if (!onPublished) stale();
        return;
    }
  }

  /** A live grant is usable only before its `expires_at` (ms, per the injected clock). Grants without the field never expire here. */
  private assertGrantLive(chain: RevisionChain): void {
    if (chain.mode !== "live") return;
    const expires = (JSON.parse(chain.grant_json) as { expires_at?: unknown }).expires_at;
    if (typeof expires === "number" && this.clockMs() >= expires) fail("grant_expired");
  }
  /** `bound`: the confirmation also moved the chain. A cancelled child is then left to the caller's explicit
   * `voidReservation(..., 'published_after_cancel')` (appendix 4.1 item 3, first row), which would otherwise find the row void. */
  private settlePublishedReservation(intent: PublicationIntent, bound: boolean, now: number): void {
    if (intent.child_mission_id === null) return;
    const terminal = bound ? "'pr_opened','abandoned','failed'" : "'pr_opened','cancelled','abandoned','failed'";
    const done = this.db.prepare(`SELECT 1 FROM engineering_contained_missions WHERE mission_id=? AND state IN (${terminal}) AND stop_obligation=0`).get(intent.child_mission_id);
    if (!done) return;
    this.db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='published',updated_at=? WHERE chain_id=? AND child_mission_id=? AND state='dispatched'")
      .run(now, intent.chain_id, intent.child_mission_id);
  }

  private update(chain: RevisionChain, patch: Patch, reason: string, at: { head: string; base: string }, now: number): RevisionChain {
    const next = { ...chain, ...patch };
    // D1: a stopped chain does not resume while a push receipt may still land (a pending push may be on the remote, an uncertain one is).
    if (chain.state === "awaiting_decision" && next.state !== "awaiting_decision" && next.state !== "closed"
      && this.db.prepare("SELECT 1 FROM engineering_publication_intents WHERE chain_id=? AND kind='push' AND state IN ('pending','uncertain')").get(chain.chain_id)) fail("intent_unsettled");
    const stop = next.state === "awaiting_decision" ? (patch.stop_reason ?? chain.stop_reason) : next.state === "closed" ? (patch.stop_reason ?? null) : null;
    // grant_json is named in the SET list only for a re-grant, so every other update stays clear of the grant triggers.
    const grant = patch.grant_json !== undefined;
    const spent = patch.spent_json !== undefined;
    this.db.prepare(`UPDATE engineering_revision_chains SET state=?,stop_reason=?,published_head=?,published_base=?,rounds_used=?,current_mission_id=?,
      ${grant ? "grant_json=?,review_deadline=?," : ""}${spent ? "spent_json=?," : ""}revision=revision+1,updated_at=? WHERE chain_id=? AND revision=?`)
      .run(next.state, stop, next.published_head, next.published_base, next.rounds_used, next.current_mission_id,
        ...(grant ? [patch.grant_json, patch.review_deadline ?? chain.review_deadline] : []), ...(spent ? [patch.spent_json] : []), now, chain.chain_id, chain.revision);
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

  /** Stopped live chains in stable cursor order; open-chain scans retain their existing semantics. */
  listStoppedLive(limit = 10, after?: { updated_at: number; chain_id: string }): RevisionChain[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit");
    return this.db.prepare(`SELECT * FROM engineering_revision_chains WHERE mode='live' AND state='awaiting_decision'
      AND (updated_at>? OR (updated_at=? AND chain_id>?)) ORDER BY updated_at,chain_id LIMIT ?`)
      .all(after?.updated_at ?? -1, after?.updated_at ?? -1, after?.chain_id ?? "", limit) as RevisionChain[];
  }
  /** Closed PR chains whose child may still need a cancellation request. */
  listClosedPrLive(limit = 10, after?: { updated_at: number; chain_id: string }): RevisionChain[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit");
    return this.db.prepare(`SELECT * FROM engineering_revision_chains WHERE mode='live' AND state='closed'
      AND stop_reason IN ('pr_merged','pr_closed') AND current_mission_id IS NOT NULL
      AND (updated_at>? OR (updated_at=? AND chain_id>?)) ORDER BY updated_at,chain_id LIMIT ?`)
      .all(after?.updated_at ?? -1, after?.updated_at ?? -1, after?.chain_id ?? "", limit) as RevisionChain[];
  }
}

interface Patch {
  state?: ChainState; stop_reason?: string | null; published_head?: string; published_base?: string;
  rounds_used?: number; current_mission_id?: string | null; grant_json?: string; review_deadline?: number | null; spent_json?: string;
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
