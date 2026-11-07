import { generateKeyPairSync } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GRANT_NOW, samplePreview } from "../bridge/revision-grant-fixtures.js";
import { signRevisionGrant, type RevisionGrant, type RevisionGrantPreview } from "../bridge/revision-grant.js";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "./attention-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";
import { openDb } from "./db.js";
import { RevisionChainStore, type RevisionChain } from "./engineering-revision-chain-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const H1 = "1".repeat(40); const B1 = "b".repeat(40);
const NOW = GRANT_NOW + 1000;
const key = generateKeyPairSync("ed25519").privateKey;
let counter = 0;
const gid = () => { counter += 1; return `rg_00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`; };

function setup() {
  const root = realpathSync(createScratchDirSync("tests", "grant"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal: EngineeringPrincipal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const missions = new ContainedMissionStore(attention, owner);
  const store = new RevisionChainStore(attention, owner);
  let n = 0;
  const mission = () => { n += 1; return missions.authorize(principal, { scope_id: scope.scope_id, spec: { goal: `g${n}` }, claim: { repo_identity: "repo", branch: `b${n}`, worktree_identity: `w${n}` } }, 1000).mission_id; };
  let pr = 40;
  /** A live chain carrying a really signed grant bound to its columns. */
  const live = (over: Partial<RevisionGrantPreview> = {}) => {
    pr += 1; const rootId = mission();
    const grant = signRevisionGrant(samplePreview({ grant_id: gid(), root_mission_id: rootId, scope_id: scope.scope_id, pr_number: pr, ...over }), key);
    const chain = store.createLiveChain({ root_mission_id: rootId, repository: "o/r", pr_number: pr, branch: grant.branch, base_ref: "main", published_head: H1, published_base: B1,
      trace_id: "tr", review_deadline: grant.issued_at + grant.review_deadline_ms, budget_origin: grant.issued_at, grant }, GRANT_NOW);
    return { chain, grant };
  };
  /** The next grant for `chain`, as `grant-revisions --chain` would sign it. */
  const renew = (chain: RevisionChain, grant: RevisionGrant, over: Partial<RevisionGrantPreview> = {}): RevisionGrant =>
    signRevisionGrant(samplePreview({ ...(({ preview_sha256: _a, signature: _b, ...p }) => p)(grant), grant_id: gid(), issued_at: NOW, expires_at: NOW + 3_600_000,
      renews: { chain_id: chain.chain_id, revision: chain.revision }, ...over }), key);
  const finish = (id: string, state: "failed" | "cancelled" = "failed", stopProven = true) => {
    db.prepare("UPDATE engineering_contained_missions SET state=?,stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(state, id);
    if (stopProven) db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(id);
  };
  const reserveAndDispatch = (chain: RevisionChain) => {
    const reserved = store.reserve(chain.chain_id, chain.revision, { head: chain.published_head, review_ids: [7], feedback_digest: "d".repeat(64) }, NOW);
    const child = mission();
    return { child, chain: store.dispatch(chain.chain_id, reserved.chain.revision, chain.published_head, child, NOW).chain };
  };
  return { db, path, root, attention, owner, scope, principal, store, mission, live, renew, finish, reserveAndDispatch };
}
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); } return "no_error"; };


const child = (f: ReturnType<typeof setup>) => f.reserveAndDispatch(f.live({ budget: { max_executor_seconds: 3600, max_container_seconds: 600, max_wall_clock_hours: 48 } }).chain);

