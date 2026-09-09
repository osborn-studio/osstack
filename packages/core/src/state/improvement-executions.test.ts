import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { improvementProposalDigest, listImprovementProposals, upsertImprovementProposal } from "./improvement-proposals.js";
import { ImprovementExecutionRepository } from "./improvement-executions.js";

const owner = { worker_id: "fixture-worker", generation: 1 };
let tmp: string;
const databases: Database.Database[] = [];
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-improvement-executions-")); });
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  rmSync(tmp, { recursive: true, force: true });
});
function proposal() {
  return { proposal_id: "proposal_1", repo_id: "repo_1", source_asset_ids: ["asset_1"], target: "eval", risk: "low" as const,
    title: "Add regression case", rationale: "A defect recurred", proposed_changes: [{ path: "tests/case.ts", action: "create" as const, summary: "A regression" }],
    required_gates: ["pnpm test"], status: "approved" as const };
}
function request() {
  return { proposal_digest: improvementProposalDigest(proposal()), base_sha: "a".repeat(40), builder_id: "builder", gates: ["pnpm test"] };
}
function descriptor() {
  return { repoPath: "/repo", worktreePath: "/candidates/run_1", branch: "codex/improve/run_1", baseRef: "a".repeat(40), rootPath: "/candidates" };
}
function fixture(version?: number) {
  const path = join(tmp, "state.db");
  const db = version === undefined ? openDb({ path }) : new Database(path);
  if (version !== undefined) {
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((entry) => entry.id <= version)) {
      db.transaction(() => { db.exec(migration.sql); db.pragma(`user_version = ${migration.id}`); })();
    }
  }
  databases.push(db);
  upsertImprovementProposal(db, path, proposal());
  return { path, db, repo: new ImprovementExecutionRepository(db, path) };
}
function claim(f: ReturnType<typeof fixture>, id = "execution_1") {
  return f.repo.claim({ execution_id: id, proposal_id: "proposal_1", request: request(), worker_id: owner.worker_id, now: 5 });
}

