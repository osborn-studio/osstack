import { createHash } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AttentionStore } from "../state/attention-store.js";
import { openDb } from "../state/db.js";
import {
  RevisionChainError, RevisionChainStore, type PublicationIntent, type RevisionChain,
} from "../state/engineering-revision-chain-store.js";
import { decideChainStep, type ChainView, type PrSnapshot, type ProducerRegistry, type ReviewState, type SnapshotReview } from "./revision-chain.js";

/** Random interleavings against a real ledger (design §10.2 invariants 1-4 and 6; invariant 5 is phase 5).
 * The world is a tiny model of GitHub: a head lineage, a base, a PR state and a review list. The reconciler under test
 * is `decideChainStep` + `RevisionChainStore`; the "publisher" drives live chains through the store's live API. */

const RUNS = Number(process.env.OSSTACK_PROPERTY_RUNS ?? 1000);
const SEED = process.env.OSSTACK_PROPERTY_SEED === undefined ? undefined : Number(process.env.OSSTACK_PROPERTY_SEED);
const HOUR = 3_600_000;
const REGISTRY: ProducerRegistry = { publisher: [{ actor_id: 9, app_id: null }], reviewers: [{ actor_id: 1, app_id: 11 }, { actor_id: 2, app_id: null }] };
const WHO = [{ actor_id: 1, app_id: 11 }, { actor_id: 2, app_id: null }, { actor_id: 3, app_id: null }, { actor_id: 1, app_id: null }] as const;
const STATES: readonly ReviewState[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"];
const STOP_BY_OUTSIDER = new Set(["external_write", "head_regressed", "attribution_unknown"]);
const TERMINAL_CHILD = new Set(["pr_opened", "cancelled", "abandoned", "failed"]);

type Op =
  | { t: "review"; who: number; st: number; stale: number | null; fb: boolean }
  | { t: "tick"; hours: number }
  | { t: "ext"; force: boolean }
  | { t: "regress"; back: number }
  | { t: "base"; ref: boolean }
  | { t: "close"; merged: boolean }
  | { t: "cycle"; incomplete: boolean; moved: boolean; who: "A" | "B" }
  | { t: "race" }
  | { t: "crash" }
  | { t: "progress"; mode: "normal" | "nosettle" | "nointent" | "uncertain" }
  | { t: "forcePush" }
  | { t: "recover" }
  | { t: "cancel" }
  | { t: "expireGrant" }
  | { t: "goodRound"; who: number; approve: boolean; last: "normal" | "nosettle" | "nointent" | "uncertain" };

// Biased towards the productive path (registered reviewer, current head, real feedback) so that reservations, dispatch, publish and
// settle are reached often; the hostile operations are rarer but still frequent enough to interleave with every phase.
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 7, arbitrary: fc.record({ t: fc.constant("review" as const), who: fc.constantFrom(0, 0, 0, 1, 1, 1, 2, 3), st: fc.constantFrom(1, 1, 1, 0, 0, 2, 3), stale: fc.constantFrom(null, null, null, null, 0, 1, 2, 5), fb: fc.constantFrom(true, true, true, false) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("tick" as const), hours: fc.constantFrom(0, 0, 1, 12, 25, 30) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("ext" as const), force: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("regress" as const), back: fc.nat(4) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("base" as const), ref: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("close" as const), merged: fc.boolean() }) },
  { weight: 9, arbitrary: fc.record({ t: fc.constant("cycle" as const), incomplete: fc.nat(9).map(n => n === 0), moved: fc.nat(9).map(n => n === 0), who: fc.constantFrom("A" as const, "B" as const) }) },
  { weight: 2, arbitrary: fc.constant({ t: "race" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "crash" as const }) },
  { weight: 9, arbitrary: fc.record({ t: fc.constant("progress" as const), mode: fc.constantFrom("normal" as const, "normal" as const, "normal" as const, "normal" as const, "nosettle" as const, "nointent" as const, "uncertain" as const) }) },
  { weight: 1, arbitrary: fc.constant({ t: "forcePush" as const }) },
  { weight: 2, arbitrary: fc.constant({ t: "recover" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "cancel" as const }) },
  { weight: 1, arbitrary: fc.constant({ t: "expireGrant" as const }) },
  { weight: 5, arbitrary: fc.record({ t: fc.constant("goodRound" as const), who: fc.nat(1), approve: fc.nat(4).map(n => n === 0), last: fc.constantFrom("normal" as const, "normal" as const, "normal" as const, "nosettle" as const, "nointent" as const, "uncertain" as const) }) },
);
const configArb = fc.record({
  mode: fc.constantFrom("shadow" as const, "live" as const, "live" as const),
  rounds: fc.constantFrom(1 as const, 2 as const),
  deadline: fc.constantFrom("none" as const, "none" as const, "none" as const, "future" as const, "future" as const, "past" as const),
});

