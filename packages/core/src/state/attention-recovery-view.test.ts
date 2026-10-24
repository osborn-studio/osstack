import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionObserver } from "./attention-observer.js";
import { readAttentionRecovery } from "./attention-recovery-view.js";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function setup() {
  const root = realpathSync(createScratchDirSync("tests", "attention-recovery")); const path = join(root, "db"); const db = openDb({ path });
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','agent','code','execute',1)");
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','agent',?,?,'awaiting_decision',1,1,1)").run('a'.repeat(64), root);
  db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)").run(JSON.stringify({ decision_id: 'd', question: 'secret question', choices: [] }));
  const store = new AttentionStore(db, path); const owner = store.claimOwner("owner"); const scope = store.registerScope(owner, 't', root); new AttentionObserver(store, owner).tick(1000);
  const read = () => readAttentionRecovery(store, owner, { scope_id: scope.scope_id }, 1001);
  return { db, store, owner, scope, read };
}
it("reads bounded recovery evidence without mutating rows or exposing message contents", () => {
  const { db, read } = setup();
  for (const [id, state] of [['m1', 'accepted'], ['m2', 'failed'], ['m3', 'applied']]) db.prepare("INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at) VALUES(?,'s','turn','inbound','text',?, ?,1)").run(id, JSON.stringify({ text: 'secret content' }), state);
  const before = db.prepare("SELECT total_changes() n").get(); const view = read();
  expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
  const session = view.subjects.find(row => row.kind === 'session')!;
  expect(session).toMatchObject({ state: 'unknown', canAutoRetry: false, missing_evidence: ['terminal_receipt'], messages: { total: 3, truncated: false } });
  expect(session.messages?.rows.map(row => row.state)).toEqual(['accepted','failed','applied']);
  expect(JSON.stringify(view)).not.toContain('secret');
});
it.each(['run_session','run_agent','tenant','binding','stale'])('fails closed for %s evidence binding', mode => {
  const { db, read } = setup();
  if (mode === 'run_session') db.exec("UPDATE runs SET session_id='other'");
  if (mode === 'run_agent') db.exec("UPDATE runs SET agent_id='other'");
  if (mode === 'tenant') db.exec("UPDATE runs SET tenant_id='foreign'");
  if (mode === 'binding') db.exec("UPDATE attention_subjects SET binding_hash='bad' WHERE kind='session'");
  if (mode === 'stale') db.exec("UPDATE agent_sessions SET version=2");
  const session = read().subjects.find(row => row.kind === 'session')!;
  expect(session.state).toBe('unknown'); expect(session.messages).toBeUndefined();
});
it("keeps abandoned-unknown unresolved and exposes checking grant IDs without signatures", () => {
  const { db, read } = setup();
  db.exec("INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at) VALUES('m','s','turn','inbound','text','{}','failed',1)");
  db.exec("INSERT INTO attention_receipt_resolutions(message_id,session_id,session_version,disposition,reason,evidence_sha256,created_at) VALUES('m','s',1,'abandoned_unknown','secret','secret',1)");
  db.exec("INSERT INTO session_continuation_grants(grant_id,session_id,body_json,digest,key_id,signature,status,expected_turn_id,expected_version,created_at,updated_at) VALUES('g','s','{}','digest','key','secret','active','turn',1,1,1)");
  db.exec("INSERT INTO session_continuation_attempts(attempt_id,grant_id,step_index,source_turn_id,source_version,decision_sha256,status,created_at,updated_at) VALUES('a','g',0,'turn',1,'digest','checking',1,1)");
  const view = read(); const session = view.subjects.find(row => row.kind === 'session')!;
  expect(session.state).toBe('unknown'); expect(session.missing_evidence).toContain('continuation_receipt');
  expect(session.messages?.rows[0]?.disposition).toBe('abandoned_unknown'); expect(JSON.stringify(view)).not.toContain('secret');
});
it("paginates evidence with consistent counts and rejects foreign scope ownership", () => {
  const { store, owner, scope, db } = setup();
  for (let i=0;i<25;i++) db.prepare("INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at) VALUES(?,'s','turn','inbound','text','{}','failed',?)").run(`m${i}`, i);
  const first = readAttentionRecovery(store, owner, { scope_id: scope.scope_id, limit: 1 }, 1001);
  expect(first).toMatchObject({ total: 2, truncated: true });
  const next = readAttentionRecovery(store, owner, { scope_id: scope.scope_id, limit: 1, after: first.next_after! }, 1001);
  const session = [...first.subjects, ...next.subjects].find(row => row.kind === 'session')!;
  expect(session.messages).toMatchObject({ total: 25, truncated: true }); expect(session.messages?.rows).toHaveLength(20);
  db.exec("UPDATE tasks SET tenant_id='foreign'"); expect(() => readAttentionRecovery(store, owner, { scope_id: scope.scope_id })).toThrow('scope_unavailable');
});
it("does not show fresh-looking evidence after scope expiry or a backward wall clock", () => {
  const { store, owner, scope } = setup();
  for (const now of [999, 70000]) {
    const view = readAttentionRecovery(store, owner, { scope_id: scope.scope_id }, now);
    expect(view.subjects.every(row => row.state === 'unknown' && row.messages === undefined)).toBe(true);
  }
});

it("does not classify an unrecognized source state as observed", () => {
  const { db, read } = setup();
  db.pragma("ignore_check_constraints=ON");
  db.exec("UPDATE agent_sessions SET state='unknown'");
  db.pragma("ignore_check_constraints=OFF");
  expect(read().subjects.find(row => row.kind === 'session')?.state).toBe('unknown');
});
it("isolates oversized identities and keeps pagination bounded", () => {
  const { db, read, store, owner, scope } = setup();
  db.prepare("UPDATE attention_subjects SET subject_id=? WHERE kind='run'").run('x'.repeat(10000));
  const view = read(); expect(view.subjects.find(row => row.kind === 'run')).toMatchObject({ subject_id: null, state: 'unknown', missing_evidence: ['invalid_source_identity'] });
  expect(view.subjects.find(row => row.kind === 'session')?.state).toBe('pending_human');
  const page = readAttentionRecovery(store, owner, { scope_id: scope.scope_id, limit: 1 }, 1001);
  expect(page.next_after!.length).toBeLessThan(20);
});
it("isolates one oversized receipt instead of hiding other subjects", () => {
  const { db, read } = setup();
  db.prepare("INSERT INTO session_messages(message_id,session_id,turn_id,direction,kind,payload_json,state,created_at) VALUES(?,'s','turn','inbound','text','{}','failed',1)").run('x'.repeat(10000));
  const view = read(); expect(view.subjects.find(row => row.kind === 'session')).toMatchObject({ state: 'unknown', missing_evidence: ['invalid_evidence'] });
  expect(view.subjects.find(row => row.kind === 'run')?.retained_run_cursor).toBeDefined();
});
