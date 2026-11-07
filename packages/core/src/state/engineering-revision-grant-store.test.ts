import { generateKeyPairSync } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { GRANT_NOW, samplePreview } from "../bridge/revision-grant-fixtures.js";
import { signRevisionGrant, type RevisionGrant, type RevisionGrantPreview } from "../bridge/revision-grant.js";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "./attention-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import type { EngineeringPrincipal } from "./engineering-store.js";
import { openDb } from "./db.js";
import { RevisionChainStore, type RevisionChain } from "./engineering-revision-chain-store.js";
import { ENGINEERING_REVISION_GRANT_DDL } from "./engineering-revision-grant-ddl.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

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
const rawUpdate = (f: ReturnType<typeof setup>, chainId: string, grantJson: string) =>
  f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?").run(grantJson, chainId);
const grantOf = (f: ReturnType<typeof setup>, chainId: string) => JSON.parse((f.db.prepare("SELECT grant_json g FROM engineering_revision_chains WHERE chain_id=?").get(chainId) as { g: string }).g) as Record<string, unknown>;

it("adds migration 53 as triggers only and reopens cleanly from schema 52", () => {
  const root = realpathSync(createScratchDirSync("tests", "grant-upgrade"));
  const path = join(root, "state.db");
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }); });
  const old = new Database(path); old.pragma("foreign_keys = ON");
  for (const m of MIGRATIONS.filter(x => x.id <= 52)) { old.exec("BEGIN"); old.exec(m.sql); old.pragma(`user_version = ${m.id}`); old.exec("COMMIT"); }
  const objects = () => (old.prepare("SELECT type,name FROM sqlite_master ORDER BY type,name").all() as Array<{ type: string; name: string }>);
  const before = objects().map(o => `${o.type}:${o.name}`);
  old.close();
  const db = openDb({ path });
  expect(MIGRATIONS.find(m => m.id === 53)).toMatchObject({ name: "engineering_revision_grant_monotonic", sql: ENGINEERING_REVISION_GRANT_DDL });
  expect(MIGRATIONS.map(m => m.id).filter(id => id >= 51 && id <= 53)).toEqual([51, 52, 53]);
  expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
  expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  const after = (db.prepare("SELECT type,name FROM sqlite_master ORDER BY type,name").all() as Array<{ type: string; name: string }>).map(o => `${o.type}:${o.name}`);
  const added = after.filter(o => !before.includes(o) && !o.includes("sqlite_autoindex") && !o.includes("host_process"));
  expect(added.filter(o => o.startsWith("table:"))).toEqual([]);
  expect(added.filter(o => o.startsWith("index:"))).toEqual(["index:engineering_intent_one_pending_push"]);
  expect(added.filter(o => o.startsWith("trigger:") && /grant/.test(o))).toEqual(["trigger:engineering_chain_grant_monotonic", "trigger:engineering_chain_grant_shadow_fixed"]);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  db.close();
  const reopened = openDb({ path }); expect(reopened.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION); reopened.close();
});

it("keeps rounds above 2 out of the database whatever the writer does (insert and update)", () => {
  const f = setup();
  const { chain, grant } = f.live({ rounds: 2 });
  expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify({ ...grant, rounds: 3 })))).toMatch(/constraint|CHECK/i);
  expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify({ ...grant, rounds: 0 })))).toMatch(/not_monotonic|constraint|CHECK/i);
  expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify({ ...grant, rounds: "2" })))).toMatch(/constraint|CHECK|not_monotonic/i);
  expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify({ ...grant, rounds: 2.5 })))).toMatch(/constraint|CHECK|not_monotonic/i);
  expect(code(() => f.store.createLiveChain({ root_mission_id: f.mission(), repository: "o/r", pr_number: 900, branch: "b", base_ref: "main", published_head: H1, published_base: B1,
    trace_id: "t", grant: { rounds: 3 as 1 } }, 5))).toMatch(/constraint|CHECK/i);
  expect(code(() => f.store.createLiveChain({ root_mission_id: f.mission(), repository: "o/r", pr_number: 901, branch: "b", base_ref: "main", published_head: H1, published_base: B1,
    trace_id: "t", grant: { rounds: 1, pad: "x".repeat(4100) } }, 5))).toMatch(/constraint|CHECK/i);
  expect(grantOf(f, chain.chain_id)["rounds"]).toBe(2);
});