class World {
  head = "h0"; base_sha = "b0"; base_ref = "main"; state: "OPEN" | "MERGED" | "CLOSED" = "OPEN";
  reviews: SnapshotReview[] = []; history = ["h0"]; private parent = new Map<string, string | null>([["h0", null]]);
  private n = 0; private bn = 0;
  fresh(): string { this.n += 1; return `h${this.n}`; }
  push(head: string, force = false): void { this.parent.set(head, force ? null : this.head); this.head = head; this.history.push(head); }
  descends(head: string, ancestor: string): boolean {
    for (let h: string | null | undefined = head; h !== null && h !== undefined; h = this.parent.get(h)) if (h === ancestor) return true;
    return false;
  }
  /** Every commit on the modelled branch beyond the root, newest first: the full history of what the branch holds right now. */
  branchCommits(): string[] {
    const out: string[] = [];
    for (let h: string | null | undefined = this.head; h !== null && h !== undefined && h !== "h0"; h = this.parent.get(h)) out.push(h);
    return out;
  }
  moveBase(ref: boolean): void { this.bn += 1; if (ref) this.base_ref = `dev${this.bn}`; else this.base_sha = `b${this.bn}`; }
}

let db: ReturnType<typeof openDb>;
let storeA: RevisionChainStore; let storeB: RevisionChainStore;
let scopeId: string;
let counter = 0; let reviewCounter = 1;
const coverage = { runs: 0, multiCommit: 0, reserved: 0, dispatched: 0, confirmed: 0, uncertain: 0, ready: 0, shadowReserve: 0, stops: new Map<string, number>(), closed: 0 };

beforeAll(() => {
  db = openDb({ path: ":memory:" });
  db.pragma("synchronous=FULL"); // satisfies the durability guard; an in-memory database has no disk to flush
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, ":memory:");
  const owner = attention.claimOwner("owner");
  scopeId = (db.prepare("INSERT INTO attention_scopes(scope_id,task_id,repo_path,discovery_after,scan_complete,sampled_at,deadline,generation) VALUES('sc','t','/x','',1,1,1,1) RETURNING scope_id").get() as { scope_id: string }).scope_id;
  storeA = new RevisionChainStore(attention, owner);
  storeB = new RevisionChainStore(attention, owner); // a second reconciler (a "restart" is just another instance)
});
afterAll(() => { db.close(); });

function mission(state: "executing" | "failed" = "executing"): string {
  counter += 1; const id = `cm_p${counter}`;
  db.prepare(`INSERT INTO engineering_contained_missions(mission_id,scope_id,owner_principal_id,owner_client_session_id,spec_digest,spec_json,state,revision,stop_obligation,created_at,updated_at)
    VALUES(?,?,'p','s',?,'{}',?,1,?,1,1)`).run(id, scopeId, "0".repeat(64), state, state === "executing" ? 1 : 0);
  return id;
}
function finishChild(id: string): void {
  const m = db.prepare("SELECT state,stop_obligation FROM engineering_contained_missions WHERE mission_id=?").get(id) as { state: string; stop_obligation: number };
  if (!TERMINAL_CHILD.has(m.state)) db.prepare("UPDATE engineering_contained_missions SET state='failed',revision=revision+1 WHERE mission_id=?").run(id);
  if (m.stop_obligation === 1) db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(id);
}

interface Run {
  mode: "shadow" | "live"; chainId: string; w: World; now: number; initialHead: string; ourHeads: string[]; ranges: Map<string, string[]>;
  stopAt: { rounds: number; reservations: number; intents: number } | null; lastRevision: number;
}

