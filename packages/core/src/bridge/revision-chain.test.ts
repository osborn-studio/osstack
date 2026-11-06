import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decideChainStep, reduceReviewers, REVIEW_TTL_MS, sameProducer,
  type ChainDecision, type ChainView, type PrSnapshot, type ProducerRegistry, type SnapshotReview,
} from "./revision-chain.js";

const HEAD = "h1"; const HEAD2 = "h2"; const BASE = "b1"; const BASE2 = "b2";
const T0 = 1_000_000_000_000;
const REGISTRY: ProducerRegistry = {
  publisher: [{ actor_id: 9, app_id: null }],
  reviewers: [{ actor_id: 1, app_id: 11 }, { actor_id: 2, app_id: null }],
};
const A = { actor_id: 1, app_id: 11 }; const B = { actor_id: 2, app_id: null };

const chain = (over: Partial<ChainView> = {}): ChainView => ({
  mode: "live", state: "awaiting_review", published_head: HEAD, published_base: BASE, base_ref: "main",
  rounds_used: 0, grant_rounds: 2, review_deadline: null, reserved_heads: [], ...over,
});
const shadow = (over: Partial<ChainView> = {}) => chain({ mode: "shadow", grant_rounds: null, ...over });
let nextId = 1;
const review = (state: SnapshotReview["state"], reviewer: SnapshotReview["reviewer"] = A, over: Partial<SnapshotReview> = {}): SnapshotReview => {
  const id = nextId++;
  return { review_id: id, state, submitted_at: T0 + id, review_commit: HEAD, reviewer, has_feedback: state === "CHANGES_REQUESTED", feedback_digest: state === "CHANGES_REQUESTED" ? `${"d".repeat(63)}${id % 10}` : null, ...over };
};
const snap = (reviews: SnapshotReview[] = [], over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  pr_state: "OPEN", head: HEAD, base_sha: BASE, base_ref: "main", reviews, complete: true, moved: false, ...over,
});
const NOW = T0 + 60_000;
const decide = (c: ChainView, s: PrSnapshot, now = NOW, opts = {}) => decideChainStep(c, s, REGISTRY, now, opts);

function expectNone(d: ChainDecision, reason: string) { expect(d).toMatchObject({ kind: "none", reason }); }

describe("terminal, incomplete and closed handling", () => {
  it("does nothing for a closed chain", () => expectNone(decide(chain({ state: "closed" }), snap([review("CHANGES_REQUESTED")])), "chain_closed"));
  it("discards an incomplete snapshot before anything else, even a closed PR or a head change", () => {
    expectNone(decide(chain(), snap([], { complete: false, pr_state: "MERGED" })), "snapshot_incomplete");
    expectNone(decide(chain(), snap([], { complete: false, head: HEAD2 })), "snapshot_incomplete");
    expectNone(decide(shadow(), snap([review("CHANGES_REQUESTED")], { complete: false })), "snapshot_incomplete");
  });
  it.each(["awaiting_review", "ready_for_human", "revision_reserved", "revising", "publishing", "awaiting_decision"] as const)("closes %s on merge and on close", state => {
    for (const mode of ["live", "shadow"] as const) {
      const c = mode === "live" ? chain({ state }) : shadow({ state: state === "revision_reserved" || state === "revising" || state === "publishing" ? "awaiting_review" : state });
      expect(decide(c, snap([], { pr_state: "MERGED" }))).toMatchObject({ kind: "transition", to: "closed", reason: "pr_merged" });
      expect(decide(c, snap([], { pr_state: "CLOSED" }))).toMatchObject({ kind: "transition", to: "closed", reason: "pr_closed" });
    }
  });
  it("leaves a chain that already awaits a human decision alone", () => {
    expectNone(decide(chain({ state: "awaiting_decision" }), snap([review("CHANGES_REQUESTED")])), "awaiting_decision");
    expectNone(decide(chain({ state: "awaiting_decision" }), snap([], { head: HEAD2 })), "awaiting_decision");
  });
});