it("gives the dispatched child its slice once, only for the current child, and never beyond the grant", () => {
  const f = setup();
  const { chain: live } = f.live({ budget: { max_executor_seconds: 3600, max_container_seconds: 600, max_wall_clock_hours: 48 } });
  const { chain, child } = f.reserveAndDispatch(live);
  expect(f.store.remainingBudget(chain.chain_id)).toEqual({ executor_seconds: 3600, container_seconds: 600 });
  const other = f.mission();
  expect(code(() => f.store.allocateChild(chain.chain_id, chain.revision, other, { executor_seconds: 10, container_seconds: 10 }, NOW))).toBe("allocation_child_mismatch");
  expect(code(() => f.store.allocateChild(chain.chain_id, chain.revision, child, { executor_seconds: 3601, container_seconds: 10 }, NOW))).toBe("budget_exhausted");
  expect(code(() => f.store.allocateChild(chain.chain_id, chain.revision, child, { executor_seconds: 0, container_seconds: 10 }, NOW))).toBe("invalid_allocation");
  const allocated = f.store.allocateChild(chain.chain_id, chain.revision, child, { executor_seconds: 1800, container_seconds: 360 }, NOW);
  expect(f.store.allocations(chain.chain_id)[child]).toEqual({ executor_seconds: 1800, container_seconds: 360, executor_used: 0, container_used: 0 });
  expect(allocated.revision).toBe(chain.revision + 1);
  expect(code(() => f.store.allocateChild(chain.chain_id, allocated.revision, child, { executor_seconds: 1, container_seconds: 1 }, NOW))).toBe("allocation_exists");
  // The slice is reserved against the chain while the child is not terminal.
  expect(f.store.remainingBudget(chain.chain_id)).toEqual({ executor_seconds: 1800, container_seconds: 240 });
});

it("charges before a launch, refuses at the slice, refunds only what was unused, and returns the unspent rest once the child is settled", () => {
  const f = setup();
  const { chain, child: id } = child(f);
  f.store.allocateChild(chain.chain_id, chain.revision, id, { executor_seconds: 1200, container_seconds: 240 }, NOW);
  expect(f.store.chargeLaunch(chain.chain_id, id, "executor", 600, NOW).executor_used).toBe(600);
  expect(f.store.chargeLaunch(chain.chain_id, id, "executor", 600, NOW).executor_used).toBe(1200);
  expect(code(() => f.store.chargeLaunch(chain.chain_id, id, "executor", 1, NOW))).toBe("budget_exhausted");
  expect(f.store.allocations(chain.chain_id)[id]!.executor_used).toBe(1200);
  expect(f.store.refundLaunch(chain.chain_id, id, "executor", 500, NOW).executor_used).toBe(700);
  expect(f.store.refundLaunch(chain.chain_id, id, "executor", 99_999, NOW).executor_used).toBe(0);
  expect(f.store.chargeLaunch(chain.chain_id, id, "container", 120, NOW).container_used).toBe(120);
  expect(code(() => f.store.chargeLaunch(chain.chain_id, id, "container", 121, NOW))).toBe("budget_exhausted");
  expect(code(() => f.store.chargeLaunch(chain.chain_id, f.mission(), "executor", 5, NOW))).toBe("allocation_child_mismatch");
  expect(f.store.remainingBudget(chain.chain_id).executor_seconds).toBe(3600 - 1200);
  f.finish(id);
  expect(f.store.remainingBudget(chain.chain_id)).toEqual({ executor_seconds: 3600 - 0, container_seconds: 600 - 120 });
  // An unproven stop keeps the whole slice counted.
  const g = setup(); const second = child(g);
  g.store.allocateChild(second.chain.chain_id, second.chain.revision, second.child, { executor_seconds: 1200, container_seconds: 240 }, NOW);
  g.finish(second.child, "failed", false);
  expect(g.store.remainingBudget(second.chain.chain_id).executor_seconds).toBe(3600 - 1200);
});

it("tops up the same child's slice on a budget re-grant by exactly the raise, keeping what it used", () => {
  const f = setup();
  const { chain: created, grant } = f.live({ rounds: 2, budget: { max_executor_seconds: 1800, max_container_seconds: 360, max_wall_clock_hours: 48 } });
  const { chain, child: id } = f.reserveAndDispatch(created);
  f.store.allocateChild(chain.chain_id, chain.revision, id, { executor_seconds: 1800, container_seconds: 360 }, NOW);
  f.store.chargeLaunch(chain.chain_id, id, "executor", 1800, NOW);
  const stopped = f.store.stopLive(chain.chain_id, f.store.get(chain.chain_id).revision, "budget_exhausted", NOW);
  const renewed = f.renew(stopped, grant, { budget: { max_executor_seconds: 3000, max_container_seconds: 360, max_wall_clock_hours: 48 } });
  const result = f.store.replaceGrant(stopped.chain_id, stopped.revision, renewed, NOW);
  expect(result.chain).toMatchObject({ state: "awaiting_decision", stop_reason: "child_halted" });
  expect(f.store.allocations(chain.chain_id)[id]).toEqual({ executor_seconds: 3000, container_seconds: 360, executor_used: 1800, container_used: 0 });
  expect(JSON.parse(f.store.events(chain.chain_id, 0, 500).filter(e => e.kind === "grant_replaced").at(-1)!.payload_json).top_up).toEqual({ executor_seconds: 1200, container_seconds: 0 });
  expect(f.store.chargeLaunch(chain.chain_id, id, "executor", 1200, NOW).executor_used).toBe(3000);
  expect(code(() => f.store.chargeLaunch(chain.chain_id, id, "executor", 1, NOW))).toBe("budget_exhausted");
});

