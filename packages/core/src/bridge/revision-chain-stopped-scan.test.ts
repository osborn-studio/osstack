import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { AttentionStore } from "../state/attention-store.js";
import { ContainedMissionStore } from "../state/engineering-contained-store.js";
import { openDb } from "../state/db.js";
import { RevisionChainStore } from "../state/engineering-revision-chain-store.js";
import { scanStoppedChains, type StoppedPrFacts } from "./revision-chain-stopped-scan.js";

const H = "1".repeat(40);
const B = "b".repeat(40);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = realpathSync(createScratchDirSync("tests", "stopped-scan")); roots.push(root);
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
  const missions = new ContainedMissionStore(attention, owner);
  const store = new RevisionChainStore(attention, owner);
  let n = 0;
  const chain = (mode: "live" | "shadow" = "live", stoppedAt = 20) => {
    n++;
    const root_mission_id = missions.authorize(principal, { scope_id: scope.scope_id, spec: { goal: `g${n}` }, claim: { repo_identity: "repo", branch: `b${n}`, worktree_identity: `w${n}` } }, 1000).mission_id;
    const input = { root_mission_id, repository: "o/r", pr_number: n, branch: `b${n}`, base_ref: "main", published_head: H, published_base: B, trace_id: "tr" };
    const created = mode === "live" ? store.createLiveChain({ ...input, grant: { rounds: 1 } }, 10) : store.createShadowChain(input, 10);
    return store.applyDecision(created.chain_id, created.revision, { kind: "stop", to: "awaiting_decision", reason: "external_write", from_head: H, from_base: B, head: "2".repeat(40), base: B, discards: [], review_ids: [], ...(mode === "shadow" ? { shadow_action: "would_stop" as const } : {}) }, stoppedAt);
  };
  return { db, store, chain, missions, principal, scope };
}
const facts = (pr_state: StoppedPrFacts["pr_state"] = "OPEN", over: Partial<StoppedPrFacts> = {}): StoppedPrFacts =>
  ({ pr_state, head: H, base_sha: B, base_ref: "main", head_repository: "o/r", head_ref: "branch", complete: true, ...over });