describe("head attribution (appendix 4.2 item 3)", () => {
  it("stops a shadow chain on any head change, normal or force", () => {
    for (const head of [HEAD2, "h-force"]) {
      expect(decide(shadow(), snap([], { head }))).toMatchObject({ kind: "stop", to: "awaiting_decision", reason: "attribution_unknown", shadow_action: "would_stop", head });
    }
    // Even a head change that live mode would accept.
    expect(decide(shadow(), snap([], { head: HEAD2 }), NOW, { confirmed_push_head: HEAD2 })).toMatchObject({ kind: "stop", reason: "attribution_unknown" });
  });
  it("accepts a live head change only with a matching confirmed push intent", () => {
    const d = decide(chain({ state: "publishing" }), snap([], { head: HEAD2 }), NOW, { confirmed_push_head: HEAD2 });
    expect(d).toMatchObject({ kind: "transition", to: "awaiting_review", reason: "push_confirmed", published_head: HEAD2, published_base: BASE });
    expect(decide(chain(), snap([], { head: HEAD2 }), NOW, { confirmed_push_head: "other" })).toMatchObject({ kind: "stop", reason: "external_write" });
  });
  it("stops with external_write for an unexplained head and head_regressed for a non-descendant", () => {
    expect(decide(chain(), snap([], { head: HEAD2 }))).toMatchObject({ kind: "stop", reason: "external_write" });
    expect(decide(chain(), snap([], { head: HEAD2 }), NOW, { head_is_descendant: true })).toMatchObject({ kind: "stop", reason: "external_write" });
    expect(decide(chain(), snap([], { head: HEAD2 }), NOW, { head_is_descendant: false })).toMatchObject({ kind: "stop", reason: "head_regressed" });
    expect(decide(chain({ state: "ready_for_human" }), snap([], { head: HEAD2 }))).toMatchObject({ kind: "stop", reason: "external_write" });
    expect(decide(chain({ state: "revising" }), snap([], { head: HEAD2 }))).toMatchObject({ kind: "stop", reason: "external_write" });
    // A live stop carries no shadow action.
    expect(decide(chain(), snap([], { head: HEAD2 }))).not.toHaveProperty("shadow_action");
  });
  it("waits while a pushed head matches a pending intent", () => {
    expectNone(decide(chain({ state: "publishing" }), snap([], { head: HEAD2 }), NOW, { pending_push_head: HEAD2 }), "publish_in_progress");
  });
  it("stops on a base change even when an accepted head arrives with it", () => {
    expect(decide(chain({ state: "publishing" }), snap([], { head: HEAD2, base_sha: BASE2 }), NOW, { confirmed_push_head: HEAD2 })).toMatchObject({ kind: "stop", reason: "base_changed" });
  });
});

describe("base changes (selection rule 2)", () => {
  it.each([["sha", { base_sha: BASE2 }], ["ref", { base_ref: "develop" }]] as const)("stops on a base %s change in both modes", (_n, over) => {
    expect(decide(chain(), snap([review("CHANGES_REQUESTED")], over))).toMatchObject({ kind: "stop", reason: "base_changed" });
    expect(decide(shadow(), snap([review("CHANGES_REQUESTED")], over))).toMatchObject({ kind: "stop", reason: "base_changed", shadow_action: "would_stop" });
    expect(decide(chain({ state: "ready_for_human" }), snap([], over))).toMatchObject({ kind: "stop", reason: "base_changed" });
    expect(decide(chain({ state: "revising" }), snap([], over))).toMatchObject({ kind: "stop", reason: "base_changed" });
  });
  it("does not select anything for in-flight states", () => {
    for (const state of ["revision_reserved", "revising", "publishing"] as const) expectNone(decide(chain({ state }), snap([review("CHANGES_REQUESTED")])), "in_flight");
  });
});

