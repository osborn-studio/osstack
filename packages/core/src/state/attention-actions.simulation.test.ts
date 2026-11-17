import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AttentionActions, type AttentionAnswer } from "./attention-actions.js";
import { AttentionStore, type AttentionOwner } from "./attention-store.js";
import { openDb } from "./db.js";

// A small command stepper is easier to replay than fast-check shrinking here: a
// crash must close and reopen the same SQLite file, including its owner lease.
const STEPS = Number(process.env.OSSTACK_PROPERTY_RUNS ?? 320);
const SEED = Number(process.env.OSSTACK_PROPERTY_SEED ?? 0x71a77e);
const EPISODE_STEPS = Math.max(16, Math.floor(STEPS / 200));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

type Db = ReturnType<typeof openDb>;
type ActionRow = {
  action_id: string;
  scope_id: string;
  item_id: string;
  message_id: string;
  state: string;
  payload_hash: string;
  created_at: number;
  updated_at: number;
};
type ItemRow = { state: string; revision: number; content_hash: string };
const decision = { decision_id: "d", question: "Choose?", choices: [] };
const terminal = new Set(["answer_applied", "answer_abandoned", "answer_cancelled"]);

function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
}

it("preserves answer identity, source guards, and terminal states through seeded SQLite crashes", () => {
  expect(Number.isSafeInteger(STEPS) && STEPS > 0).toBe(true);
  expect(Number.isSafeInteger(SEED) && SEED >= 0).toBe(true);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "attention-sim-")));
  const path = join(root, "state.db");
  let db: Db = openDb({ path });
  // Simulate object/process loss, not power loss; fsync is outside this model.
  db.pragma("synchronous = OFF");
  let store = new AttentionStore(db, path);
  let owner: AttentionOwner = store.claimOwner("simulation");
  let actions = new AttentionActions(store, owner);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)").run();
  const scope = store.registerScope(owner, "t", root);
  const next = random(SEED);
  let input!: AttentionAnswer;
  let sessionId = "";
  let actionId = "";
  let messageId: string | undefined;
  let executions = 0;
  let previousState = "open";
  let now = 1_000;
  let sourceChanged = false;
  let sourceError = "source_changed";
  let episode = -1;
  const trace: string[] = [];
  const item = () => db.prepare("SELECT state,revision,content_hash FROM attention_items WHERE item_id=?").get(input.item_id) as ItemRow;
  const action = () => db.prepare("SELECT * FROM attention_actions WHERE item_id=?").get(input.item_id) as ActionRow | undefined;
  const messageCount = () => (db.prepare("SELECT count(*) AS n FROM session_messages WHERE session_id=? AND direction='inbound'").get(sessionId) as { n: number }).n;
  const error = (fn: () => unknown, code: string) => {
    try { fn(); throw new Error(`expected ${code}`); }
    catch (cause) { if (!(cause instanceof Error) || cause.message !== code) throw cause; }
  };
  const restart = () => {
    db.close();
    db = openDb({ path });
    db.pragma("synchronous = OFF");
    store = new AttentionStore(db, path);
    owner = store.claimOwner("simulation-restarted");
    actions = new AttentionActions(store, owner);
  };
  const start = () => {
    episode++;
    sessionId = `s${episode}`;
    actionId = `a${episode}`;
    db.prepare("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES(?, 't', ?, 'codex-cli', 'code', 'execute', 1)").run(`r${episode}`, sessionId);
    db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES(?,'t',? ,? ,? ,? ,'awaiting_decision',1,1,1,?)")
      .run(sessionId, `r${episode}`, "codex-cli", "a".repeat(64), root, `native${episode}`);
    db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES(?,?,1,'awaiting_decision',?,1,1)")
      .run(`turn${episode}`, sessionId, JSON.stringify(decision));
    const projected = store.projectDecision(owner, { scopeId: scope.scope_id, sessionId, turnId: `turn${episode}`, sourceVersion: 1, decision, now });
    input = { scope_id: scope.scope_id, item_id: projected.item_id, action_id: actionId, revision: projected.revision, content_hash: projected.content_hash, text: `answer ${episode}`, takeover: false };
    messageId = undefined;
    executions = 0;
    previousState = "open";
    sourceChanged = false;
    sourceError = "source_changed";
  };
  start();
  for (let step = 0; step < STEPS; step++) {
    const choice = next() % 16;
    const label = ["answer", "replay", "conflict", "second-id", "crash-before", "crash-during", "late-state", "late-version", "late-turn", "late-decision", "uncertain", "recover", "abandon", "clock-rewind", "stale-revision", "stale-hash"][choice]!;
    trace.push(`${step}:${episode}:${label}`);
    try {
      if (step > 0 && step % EPISODE_STEPS === 0) start();
      now = choice === 13 ? now - 10 : now + 1;
      const before = executions;
      const current = item();
      if (choice === 0) {
        if (messageId) {
          const replay = actions.reserve(input, now);
          expect(replay.message_id).toBe(messageId);
          expect(replay.action_id).toBe(actionId);
          expect(replay.payload_hash).toBe(action()?.payload_hash);
          expect(replay.replay).toBe(true);
        } else if (sourceChanged || current.state !== "open") {
          error(() => actions.reserve(input, now), sourceChanged && current.state === "open" ? sourceError : "stale_item");
        } else {
          const reserved = actions.reserve(input, now);
          messageId = reserved.message_id;
          expect(reserved.replay).toBe(false);
        }
      } else if (choice === 1 && messageId) {
        const replay = actions.reserve(input, now);
        expect(replay.message_id).toBe(messageId);
        expect(replay.action_id).toBe(actionId);
        expect(replay.payload_hash).toBe(action()?.payload_hash);
        expect(replay.replay).toBe(true);
        expect(actions.replay(input)?.message_id).toBe(messageId);
      } else if (choice === 2 && messageId) {
        error(() => actions.reserve({ ...input, text: "different" }, now), "action_id_conflict");
        error(() => actions.replay({ ...input, text: "different" }), "action_id_conflict");
      } else if (choice === 3) {
        if (messageId || current.state !== "open") error(() => actions.reserve({ ...input, action_id: `${actionId}-second` }, now), "stale_item");
        else if (sourceChanged) error(() => actions.reserve({ ...input, action_id: `${actionId}-second` }, now), sourceError);
      } else if (choice === 4) {
        restart();
      } else if (choice === 5 && messageId) {
        // Crash after the external executor accepts the message but before its receipt is recorded.
        if (executions === 0 && current.state === "answer_reserved") executions++;
        restart();
        actions.recover();
      } else if (choice >= 6 && choice <= 9 && !messageId && !sourceChanged) {
        sourceChanged = true;
        sourceError = choice === 6 ? "session_not_awaiting_decision" : "source_changed";
        if (choice === 6) db.prepare("UPDATE agent_sessions SET state='running' WHERE session_id=?").run(sessionId);
        if (choice === 7) db.prepare("UPDATE agent_sessions SET version=version+1 WHERE session_id=?").run(sessionId);
        if (choice === 8) db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES(?,?,2,'awaiting_decision',?,1,1)").run(`later${episode}`, sessionId, JSON.stringify(decision));
        if (choice === 9) db.prepare("UPDATE session_turns SET decision_json=? WHERE session_id=?").run(JSON.stringify({ ...decision, question: "Changed?" }), sessionId);
        error(() => actions.reserve(input, now), sourceError);
      } else if (choice === 10 && messageId && executions === 0 && current.state === "answer_reserved") {
        executions++;
        db.prepare("UPDATE session_messages SET state='failed' WHERE message_id=?").run(messageId);
        actions.recover();
      } else if (choice === 11) {
        actions.recover();
        const row = action();
        if (row) actions.reconcile(row, now);
      } else if (choice === 12 && messageId && item().state === "answer_uncertain") {
        actions.abandon({ scope_id: scope.scope_id, session_id: sessionId, message_id: messageId, expected_version: 2, reason: "Executor outcome inspected", evidence_sha256: "b".repeat(64) }, now);
      } else if (choice === 14 && !messageId) {
        error(() => actions.reserve({ ...input, revision: input.revision + 1 }, now), "stale_item");
      } else if (choice === 15 && !messageId) {
        error(() => actions.reserve({ ...input, content_hash: "0".repeat(64) }, now), "stale_item");
      } else if (choice === 13) {
        if (messageId) expect(actions.reserve(input, now).message_id).toBe(messageId);
        else if (current.state === "open" && !sourceChanged) messageId = actions.reserve(input, now).message_id;
      }
      // A successful executor receipt can arrive after any reserved step.
      if (messageId && executions === 0 && item().state === "answer_reserved" && next() % 7 === 0) {
        executions++;
        db.prepare("UPDATE session_messages SET state='applied' WHERE message_id=?").run(messageId);
        actions.recover();
      }
      const after = item();
      expect(executions).toBeLessThanOrEqual(1);
      expect(action() === undefined ? 0 : 1).toBe(messageId ? 1 : 0);
      expect(messageCount()).toBe(messageId ? 1 : 0);
      if (messageId) expect(action()?.message_id).toBe(messageId);
      if (messageId) expect(action()?.action_id).toBe(actionId);
      if (terminal.has(previousState)) expect(after.state).toBe(previousState);
      if (current.state === "answer_uncertain") expect(executions).toBe(before);
      if (after.state === "answer_uncertain") expect(action()?.state).toBe("uncertain");
      if (after.state === "answer_applied") expect(action()?.state).toBe("applied");
      if (after.state === "answer_abandoned") expect(action()?.state).toBe("abandoned_unknown");
      previousState = after.state;
    } catch (cause) {
      throw new Error(`attention simulation seed=${SEED} step=${step} episode=${episode} trace=${trace.slice(-20).join(",")} cause=${String(cause)}`, { cause });
    }
  }
}, STEPS >= 100_000 ? 180_000 : 30_000);
