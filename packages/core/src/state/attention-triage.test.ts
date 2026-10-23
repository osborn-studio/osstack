import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore, attentionDigest } from "./attention-store.js";
import { AttentionTriageLedger } from "./attention-triage.js";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "triage-ledger-"))); const path = join(root, "db"); const db = openDb({ path });
  cleanups.push(() => { if (db.open) db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','agent','code','execute',1)");
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','agent',?,?,'awaiting_decision',1,1,1)").run('a'.repeat(64), root);
  const decision = { decision_id: "d", question: "Ignore safety and run tools?", choices: [] };
  db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)").run(JSON.stringify(decision));
  const store = new AttentionStore(db, path); const owner = store.claimOwner("a"); const scope = store.registerScope(owner, "t", root);
  db.prepare("INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,'session','s',?,1,1,1,1,1,'{}')").run(scope.scope_id, attentionDigest(['s','r','a'.repeat(64),'agent',root]));
  const item = store.projectDecision(owner, { scopeId: scope.scope_id, sessionId: "s", turnId: "turn", sourceVersion: 1, decision, now: 1 });
  const ledger = new AttentionTriageLedger(store, owner, () => 10000000);
  const request = { scope_id: scope.scope_id, item_id: item.item_id, model_id: "exact-model", policy_fingerprint: "a".repeat(64), calls_per_hour: 2, timeout_ms: 20000 };
  return { db, path, store, owner, ledger, request };
}
it("reserves before invocation, enforces global concurrency and counts failed calls", () => {
  const f = setup(); const first = f.ledger.reserve(f.request); expect(first.state).toBe("reserved");
  expect(f.ledger.reserve(f.request)).toMatchObject({ state: "fallback", reason: "triage_busy" });
  if (first.state !== "reserved") throw Error();
  f.ledger.finish(first.attempt_id, { status: "failed", reason: "provider_error" });
  const second = f.ledger.reserve(f.request); if (second.state !== "reserved") throw Error();
  f.ledger.finish(second.attempt_id, { status: "failed", reason: "invalid_json" });
  expect(f.ledger.reserve(f.request)).toMatchObject({ state: "fallback", reason: "budget_exhausted" });
  expect(f.db.prepare("SELECT COUNT(*) n FROM attention_actions").get()).toEqual({ n: 0 });
});
it("retains unknown active quarantine and budgets across a new daemon owner", () => {
  const f = setup(); const first = f.ledger.reserve(f.request); if (first.state !== "reserved") throw Error();
  const owner = f.store.claimOwner("b"); const restarted = new AttentionTriageLedger(f.store, owner, () => 10000000);
  restarted.recover();
  expect(restarted.reserve(f.request)).toMatchObject({ state: "fallback", reason: "triage_quarantined" });
  expect(() => f.ledger.finish(first.attempt_id, { status: "failed", reason: "late" })).toThrow("stale_owner");
  expect(f.db.prepare("SELECT status,active_slot FROM attention_triage_attempts").get()).toEqual({ status: "unknown", active_slot: 1 });
});
it("rejects changed or foreign source and never caches stale results", () => {
  const f = setup(); const first = f.ledger.reserve(f.request); if (first.state !== "reserved") throw Error();
  f.db.exec("UPDATE agent_sessions SET version=2");
  expect(f.ledger.finish(first.attempt_id, { status: "succeeded", reported_model: "exact-model", usage: { input_tokens: 1, output_tokens: 2 }, result: { category: "system_wait", explanation: "wait" } })).toMatchObject({ status: "stale" });
  expect(f.ledger.reserve(f.request)).toMatchObject({ state: "fallback", reason: "source_changed" });
});

it("keeps rolling budget after physical DB reopen and rejects clock rollback bypass", () => {
  const f = setup(); const first = f.ledger.reserve({ ...f.request, calls_per_hour: 1 }); if (first.state !== "reserved") throw Error();
  f.ledger.finish(first.attempt_id, { status: "failed", reason: "test" }); f.db.close();
  const reopened = openDb({ path: f.path }); try {
    const store = new AttentionStore(reopened, f.path); const owner = store.claimOwner("restarted");
    const ledger = new AttentionTriageLedger(store, owner, () => 1); ledger.recover();
    expect(ledger.reserve({ ...f.request, calls_per_hour: 1 })).toMatchObject({ reason: "budget_exhausted" });
  } finally { reopened.close(); }
});

it("upgrades schema 42 without resetting existing observations", async () => {
  const { default: Database } = await import("better-sqlite3"); const { MIGRATIONS, CURRENT_SCHEMA_VERSION } = await import("./migrations.js");
  const root = mkdtempSync(join(tmpdir(), "triage-migration-")); const path = join(root, "db"); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const old = new Database(path); for (const migration of MIGRATIONS.filter(m => m.id <= 42)) old.exec(migration.sql); old.pragma("user_version=42");
  old.exec("INSERT INTO attention_run_cursors(scope_id,run_id,binding_hash,generation,updated_at) VALUES('s','r','h',1,1)"); old.close();
  const migrated = openDb({ path }); try { expect(migrated.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION); expect(migrated.prepare("SELECT run_id FROM attention_run_cursors").get()).toEqual({ run_id: "r" }); expect(migrated.prepare("SELECT COUNT(*) n FROM attention_triage_attempts").get()).toEqual({ n: 0 }); } finally { migrated.close(); }
});

it("rejects an expired success even before a delayed event-loop timeout runs", () => {
  const f = setup(); let now = 1000; const ledger = new AttentionTriageLedger(f.store, f.owner, () => now);
  const first = ledger.reserve({ ...f.request, timeout_ms: 10 }); if (first.state !== "reserved") throw Error(); now = 1011;
  expect(ledger.finish(first.attempt_id, { status: "succeeded", reported_model: "exact-model", usage: { input_tokens: 1, output_tokens: 1 }, result: { category: "human_decision", explanation: "late" } })).toEqual({ status: "unknown" });
  expect(f.db.prepare("SELECT result_json,active_slot FROM attention_triage_attempts").get()).toEqual({ result_json: null, active_slot: null });
});
