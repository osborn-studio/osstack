import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { improvementProposalDigest, listImprovementProposals, upsertImprovementProposal } from "./improvement-proposals.js";
import { ImprovementExecutionRepository } from "./improvement-executions.js";

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
  return f.repo.claim({ execution_id: id, proposal_id: "proposal_1", request: request(), now: 5 });
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
    f.repo.recordWorktree("execution_1", descriptor(), 7);
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
    const running = f.repo.recordWorktree("execution_1", descriptor(), 6);
    expect(running).toMatchObject({ state: "running", worktree: descriptor(), updated_at: 6 });
    expect(f.repo.recordWorktree("execution_1", descriptor(), 7)).toEqual(running);
    expect(() => f.repo.recordWorktree("execution_1", { ...descriptor(), worktreePath: "/other" }, 7)).toThrow(/conflict/i);
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
    f.repo.recordWorktree("execution_1", descriptor(), 6);
    const result = { manifest_path: "/evidence/run_1/manifest.json", manifest_sha256: "c".repeat(64), changed_paths: ["tests/case.ts"] };
    const terminal = f.repo.complete("execution_1", state, result, 7);
    expect(terminal).toMatchObject({ state, result, updated_at: 7 });
    expect(f.repo.complete("execution_1", state, result, 8)).toEqual(terminal);
    expect(() => f.repo.complete("execution_1", state, { ...result, changed_paths: [] }, 8)).toThrow(/terminal.*conflict/i);
    expect(() => f.repo.complete("execution_1", state === "candidate_verified" ? "candidate_failed" : "candidate_verified", result, 8)).toThrow(/terminal.*conflict/i);
    expect(() => f.repo.recordWorktree("execution_1", descriptor(), 8)).toThrow(/terminal|state/i);
    expect(claim(f)).toEqual({ outcome: "replay", execution: terminal });
    expect(listImprovementProposals(f.db)).toEqual(original);
    expect(claim(f, "execution_2").outcome).toBe("claimed");
  });

  it("can record a failure before worktree creation but cannot verify without an implementation workspace", () => {
    const f = fixture();
    claim(f);
    expect(() => f.repo.complete("execution_1", "candidate_verified", {}, 6)).toThrow(/running|worktree/i);
    expect(f.repo.complete("execution_1", "candidate_failed", { reason: "worktree_failed" }, 6)).toMatchObject({ state: "candidate_failed" });
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