describe("ImprovementExecutionRepository", () => {
  it("upgrades schema 24 without changing existing proposal records", () => {
    const f = fixture(24);
    const before = listImprovementProposals(f.db);
    f.db.close();
    const upgraded = openDb({ path: f.path });
    databases.push(upgraded);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(listImprovementProposals(upgraded)).toEqual(before);
    expect(new ImprovementExecutionRepository(upgraded, f.path).list()).toEqual([]);
    expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("claims once, binds request content, and returns the same unfinished record on replay", () => {
    const f = fixture();
    const input = request();
    const first = f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: input, now: 5 });
    expect(first.outcome).toBe("claimed");
    expect(first.execution).toMatchObject({ state: "claimed", request: input, created_at: 5, updated_at: 5 });
    expect(first.execution.request_sha256).toMatch(/^[a-f0-9]{64}$/);
    input.gates.push("other");
    expect(f.repo.get("execution_1")?.request).toEqual(request());
    expect(claim(f)).toEqual({ outcome: "replay", execution: first.execution });
    expect(f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: {
      gates: ["pnpm test"], builder_id: "builder", base_sha: "a".repeat(40), proposal_digest: request().proposal_digest,
    }, now: 6 })).toEqual({ outcome: "replay", execution: first.execution });
    expect(() => f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: { ...request(), gates: ["different"] }, now: 6 })).toThrow(/conflict/i);
    expect(() => f.repo.claim({ execution_id: "execution_1", proposal_id: "other", request: request(), now: 6 })).toThrow(/conflict/i);
  });

  it.each(["draft", "needs_human", "blocked", "applied", "rejected"] as const)("cannot claim an unapproved %s proposal", (status) => {
    const f = fixture();
    f.db.prepare("UPDATE improvement_proposals SET status = ?").run(status);
    expect(() => claim(f)).toThrow(/approved/i);
    expect(f.repo.list()).toEqual([]);
  });

  it("compares the frozen proposal digest within the claim transaction", () => {
    const f = fixture();
    expect(() => f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: { ...request(), proposal_digest: "b".repeat(64) }, now: 5 })).toThrow(/digest/i);
    expect(f.repo.list()).toEqual([]);
  });

  it("prevents a second active execution across separate database connections", () => {
    const f = fixture();
    const otherDb = openDb({ path: f.path });
    databases.push(otherDb);
    const other = new ImprovementExecutionRepository(otherDb, f.path);
    claim(f);
    expect(() => other.claim({ execution_id: "execution_2", proposal_id: "proposal_1", request: request(), now: 6 })).toThrow(/active/i);
    f.repo.recordWorktree("execution_1", descriptor(), 7, owner);
    expect(() => other.claim({ execution_id: "execution_2", proposal_id: "proposal_1", request: request(), now: 8 })).toThrow(/active/i);
    expect(other.list({ state: "running" })).toHaveLength(1);
  });

  it("enforces active uniqueness in SQLite and rolls back a claim with its outer transaction", () => {
    const f = fixture();
    expect(() => f.db.transaction(() => {
      claim(f);
      throw new Error("caller failed");
    })()).toThrow("caller failed");
    expect(f.repo.list()).toEqual([]);
    claim(f);
    expect(() => f.db.prepare(`INSERT INTO improvement_executions
      (execution_id, proposal_id, request_json, request_sha256, state, created_at, updated_at)
      SELECT 'execution_2', proposal_id, request_json, request_sha256, 'claimed', 6, 6
      FROM improvement_executions WHERE execution_id = 'execution_1'`).run()).toThrow(/UNIQUE/);
    expect(f.repo.list()).toHaveLength(1);
  });

  it("records the worktree once and keeps its immutable descriptor after reopening", () => {
    const f = fixture();
    claim(f);
    const running = f.repo.recordWorktree("execution_1", descriptor(), 6, owner);
    expect(running).toMatchObject({ state: "running", worktree: descriptor(), updated_at: 6 });
    expect(f.repo.recordWorktree("execution_1", descriptor(), 7, owner)).toEqual(running);
    expect(() => f.repo.recordWorktree("execution_1", { ...descriptor(), worktreePath: "/other" }, 7, owner)).toThrow(/conflict/i);
    f.db.close();
    const reopened = openDb({ path: f.path });
    databases.push(reopened);
    const repo = new ImprovementExecutionRepository(reopened, f.path);
    expect(repo.get("execution_1")).toEqual(running);
    expect(repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: request(), now: 8 })).toEqual({ outcome: "replay", execution: running });
  });

  it.each(["candidate_verified", "candidate_failed"] as const)("persists immutable %s results without changing approval or pretending applied", (state) => {
    const f = fixture();
    const original = listImprovementProposals(f.db);
    claim(f);
    f.repo.recordWorktree("execution_1", descriptor(), 6, owner);
    const result = { manifest_path: "/evidence/run_1/manifest.json", manifest_sha256: "c".repeat(64), changed_paths: ["tests/case.ts"] };
    const terminal = f.repo.complete("execution_1", state, result, 7, owner);
    expect(terminal).toMatchObject({ state, result, updated_at: 7 });
    expect(f.repo.complete("execution_1", state, result, 8, owner)).toEqual(terminal);
    expect(() => f.repo.complete("execution_1", state, { ...result, changed_paths: [] }, 8, owner)).toThrow(/terminal.*conflict/i);
    expect(() => f.repo.complete("execution_1", state === "candidate_verified" ? "candidate_failed" : "candidate_verified", result, 8, owner)).toThrow(/terminal.*conflict/i);
    expect(() => f.repo.recordWorktree("execution_1", descriptor(), 8, owner)).toThrow(/terminal|state/i);
    expect(claim(f)).toEqual({ outcome: "replay", execution: terminal });
    expect(listImprovementProposals(f.db)).toEqual(original);
    expect(claim(f, "execution_2").outcome).toBe("claimed");
  });

  it("can record a failure before worktree creation but cannot verify without an implementation workspace", () => {
    const f = fixture();
    claim(f);
    expect(() => f.repo.complete("execution_1", "candidate_verified", {}, 6, owner)).toThrow(/running|worktree/i);
    expect(f.repo.complete("execution_1", "candidate_failed", { reason: "worktree_failed" }, 6, owner)).toMatchObject({ state: "candidate_failed" });
  });

  it("does not reset old execution history when its proposal is later rejected", () => {
    const f = fixture();
    const original = claim(f).execution;
    f.db.prepare("UPDATE improvement_proposals SET status = 'rejected'").run();
    expect(claim(f)).toEqual({ outcome: "replay", execution: original });
    expect(() => claim(f, "execution_2")).toThrow(/approved/i);
  });

  it("rejects non-JSON requests instead of silently changing their binding", () => {
    const f = fixture();
    for (const value of [Number.NaN, Infinity, new Date(), () => {}, [undefined]]) {
      expect(() => f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: { ...request(), invalid: value }, now: 5 })).toThrow(/JSON/i);
    }
    expect(f.repo.list()).toEqual([]);
  });

  it("requires a digest and binds nested JSON content while treating omitted fields consistently", () => {
    const f = fixture();
    expect(() => f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: { ...request(), proposal_digest: "" }, now: 5 })).toThrow(/digest/);
    const input = { ...request(), profile: { nested: { instruction: "implement" }, missing: undefined } };
    const first = f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: input, now: 5 });
    expect(f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: {
      ...request(), profile: { nested: { instruction: "implement" } },
    }, now: 6 })).toEqual({ outcome: "replay", execution: first.execution });
    expect(() => f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: {
      ...request(), profile: { nested: { instruction: "different" } },
    }, now: 6 })).toThrow(/conflict/);
  });
});


