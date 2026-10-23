import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "attention-store-"));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','task','running',1,1)"
  );
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("daemon-a");
  const scope = store.registerScope(owner, "t", root);
  return { db, store, owner, scope };
}
const decision = {
  decision_id: "d",
  question: "Choose?",
  choices: [{ choice_id: "a", label: "A" }],
};
it("keeps one decision episode across unrelated CAS changes and isolates repeated IDs in new turns", () => {
  const { store, owner, scope } = setup();
  const a = store.projectDecision(owner, {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "t1",
    sourceVersion: 1,
    decision,
    now: 1,
  });
  const b = store.projectDecision(owner, {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "t1",
    sourceVersion: 2,
    decision,
    now: 2,
  });
  expect(a.item_id).toBe(b.item_id);
  expect(store.listItems(scope.scope_id)).toHaveLength(1);
  store.projectDecision(owner, {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "t2",
    sourceVersion: 3,
    decision,
    now: 3,
  });
  expect(store.listItems(scope.scope_id)).toHaveLength(2);
});
it("rejects changed content, stale owners and cross-scope access without losing evidence", () => {
  const { store, owner, scope } = setup();
  const input = {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "t",
    sourceVersion: 1,
    decision,
    now: 1,
  };
  const item = store.projectDecision(owner, input);
  expect(() =>
    store.projectDecision(owner, {
      ...input,
      decision: { ...decision, question: "Changed" },
    })
  ).toThrow(/content_conflict/);
  expect(store.getItem("other", item.item_id)).toBeUndefined();
  store.claimOwner("daemon-b");
  expect(() => store.projectDecision(owner, input)).toThrow(/stale_owner/);
  expect(store.getItem(scope.scope_id, item.item_id)?.decision.question).toBe(
    "Choose?"
  );
});
it("preserves minimal decision snapshots when the task source is deleted", () => {
  const { db, store, owner, scope } = setup();
  const item = store.projectDecision(owner, {
    scopeId: scope.scope_id,
    sessionId: "s",
    turnId: "t",
    sourceVersion: 1,
    decision,
    now: 1,
  });
  db.exec("DELETE FROM tasks WHERE task_id='t'");
  store.markMissing(owner, scope.scope_id, "s");
  expect(store.getItem(scope.scope_id, item.item_id)).toMatchObject({
    state: "source_missing",
    decision,
  });
});
