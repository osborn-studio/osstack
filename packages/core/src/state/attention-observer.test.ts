import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionObserver } from "./attention-observer.js";
const clean: Array<() => void> = [];
afterEach(() => clean.splice(0).forEach((fn) => { fn(); }));
function setup(n = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "observer-")));
  const path = join(root, "db");
  const db = openDb({ path });
  clean.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','task','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)"
  );
  for (let i = 0; i < n; i++) {
    const id = `s${i.toString().padStart(4, "0")}`;
    db.prepare(
      "INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES(?,'t','r','codex-cli','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,'awaiting_decision',1,1,1)"
    ).run(id, root);
    db.prepare(
      "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES(?,?,1,'awaiting_decision',?,1,1)"
    ).run(
      `turn${i}`,
      id,
      JSON.stringify({ decision_id: "d", question: "Choose?", choices: [] })
    );
  }
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root);
  const observer = new AttentionObserver(store, owner);
  return { db, store, owner, scope, observer };
}
it("discovers beyond 200 with bounded admission and never claims complete capacity", () => {
  const { observer, scope, db } = setup(220);
  observer.tick(1000);
  observer.tick(2000);
  const view = observer.inventory(scope.scope_id, 2000);
  expect(view.subject_total).toBe(221);
  expect(view.admitted).toBe(100);
  expect(view.coverage).toBe("degraded");
  expect(
    (
      db
        .prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=0")
        .get() as { n: number }
    ).n
  ).toBe(121);
});
it("projects historical turns atomically and discloses missing ordinal gaps", () => {
  const { observer, scope, db, store } = setup();
  observer.tick(1000);
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('later','s0000',3,'awaiting_decision',?,1,1)"
  ).run(JSON.stringify({ decision_id: "d", question: "Next?", choices: [] }));
  observer.tick(2000);
  expect(store.listItems(scope.scope_id)).toHaveLength(2);
  expect(JSON.stringify(observer.inventory(scope.scope_id, 2000))).toContain(
    "history_gap"
  );
});
it("fences old generations, retains missing source, and expires coverage independently of business state", () => {
  const { observer, scope, db, store } = setup();
  observer.tick(1000);
  expect(observer.inventory(scope.scope_id, 100000).coverage).toBe("uncovered");
  db.exec("DELETE FROM session_turns; DELETE FROM agent_sessions");
  observer.tick(2000);
  expect(store.listItems(scope.scope_id)[0]?.state).toBe("source_missing");
  store.claimOwner("replacement");
  expect(() => observer.tick(3000)).toThrow("stale_owner");
});
it("isolates a poison decision to its subject instead of blinding a healthy session", () => {
  const { observer, scope, db, store } = setup(2);
  db.exec(
    "UPDATE session_turns SET decision_json='bad' WHERE session_id='s0000'"
  );
  observer.tick(1000);
  expect(store.listItems(scope.scope_id).map((i) => i.session_id)).toContain(
    "s0001"
  );
  expect(observer.inventory(scope.scope_id, 1000).coverage).toBe("degraded");
});
it("issues only observation handoff receipts and rejects gaps and stale foreground generations", async () => {
  const { AttentionExperience } = await import("./attention-experience.js");
  const { observer, scope, db, store, owner } = setup();
  observer.tick(1000);
  const ux = new AttentionExperience(store, owner);
  const fg = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1001
  );
  const receipt = ux.handoff(scope.scope_id, fg.client_id, fg.token, 1002);
  expect(receipt).toMatchObject({
    execution_takeover: false,
    process_liveness: "unknown",
    valid_until: 66000,
  });
  const fg2 = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1003
  );
  expect(
    ux.turnEnd(
      scope.scope_id,
      fg2.client_id,
      fg2.token,
      "foreground_owner",
      1004
    ).reminder
  ).not.toBeNull();
  expect(
    ux.turnEnd(
      scope.scope_id,
      fg2.client_id,
      fg2.token,
      "foreground_owner",
      1005
    ).reminder
  ).toBeNull();
  db.prepare(
    "UPDATE attention_subjects SET payload_json=json_set(payload_json,'$.gap','history_gap') WHERE kind='session'"
  ).run();
  expect(() =>
    ux.handoff(scope.scope_id, fg2.client_id, fg2.token, 1006)
  ).toThrow("coverage_not_ready");
  store.claimOwner("new");
  expect(() =>
    ux.turnEnd(
      scope.scope_id,
      fg2.client_id,
      fg2.token,
      "foreground_owner",
      1007
    )
  ).toThrow("stale_owner");
});
it("keeps gaps sticky across transient invalid observations and continues after corrupt turns", () => {
  const { observer, scope, db, store } = setup();
  observer.tick(1000);
  db.exec("UPDATE session_turns SET ordinal=3,decision_json='bad'");
  observer.tick(2000);
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('healthy','s0000',4,'awaiting_decision',?,1,1)"
  ).run(
    JSON.stringify({
      decision_id: "new",
      question: "Healthy after poison",
      choices: [],
    })
  );
  observer.tick(3000);
  expect(
    store.listItems(scope.scope_id).some((i) => i.turn_id === "healthy")
  ).toBe(true);
  db.exec("UPDATE agent_sessions SET version=2");
  observer.tick(4000);
  expect(observer.inventory(scope.scope_id, 4000).coverage).toBe("degraded");
});
it("allows a once-only expired foreground reminder but never silently renews a handoff receipt", async () => {
  const { AttentionExperience } = await import("./attention-experience.js");
  const { observer, scope, store, owner } = setup();
  observer.tick(1000);
  const ux = new AttentionExperience(store, owner);
  const fg = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1001
  );
  const receipt = ux.handoff(scope.scope_id, fg.client_id, fg.token, 1002);
  observer.tick(5000);
  expect(
    ux.handoff(scope.scope_id, fg.client_id, fg.token, 6000)
  ).toMatchObject({ valid_until: receipt.valid_until });
  const other = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    6001
  );
  expect(
    ux.turnEnd(
      scope.scope_id,
      other.client_id,
      other.token,
      "foreground_owner",
      200000
    )
  ).toMatchObject({ foreground_expired: true, continues: false });
});
it("isolates discovery filesystem errors and permits explicit slot release without silent eviction", () => {
  const { observer, scope, db, store, owner } = setup(2);
  db.prepare(
    "UPDATE agent_sessions SET repo_path=? WHERE session_id='s0000'"
  ).run(store.path + "/not-a-directory");
  observer.tick(1000);
  expect(
    store.listItems(scope.scope_id).some((i) => i.session_id === "s0001")
  ).toBe(true);
  expect(observer.inventory(scope.scope_id, 1000).coverage).toBe("degraded");
  store.release(owner, scope.scope_id, "session", "s0001", 1);
  observer.tick(2000);
  expect(
    (
      db
        .prepare(
          "SELECT admitted FROM attention_subjects WHERE subject_id='s0001'"
        )
        .get() as { admitted: number }
    ).admitted
  ).toBe(0);
});
it("rolls back a subject cursor when a late projection failure would otherwise erase a newly found gap", () => {
  const { observer, scope, db } = setup();
  observer.tick(1000);
  db.prepare(
    "INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('gap-turn','s0000',3,'awaiting_decision',?,1,1)"
  ).run(JSON.stringify({ decision_id: "next", question: "Next", choices: [] }));
  db.exec("UPDATE attention_items SET decision_json='bad'");
  observer.tick(2000);
  expect(
    (
      db
        .prepare(
          "SELECT ordinal_cursor FROM attention_subjects WHERE subject_id='s0000'"
        )
        .get() as { ordinal_cursor: number }
    ).ordinal_cursor
  ).toBe(1);
  db.prepare("UPDATE attention_items SET decision_json=?").run(
    JSON.stringify({ decision_id: "d", question: "Choose?", choices: [] })
  );
  observer.tick(3000);
  expect(observer.inventory(scope.scope_id, 3000).coverage).toBe("degraded");
});

