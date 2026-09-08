import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb, withWrite } from "./db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { insertRun, insertTask } from "./run-store.js";
import { SessionRepository } from "./sessions.js";
import { SessionContinuationRepository } from "./session-continuations.js";

let tmp: string;
const databases: ReturnType<typeof openDb>[] = [];
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-continuations-")); });
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  rmSync(tmp, { recursive: true, force: true });
});
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function body() {
  return {
    version: 1 as const, grant_id: "grant_1", session_id: "sess_01", runtime_id: "codex-cli",
    runtime_policy_sha256: "b".repeat(64), repo_path: "/tmp/continuation-repo",
    initial_turn_id: "turn_1", initial_version: 1,
    issued_at: new Date(1_000).toISOString(), expires_at: new Date(100_000).toISOString(),
    max_resumes: 3, max_checks: 4, turn_timeout_ms: 1000,
    steps: [{ phase: "verify", instruction: "Continue the frozen plan.", checks: [{ kind: "text_equals" as const, expected: "ready" }],
      retry_instruction: "Fix the frozen check.", max_retries: 1 }],
  };
}
function decision(phase = "verify", gate = "phase_continue") {
  return { decision_id: "decision_1", question: "Continue?", choices: [], continuation: {
    version: 1, gate_kind: gate, phase, next_action: "Untrusted suggestion.", evidence_refs: [],
  } };
}
function setup(migrationVersion?: number) {
  const path = join(tmp, "state.db");
  const db = migrationVersion === undefined ? openDb({ path }) : new Database(path);
  if (migrationVersion !== undefined) {
    db.pragma("foreign_keys = ON");
    for (const migration of MIGRATIONS.filter((entry) => entry.id <= migrationVersion)) {
      db.transaction(() => { db.exec(migration.sql); db.pragma(`user_version = ${migration.id}`); })();
    }
  }
  databases.push(db);
  insertTask(db, path, { task_id: "task_01", title: "Continuation", created_at: 1 });
  insertRun(db, path, { run_id: "run_01", task_id: "task_01", session_id: "sess_01", agent_id: "codex-cli",
    capability_id: "codex-cli.code.write", phase: "code", started_at: 1 });
  const sessions = new SessionRepository(db, path);
  sessions.createSession({ session_id: "sess_01", task_id: "task_01", run_id: "run_01", agent_id: "codex-cli",
    request_sha256: "a".repeat(64), native_session_id: "native_1", repo_path: "/tmp/continuation-repo",
    state: "awaiting_decision", resume_supported: true, version: 1, updated_at: 2 });
  sessions.appendTurn({ turn_id: "turn_1", session_id: "sess_01", ordinal: 1, state: "awaiting_decision",
    assistant_text: "ready", decision: decision(), created_at: 2, updated_at: 2 });
  const repo = new SessionContinuationRepository(db, path);
  return { db, path, sessions, repo };
}
function installed() {
  const f = setup();
  f.repo.install(body(), digest(body()), "key_1", 3, "fixture-signature");
  return f;
}
function reserve(f: ReturnType<typeof setup>, passed = true, now = 4) {
  const checking = f.repo.beginCheck("grant_1", now);
  if (checking.outcome !== "checking") throw new Error(checking.outcome);
  const reserved = f.repo.finishCheck(checking.attempt.attempt_id, { passed, details: { evidence: "local check" } }, now + 1);
  if (reserved.outcome !== "reserved") throw new Error(reserved.outcome);
  return reserved;
}
function complete(f: ReturnType<typeof setup>, reserved: ReturnType<typeof reserve>, turnId = "turn_2", ordinal = 2,
  nextPhase = "verify", completedAt = reserved.message.created_at + 0.5) {
  return withWrite(f.db, f.path, () => {
    const session = f.sessions.completeInboundTurn({ message_id: reserved.message.message_id,
      expected_version: reserved.reservation_version, applied_at: completedAt,
      turn: { turn_id: turnId, session_id: "sess_01", ordinal, state: "awaiting_decision", assistant_text: "ready",
        decision: decision(nextPhase), created_at: completedAt, updated_at: completedAt } });
    return f.repo.completeAttempt(reserved.attempt.attempt_id, turnId, session.version, completedAt);
  });
}