it("lets the allowance only grow and refuses rebinding, through the database trigger alone", () => {
  const f = setup();
  const { chain, grant } = f.live({ rounds: 2 });
  expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify({ ...grant, rounds: 1 })))).toBe("grant_not_monotonic");
  for (const rebind of [{ root_mission_id: "cm_00000000-0000-4000-8000-000000000099" }, { pr_number: 999 }, { repository: "o/other" }, { scope_id: "9".repeat(64) }]) {
    expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify({ ...grant, ...rebind }))), JSON.stringify(rebind)).toBe("grant_not_monotonic");
  }
  // NULL holes: a grant missing a bound field is a change from a present one, never a pass.
  for (const field of ["rounds", "root_mission_id", "pr_number", "repository", "scope_id"]) {
    const { [field]: _gone, ...without } = grant as unknown as Record<string, unknown>;
    expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify(without))), field).toMatch(/not_monotonic|constraint|CHECK/i);
  }
  expect(code(() => rawUpdate(f, chain.chain_id, "not json"))).toMatch(/constraint|CHECK|malformed/i);
  expect(code(() => rawUpdate(f, chain.chain_id, JSON.stringify({ ...grant, expires_at: grant.expires_at + 5 })))).toBe("no_error");
});

it("treats a grant that never carried the bound fields as unchanged, so older minimal rows keep working", () => {
  const f = setup();
  const chain = f.store.createLiveChain({ root_mission_id: f.mission(), repository: "o/r", pr_number: 700, branch: "b", base_ref: "main", published_head: H1, published_base: B1, trace_id: "t", grant: { rounds: 1 } }, 5);
  expect(code(() => rawUpdate(f, chain.chain_id, '{"kind":"live","rounds":2}'))).toBe("no_error");
  expect(code(() => rawUpdate(f, chain.chain_id, '{"kind":"live","rounds":1}'))).toBe("grant_not_monotonic");
});

it("never lets a shadow chain's grant change", () => {
  const f = setup();
  const chain = f.store.createShadowChain({ root_mission_id: f.mission(), repository: "o/r", pr_number: 800, branch: "b", base_ref: "main", published_head: H1, published_base: B1, trace_id: "t" }, 5);
  expect(code(() => rawUpdate(f, chain.chain_id, '{"kind":"shadow_hypothetical","x":1}'))).toBe("grant_shadow_fixed");
  expect(code(() => rawUpdate(f, chain.chain_id, '{"kind":"live","rounds":2}'))).toMatch(/grant_shadow_fixed|constraint|CHECK/i);
  expect(code(() => rawUpdate(f, chain.chain_id, '{"kind":"shadow_hypothetical"}'))).toBe("no_error");
});

it("records the budget origin and review deadline at creation and keeps ordinary updates clear of the grant", () => {
  const f = setup();
  const { chain, grant } = f.live();
  expect(JSON.parse(chain.budget_json!)).toEqual({ origin: GRANT_NOW });
  expect(JSON.parse(chain.spent_json!)).toEqual({ allocations: {} });
  expect(chain.review_deadline).toBe(grant.issued_at + grant.review_deadline_ms);
  const stopped = f.store.stopLive(chain.chain_id, chain.revision, "grant_expired", NOW);
  expect(stopped).toMatchObject({ state: "awaiting_decision", stop_reason: "grant_expired" });
  expect(stopped.grant_json).toBe(chain.grant_json);
});