it("reuses explicitly released capacity without silently evicting or readmitting its old owner", () => {
  const { observer, scope, store, owner, db } = setup(101);
  observer.tick(1000);
  store.release(owner, scope.scope_id, "session", "s0000", 1);
  observer.tick(2000);
  expect(
    db
      .prepare(
        "SELECT admitted FROM attention_subjects WHERE subject_id='s0100'"
      )
      .get()
  ).toEqual({ admitted: 1 });
  expect(
    db
      .prepare(
        "SELECT admitted FROM attention_subjects WHERE subject_id='s0000'"
      )
      .get()
  ).toEqual({ admitted: 0 });
  expect(observer.inventory(scope.scope_id, 2000).coverage).toBe("degraded");
  expect(
    store.listItems(scope.scope_id).some((item) => item.session_id === "s0000")
  ).toBe(true);
});

it("degrades coverage when a previously admitted standalone run disappears", () => {
  const { db, observer, scope } = setup(0);
  observer.tick(1000);
  expect(observer.inventory(scope.scope_id, 1000).coverage).toBe("covered");
  db.exec("DELETE FROM runs");
  observer.tick(2000);
  expect(observer.inventory(scope.scope_id, 2000).coverage).toBe("degraded");
  expect(JSON.stringify(observer.inventory(scope.scope_id, 2000))).toContain(
    "source_missing"
  );
});
it("replays an expired handoff as historical evidence without renewing it", async () => {
  const { AttentionExperience } = await import("./attention-experience.js");
  const { observer, scope, store, owner } = setup();
  observer.tick(1000);
  const ux = new AttentionExperience(store, owner);
  const fg = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1001
  );
  const receipt = ux.handoff(scope.scope_id, fg.client_id, fg.token, 1002);
  expect(
    ux.handoff(scope.scope_id, fg.client_id, fg.token, 130000)
  ).toMatchObject({
    receipt_id: receipt.receipt_id,
    valid_until: 66000,
    expired: true,
    currently_valid: false,
  });
  const fresh = ux.foreground(
    scope.scope_id,
    [{ subject_id: "s0000", source_version: 1 }],
    1001
  );
  expect(() =>
    ux.handoff(scope.scope_id, fresh.client_id, fresh.token, 130000)
  ).toThrow("invalid_foreground");
});