function snapshotOf(w: World, incomplete: boolean, moved: boolean): PrSnapshot {
  return { pr_state: w.state, head: w.head, base_sha: w.base_sha, base_ref: w.base_ref, reviews: w.reviews, complete: !incomplete, moved };
}
function viewOf(store: RevisionChainStore, c: RevisionChain): ChainView {
  const grant = JSON.parse(c.grant_json) as { rounds?: number };
  const reserved = c.mode === "live" ? store.reservations(c.chain_id).map(r => r.head_sha)
    : store.shadowDecisions(c.chain_id).filter(d => d.action === "would_reserve").map(d => d.head_sha);
  return { mode: c.mode, state: c.state, published_head: c.published_head, published_base: c.published_base, base_ref: c.base_ref, rounds_used: c.rounds_used,
    grant_rounds: grant.rounds ?? null, review_deadline: c.review_deadline, reserved_heads: reserved };
}
function decideFor(r: Run, store: RevisionChainStore, c: RevisionChain, incomplete: boolean, moved: boolean) {
  const intents = r.mode === "live" ? store.intents(c.chain_id).filter(i => i.kind === "push") : [];
  const pending = intents.find(i => i.state === "pending" || i.state === "uncertain")?.new_head ?? undefined;
  // D3: only the confirmed intent extending the published head counts, not any earlier confirmed head.
  const confirmed = r.mode === "live" && store.nextConfirmedPushHead(c.chain_id) === r.w.head ? r.w.head : undefined;
  return decideChainStep(viewOf(store, c), snapshotOf(r.w, incomplete, moved), REGISTRY, r.now, {
    ...(confirmed !== undefined ? { confirmed_push_head: confirmed } : {}),
    ...(pending !== undefined ? { pending_push_head: pending } : {}),
    head_is_descendant: r.w.descends(r.w.head, c.published_head),
  });
}
function tolerate(fn: () => void): void {
  try { fn(); } catch (e) { if (!(e instanceof RevisionChainError && e.code === "version_conflict")) throw e; }
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function cycle(r: Run, store: RevisionChainStore, incomplete: boolean, moved: boolean): void {
  const c = store.get(r.chainId);
  store.applyDecision(c.chain_id, c.revision, decideFor(r, store, c, incomplete, moved), r.now);
}

function completePublish(r: Run, intent: PublicationIntent): void {
  const out = storeA.settleIntent(intent.intent_id, "confirmed", r.now);
  if (out.chain.state === "awaiting_review") {
    const res = storeA.reservations(r.chainId).find(x => x.state !== "void");
    if (res) {
      if (res.child_mission_id) finishChild(res.child_mission_id);
      storeA.voidReservation(r.chainId, storeA.get(r.chainId).revision, res.head_sha, "completed", r.now);
    }
  }
}
function pendingPush(r: Run): PublicationIntent | undefined {
  return storeA.intents(r.chainId).find(i => i.kind === "push" && i.state === "pending");
}
function recordPush(r: Run, c: RevisionChain, newHead: string, commits: string[] = [newHead]): PublicationIntent {
  const intent = storeA.recordIntent(c.chain_id, c.revision, { kind: "push", branch: c.branch, expected_old_head: c.published_head, new_head: newHead, expected_base_sha: c.published_base, child_mission_id: c.current_mission_id! }, r.now).intent;
  r.ranges.set(intent.intent_id, commits);
  return intent;
}

function progress(r: Run, mode: "normal" | "nosettle" | "nointent" | "uncertain"): void {
  if (r.mode !== "live") return;
  const c = storeA.get(r.chainId);
  if (c.state === "revision_reserved") {
    const res = storeA.reservations(r.chainId).find(x => x.state === "reserved")!;
    storeA.dispatch(c.chain_id, c.revision, res.head_sha, mission(), r.now);
  } else if (c.state === "revising") {
    const next = r.w.fresh();
    if (mode === "nointent") { if (r.w.state === "OPEN") { r.w.push(next); } return; } // pushed without an intent: indistinguishable from an outsider
    // Multi-commit revisions make the range assertion stronger than head membership.
    const commits = counter % 2 === 0 ? [next, r.w.fresh(), r.w.fresh()] : [next];
    recordPush(r, c, commits.at(-1)!, commits);
  } else if (c.state === "publishing") {
    const intent = pendingPush(r);
    if (!intent) { recordPush(r, c, r.w.fresh()); return; } // an earlier attempt failed: retry as a fresh intent
    if (r.ourHeads.includes(intent.new_head!)) return; // already pushed, receipt missing: only recovery may settle it
    if (r.w.state !== "OPEN" || r.w.head !== intent.expected_old_head || r.w.base_sha !== intent.expected_base_sha || r.w.base_ref !== c.base_ref) {
      storeA.settleIntent(intent.intent_id, "failed", r.now, "precondition"); return; // the lease / pre-read refuses the push
    }
    // Nothing the publisher pushes may land on a branch that already carries a commit it did not push.
    for (const commit of r.w.branchCommits()) expect(r.ourHeads, `foreign commit ${commit} under a publisher push`).toContain(commit);
    for (const commit of r.ranges.get(intent.intent_id)!) { r.w.push(commit); r.ourHeads.push(commit); }
    if (mode === "nosettle") return; // crash after the push, before the receipt
    if (mode === "uncertain") { storeA.settleIntent(intent.intent_id, "uncertain", r.now); return; }
    completePublish(r, intent);
  }
}
function recover(r: Run): void {
  if (r.mode !== "live") return;
  for (const intent of storeA.intents(r.chainId)) {
    if (intent.kind !== "push" || (intent.state !== "pending" && intent.state !== "uncertain")) continue;
    if (r.w.head === intent.new_head) completePublish(r, intent);
    else if (r.w.head === intent.expected_old_head && intent.state === "pending") storeA.settleIntent(intent.intent_id, "failed", r.now);
    else if (intent.state === "pending") storeA.settleIntent(intent.intent_id, "uncertain", r.now);
  }
}

function apply(r: Run, op: Op): void {
  const w = r.w;
  switch (op.t) {
    case "review": {
      const commit = op.stale === null ? w.head : w.history[op.stale % w.history.length]!;
      const id = reviewCounter++; const state = STATES[op.st]!;
      w.reviews = [...w.reviews, { review_id: id, state, submitted_at: r.now, review_commit: commit, reviewer: WHO[op.who]!, has_feedback: state === "CHANGES_REQUESTED" && op.fb, feedback_digest: state === "CHANGES_REQUESTED" && op.fb ? sha(`fb${id}`) : null }];
      return;
    }
    case "tick": r.now += op.hours * HOUR + 1; return;
    case "ext": if (w.state === "OPEN") w.push(w.fresh(), op.force); return;
    case "regress": { if (w.state === "OPEN") { const target = w.history[Math.max(0, w.history.length - 1 - (op.back % w.history.length))]!; if (target !== w.head) { w.head = target; w.history.push(target); } } return; }
    case "base": if (w.state === "OPEN") w.moveBase(op.ref); return;
    case "close": if (w.state === "OPEN") w.state = op.merged ? "MERGED" : "CLOSED"; return;
    case "cycle": cycle(r, op.who === "A" ? storeA : storeB, op.incomplete, op.moved); return;
    case "race": {
      // Two reconcilers read the same revision and decide independently; at most one write may win.
      const ca = storeA.get(r.chainId); const cb = storeB.get(r.chainId);
      const da = decideFor(r, storeA, ca, false, false); const db2 = decideFor(r, storeB, cb, false, false);
      tolerate(() => storeA.applyDecision(ca.chain_id, ca.revision, da, r.now));
      tolerate(() => storeB.applyDecision(cb.chain_id, cb.revision, db2, r.now));
      return;
    }
    case "crash": {
      const before = fingerprint(r);
      const c = storeA.get(r.chainId); const decision = decideFor(r, storeA, c, false, false);
      expect(() => db.transaction(() => { storeA.applyDecision(c.chain_id, c.revision, decision, r.now); throw Error("crash"); })()).toThrow("crash");
      expect(fingerprint(r)).toEqual(before); // nothing partial survives; the next cycle replays the same decision
      return;
    }
    case "progress": progress(r, op.mode); return;
    case "forcePush": {
      // A publisher that ignores the machine: the store must refuse an intent outside revising/publishing.
      const c = storeA.get(r.chainId);
      const attempt = (): void => { storeA.recordIntent(c.chain_id, c.revision, { kind: "push", branch: c.branch, expected_old_head: c.published_head, new_head: "zz", expected_base_sha: c.published_base }, r.now); };
      if (r.mode === "shadow") expect(attempt).toThrow("bridge_shadow_write_denied");
      else if (c.state === "revising" || c.state === "publishing") { /* legitimate; covered by progress */ }
      else expect(attempt).toThrow("state_denied");
      return;
    }
    case "recover": recover(r); return;
    case "cancel": case "expireGrant": {
      if (r.mode !== "live") return;
      const chain = storeA.get(r.chainId);
      if (chain.state === "closed" || chain.state === "awaiting_decision") return;
      if (op.t === "cancel" && chain.current_mission_id) finishChild(chain.current_mission_id);
      storeA.stopLive(chain.chain_id, chain.revision, op.t === "cancel" ? "child_cancelled" : "grant_expired", r.now);
      return;
    }
    case "goodRound": {
      // The whole productive path in one step: a qualifying review, a cycle, then the publisher drives the child to a confirmed push.
      apply(r, { t: "review", who: op.who, st: op.approve ? 0 : 1, stale: null, fb: true });
      apply(r, { t: "cycle", incomplete: false, moved: false, who: "A" });
      for (let i = 0; i < 3; i++) { apply(r, { t: "progress", mode: i === 2 ? op.last : "normal" }); checkInvariants(r); }
      apply(r, { t: "cycle", incomplete: false, moved: false, who: "B" });
      return;
    }
  }
}

function fingerprint(r: Run) {
  return {
    chain: storeA.get(r.chainId), events: storeA.events(r.chainId, 0, 500).length, decisions: storeA.shadowDecisions(r.chainId).length,
    reservations: storeA.reservations(r.chainId), intents: storeA.intents(r.chainId),
  };
}

function checkInvariants(r: Run): void {
  const c = storeA.get(r.chainId);
  const grant = JSON.parse(c.grant_json) as { rounds?: number; kind: string };
  const reservations = storeA.reservations(r.chainId);
  const intents = storeA.intents(r.chainId);
  // 1. rounds_used <= grant.rounds <= 2, and every consumed round has exactly one reservation.
  if (r.mode === "live") {
    expect(grant.rounds === 1 || grant.rounds === 2).toBe(true);
    expect(c.rounds_used).toBeLessThanOrEqual(grant.rounds!);
    expect(reservations).toHaveLength(c.rounds_used);
  } else {
    expect(c.rounds_used).toBe(0); expect(c.current_mission_id).toBeNull();
    expect(reservations).toHaveLength(0); expect(intents).toHaveLength(0);
    expect(["revision_reserved", "revising", "publishing"]).not.toContain(c.state);
  }
  // 2. at most one reservation per (repository, pr, head).
  expect(new Set(reservations.map(x => `${x.repository}#${x.pr_number}@${x.head_sha}`)).size).toBe(reservations.length);
  // A reservation is bound to registered CHANGES_REQUESTED reviews made on exactly the reserved head.
  for (const res of reservations) {
    for (const id of JSON.parse(res.review_ids_json) as number[]) {
      const rv = r.w.reviews.find(x => x.review_id === id);
      expect(rv, `review ${id}`).toBeDefined();
      expect(rv!.state).toBe("CHANGES_REQUESTED");
      expect(rv!.review_commit).toBe(res.head_sha);
      expect(REGISTRY.reviewers.some(p => p.actor_id === rv!.reviewer.actor_id && p.app_id === rv!.reviewer.app_id)).toBe(true);
    }
  }
  // 3. at most one in-flight reservation and at most one non-terminal child per chain.
  expect(reservations.filter(x => x.state !== "void").length).toBeLessThanOrEqual(1);
  const live = reservations.filter(x => x.child_mission_id).map(x => x.child_mission_id!)
    .filter(id => !TERMINAL_CHILD.has((db.prepare("SELECT state FROM engineering_contained_missions WHERE mission_id=?").get(id) as { state: string }).state));
  expect(live.length).toBeLessThanOrEqual(1);
  if (c.current_mission_id) expect(reservations.some(x => x.child_mission_id === c.current_mission_id)).toBe(true);
  // 4. after an outsider write the chain neither reserves nor publishes until a human decides.
  if (c.stop_reason !== null && STOP_BY_OUTSIDER.has(c.stop_reason) || r.stopAt) {
    const now = { rounds: c.rounds_used, reservations: reservations.length, intents: intents.length };
    if (!r.stopAt) r.stopAt = now;
    expect(now).toEqual(r.stopAt);
    expect(["awaiting_decision", "closed"]).toContain(c.state);
  }
  // Revision is strictly monotone.
  expect(c.revision).toBeGreaterThanOrEqual(r.lastRevision); r.lastRevision = c.revision;
  // A published head is the initial one or the new_head of a confirmed push intent (6, forward direction).
  if (c.published_head !== r.initialHead) expect(intents.some(i => i.kind === "push" && i.state === "confirmed" && i.new_head === c.published_head)).toBe(true);
}

/** After a complete cycle on an open PR, a head the chain cannot explain must have stopped it. */
function checkStopOnUnexplainedHead(r: Run): void {
  const c = storeA.get(r.chainId);
  if (r.w.state !== "OPEN" || c.state === "closed") return;
  const explained = r.w.head === c.published_head
    || (r.mode === "live" && storeA.intents(r.chainId).some(i => i.kind === "push" && (i.state === "pending" || i.state === "uncertain") && i.new_head === r.w.head));
  if (!explained) expect(c.state).toBe("awaiting_decision");
}

/** The modelled branch is the ground truth: while the chain is still active, every commit on it beyond the root was pushed by the
 * publisher under a confirmed intent; any other commit must already have stopped the chain. (The publisher's own pushes are checked
 * at push time in `progress`: never onto a branch holding a foreign commit.) */
function checkBranch(r: Run): void {
  const c = storeA.get(r.chainId);
  const confirmed = storeA.intents(r.chainId).filter(i => i.kind === "push" && i.state === "confirmed").flatMap(i => r.ranges.get(i.intent_id)!);
  if (r.w.state === "OPEN" && c.state !== "awaiting_decision" && c.state !== "closed") {
    expect(r.w.head).toBe(c.published_head);
    for (const commit of r.w.branchCommits()) expect(confirmed, `commit ${commit} on the branch`).toContain(commit);
    if (r.mode === "live") {
      const intents = storeA.intents(r.chainId).filter(i => i.state === "confirmed" && (i.kind === "open_pr" || i.kind === "push"));
      assertExactPublicationRanges(["h0", ...r.w.branchCommits().reverse()], intents, r.ranges);
    }
  }
}

function assertExactPublicationRanges(commits: string[], intents: PublicationIntent[], ranges: Map<string, string[]>): void {
  const baseline = intents.filter(i => i.kind === "open_pr");
  expect(baseline, "one confirmed baseline intent").toHaveLength(1);
  const ordered = [...intents].sort((a, b) => {
    if (a.kind === "open_pr") return -1;
    if (b.kind === "open_pr") return 1;
    return commits.indexOf(a.new_head!) - commits.indexOf(b.new_head!);
  });
  const journaled = ordered.flatMap(i => {
    const range = ranges.get(i.intent_id);
    expect(range, `range for ${i.intent_id}`).toBeDefined();
    expect(range!.at(-1)).toBe(i.new_head);
    return range!;
  });
  expect(journaled, "confirmed ranges exactly reproduce root-start..published-head").toEqual(commits);
}

it("rejects a missing baseline, missing intermediate commit and reordered range", () => {
  const baseline = { intent_id: "baseline", kind: "open_pr", state: "confirmed", new_head: "root" } as PublicationIntent;
  const push = { intent_id: "push", kind: "push", state: "confirmed", new_head: "last" } as PublicationIntent;
  const ranges = new Map([["baseline", ["root"]], ["push", ["middle", "last"]]]);
  expect(() => assertExactPublicationRanges(["root", "middle", "last"], [push], ranges)).toThrow();
  expect(() => assertExactPublicationRanges(["root", "middle", "last"], [baseline, push], new Map([["baseline", ["root"]], ["push", ["last"]]]))).toThrow();
  expect(() => assertExactPublicationRanges(["root", "middle", "last"], [baseline, push], new Map([["baseline", ["root"]], ["push", ["last", "middle"]]]))).toThrow();
  assertExactPublicationRanges(["root", "middle", "last"], [baseline, push], ranges);
});

function runOne(config: { mode: "shadow" | "live"; rounds: 1 | 2; deadline: "none" | "past" | "future" }, ops: Op[]): void {
  const w = new World(); const now = 5 * HOUR;
  counter += 1;
  const root = mission("failed");
  const deadline = config.deadline === "none" ? null : config.deadline === "past" ? now - 1 : now + 6 * HOUR;
  const base = { root_mission_id: root, repository: "o/r", pr_number: counter, branch: "osstack/mission/x", base_ref: "main", published_head: "h0", published_base: "b0", trace_id: "t", review_deadline: deadline };
  const chain = config.mode === "live" ? storeA.createLiveChain({ ...base, grant: { rounds: config.rounds } }, now) : storeA.createShadowChain(base, now);
  const r: Run = { mode: config.mode, chainId: chain.chain_id, w, now, initialHead: "h0", ourHeads: [], ranges: new Map(), stopAt: null, lastRevision: 1 };
  if (config.mode === "live") {
    const baseline = storeA.recordIntent(chain.chain_id, chain.revision, { kind: "open_pr", branch: chain.branch,
      expected_old_head: "root-start", new_head: "h0", expected_base_sha: "b0" }, now).intent;
    r.ranges.set(baseline.intent_id, ["h0"]);
    storeA.settleIntent(baseline.intent_id, "confirmed", now);
  }
  for (const op of ops) {
    apply(r, op);
    checkInvariants(r);
    if (op.t === "cycle" && !op.incomplete && !op.moved && r.w.state === "OPEN") checkStopOnUnexplainedHead(r);
  }
  const end = storeA.get(r.chainId);
  coverage.runs += 1; if (end.state === "ready_for_human") coverage.ready += 1; if (end.state === "closed") coverage.closed += 1;
  if (end.stop_reason) coverage.stops.set(end.stop_reason, (coverage.stops.get(end.stop_reason) ?? 0) + 1);
  coverage.multiCommit += [...r.ranges.values()].filter(range => range.length > 1).length;
  coverage.reserved += storeA.reservations(r.chainId).length;
  coverage.dispatched += storeA.reservations(r.chainId).filter(x => x.child_mission_id).length;
  coverage.confirmed += storeA.intents(r.chainId).filter(i => i.kind === "push" && i.state === "confirmed").length;
  coverage.uncertain += storeA.intents(r.chainId).filter(i => i.state === "uncertain").length;
  coverage.shadowReserve += storeA.shadowDecisions(r.chainId).filter(d => d.action === "would_reserve").length;
  // Reconcile, then one last complete cycle, then judge the branch as a whole (invariants 4 and 6).
  recover(r);
  if (r.w.state === "OPEN") cycle(r, storeA, false, false);
  recover(r);
  checkInvariants(r);
  checkBranch(r);
  if (r.mode === "live") {
    const intents = storeA.intents(r.chainId).filter(i => i.kind === "push");
    for (const head of r.ourHeads) {
      const intent = intents.find(i => r.ranges.get(i.intent_id)?.includes(head))!;
      expect(intent, `intent for ${head}`).toBeDefined();
      if (intent.state === "uncertain") expect(r.w.head).not.toBe(intent.new_head); // a human reconciles it; the branch moved on
      else if (intent.state === "failed") expect(r.w.descends(r.w.head, intent.new_head!)).toBe(false); // the commit left the branch (an outsider reverted it)
      else expect(intent.state).toBe("confirmed");
    }
    for (const i of intents.filter(x => x.state === "confirmed")) expect(r.ourHeads).toContain(i.new_head);
    expect(intents.every(i => i.state !== "pending")).toBe(true);
  }
}

it(`keeps the chain invariants over ${RUNS} random interleavings`, () => {
  fc.assert(fc.property(configArb, fc.array(opArb, { minLength: 1, maxLength: 36 }), (config, ops) => { runOne(config, ops); }),
    { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) });
  if (process.env.OSSTACK_PROPERTY_COVERAGE) console.log(JSON.stringify({ ...coverage, stops: Object.fromEntries(coverage.stops) }));
  // The generator must actually reach the interesting states, or the invariants above prove nothing.
  if (RUNS >= 500) {
    expect(coverage.reserved).toBeGreaterThan(0); expect(coverage.dispatched).toBeGreaterThan(0); expect(coverage.confirmed).toBeGreaterThan(0);
    expect(coverage.multiCommit).toBeGreaterThan(0); expect(coverage.uncertain).toBeGreaterThan(0); expect(coverage.ready).toBeGreaterThan(0); expect(coverage.shadowReserve).toBeGreaterThan(0);
    for (const reason of ["external_write", "attribution_unknown", "base_changed", "reviewer_conflict", "rounds_exhausted"]) expect(coverage.stops.get(reason) ?? 0, reason).toBeGreaterThan(0);
  }
}, 3_600_000);
