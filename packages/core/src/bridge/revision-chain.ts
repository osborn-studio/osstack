import { createHash } from "node:crypto";

/** Pure revision-chain decision function (bridge phase 4-A, appendix §4). No I/O, no clock, no git:
 * everything the decision needs arrives as input, so shadow replay and live driving share it. */

export type ChainMode = "shadow" | "live";
export type ChainState =
  | "awaiting_review" | "revision_reserved" | "revising" | "publishing"
  | "ready_for_human" | "closed" | "awaiting_decision";
export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
export type PrState = "OPEN" | "MERGED" | "CLOSED";
export type ShadowAction = "would_reserve" | "would_mark_ready" | "would_stop";

/** Review expiry (design §8.4 rule 6). */
export const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export type DiscardReason =
  | "snapshot_incomplete" | "snapshot_moved" | "head_mismatch" | "base_changed" | "unregistered_reviewer"
  | "no_feedback" | "reviewer_conflict" | "expired" | "head_already_reserved";
export type StopReason =
  | "attribution_unknown" | "external_write" | "head_regressed" | "base_changed" | "reviewer_conflict"
  | "no_feedback" | "review_deadline" | "rounds_exhausted";
export type NoneReason =
  | DiscardReason | "no_review" | "chain_closed" | "awaiting_decision" | "in_flight" | "publish_in_progress" | "already_ready";

export interface ProducerIdentity { actor_id: number; app_id: number | null }
export interface ProducerRegistry { publisher: readonly ProducerIdentity[]; reviewers: readonly ProducerIdentity[] }

/** One review as the reader normalised it. Bodies are gone: only a digest and a presence flag remain. */
export interface SnapshotReview {
  review_id: number; state: ReviewState; submitted_at: number; review_commit: string;
  reviewer: { app_id: number | null; actor_id: number };
  has_feedback: boolean; feedback_digest: string | null;
}
export interface PrSnapshot {
  pr_state: PrState; head: string; base_sha: string; base_ref: string;
  reviews: readonly SnapshotReview[];
  /** Every connection was read to the end (design §8.4 rule 1). */
  complete: boolean;
  /** The second read before a reserve / ready decision saw a different head, base or review state. */
  moved: boolean;
}

export interface ChainView {
  mode: ChainMode; state: ChainState;
  published_head: string; published_base: string; base_ref: string;
  rounds_used: number;
  /** `grant.rounds` for a live chain; null for a shadow chain. */
  grant_rounds: number | null;
  review_deadline: number | null;
  /** Heads that already carry a reservation (live) or a recorded would_reserve (shadow). */
  reserved_heads: readonly string[];
}
export interface DecisionOptions {
  /** Live only: new_head of a `confirmed` push intent not yet reflected in `published_head`. */
  confirmed_push_head?: string;
  /** Live only: new_head of a `pending` push intent (the push may already be visible). */
  pending_push_head?: string;
  /** Live only: whether the observed head descends from `published_head`; the caller owns the git check. */
  head_is_descendant?: boolean;
}

export interface Discard { review_id: number; reason: DiscardReason }
interface Common { head: string; base: string; discards: readonly Discard[] }
export type ChainDecision =
  | { kind: "none"; reason: NoneReason; discards: readonly Discard[] }
  | (Common & { kind: "transition"; to: ChainState; reason: string; published_head?: string; published_base?: string;
      review_ids: readonly number[]; shadow_action?: "would_mark_ready" })
  | (Common & { kind: "stop"; to: "awaiting_decision"; reason: StopReason; review_ids: readonly number[]; shadow_action?: "would_stop" })
  | (Common & { kind: "reserve"; review_ids: readonly number[]; feedback_digest: string })
  | (Common & { kind: "would_reserve"; review_ids: readonly number[]; feedback_digest: string; back_to_review: boolean });

const IN_FLIGHT: ReadonlySet<ChainState> = new Set(["revision_reserved", "revising", "publishing"]);

export function sameProducer(a: ProducerIdentity, b: { actor_id: number; app_id: number | null }): boolean {
  return a.actor_id === b.actor_id && a.app_id === b.app_id;
}

interface Reduced { review: SnapshotReview; state: "APPROVED" | "CHANGES_REQUESTED" }

/** Design §8.4 rule 4: per registered reviewer, the latest APPROVED / CHANGES_REQUESTED on the current head.
 * COMMENTED changes nothing; DISMISSED clears. Reviews on other commits or from unregistered actors are discarded. */
export function reduceReviewers(head: string, reviews: readonly SnapshotReview[], registry: ProducerRegistry):
  { participating: Map<number, Reduced>; discards: Discard[] } {
  const discards: Discard[] = [];
  const byReviewer = new Map<number, SnapshotReview[]>();
  for (const review of reviews) {
    const registered = registry.reviewers.some(r => sameProducer(r, review.reviewer));
    if (!registered) { discards.push({ review_id: review.review_id, reason: "unregistered_reviewer" }); continue; }
    if (review.review_commit !== head) { discards.push({ review_id: review.review_id, reason: "head_mismatch" }); continue; }
    const list = byReviewer.get(review.reviewer.actor_id) ?? [];
    list.push(review); byReviewer.set(review.reviewer.actor_id, list);
  }
  const participating = new Map<number, Reduced>();
  for (const [actor, list] of byReviewer) {
    let current: Reduced | null = null;
    for (const review of [...list].sort((a, b) => a.submitted_at - b.submitted_at || a.review_id - b.review_id)) {
      if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") current = { review, state: review.state };
      else if (review.state === "DISMISSED") current = null;
    }
    if (current) participating.set(actor, current);
  }
  return { participating, discards };
}