describe("improvement execution worker and stop contract", () => {
  const worker = { worker_id: "worker-instance-1", generation: 1 };
  function owned(f: ReturnType<typeof fixture>) {
    return f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: request(), worker_id: worker.worker_id, now: 5 });
  }

  it("assigns an owner even to a legacy-shaped new claim", () => {
    const f = fixture();
    const result = f.repo.claim({ execution_id: "execution_1", proposal_id: "proposal_1", request: request(), now: 5 });
    expect(result.execution.worker?.worker_id).toBeTruthy();
    expect(() => f.repo.complete("execution_1", "candidate_failed", {}, 6)).toThrow(/worker/i);
    expect(f.repo.complete("execution_1", "candidate_failed", {}, 6, result.execution.worker).state).toBe("candidate_failed");
  });

  it("requires the bound worker on all writes, including legacy method calls", () => {
    const f = fixture();
    expect(owned(f).execution.worker).toEqual(worker);
    expect(() => f.repo.recordWorktree("execution_1", descriptor(), 6)).toThrow(/worker/i);
    expect(() => f.repo.complete("execution_1", "candidate_failed", {}, 6)).toThrow(/worker/i);
    for (const invalid of [{ ...worker, worker_id: "other" }, { ...worker, generation: 2 }]) {
      expect(() => f.repo.recordWorktree("execution_1", descriptor(), 6, invalid)).toThrow(/worker/i);
      expect(() => f.repo.complete("execution_1", "candidate_failed", {}, 6, invalid)).toThrow(/worker/i);
    }
    f.repo.recordWorktree("execution_1", descriptor(), 6, worker);
    expect(f.repo.complete("execution_1", "candidate_verified", {}, 7, worker).state).toBe("candidate_verified");
  });

  it("persists stop across reopen, fences late results, and keeps the active slot", () => {
    const f = fixture();
    owned(f);
    f.repo.recordWorktree("execution_1", descriptor(), 6, worker);
    const stopDb = openDb({ path: f.path }); databases.push(stopDb);
    const stopped = new ImprovementExecutionRepository(stopDb, f.path).requestStop("execution_1", "operator paused trial", 7);
    expect(stopped).toMatchObject({ state: "running", worker: { ...worker, generation: 2 }, stop: { reason: "operator paused trial", requested_at: 7 } });
    expect(stopped.result).toBeUndefined();
    expect(f.repo.requestStop("execution_1", "duplicate request", 8)).toEqual(stopped);
    f.db.close();
    const db = openDb({ path: f.path }); databases.push(db);
    const repo = new ImprovementExecutionRepository(db, f.path);
    expect(repo.get("execution_1")).toEqual(stopped);
    expect(() => repo.assertWorker("execution_1", worker)).toThrow(/stop/i);
    for (const state of ["candidate_verified", "candidate_failed"] as const) {
      expect(() => repo.complete("execution_1", state, {}, 9, worker)).toThrow(/stop/i);
    }
    expect(() => repo.recordWorktree("execution_1", descriptor(), 9, worker)).toThrow(/stop/i);
    expect(() => repo.claim({ execution_id: "execution_2", proposal_id: "proposal_1", request: request(), worker_id: "new-worker", now: 100000 })).toThrow(/active/i);
    expect(repo.get("execution_1")).toEqual(stopped);
  });

  it("stop wins before worktree registration and cannot be bypassed by an unowned legacy call", () => {
    const f = fixture(); claim(f);
    f.db.prepare("UPDATE improvement_executions SET worker_id = NULL").run();
    f.repo.requestStop("execution_1", "stop legacy worker", 6);
    expect(() => f.repo.recordWorktree("execution_1", descriptor(), 7)).toThrow(/stop/i);
    expect(() => f.repo.complete("execution_1", "candidate_failed", {}, 7)).toThrow(/stop/i);
    expect(() => f.db.prepare("UPDATE improvement_executions SET state = 'candidate_failed', result_json = '{}' WHERE execution_id = 'execution_1'").run()).toThrow(/stop/i);
    expect(f.repo.get("execution_1")?.state).toBe("claimed");
  });

  it("keeps a terminal result if completion wins the race", () => {
    const f = fixture(); owned(f);
    const completed = f.repo.complete("execution_1", "candidate_failed", { reason: "setup failed" }, 6, worker);
    const stopDb = openDb({ path: f.path }); databases.push(stopDb);
    expect(new ImprovementExecutionRepository(stopDb, f.path).requestStop("execution_1", "too late", 7)).toEqual(completed);
    expect(f.repo.complete("execution_1", "candidate_failed", { reason: "setup failed" }, 8, worker)).toEqual(completed);
  });

  it("upgrades schema 25 with active and terminal legacy executions intact", () => {
    const f = fixture(25);
    const legacy = { ...request() };
    for (const [id, state] of [["old-active", "claimed"], ["old-failed", "candidate_failed"]]) {
      f.db.prepare(`INSERT INTO improvement_executions
        (execution_id,proposal_id,request_json,request_sha256,state,result_json,created_at,updated_at)
        VALUES (?, 'proposal_1', ?, ?, ?, ?, 5, 6)`).run(id, JSON.stringify(legacy), "a".repeat(64), state, state === "claimed" ? null : "{}");
    }
    const before = f.db.prepare("SELECT execution_id, state, request_json, result_json FROM improvement_executions ORDER BY execution_id").all();
    f.db.close();
    const db = openDb({ path: f.path }); databases.push(db);
    expect(db.prepare("SELECT execution_id, state, request_json, result_json FROM improvement_executions ORDER BY execution_id").all()).toEqual(before);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    const repo = new ImprovementExecutionRepository(db, f.path);
    expect(repo.get("old-active")?.worker).toBeUndefined();
    expect(repo.complete("old-active", "candidate_failed", { reason: "legacy setup failure" }, 7).state).toBe("candidate_failed");
  });
});