describe("reviewer reduction (selection rules 3 and 4)", () => {
  it("matches reviewers on the (actor, app) pair only", () => {
    expect(sameProducer({ actor_id: 1, app_id: 11 }, A)).toBe(true);
    expect(sameProducer({ actor_id: 1, app_id: 11 }, { actor_id: 1, app_id: null })).toBe(false);
    expect(sameProducer({ actor_id: 2, app_id: null }, { actor_id: 2, app_id: 5 })).toBe(false);
    expect(sameProducer({ actor_id: 2, app_id: null }, B)).toBe(true);
  });
  it("ignores an absent reviewer and an empty review list", () => {
    expectNone(decide(chain(), snap([])), "no_review");
    expectNone(decide(shadow(), snap([])), "no_review");
  });
  it("discards unregistered reviewers, including a registered actor id with the wrong app", () => {
    const d = decide(chain(), snap([review("CHANGES_REQUESTED", { actor_id: 77, app_id: null }), review("CHANGES_REQUESTED", { actor_id: 1, app_id: null }), review("APPROVED", { actor_id: 9, app_id: null })]));
    expectNone(d, "unregistered_reviewer");
    expect((d as unknown as { discards: unknown[] }).discards).toHaveLength(3);
  });
  it("lets COMMENTED change nothing", () => {
    expectNone(decide(chain(), snap([review("COMMENTED")])), "no_review");
    expect(decide(chain(), snap([review("CHANGES_REQUESTED"), review("COMMENTED")]))).toMatchObject({ kind: "reserve" });
    expect(decide(chain(), snap([review("APPROVED"), review("COMMENTED")]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
  });
  it("clears state on a later DISMISSED", () => {
    expectNone(decide(chain(), snap([review("CHANGES_REQUESTED"), review("DISMISSED")])), "no_review");
    expectNone(decide(chain(), snap([review("APPROVED"), review("DISMISSED")])), "no_review");
    // ...but a review after the dismissal counts again.
    expect(decide(chain(), snap([review("CHANGES_REQUESTED"), review("DISMISSED"), review("APPROVED")]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
  });
  it("takes the latest of approve and request by submission time, then review id", () => {
    expect(decide(chain(), snap([review("APPROVED"), review("CHANGES_REQUESTED")]))).toMatchObject({ kind: "reserve" });
    expect(decide(chain(), snap([review("CHANGES_REQUESTED"), review("APPROVED")]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
    const t = T0 + 5;
    const early = review("CHANGES_REQUESTED", A, { submitted_at: t, review_id: 50 });
    const late = review("APPROVED", A, { submitted_at: t, review_id: 51 });
    expect(decide(chain(), snap([late, early]))).toMatchObject({ kind: "transition", to: "ready_for_human" }); // input order does not matter
    const older = review("APPROVED", A, { submitted_at: t + 10, review_id: 1 });
    const newer = review("CHANGES_REQUESTED", A, { submitted_at: t + 20, review_id: 2 });
    expect(decide(chain(), snap([newer, older]))).toMatchObject({ kind: "reserve", review_ids: [2] });
  });
  it("ignores reviews on other commits", () => {
    const stale = review("CHANGES_REQUESTED", A, { review_commit: "old" });
    const d = decide(chain(), snap([stale]));
    expectNone(d, "head_mismatch");
    expect((d as unknown as { discards: unknown[] }).discards).toEqual([{ review_id: stale.review_id, reason: "head_mismatch" }]);
    // A stale approval never makes the head ready; a current request still wins.
    expect(decide(chain(), snap([review("APPROVED", A, { review_commit: "old" }), review("CHANGES_REQUESTED", B)]))).toMatchObject({ kind: "reserve" });
  });
  it("exposes the reduction for reuse", () => {
    const r = reduceReviewers(HEAD, [review("APPROVED", A), review("CHANGES_REQUESTED", B)], REGISTRY, NOW);
    expect([...r.participating.values()].map(p => p.state).sort()).toEqual(["APPROVED", "CHANGES_REQUESTED"]);
  });
});

describe("conflicts (rule 5)", () => {
  it("stops when one reviewer approves and another requests changes", () => {
    const rs = [review("APPROVED", A), review("CHANGES_REQUESTED", B)];
    expect(decide(chain(), snap(rs))).toMatchObject({ kind: "stop", reason: "reviewer_conflict" });
    expect(decide(shadow(), snap(rs))).toMatchObject({ kind: "stop", reason: "reviewer_conflict", shadow_action: "would_stop" });
    expect(decide(chain({ state: "ready_for_human" }), snap(rs))).toMatchObject({ kind: "stop", reason: "reviewer_conflict" });
  });
  it("is not a conflict when two reviewers both request changes or both approve", () => {
    expect(decide(chain(), snap([review("CHANGES_REQUESTED", A), review("CHANGES_REQUESTED", B)]))).toMatchObject({ kind: "reserve" });
    expect(decide(chain(), snap([review("APPROVED", A), review("APPROVED", B)]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
  });
});

describe("ready_for_human (appendix 4.2 item 1)", () => {
  it("is reached when the participating set is non-empty and all approved, ignoring non-participants", () => {
    const d = decide(chain(), snap([review("APPROVED", A), review("COMMENTED", B)]));
    expect(d).toMatchObject({ kind: "transition", to: "ready_for_human", reason: "all_participating_approved" });
    expect(d).not.toHaveProperty("shadow_action");
  });
  it("records would_mark_ready in shadow mode", () => {
    expect(decide(shadow(), snap([review("APPROVED")]))).toMatchObject({ kind: "transition", to: "ready_for_human", shadow_action: "would_mark_ready" });
  });
  it("is not reached with an empty set", () => expectNone(decide(chain(), snap([review("COMMENTED", A), review("DISMISSED", B)])), "no_review"));
  it("is discarded when the second read moved", () => {
    expectNone(decide(chain(), snap([review("APPROVED")], { moved: true })), "snapshot_moved");
    expectNone(decide(shadow(), snap([review("APPROVED")], { moved: true })), "snapshot_moved");
  });
  it("stays put once ready, and falls back when the approvals are withdrawn", () => {
    expectNone(decide(chain({ state: "ready_for_human" }), snap([review("APPROVED")])), "already_ready");
    expect(decide(chain({ state: "ready_for_human" }), snap([review("APPROVED"), review("DISMISSED")]))).toMatchObject({ kind: "transition", to: "awaiting_review", reason: "approval_withdrawn" });
    expect(decide(shadow({ state: "ready_for_human" }), snap([]))).toMatchObject({ kind: "transition", to: "awaiting_review" });
  });
  it("treats a fresh change request after ready as an awaiting_review selection", () => {
    const rs = [review("APPROVED", A), review("CHANGES_REQUESTED", A)];
    expect(decide(chain({ state: "ready_for_human" }), snap(rs))).toMatchObject({ kind: "reserve", head: HEAD });
    expect(decide(shadow({ state: "ready_for_human" }), snap(rs))).toMatchObject({ kind: "would_reserve", back_to_review: true });
    expect(decide(shadow(), snap(rs))).toMatchObject({ kind: "would_reserve", back_to_review: false });
  });
  it("expires an approval like any other review (rule 6): it neither marks ready nor creates a conflict", () => {
    const old = review("APPROVED", A, { submitted_at: NOW - REVIEW_TTL_MS });
    const d = decide(chain(), snap([old]));
    expectNone(d, "expired");
    expect((d as unknown as { discards: unknown[] }).discards).toEqual([{ review_id: old.review_id, reason: "expired" }]);
    expect(decide(chain(), snap([review("APPROVED", A, { submitted_at: NOW - REVIEW_TTL_MS + 1 })]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
    // An expired approval does not conflict with a fresh request, and the request proceeds.
    expect(decide(chain(), snap([old, review("CHANGES_REQUESTED", B)]))).toMatchObject({ kind: "reserve" });
    expect(decide(shadow(), snap([old, review("CHANGES_REQUESTED", B)]))).toMatchObject({ kind: "would_reserve" });
    // An expired request does not conflict with a fresh approval either.
    const oldRequest = review("CHANGES_REQUESTED", B, { submitted_at: NOW - REVIEW_TTL_MS - 5 });
    expect(decide(chain(), snap([oldRequest, review("APPROVED", A)]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
  });
  it("leaves a reviewer with no state when the latest review expired", () => {
    const latestExpired = review("APPROVED", A, { submitted_at: NOW - REVIEW_TTL_MS - 1 });
    expectNone(decide(chain(), snap([latestExpired])), "expired");
    // A ready chain whose only approval expired falls back to waiting for review.
    expect(decide(chain({ state: "ready_for_human" }), snap([latestExpired]))).toMatchObject({ kind: "transition", to: "awaiting_review", reason: "approval_withdrawn" });
  });
});

describe("reserve selection (rules 4 and 6)", () => {
  it("reserves a live chain on a qualifying request and binds head, base and digest", () => {
    const r = review("CHANGES_REQUESTED", A, { feedback_digest: "f".repeat(64) });
    expect(decide(chain(), snap([r]))).toEqual({ kind: "reserve", head: HEAD, base: BASE, base_ref: "main", discards: [], review_ids: [r.review_id], feedback_digest: "f".repeat(64) });
  });
  it("only records would_reserve in shadow mode and never reserves", () => {
    const d = decide(shadow(), snap([review("CHANGES_REQUESTED")]));
    expect(d).toMatchObject({ kind: "would_reserve", head: HEAD, base: BASE });
    expect(d.kind).not.toBe("reserve");
    expect(d).not.toHaveProperty("shadow_action");
  });
  it("combines digests of several requesting reviewers independent of order", () => {
    const a = review("CHANGES_REQUESTED", A, { feedback_digest: "a".repeat(64) });
    const b = review("CHANGES_REQUESTED", B, { feedback_digest: "b".repeat(64) });
    const expected = createHash("sha256").update(["a".repeat(64), "b".repeat(64)].join("\n")).digest("hex");
    for (const rs of [[a, b], [b, a]]) expect(decide(chain(), snap(rs))).toMatchObject({ kind: "reserve", feedback_digest: expected, review_ids: [a.review_id, b.review_id].sort((x, y) => x - y) });
  });
  it("uses only requests that carry feedback", () => {
    const a = review("CHANGES_REQUESTED", A, { has_feedback: false, feedback_digest: null });
    const b = review("CHANGES_REQUESTED", B, { feedback_digest: "b".repeat(64) });
    expect(decide(chain(), snap([a, b]))).toMatchObject({ kind: "reserve", review_ids: [b.review_id], feedback_digest: "b".repeat(64) });
  });
  it("hands an empty request to a human (no_feedback)", () => {
    const empty = review("CHANGES_REQUESTED", A, { has_feedback: false, feedback_digest: null });
    expect(decide(chain(), snap([empty]))).toMatchObject({ kind: "stop", reason: "no_feedback", to: "awaiting_decision" });
    expect(decide(shadow(), snap([empty]))).toMatchObject({ kind: "stop", reason: "no_feedback", shadow_action: "would_stop" });
    const noDigest = review("CHANGES_REQUESTED", A, { has_feedback: true, feedback_digest: null });
    expect(decide(chain(), snap([noDigest]))).toMatchObject({ kind: "stop", reason: "no_feedback" });
  });
  it("discards an expired request at exactly 24 hours and accepts it one millisecond earlier", () => {
    const r = review("CHANGES_REQUESTED", A, { submitted_at: T0 });
    expect(decide(chain(), snap([r]), T0 + REVIEW_TTL_MS - 1)).toMatchObject({ kind: "reserve" });
    const d = decide(chain(), snap([r]), T0 + REVIEW_TTL_MS);
    expectNone(d, "expired");
    expect((d as unknown as { discards: unknown[] }).discards).toEqual([{ review_id: r.review_id, reason: "expired" }]);
    expectNone(decide(shadow(), snap([r]), T0 + REVIEW_TTL_MS + 1), "expired");
  });
  it("skips a head that already carries a reservation, before any other discard", () => {
    expectNone(decide(chain({ reserved_heads: [HEAD] }), snap([review("CHANGES_REQUESTED")])), "head_already_reserved");
    expectNone(decide(shadow({ reserved_heads: [HEAD] }), snap([review("CHANGES_REQUESTED", A, { has_feedback: false, feedback_digest: null })])), "head_already_reserved");
    expect(decide(chain({ reserved_heads: ["other"] }), snap([review("CHANGES_REQUESTED")]))).toMatchObject({ kind: "reserve" });
  });
  it("discards when the second read moved", () => {
    expectNone(decide(chain(), snap([review("CHANGES_REQUESTED")], { moved: true })), "snapshot_moved");
    expectNone(decide(shadow(), snap([review("CHANGES_REQUESTED")], { moved: true })), "snapshot_moved");
  });
  it("hands a live chain with no rounds left to a human, but never a shadow chain", () => {
    expect(decide(chain({ rounds_used: 2, grant_rounds: 2 }), snap([review("CHANGES_REQUESTED")]))).toMatchObject({ kind: "stop", reason: "rounds_exhausted" });
    expect(decide(chain({ rounds_used: 1, grant_rounds: 1 }), snap([review("CHANGES_REQUESTED")]))).toMatchObject({ kind: "stop", reason: "rounds_exhausted" });
    expect(decide(chain({ rounds_used: 1, grant_rounds: 2 }), snap([review("CHANGES_REQUESTED")]))).toMatchObject({ kind: "reserve" });
    // Exhausted rounds do not block a pass on the last revision.
    expect(decide(chain({ rounds_used: 2, grant_rounds: 2 }), snap([review("APPROVED")]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
  });
});

describe("review deadline", () => {
  const nobody = snap([]);
  it("never fires when absent", () => expectNone(decide(chain({ review_deadline: null }), nobody, NOW + 1e12), "no_review"));
  it("fires when past or reached", () => {
    expect(decide(chain({ review_deadline: NOW - 1 }), nobody)).toMatchObject({ kind: "stop", reason: "review_deadline" });
    expect(decide(chain({ review_deadline: NOW }), nobody)).toMatchObject({ kind: "stop", reason: "review_deadline" });
    expect(decide(shadow({ review_deadline: NOW - 1 }), nobody)).toMatchObject({ kind: "stop", reason: "review_deadline", shadow_action: "would_stop" });
  });
  it("is quiet while still in the future", () => expectNone(decide(chain({ review_deadline: NOW + 1 }), nobody), "no_review"));
  it("only bounds an unanswered wait", () => {
    expect(decide(chain({ review_deadline: NOW - 1 }), snap([review("CHANGES_REQUESTED")]))).toMatchObject({ kind: "reserve" });
    expect(decide(chain({ review_deadline: NOW - 1 }), snap([review("APPROVED")]))).toMatchObject({ kind: "transition", to: "ready_for_human" });
    expectNone(decide(chain({ state: "ready_for_human", review_deadline: NOW - 1 }), snap([review("APPROVED")])), "already_ready");
    expectNone(decide(chain({ state: "revising", review_deadline: NOW - 1 }), nobody), "in_flight");
  });
});

describe("stop decisions carry what the store needs", () => {
  it("records the observed head and base on every stop and transition", () => {
    const d = decide(shadow(), snap([], { head: HEAD2, base_sha: BASE2 }));
    expect(d).toMatchObject({ kind: "stop", head: HEAD2, base: BASE2 });
    const m = decide(chain(), snap([], { pr_state: "MERGED", head: HEAD2 }));
    expect(m).toMatchObject({ kind: "transition", head: HEAD2, base: BASE });
  });
});