function combineDigests(digests: readonly string[]): string {
  const sorted = [...digests].sort();
  return sorted.length === 1 ? sorted[0]! : createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export function decideChainStep(chain: ChainView, snapshot: PrSnapshot, registry: ProducerRegistry, now: number, opts: DecisionOptions = {}): ChainDecision {
  const shadow = chain.mode === "shadow";
  const none = (reason: NoneReason, discards: readonly Discard[] = []): ChainDecision => ({ kind: "none", reason, discards });
  const base = { head: snapshot.head, base: snapshot.base_sha };
  const stop = (reason: StopReason, discards: readonly Discard[] = [], review_ids: readonly number[] = []): ChainDecision => ({
    kind: "stop", to: "awaiting_decision", reason, ...base, discards, review_ids, ...(shadow ? { shadow_action: "would_stop" as const } : {}),
  });

  if (chain.state === "closed") return none("chain_closed");
  // Rule 1: an incomplete read decides nothing, not even a stop.
  if (!snapshot.complete) return none("snapshot_incomplete");
  if (snapshot.pr_state !== "OPEN") {
    return { kind: "transition", to: "closed", reason: snapshot.pr_state === "MERGED" ? "pr_merged" : "pr_closed", ...base, discards: [], review_ids: [] };
  }
  if (chain.state === "awaiting_decision") return none("awaiting_decision");

  // Head attribution (appendix §4.2 item 3): the timeline never attributes; only a confirmed push intent does.
  let headAccepted = false;
  if (snapshot.head !== chain.published_head) {
    if (shadow) return stop("attribution_unknown");
    if (opts.confirmed_push_head === snapshot.head) headAccepted = true;
    else if (opts.pending_push_head === snapshot.head) return none("publish_in_progress");
    else return stop(opts.head_is_descendant === false ? "head_regressed" : "external_write");
  }
  if (snapshot.base_sha !== chain.published_base || snapshot.base_ref !== chain.base_ref) return stop("base_changed");
  if (headAccepted) {
    return { kind: "transition", to: "awaiting_review", reason: "push_confirmed", ...base, published_head: snapshot.head, published_base: snapshot.base_sha, discards: [], review_ids: [] };
  }
  if (IN_FLIGHT.has(chain.state)) return none("in_flight");

  const { participating, discards } = reduceReviewers(chain.published_head, snapshot.reviews, registry);
  const states = [...participating.values()];
  const approved = states.filter(s => s.state === "APPROVED");
  const requested = states.filter(s => s.state === "CHANGES_REQUESTED");
  const ids = states.map(s => s.review.review_id).sort((a, b) => a - b);

  // Rule 5 first: a conflict is a stop whatever else is true.
  if (approved.length > 0 && requested.length > 0) return stop("reviewer_conflict", discards, ids);

  const waiting = chain.state === "awaiting_review";

  // Appendix §4.2 item 1: the participating set is non-empty and all APPROVED.
  if (approved.length > 0) {
    if (chain.state === "ready_for_human") return none("already_ready", discards);
    if (snapshot.moved) return none("snapshot_moved", discards);
    return { kind: "transition", to: "ready_for_human", reason: "all_participating_approved", ...base, discards, review_ids: ids,
      ...(shadow ? { shadow_action: "would_mark_ready" as const } : {}) };
  }

  if (requested.length > 0) {
    if (chain.reserved_heads.includes(chain.published_head)) return none("head_already_reserved", discards);
    const fresh = requested.filter(s => now < s.review.submitted_at + REVIEW_TTL_MS);
    if (fresh.length === 0) return none("expired", [...discards, ...requested.map(s => ({ review_id: s.review.review_id, reason: "expired" as const }))]);
    const withFeedback = fresh.filter(s => s.review.has_feedback && s.review.feedback_digest);
    if (withFeedback.length === 0) return stop("no_feedback", discards, fresh.map(s => s.review.review_id));
    if (!shadow && chain.grant_rounds !== null && chain.rounds_used >= chain.grant_rounds) return stop("rounds_exhausted", discards, ids);
    if (snapshot.moved) return none("snapshot_moved", discards);
    const review_ids = withFeedback.map(s => s.review.review_id).sort((a, b) => a - b);
    const feedback_digest = combineDigests(withFeedback.map(s => s.review.feedback_digest!));
    return shadow
      ? { kind: "would_reserve", ...base, discards, review_ids, feedback_digest, back_to_review: chain.state === "ready_for_human" }
      : { kind: "reserve", ...base, discards, review_ids, feedback_digest };
  }

  // Nobody participates (the deadline only bounds an unanswered wait). A chain that was ready lost its approvals (dismissed): back to waiting.
  if (chain.state === "ready_for_human") {
    return { kind: "transition", to: "awaiting_review", reason: "approval_withdrawn", ...base, discards, review_ids: [] };
  }
  if (waiting && chain.review_deadline !== null && now >= chain.review_deadline) return stop("review_deadline", discards);
  const reason: NoneReason = discards.some(d => d.reason === "unregistered_reviewer") ? "unregistered_reviewer"
    : discards.some(d => d.reason === "head_mismatch") ? "head_mismatch" : "no_review";
  return none(reason, discards);
}