describe("improvement execution baseline", () => {
  it("includes every attempt beyond the list limit and keeps stop as an overlapping label", () => {
    const f = fixture();
    for (let i = 0; i < 103; i++) {
      const id = `failed_${i}`;
      claim(f, id);
      f.repo.complete(id, "candidate_failed", { reason: "invalid candidate" }, 7, owner);
    }
    claim(f, "verified");
    f.repo.recordWorktree("verified", descriptor(), 6, owner);
    f.repo.complete("verified", "candidate_verified", {}, 7, owner);
    claim(f, "pending");
    f.repo.requestStop("pending", "inspect worker", 8);
    expect(f.repo.list()).toHaveLength(100);
    const snapshot = f.repo.baseline({ now: 9 });
    expect(snapshot.counts).toEqual({ total: 105, claimed: 1, running: 0, candidate_verified: 1, candidate_failed: 103 });
    expect(snapshot.stop_requests).toEqual({ operator: 1, system_indeterminate: 0 });
    expect(snapshot.records).toHaveLength(105);
    expect(new Set(snapshot.records.map((row) => row.execution_id)).size).toBe(105);
    expect(snapshot).toMatchObject({ endpoint: "candidate_verification", cost_usd: null, cost_status: "not_collected", delivery_effectiveness: "not_measured" });
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.repo.baseline({ now: 9 })).toEqual(snapshot);
    expect(f.repo.baseline({ now: 10 }).records).toEqual(snapshot.records);
    expect(f.repo.baseline({ now: 9, proposal_id: "absent" }).counts.total).toBe(0);
  });
});