describe("SessionContinuationRepository", () => {
  it("upgrades a real schema 23 database without changing existing session state", () => {
    const f = setup(23);
    const original = f.sessions.latestSnapshot("sess_01");
    expect(f.db.pragma("user_version", { simple: true })).toBe(23);
    f.db.close();
    const upgraded = openDb({ path: f.path });
    databases.push(upgraded);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(new SessionRepository(upgraded, f.path).latestSnapshot("sess_01")).toEqual(original);
    expect(new SessionContinuationRepository(upgraded, f.path).listActive()).toEqual([]);
    expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("persists an immutable grant and does not reset counters on replay", () => {
    const f = installed();
    f.repo.beginCheck("grant_1", 4);
    const stored = f.repo.get("grant_1");
    expect(f.repo.install(body(), digest(body()), "key_1", 5, "fixture-signature")).toEqual(stored);
    expect(f.repo.forSession("sess_01")).toEqual(stored);
    expect(f.repo.listActive()).toEqual([stored]);
    const other = { ...body(), grant_id: "grant_2" };
    expect(() => f.repo.install(other, digest(other), "key_1", 5, "fixture-signature")).toThrow(/active/i);
    const changed = { ...body(), max_checks: 5 };
    expect(() => f.repo.install(changed, digest(changed), "key_1", 5, "fixture-signature")).toThrow(/conflict/i);
    expect(() => f.repo.install(body(), digest(body()), "key_2", 5, "fixture-signature")).toThrow(/conflict/i);
    f.db.close();
    const reopened = openDb({ path: f.path });
    databases.push(reopened);
    expect(new SessionContinuationRepository(reopened, f.path).get("grant_1")).toEqual(stored);
  });

  it.each([
    { initial_turn_id: "old_turn" }, { initial_version: 2 }, { runtime_id: "other-runtime" }, { repo_path: "/other/repo" },
  ])("rejects an installation that does not bind the real session: %j", (change) => {
    const f = setup();
    const grant = { ...body(), ...change };
    expect(() => f.repo.install(grant, digest(grant), "key_1", 3, "fixture-signature")).toThrow(/binding|cursor/i);
    expect(f.repo.listActive()).toEqual([]);
  });

  it("rejects a mismatched digest and expired installation", () => {
    const f = setup();
    expect(() => f.repo.install(body(), "f".repeat(64), "key_1", 3, "fixture-signature")).toThrow(/digest/i);
    expect(() => f.repo.install(body(), digest(body()), "key_1", 100, "fixture-signature")).toThrow(/expired/i);
  });

  it("canonicalizes an explicit undefined optional field identically to its wire omission", () => {
    const f = setup();
    const step = body().steps[0]!;
    const { retry_instruction: _retryInstruction, ...wireStep } = step;
    const wire = { ...body(), steps: [wireStep] };
    const raw = { ...body(), steps: [{ ...wireStep, retry_instruction: undefined }] };
    const installedGrant = f.repo.install(raw, digest(wire), "key_1", 3, "fixture-signature");
    expect(installedGrant.body).toEqual(wire);
    expect(f.repo.install(wire, digest(wire), "key_1", 4, "fixture-signature")).toEqual(installedGrant);
    expect(() => f.repo.install(wire, digest(wire), "key_1", 4, "different-signature")).toThrow(/conflict/i);
  });

  it("expires a pending check instead of leaving its grant active indefinitely", () => {
    const f = installed();
    f.repo.beginCheck("grant_1", 4);
    expect(f.repo.beginCheck("grant_1", 100)).toMatchObject({ outcome: "blocked", reason: "expired" });
    expect(f.repo.get("grant_1")?.checks_used).toBe(1);
  });

  it("freezes the authorized instruction, reserves once, and atomically completes the final step", () => {
    const f = installed();
    const reserved = reserve(f);
    expect(reserved.prompt).toBe("Continue the frozen plan.");
    expect(reserved.reservation_version).toBe(2);
    expect(reserved.message).toMatchObject({ session_id: "sess_01", turn_id: "turn_1", state: "accepted" });
    expect(JSON.parse(reserved.message.payload_json)).toEqual({ text: "Continue the frozen plan.", requested_by: "agent:collaborator:grant_1" });
    expect(f.repo.finishCheck(reserved.attempt.attempt_id, { passed: true, details: null }, 5).outcome).toBe("unchanged");
    expect(f.repo.beginCheck("grant_1", 5).outcome).toBe("busy");
    expect(complete(f, reserved)).toMatchObject({ status: "completed", step_index: 1, resumes_used: 1, checks_used: 1,
      expected_turn_id: "turn_2", expected_version: 3 });
    expect(f.repo.completeAttempt(reserved.attempt.attempt_id, "turn_2", 3, 7)).toEqual(f.repo.get("grant_1"));
    expect(f.repo.listActive()).toEqual([]);
  });

  it("retries only with the frozen retry instruction and a finite retry budget", () => {
    const f = installed();
    const retry = reserve(f, false);
    expect(retry.prompt).toBe("Fix the frozen check.");
    expect(retry.attempt.action).toBe("retry");
    expect(complete(f, retry)).toMatchObject({ status: "active", step_index: 0, retries_used: 1 });
    const again = f.repo.beginCheck("grant_1", 7);
    if (again.outcome !== "checking") throw new Error(again.outcome);
    expect(f.repo.finishCheck(again.attempt.attempt_id, { passed: false, details: [] }, 8)).toMatchObject({
      outcome: "blocked", reason: "checks_failed", grant: { resumes_used: 1, checks_used: 2 },
    });
  });

  it("advances through frozen phases and resets only the per-step retry count", () => {
    const f = setup();
    const grant = { ...body(), steps: [body().steps[0]!, { ...body().steps[0]!, phase: "finish", instruction: "Finish the delegated steps." }] };
    f.repo.install(grant, digest(grant), "key_1", 3, "fixture-signature");
    complete(f, reserve(f, false), "turn_2", 2);
    expect(f.repo.get("grant_1")).toMatchObject({ step_index: 0, retries_used: 1 });
    complete(f, reserve(f, true, 7), "turn_3", 3, "finish");
    expect(f.repo.get("grant_1")).toMatchObject({ step_index: 1, retries_used: 0, checks_used: 2, resumes_used: 2 });
    const last = reserve(f, true, 9);
    expect(last.prompt).toBe("Finish the delegated steps.");
    expect(complete(f, last, "turn_4", 4)).toMatchObject({ status: "completed", step_index: 2, checks_used: 3, resumes_used: 3 });
    expect(f.repo.block("grant_1", "late failure", 11).status).toBe("completed");
  });

  it("failure preserves spent budgets and prevents a second automatic delivery", () => {
    const f = installed();
    const reserved = reserve(f);
    expect(f.repo.failAttempt(reserved.attempt.attempt_id, "native_timeout", 6)).toMatchObject({
      status: "blocked", reason: "native_timeout", resumes_used: 1, checks_used: 1,
    });
    expect(f.repo.finishCheck(reserved.attempt.attempt_id, { passed: true, details: null }, 7).outcome).toBe("unchanged");
    expect(f.repo.beginCheck("grant_1", 8).outcome).toBe("blocked");
    expect(f.sessions.getMessage(reserved.message.message_id)?.state).toBe("accepted");
    const replacement = { ...body(), grant_id: "grant_2", initial_version: reserved.reservation_version };
    expect(() => f.repo.install(replacement, digest(replacement), "key_1", 8, "fixture-signature")).toThrow(/unresolved receipt/i);
  });

  it.each(["risk_approval", "task_authorization", "external_input"])("blocks the non-continuation gate %s", (gate) => {
    const f = installed();
    f.db.prepare("UPDATE session_turns SET decision_json = ?").run(JSON.stringify(decision("verify", gate)));
    expect(f.repo.beginCheck("grant_1", 4)).toMatchObject({ outcome: "blocked", reason: "decision_not_authorized" });
  });

  it.each([decision("wrong-phase"), { ...decision(), unknown: true }, null])("rejects mismatched or malformed strict decisions", (value) => {
    const f = installed();
    f.db.prepare("UPDATE session_turns SET decision_json = ?").run(JSON.stringify(value));
    expect(f.repo.beginCheck("grant_1", 4).outcome).toBe("blocked");
  });

  it.each(["cursor", "decision"])("rechecks %s after external checks finish", (change) => {
    const f = installed();
    const checking = f.repo.beginCheck("grant_1", 4);
    if (checking.outcome !== "checking") throw new Error(checking.outcome);
    if (change === "cursor") f.sessions.setState("sess_01", "awaiting_decision", 1, 5);
    else f.db.prepare("UPDATE session_turns SET decision_json = ?").run(JSON.stringify({ ...decision(), question: "Changed request" }));
    expect(f.repo.finishCheck(checking.attempt.attempt_id, { passed: true, details: null }, 6).outcome).toBe("blocked");
    expect(f.db.prepare("SELECT * FROM session_messages").all()).toEqual([]);
  });

  it.each(["accepted", "failed"] as const)("blocks unresolved %s receipts", (state) => {
    const f = installed();
    f.sessions.applyInbound({ message_id: "human_1", session_id: "sess_01", turn_id: "turn_1", direction: "inbound",
      kind: "instruction.send", payload: { text: "human input" }, state, created_at: 4 }, 1, 4);
    expect(f.repo.beginCheck("grant_1", 5).outcome).toBe("blocked");
  });

  it("rechecks expiry and revocation after checks without consuming a resume", () => {
    const f = installed();
    const checking = f.repo.beginCheck("grant_1", 4);
    if (checking.outcome !== "checking") throw new Error(checking.outcome);
    expect(f.repo.finishCheck(checking.attempt.attempt_id, { passed: true, details: null }, 100)).toMatchObject({
      outcome: "blocked", reason: "expired", grant: { checks_used: 1, resumes_used: 0 },
    });
    expect(f.repo.revoke("grant_1", 101).status).toBe("blocked");
  });

  it("does not deliver a check result after revoke and preserves the revoked state on replay", () => {
    const f = installed();
    const checking = f.repo.beginCheck("grant_1", 4);
    if (checking.outcome !== "checking") throw new Error(checking.outcome);
    f.repo.revoke("grant_1", 5);
    expect(f.repo.finishCheck(checking.attempt.attempt_id, { passed: true, details: null }, 6)).toMatchObject({ outcome: "blocked", grant: { status: "revoked" } });
    expect(f.repo.install(body(), digest(body()), "key_1", 7, "fixture-signature").status).toBe("revoked");
    expect(f.repo.block("grant_1", "later failure", 8).status).toBe("revoked");
  });

  it("records a receipt completed after revoke without reviving the grant", () => {
    const f = installed();
    const reserved = reserve(f);
    f.repo.revoke("grant_1", 5);
    expect(complete(f, reserved).status).toBe("revoked");
    expect(f.repo.getAttempt(reserved.attempt.attempt_id)?.status).toBe("applied");
  });

  it.each(["expired", "turn_timeout"] as const)("retains the real receipt but blocks a completion after %s", (reason) => {
    const f = setup();
    const grant = { ...body(), expires_at: new Date(reason === "expired" ? 6_000 : 100_000).toISOString() };
    f.repo.install(grant, digest(grant), "key_1", 3, "fixture-signature");
    const reserved = reserve(f);
    expect(complete(f, reserved, "turn_2", 2, "verify", reason === "expired" ? 7 : 6)).toMatchObject({
      status: "blocked", reason, expected_turn_id: "turn_2", expected_version: 3, resumes_used: 1,
    });
    expect(f.sessions.getMessage(reserved.message.message_id)?.state).toBe("applied");
    expect(f.repo.getAttempt(reserved.attempt.attempt_id)?.status).toBe("applied");
    expect(f.repo.listActive()).toEqual([]);
  });

  it("keeps both session and grant unchanged if completion cursor validation fails", () => {
    const f = installed();
    const reserved = reserve(f);
    expect(() => withWrite(f.db, f.path, () => {
      f.sessions.completeInboundTurn({ message_id: reserved.message.message_id, expected_version: 2, applied_at: 6,
        turn: { turn_id: "turn_2", session_id: "sess_01", ordinal: 2, state: "awaiting_decision", assistant_text: "ready",
          decision: decision(), created_at: 6, updated_at: 6 } });
      f.repo.completeAttempt(reserved.attempt.attempt_id, "wrong_turn", 3, 6);
    })).toThrow(/completion/i);
    expect(f.sessions.latestSnapshot("sess_01").version).toBe(2);
    expect(f.sessions.getMessage(reserved.message.message_id)?.state).toBe("accepted");
    expect(f.repo.getAttempt(reserved.attempt.attempt_id)?.status).toBe("reserved");
  });

  it("does not count a manually marked receipt without a new turn as a completed instruction", () => {
    const f = installed();
    const reserved = reserve(f);
    f.sessions.markMessageApplied(reserved.message.message_id, 6);
    f.sessions.setState("sess_01", "awaiting_decision", reserved.reservation_version, 6);
    expect(() => f.repo.completeAttempt(reserved.attempt.attempt_id, "turn_1", 3, 6)).toThrow(/completion/i);
  });

  it("abandons interrupted checks without refunding budget and blocks uncertain reserved delivery", () => {
    const f = installed();
    const checking = f.repo.beginCheck("grant_1", 4);
    if (checking.outcome !== "checking") throw new Error(checking.outcome);
    expect(f.repo.recover(5)).toEqual({ abandoned: 1, blocked: 0 });
    expect(f.repo.getAttempt(checking.attempt.attempt_id)?.status).toBe("abandoned");
    expect(f.repo.get("grant_1")?.checks_used).toBe(1);
    const reserved = reserve(f, true, 6);
    expect(reserved.grant.checks_used).toBe(2);
    expect(f.repo.recover(8)).toEqual({ abandoned: 0, blocked: 1 });
    expect(f.repo.get("grant_1")).toMatchObject({ status: "blocked", reason: "delivery_uncertain", resumes_used: 1 });
    expect(f.repo.getAttempt(reserved.attempt.attempt_id)?.status).toBe("blocked");
    expect(f.repo.recover(9)).toEqual({ abandoned: 0, blocked: 0 });
    expect(f.repo.beginCheck("grant_1", 10).outcome).toBe("blocked");
  });

  it.each(["checks", "resumes"])("stops when the %s budget is exhausted", (budget) => {
    const f = setup();
    const grant = { ...body(), max_checks: budget === "checks" ? 1 : 4, max_resumes: budget === "resumes" ? 1 : 3 };
    f.repo.install(grant, digest(grant), "key_1", 3, "fixture-signature");
    const retry = reserve(f, false);
    complete(f, retry);
    expect(f.repo.beginCheck("grant_1", 7)).toMatchObject({ outcome: "blocked", reason: `${budget}_exhausted` });
  });
});