it("re-grants an exhausted chain: rounds rise, the deadline restarts and the consumed head is reported", () => {
  const f = setup();
  const { chain, grant } = f.live({ rounds: 1 });
  const { chain: dispatched, child } = f.reserveAndDispatch(chain);
  f.finish(child);
  f.db.prepare("UPDATE engineering_workspace_claims SET state='released',released_at=1,release_reason='t' WHERE mission_id=?").run(child);
  const stopped = f.store.stopLive(dispatched.chain_id, dispatched.revision, "child_failed", NOW);
  expect(code(() => f.store.replaceGrant(stopped.chain_id, stopped.revision, f.renew(stopped, grant, { rounds: 2 }), NOW))).toBe("state_denied");
  // A chain that ran out of rounds stops with rounds_exhausted; model it by closing the loop through the 4-A decision path.
  f.db.prepare("UPDATE engineering_revision_chains SET stop_reason='rounds_exhausted',revision=revision+1 WHERE chain_id=?").run(chain.chain_id);
  const exhausted = f.store.get(chain.chain_id);
  expect(exhausted).toMatchObject({ state: "awaiting_decision", stop_reason: "rounds_exhausted", rounds_used: 1 });
  expect(code(() => f.store.replaceGrant(exhausted.chain_id, exhausted.revision, f.renew(exhausted, grant, { rounds: 1 }), NOW))).toBe("rounds_not_raised");
  const result = f.store.replaceGrant(exhausted.chain_id, exhausted.revision, f.renew(exhausted, grant, { rounds: 2 }), NOW);
  expect(result.head_consumed).toBe(true);
  expect(result.chain).toMatchObject({ state: "awaiting_review", stop_reason: null, rounds_used: 1, review_deadline: NOW + 24 * 3_600_000 });
  expect(grantOf(f, chain.chain_id)["rounds"]).toBe(2);
  expect(f.store.events(chain.chain_id, 0, 500).filter(e => e.kind === "grant_replaced").map(e => JSON.parse(e.payload_json))).toEqual([
    expect.objectContaining({ rounds: { from: 1, to: 2 }, restored_state: "awaiting_review", head_consumed: true }),
  ]);
});

it("re-grants from awaiting_review and refuses unsafe re-grants", () => {
  const f = setup();
  const { chain, grant } = f.live({ rounds: 1 });
  const ok = f.store.replaceGrant(chain.chain_id, chain.revision, f.renew(chain, grant, { rounds: 2 }), NOW);
  expect(ok).toMatchObject({ head_consumed: false, chain: { state: "awaiting_review", revision: chain.revision + 1 } });
  const cur = ok.chain; const curGrant = JSON.parse(cur.grant_json) as RevisionGrant;
  const bad: Array<[string, () => unknown]> = [
    ["stale revision", () => f.store.replaceGrant(cur.chain_id, cur.revision - 1, f.renew(cur, curGrant), NOW)],
    ["wrong renews revision", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { renews: { chain_id: cur.chain_id, revision: cur.revision + 5 } }), NOW)],
    ["wrong renews chain", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { renews: { chain_id: "rc_00000000-0000-4000-8000-000000000000", revision: cur.revision } }), NOW)],
    ["no renews", () => f.store.replaceGrant(cur.chain_id, cur.revision, signRevisionGrant((({ preview_sha256: _a, signature: _b, renews: _c, ...p }) => ({ ...p, grant_id: gid() }))(f.renew(cur, curGrant)), key), NOW)],
    ["same grant id", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { grant_id: curGrant.grant_id }), NOW)],
    ["lower rounds", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { rounds: 1 }), NOW)],
    ["rebound pr", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { pr_number: 9999 }), NOW)],
    ["rebound repo", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { repository: "o/other" }), NOW)],
    ["rebound scope", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { scope_id: "7".repeat(64) }), NOW)],
    ["rebound root", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { root_mission_id: "cm_00000000-0000-4000-8000-000000000077" }), NOW)],
    ["other protected set", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { protected_set_digest: "1".repeat(64) }), NOW)],
    ["smaller budget", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { budget: { ...curGrant.budget, max_executor_seconds: 10 } }), NOW)],
    ["already expired", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { issued_at: NOW - 10, expires_at: NOW }), NOW)],
    ["issued in the future", () => f.store.replaceGrant(cur.chain_id, cur.revision, f.renew(cur, curGrant, { issued_at: NOW + 10, expires_at: NOW + 5000 }), NOW)],
    ["not a grant", () => f.store.replaceGrant(cur.chain_id, cur.revision, { rounds: 2 } as unknown as RevisionGrant, NOW)],
  ];
  const expected: Record<string, string> = { "stale revision": "version_conflict", "not a grant": "grant_invalid", "already expired": "grant_expired", "issued in the future": "grant_expired",
    "lower rounds": "grant_not_monotonic", "smaller budget": "grant_not_monotonic" };
  for (const [name, fn] of bad) expect(code(fn), name).toBe(expected[name] ?? "grant_binding_mismatch");
  expect(f.store.get(cur.chain_id).revision).toBe(cur.revision);
});

