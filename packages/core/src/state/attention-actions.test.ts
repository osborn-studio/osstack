import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import {
  AttentionActions,
  reserveSessionInstruction,
} from "./attention-actions.js";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "actions-")));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    `INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)`
  );
  db.prepare(
    `INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at,native_session_id) VALUES('s','t','r','codex-cli',?,?,'awaiting_decision',1,1,1,'native')`
  ).run("a".repeat(64), root);
  const decision = { decision_id: "d", question: "Choose?", choices: [] };
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','s',1,'awaiting_decision',?,1,1)"
  ).run(JSON.stringify(decision));
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root);
  const item = store.projectDecision(owner, {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "turn",
    sourceVersion: 1,
    decision,
    now: 1,
  });
  const input = {
    scope_id: scope.scope_id,
    item_id: item.item_id,
    action_id: "a",
    revision: item.revision,
    content_hash: item.content_hash,
    text: "A",
    takeover: false,
  };
  return { db, path, input, actions: new AttentionActions(store, owner) };
}
it("reserves once, returns uncertainty on retry, and prevents replacement IDs after ambiguous delivery", () => {
  const { actions, input, db } = setup();
  const first = actions.reserve(input);
  const second = actions.reserve(input);
  expect(second.message_id).toBe(first.message_id);
  expect(second.state).toBe("uncertain");
  expect(() => actions.reserve({ ...input, action_id: "b" })).toThrow();
  expect(() => actions.reserve({ ...input, text: "B" })).toThrow(
    "action_id_conflict"
  );
  expect(
    (
      db.prepare("SELECT COUNT(*) n FROM session_messages").get() as {
        n: number;
      }
    ).n
  ).toBe(1);
});
it("reconciles an applied exact receipt without claiming task completion", () => {
  const { actions, input, db } = setup();
  const a = actions.reserve(input);
  db.prepare(
    "UPDATE session_messages SET state='applied' WHERE message_id=?"
  ).run(a.message_id);
  expect(actions.reserve(input).state).toBe("applied");
  expect(
    (
      db.prepare("SELECT status FROM tasks WHERE task_id='t'").get() as {
        status: string;
      }
    ).status
  ).toBe("running");
});
it("serializes a direct send against an inbox reservation", () => {
  const { actions, input, db, path } = setup();
  actions.reserve(input);
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "other",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "B" },
        state: "accepted",
        created_at: 2,
      },
      2,
      2
    )
  ).toThrow("delivery_uncertain");
});
it("requires a signed approval route for risk gates", () => {
  const { actions, input, db } = setup();
  db.exec(
    `UPDATE session_turns SET decision_json='{"decision_id":"d","question":"Choose?","choices":[],"continuation":{"version":1,"gate_kind":"risk_approval","phase":"deploy","next_action":"deploy","evidence_refs":[]}}'`
  );
  expect(() => actions.reserve(input)).toThrow("source_changed");
  expect(db.prepare("SELECT 1 FROM attention_actions").get()).toBeUndefined();
});
it("refuses terminal session revival and recovers crash-window reservations", () => {
  const { actions, input, db } = setup();
  db.exec("UPDATE agent_sessions SET state='cancelled'");
  expect(() => actions.reserve(input)).toThrow("session_not_awaiting_decision");
  db.exec("UPDATE agent_sessions SET state='awaiting_decision'");
  actions.reserve(input);
  actions.recover();
  expect(
    (db.prepare("SELECT state FROM attention_items").get() as { state: string })
      .state
  ).toBe("answer_uncertain");
});
it("requires risk approval even when source digest is unchanged, and provides explicit abandonment without replay", () => {
  const { actions, input, db, path } = setup();
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({
      decision_id: "d",
      question: "Deploy?",
      choices: [],
      continuation: {
        version: 1,
        gate_kind: "risk_approval",
        phase: "deploy",
        next_action: "deploy",
        evidence_refs: [],
      },
    })
  );
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "risk",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("signed_approval_required");
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({ decision_id: "d", question: "Choose?", choices: [] })
  );
  const reserved = actions.reserve(input);
  actions.recover();
  expect(
    actions.abandon({
      scope_id: input.scope_id,
      session_id: "s",
      message_id: reserved.message_id,
      expected_version: 2,
      reason:
        "Owner inspected uncertain effects; discard original instruction without replay",
      evidence_sha256: "a".repeat(64),
    })
  ).toMatchObject({ disposition: "abandoned_unknown", replayed: false });
  expect(actions.reserve(input).state).toBe("abandoned_unknown");
  expect(
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "new-manual",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "Inspect current state only" },
        state: "accepted",
        created_at: 3,
      },
      2,
      3
    ).session_version
  ).toBe(3);
});
it("rejects malformed structured risk decisions on the direct manual path", () => {
  const { db, path } = setup();
  db.prepare("UPDATE session_turns SET decision_json=?").run(
    JSON.stringify({
      decision_id: "risk",
      choices: [],
      continuation: { gate_kind: "risk_approval" },
    })
  );
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "m",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("invalid_decision");
  expect(db.prepare("SELECT 1 FROM session_messages").get()).toBeUndefined();
});

it("rejects an awaiting-decision turn with no decision on the direct path", () => {
  const { db, path } = setup();
  db.exec("UPDATE session_turns SET decision_json=NULL");
  expect(() =>
    reserveSessionInstruction(
      db,
      path,
      {
        message_id: "missing",
        session_id: "s",
        turn_id: "turn",
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: "yes" },
        state: "accepted",
        created_at: 1,
      },
      1,
      1
    )
  ).toThrow("invalid_decision");
  expect(db.prepare("SELECT 1 FROM session_messages").get()).toBeUndefined();
});