it.each(["MERGED", "CLOSED"] as const)("closes a stopped chain when the PR is %s and records the transition", async state => {
  const f = setup(); const c = f.chain();
  const report = await scanStoppedChains({ store: f.store, readPr: async () => facts(state), now: 30, limit: 10 });
  expect(report.chains).toMatchObject([{ chain_id: c.chain_id, action: "closed", reason: state === "MERGED" ? "pr_merged" : "pr_closed" }]);
  expect(f.store.get(c.chain_id)).toMatchObject({ state: "closed", stop_reason: null });
  expect(f.store.events(c.chain_id).at(-1)).toMatchObject({ kind: "transition" });
  f.db.close();
});
it("records changed open facts once, without changing state or stop reason", async () => {
  const f = setup(); const c = f.chain(); const readPr = async () => facts("OPEN", { head: "3".repeat(40) });
  const first = await scanStoppedChains({ store: f.store, readPr, now: 30, limit: 10 });
  const second = await scanStoppedChains({ store: f.store, readPr, now: 40, limit: 10 });
  expect(first.chains[0]).toMatchObject({ action: "none", reason: "facts_changed" });
  expect(second.chains[0]).toMatchObject({ action: "none", reason: "facts_unchanged" });
  expect(f.store.get(c.chain_id)).toMatchObject({ state: "awaiting_decision", stop_reason: "external_write", revision: c.revision });
  expect(f.store.events(c.chain_id).filter(e => e.kind === "stopped_chain_observed")).toHaveLength(1);
  f.db.close();
});
it("makes no write after an incomplete or failed read", async () => {
  const f = setup(); const c = f.chain(); const before = f.store.events(c.chain_id).length;
  const incomplete = await scanStoppedChains({ store: f.store, readPr: async () => facts("MERGED", { complete: false }), now: 30, limit: 10 });
  const failed = await scanStoppedChains({ store: f.store, readPr: async () => { throw Error("network"); }, now: 40, limit: 10 });
  expect(incomplete.chains[0]?.reason).toBe("snapshot_incomplete");
  expect(failed.chains[0]?.reason).toBe("read_failed");
  expect(f.store.events(c.chain_id)).toHaveLength(before);
  f.db.close();
});
it("skips shadow chains and honors the batch limit", async () => {
  const f = setup(); f.chain("shadow"); const c = f.chain(); f.chain("live", 21);
  const report = await scanStoppedChains({ store: f.store, readPr: async () => facts(), now: 30, limit: 1 });
  expect(report.chains.map(x => x.chain_id)).toEqual([c.chain_id]);
  f.db.close();
});
it("paginates stopped chains and returns a null cursor for an empty batch", async () => {
  const f = setup(); const a = f.chain("live", 20); const b = f.chain("live", 21);
  const first = await scanStoppedChains({ store: f.store, readPr: async () => facts(), now: 30, limit: 1 });
  const second = await scanStoppedChains({ store: f.store, readPr: async () => facts(), now: 31, limit: 1, after: first.next_cursor! });
  const empty = await scanStoppedChains({ store: f.store, readPr: async () => facts(), now: 32, limit: 1, after: second.next_cursor! });
  expect(first.chains.map(x => x.chain_id)).toEqual([a.chain_id]);
  expect(first.next_cursor).toEqual({ updated_at: a.updated_at, chain_id: a.chain_id });
  expect(second.chains.map(x => x.chain_id)).toEqual([b.chain_id]);
  expect(second.next_cursor).toEqual({ updated_at: b.updated_at, chain_id: b.chain_id });
  expect(empty).toEqual({ chains: [], next_cursor: null });
  f.db.close();
});
it("closes an uncertain push chain, voids its dispatched reservation, and reports its child", async () => {
  const f = setup(); const root = f.missions.authorize(f.principal, { scope_id: f.scope.scope_id, spec: { goal: "root" }, claim: { repo_identity: "repo", branch: "root", worktree_identity: "root" } }, 1000);
  const child = f.missions.authorize(f.principal, { scope_id: f.scope.scope_id, spec: { goal: "child" }, claim: { repo_identity: "repo", branch: "child", worktree_identity: "child" } }, 1000);
  const created = f.store.createLiveChain({ root_mission_id: root.mission_id, repository: "o/r", pr_number: 90, branch: "b", base_ref: "main", published_head: H, published_base: B, trace_id: "tr", grant: { rounds: 1 } }, 10);
  const reserved = f.store.reserve(created.chain_id, created.revision, { head: H, review_ids: [1], feedback_digest: "digest" }, 11);
  const dispatched = f.store.dispatch(created.chain_id, reserved.chain.revision, H, child.mission_id, 12);
  const intent = f.store.recordIntent(created.chain_id, dispatched.chain.revision, { kind: "push", branch: "b", expected_old_head: H, new_head: "2".repeat(40), expected_base_sha: B, child_mission_id: child.mission_id }, 13).intent;
  expect(f.store.settleIntent(intent.intent_id, "uncertain", 14).chain.state).toBe("awaiting_decision");
  const report = await scanStoppedChains({ store: f.store, readPr: async () => facts("MERGED"), now: 30, limit: 10 });
  expect(report.chains[0]).toMatchObject({ action: "closed", current_mission_id: child.mission_id, voided_reservation_heads: [H] });
  expect(f.store.reservations(created.chain_id)).toMatchObject([{ state: "void", settled_reason: "chain_closed:pr_merged" }]);
  expect(f.store.getIntent(intent.intent_id).state).toBe("uncertain");
  f.db.close();
});
it("keeps committed closes in the report when a later chain has corrupt observation JSON", async () => {
  const f = setup(); const a = f.chain("live", 20); const b = f.chain("live", 21);
  f.db.prepare("INSERT INTO engineering_revision_chain_events(chain_id,kind,payload_json,created_at) VALUES(?,'stopped_chain_observed','{',22)").run(b.chain_id);
  const report = await scanStoppedChains({ store: f.store, readPr: async chain => facts(chain.chain_id === a.chain_id ? "MERGED" : "OPEN"), now: 30, limit: 10 });
  expect(report.chains).toMatchObject([{ chain_id: a.chain_id, action: "closed" }, { chain_id: b.chain_id, action: "none", reason: "scan_error" }]);
  expect(f.store.get(a.chain_id).state).toBe("closed");
  f.db.close();
});
it.each(["append", "close"] as const)("continues after a per-chain %s failure", async failure => {
  const f = setup(); const a = f.chain("live", 20); const b = f.chain("live", 21); const c = f.chain("live", 22);
  const scanStore = Object.create(f.store) as RevisionChainStore;
  scanStore.appendEvent = (chainId, kind, payload, now) => {
    if (failure === "append" && chainId === b.chain_id) throw Error("append failed");
    return f.store.appendEvent(chainId, kind, payload, now);
  };
  scanStore.applyDecision = (chainId, revision, decision, now) => {
    if (failure === "close" && chainId === b.chain_id) throw Error("unexpected decision error");
    return f.store.applyDecision(chainId, revision, decision, now);
  };
  const report = await scanStoppedChains({ store: scanStore, readPr: async chain => facts(chain.chain_id === b.chain_id && failure === "append" ? "OPEN" : "MERGED"), now: 30, limit: 10 });
  expect(report.chains).toMatchObject([
    { chain_id: a.chain_id, action: "closed" },
    { chain_id: b.chain_id, action: "none", reason: "scan_error" },
    { chain_id: c.chain_id, action: "closed" },
  ]);
  expect(f.store.get(a.chain_id).state).toBe("closed");
  expect(f.store.get(c.chain_id).state).toBe("closed");
  f.db.close();
});
it("skips an observation if the chain changes while PR facts are read", async () => {
  const f = setup(); const c = f.chain();
  const report = await scanStoppedChains({ store: f.store, readPr: async () => {
    f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',stop_reason=NULL,revision=revision+1 WHERE chain_id=?").run(c.chain_id);
    return facts("OPEN", { head: "3".repeat(40) });
  }, now: 30, limit: 10 });
  expect(report.chains[0]).toMatchObject({ action: "none", reason: "changed_during_read" });
  expect(f.store.events(c.chain_id).filter(e => e.kind === "stopped_chain_observed")).toHaveLength(0);
  f.db.close();
});
it.each(["pending", "uncertain"] as const)("closes with a %s intent and leaves the intent unchanged", async state => {
  const f = setup(); const c = f.chain();
  const intent = f.store.recordIntent(c.chain_id, c.revision, { kind: "check", branch: c.branch }, 25).intent;
  if (state === "uncertain") f.store.settleIntent(intent.intent_id, "uncertain", 26);
  const report = await scanStoppedChains({ store: f.store, readPr: async () => facts("CLOSED"), now: 30, limit: 10 });
  expect(report.chains[0]).toMatchObject({ action: "closed", reason: "pr_closed" });
  expect(f.store.getIntent(intent.intent_id).state).toBe(state);
  f.db.close();
});
it("reports a stale revision without closing the chain", async () => {
  const f = setup(); const c = f.chain();
  const report = await scanStoppedChains({ store: f.store, readPr: async () => {
    const row = f.store.get(c.chain_id);
    f.db.prepare("UPDATE engineering_revision_chains SET revision=revision+1 WHERE chain_id=?").run(row.chain_id);
    return facts("MERGED");
  }, now: 30, limit: 10 });
  expect(report.chains[0]).toMatchObject({ action: "none", reason: "version_conflict" });
  expect(f.store.get(c.chain_id).state).toBe("awaiting_decision");
  f.db.close();
});