it("refuses a re-grant while a push intent is unsettled, in flight, closed, or on a shadow chain", () => {
  const f = setup();
  const { chain, grant } = f.live({ rounds: 2 });
  const { chain: revising, child } = f.reserveAndDispatch(chain);
  expect(code(() => f.store.replaceGrant(revising.chain_id, revising.revision, f.renew(revising, grant), NOW))).toBe("state_denied");
  const intent = f.store.recordIntent(revising.chain_id, revising.revision, { kind: "push", branch: revising.branch, expected_old_head: H1, new_head: "2".repeat(40), expected_base_sha: B1, child_mission_id: child }, NOW);
  const stopped = f.store.stopLive(intent.chain.chain_id, intent.chain.revision, "grant_expired", NOW);
  expect(code(() => f.store.replaceGrant(stopped.chain_id, stopped.revision, f.renew(stopped, grant), NOW))).toBe("intent_unsettled");
  const closed = f.store.closeLive(stopped.chain_id, stopped.revision, "abandon", NOW);
  expect(code(() => f.store.replaceGrant(closed.chain_id, closed.revision, f.renew(closed, grant), NOW))).toBe("chain_terminal");
  const shadow = f.store.createShadowChain({ root_mission_id: f.mission(), repository: "o/r", pr_number: 5, branch: "b", base_ref: "main", published_head: H1, published_base: B1, trace_id: "t" }, 5);
  expect(code(() => f.store.replaceGrant(shadow.chain_id, shadow.revision, f.renew(shadow, grant), NOW))).toBe("bridge_shadow_write_denied");
});

it("resumes the same child after a grant or budget stop, and waits for a terminal child's claim release", () => {
  const f = setup();
  const { chain, grant } = f.live({ rounds: 2 });
  const { chain: revising, child } = f.reserveAndDispatch(chain);
  const stopped = f.store.stopLive(revising.chain_id, revising.revision, "budget_exhausted", NOW);
  expect(stopped.current_mission_id).toBe(child);
  expect(code(() => f.store.replaceGrant(stopped.chain_id, stopped.revision, f.renew(stopped, grant), NOW))).toBe("budget_not_raised");
  const more = f.renew(stopped, grant, { budget: { ...grant.budget, max_executor_seconds: grant.budget.max_executor_seconds + 600 } });
  const resumed = f.store.replaceGrant(stopped.chain_id, stopped.revision, more, NOW).chain;
  expect(resumed).toMatchObject({ state: "revising", stop_reason: null, current_mission_id: child });
  // A failed child with the stop proven but the claim still active is not a clean slate.
  f.finish(child);
  const again = f.store.stopLive(resumed.chain_id, resumed.revision, "child_failed", NOW);
  expect(code(() => f.store.replaceGrant(again.chain_id, again.revision, f.renew(again, grant), NOW))).toBe("state_denied");
  f.db.prepare("UPDATE engineering_revision_chains SET stop_reason='grant_expired',revision=revision+1 WHERE chain_id=?").run(again.chain_id);
  const expired = f.store.get(again.chain_id); const current = JSON.parse(expired.grant_json) as RevisionGrant;
  expect(code(() => f.store.replaceGrant(expired.chain_id, expired.revision, f.renew(expired, current), NOW))).toBe("child_claim_unreleased");
  f.db.prepare("UPDATE engineering_workspace_claims SET state='released',released_at=1,release_reason='t' WHERE mission_id=?").run(child);
  expect(f.store.replaceGrant(expired.chain_id, expired.revision, f.renew(expired, current), NOW).chain.state).toBe("awaiting_review");
});

it("resumes into publishing when the stopped child already has a settled push intent", () => {
  const f = setup();
  const { chain, grant } = f.live({ rounds: 2 });
  const { chain: revising, child } = f.reserveAndDispatch(chain);
  const withIntent = f.store.recordIntent(revising.chain_id, revising.revision, { kind: "push", branch: revising.branch, expected_old_head: H1, new_head: "2".repeat(40), expected_base_sha: B1, child_mission_id: child }, NOW);
  f.store.settleIntent(withIntent.intent.intent_id, "failed", NOW, "refused");
  const stopped = f.store.stopLive(withIntent.chain.chain_id, f.store.get(chain.chain_id).revision, "grant_expired", NOW);
  expect(f.store.replaceGrant(stopped.chain_id, stopped.revision, f.renew(stopped, grant), NOW).chain.state).toBe("publishing");
});

