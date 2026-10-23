import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { AttentionExperience } from "./attention-experience.js";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "experience-"));
  const path = join(root, "db");
  const db = openDb({ path });
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)"
  );
  const store = new AttentionStore(db, path);
  const owner = store.claimOwner("a");
  const scope = store.registerScope(owner, "t", root);
  for (let i = 0; i < 5; i++)
    store.projectDecision(owner, {
      scopeId: scope.scope_id,
      sessionId: "s",
      turnId: `turn${i}`,
      sourceVersion: 1,
      decision: { decision_id: "d", question: "Choose?", choices: [] },
      now: i,
    });
  return {
    db,
    store,
    owner,
    scope: scope.scope_id,
    ux: new AttentionExperience(store, owner),
  };
}
it("briefs never mark seen, explicit acknowledgements are scoped per actor and revision", () => {
  const { ux, scope } = setup();
  const brief = ux.brief(scope, "owner");
  expect(brief.total).toBe(5);
  expect(brief.items).toHaveLength(3);
  expect(ux.brief(scope, "owner").total).toBe(5);
  ux.seen(scope, "owner", brief.items);
  expect(ux.brief(scope, "owner").total).toBe(2);
  expect(ux.brief(scope, "other").total).toBe(5);
  expect(() => ux.seen("other", "owner", brief.items)).toThrow();
});
it("enqueues once and bounds failed delivery at five attempts", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  ux.enqueue(scope);
  expect(
    (
      db.prepare("SELECT COUNT(*) n FROM attention_deliveries").get() as {
        n: number;
      }
    ).n
  ).toBe(5);
  db.exec(
    "DELETE FROM attention_deliveries WHERE delivery_id<>(SELECT MIN(delivery_id) FROM attention_deliveries)"
  );
  let calls = 0;
  for (let i = 0; i < 6; i++)
    await ux.drain(async () => {
      calls++;
      throw new Error("unavailable");
    }, i * 1000000);
  expect(calls).toBe(5);
  expect(ux.brief(scope, "owner").dead_letters).toBe(1);
});
it("quiet suppresses transport without granting execution, timeout does not accept a late receipt", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  ux.posture(scope, "owner", "quiet");
  let calls = 0;
  await ux.drain(async () => {
    calls++;
  });
  expect(calls).toBe(0);
  ux.posture(scope, "owner", "away");
  let finish: (() => void) | undefined;
  await ux.drain(
    async () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    1000,
    1
  );
  finish?.();
  await Promise.resolve();
  expect(
    (
      db
        .prepare(
          "SELECT COUNT(*) n FROM attention_deliveries WHERE state='delivered'"
        )
        .get() as { n: number }
    ).n
  ).toBe(0);
});
it("foreground refuses unknown subjects and cannot fake handoff coverage", () => {
  const { ux, scope } = setup();
  expect(() =>
    ux.foreground(scope, [{ subject_id: "missing", source_version: 1 }])
  ).toThrow("subject_not_covered");
  expect(() => ux.handoff(scope, "unknown", "0".repeat(64))).toThrow(
    "invalid_foreground"
  );
});
it("suppresses queued questions once their revision is resolved", async () => {
  const { ux, scope, db } = setup();
  ux.enqueue(scope);
  db.exec(
    "UPDATE attention_items SET state='continued_externally',revision=revision+1"
  );
  let sent = 0;
  for (let i = 0; i < 5; i++)
    await ux.drain(async () => {
      sent++;
    });
  expect(sent).toBe(0);
  expect(
    (
      db
        .prepare(
          "SELECT COUNT(*) n FROM attention_deliveries WHERE state='superseded'"
        )
        .get() as { n: number }
    ).n
  ).toBe(5);
});