it("slices only admitted subjects fairly while preserving per-source event cursors", () => {
  const { observer, scope, db } = setup(100);
  let rounds = 0; let complete = false;
  while (!complete && rounds++ < 20) {
    const slice = observer.step({ maxSubjects: 7, maxEvents: 14, maxDurationMs: 1000 }, 2000);
    expect(slice.subjectsSampled).toBeLessThanOrEqual(7);
    expect(slice.eventQuotaUsed).toBeLessThanOrEqual(14);
    complete = slice.passComplete;
  }
  expect(complete).toBe(true);
  expect(rounds).toBe(15);
  expect((db.prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1 AND ordinal_cursor=1").get() as { n: number }).n).toBe(100);
  expect(observer.inventory(scope.scope_id, 2000).subject_total).toBe(101);
});
it("does not revive an admitted subject released between slices", () => {
  const { observer, scope, store, owner, db } = setup(3);
  observer.step({ maxSubjects: 1, maxEvents: 1, maxDurationMs: 1000 }, 2000);
  store.release(owner, scope.scope_id, "session", "s0002", 1);
  while (!observer.step({ maxSubjects: 1, maxEvents: 1, maxDurationMs: 1000 }, 2000).passComplete) { /* drain pass */ }
  expect(db.prepare("SELECT admitted,ordinal_cursor FROM attention_subjects WHERE subject_id='s0002'").get()).toMatchObject({ admitted: 0, ordinal_cursor: 0 });
});
it("keeps capacity overflow explicit and advances the existing discovery cursor across passes", () => {
  const { observer, scope, db } = setup(600);
  for (let pass = 0; pass < 3; pass++) {
    while (!observer.step({ maxSubjects: 25, maxEvents: 200, maxDurationMs: 1000 }, 2000 + pass).passComplete) { /* drain pass */ }
  }
  expect(observer.inventory(scope.scope_id, 2003)).toMatchObject({ subject_total: 601, admitted: 100, coverage: "degraded" });
  expect((db.prepare("SELECT COUNT(*) n FROM attention_subjects WHERE admitted=0 AND json_extract(payload_json,'$.reason')='capacity_exceeded'").get() as { n: number }).n).toBe(501);
});
it("does not call an unknown observation healthy when its reason field is absent", () => {
  const { observer, scope, db } = setup(1);
  observer.tick(2000);
  db.prepare("UPDATE attention_subjects SET payload_json=?").run(JSON.stringify({ state: "unknown", reason: null }));
  expect(observer.inventory(scope.scope_id, 2001).coverage).toBe("degraded");
});
it("fences an interrupted slice after owner replacement", () => {
  const { observer, store } = setup(4);
  observer.step({ maxSubjects: 1, maxEvents: 1, maxDurationMs: 1000 }, 1000);
  store.claimOwner("new");
  expect(() => observer.step({}, 2000)).toThrow("stale_owner");
});
it("does not publish full coverage while newly admitted subjects still await sampling", () => {
  const { observer, scope } = setup(4);
  observer.step({ maxSubjects: 1, maxEvents: 1, maxDurationMs: 1000 }, 1000);
  expect(observer.inventory(scope.scope_id, 1001).coverage).toBe("degraded");
  expect(observer.inventory(scope.scope_id, 999).coverage).toBe("unknown");
});
it("retains explicit release when a scope disappears and later returns", () => {
  const { observer, scope, store, owner, db } = setup(2);
  observer.tick(1000); store.release(owner, scope.scope_id, 'session', 's0001', 1);
  db.exec("UPDATE tasks SET created_at=2"); observer.tick(2000);
  db.exec("UPDATE tasks SET created_at=1"); observer.tick(3000);
  expect(db.prepare("SELECT admitted,json_extract(payload_json,'$.reason') reason FROM attention_subjects WHERE subject_id='s0001'").get()).toMatchObject({ admitted: 0, reason: 'owner_released' });
});
it.each(['{', '{}'])("does not infer readmission when released metadata becomes %s", payload => {
  const { observer, scope, store, owner, db } = setup(2);
  observer.tick(1000); store.release(owner, scope.scope_id, 'session', 's0001', 1);
  db.prepare("UPDATE attention_subjects SET payload_json=? WHERE kind='session' AND subject_id='s0001'").run(payload);
  observer.tick(2000);
  expect(db.prepare("SELECT admitted FROM attention_subjects WHERE subject_id='s0001'").get()).toEqual({ admitted: 0 });
});