it("stops and closes live chains through narrow, validated methods", () => {
  const f = setup();
  const { chain } = f.live();
  for (const bad of ["", "grant expired", "Grant_Expired", "external_write", "x".repeat(65), "publish_refused", "publish_refused:", "child_halted:x y"]) {
    expect(code(() => f.store.stopLive(chain.chain_id, chain.revision, bad, NOW)), bad).toBe("invalid_reason");
  }
  expect(code(() => f.store.stopLive(chain.chain_id, chain.revision + 1, "grant_expired", NOW))).toBe("version_conflict");
  const stopped = f.store.stopLive(chain.chain_id, chain.revision, "publish_refused:base_changed", NOW);
  expect(stopped).toMatchObject({ state: "awaiting_decision", stop_reason: "publish_refused:base_changed" });
  expect(code(() => f.store.stopLive(stopped.chain_id, stopped.revision, "grant_expired", NOW))).toBe("state_denied");
  const { chain: second } = f.live();
  const { chain: busy } = f.reserveAndDispatch(second);
  const closed = f.store.closeLive(busy.chain_id, busy.revision, "takeover", NOW);
  expect(closed).toMatchObject({ state: "closed", stop_reason: null });
  expect(f.store.reservations(busy.chain_id).map(r => [r.state, r.settled_reason])).toEqual([["void", "chain_closed:takeover"]]);
  expect(code(() => f.store.closeLive(closed.chain_id, closed.revision, "abandon", NOW))).toBe("chain_terminal");
  expect(code(() => f.store.closeLive(second.chain_id, 1, "bad reason!", NOW))).toBe("invalid_reason");
  const shadow = f.store.createShadowChain({ root_mission_id: f.mission(), repository: "o/r", pr_number: 5, branch: "b", base_ref: "main", published_head: H1, published_base: B1, trace_id: "t" }, 5);
  expect(code(() => f.store.stopLive(shadow.chain_id, shadow.revision, "grant_expired", NOW))).toBe("bridge_shadow_write_denied");
  expect(code(() => f.store.closeLive(shadow.chain_id, shadow.revision, "abandon", NOW))).toBe("bridge_shadow_write_denied");
});

it("runs a cross-store transaction atomically", () => {
  const f = setup();
  const before = (f.db.prepare("SELECT COUNT(*) n FROM engineering_revision_chains").get() as { n: number }).n;
  expect(code(() => f.store.transaction(() => { f.live(); throw new Error("boom"); }))).toBe("boom");
  expect((f.db.prepare("SELECT COUNT(*) n FROM engineering_revision_chains").get() as { n: number }).n).toBe(before);
  f.store.transaction(() => { f.live(); });
  expect((f.db.prepare("SELECT COUNT(*) n FROM engineering_revision_chains").get() as { n: number }).n).toBe(before + 1);
});

it("allows at most one pending push intent per chain, in the database itself", () => {
  const f = setup();
  const { chain } = f.live({ rounds: 2 });
  const { chain: revising, child } = f.reserveAndDispatch(chain);
  const first = f.store.recordIntent(revising.chain_id, revising.revision, { kind: "push", branch: revising.branch, expected_old_head: H1, new_head: "2".repeat(40), expected_base_sha: B1, child_mission_id: child }, NOW);
  const row = f.db.prepare("SELECT * FROM engineering_publication_intents WHERE intent_id=?").get(first.intent.intent_id) as Record<string, unknown>;
  const clone = () => f.db.prepare(`INSERT INTO engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,expected_base_sha,child_mission_id,binding_json,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run("pi_second", row["chain_id"], "push", row["repository"], row["pr_number"], row["branch"], row["expected_old_head"], "3".repeat(40), row["expected_base_sha"], row["child_mission_id"], "{}", NOW, NOW);
  expect(code(clone)).toMatch(/UNIQUE/);
  expect(code(() => f.store.recordIntent(first.chain.chain_id, first.chain.revision, { kind: "push", branch: revising.branch, expected_old_head: H1, new_head: "3".repeat(40), expected_base_sha: B1, child_mission_id: child }, NOW))).toMatch(/UNIQUE/);
  // Once settled, the next push may be recorded; a pending non-push intent never collides.
  f.store.settleIntent(first.intent.intent_id, "failed", NOW, "refused");
  expect(code(clone)).toBe("no_error");
  expect(f.store.intents(chain.chain_id).filter(i => i.kind === "push" && i.state === "pending")).toHaveLength(1);
});