it("does not top up for a stop that is not about budget, and refuses a budget re-grant that raises nothing", () => {
  const f = setup();
  const { chain: created, grant } = f.live({ rounds: 2 });
  const { chain, child: id } = f.reserveAndDispatch(created);
  f.store.allocateChild(chain.chain_id, chain.revision, id, { executor_seconds: 1800, container_seconds: 360 }, NOW);
  const stopped = f.store.stopLive(chain.chain_id, f.store.get(chain.chain_id).revision, "grant_expired", NOW);
  f.store.replaceGrant(stopped.chain_id, stopped.revision, f.renew(stopped, grant), NOW);
  expect(f.store.allocations(chain.chain_id)[id]).toMatchObject({ executor_seconds: 1800, container_seconds: 360 });
  f.db.prepare("UPDATE engineering_revision_chains SET stop_reason='budget_exhausted',revision=revision+1 WHERE chain_id=?").run(chain.chain_id);
  const again = f.store.get(chain.chain_id);
  expect(code(() => f.store.replaceGrant(again.chain_id, again.revision, f.renew(again, grant), NOW))).toBe("budget_not_raised");
});

it("rolls an allocation back with the rest of an outer transaction", () => {
  const f = setup();
  const { chain: created } = f.live();
  const { chain, child: id } = f.reserveAndDispatch(created);
  expect(code(() => f.store.transaction(() => {
    f.store.allocateChild(chain.chain_id, chain.revision, id, { executor_seconds: 100, container_seconds: 100 }, NOW);
    throw Error("crash");
  }))).toBe("crash");
  expect(f.store.allocations(chain.chain_id)).toEqual({});
  expect(f.store.get(chain.chain_id).revision).toBe(chain.revision);
});

it("lets a halted Mission re-enter candidate_ready only as the very candidate it halted on", () => {
  const f = setup();
  const m = f.mission();
  const id = m;
  const walk = (rev: number, to: Parameters<ContainedMissionStore["transition"]>[1]["to"], extra: Record<string, unknown> = {}) =>
    new ContainedMissionStore(f.attention, f.owner).transition(id, { if_revision: rev, to, event: { kind: `to_${to}`, payload: {} }, ...extra } as never, 2000).revision;
  const store = new ContainedMissionStore(f.attention, f.owner);
  let rev = store.get(id).revision;
  rev = walk(rev, "workspace_ready"); rev = walk(rev, "executing", { expected_head: H1 });
  rev = store.recordStopEvidence(id, rev, {}, 2000).revision;
  const cand = { head: "2".repeat(40), tree: "3".repeat(40), diff_digest: "d".repeat(64) };
  rev = walk(rev, "candidate_ready", { candidate: cand });
  rev = walk(rev, "awaiting_decision");
  expect(code(() => walk(rev, "candidate_ready"))).toBe("candidate_unexpected");
  expect(code(() => walk(rev, "candidate_ready", { candidate: { ...cand, head: "4".repeat(40) } }))).toBe("candidate_unexpected");
  expect(code(() => walk(rev, "candidate_ready", { candidate: { ...cand, diff_digest: "e".repeat(64) } }))).toBe("candidate_unexpected");
  expect(store.get(id).state).toBe("awaiting_decision");
  walk(rev, "candidate_ready", { candidate: cand });
  expect(store.get(id)).toMatchObject({ state: "candidate_ready", candidate_head: cand.head, candidate_verified: 0 });
});
