import { expect, it } from "vitest";
import { publishedRecheck, runFixture } from "./local-failure-recheck.testkit.js";

it("requires a chain confirmation on the current head only until the ledger opens", () => {
  const d = publishedRecheck();
  const { ledger, f, dispatch } = d;
  d.recordConfirmation();
  expect(ledger.collectable(100)).toEqual([]);
  d.confirm();
  const candidate = { request_id: d.r.request_id, dispatch_id: dispatch.dispatch_id,
    child_mission_id: dispatch.child_mission_id, created_at: d.now, recheck_id: null };
  expect(ledger.collectable(1)).toEqual([candidate]);
  const move = f.db.prepare("UPDATE engineering_revision_chains SET published_head=?,revision=revision+1");
  move.run(f.v.head_sha);
  expect(ledger.collectable(1)).toEqual([]);
  move.run(d.payload.candidate);
  const { recheck_id } = d.open();
  move.run(f.v.head_sha);
  expect(ledger.collectable(1)).toEqual([{ ...candidate, recheck_id }]);
});

it.each(["awaiting_decision", "recheck_passed"])("excludes a row in %s", state => {
  const d = publishedRecheck();
  d.recordConfirmation(); d.confirm();
  const row = d.open(), result = d.add(state === "awaiting_decision" ? { skill_version: "2.0.0" } : {});
  const { runs, input, settle } = runFixture(d, row);
  const { run } = runs.reserve(input);
  settle(runs.start(run.run_id, run.revision));
  expect(d.ledger.evaluate({ result, recheck_id: row.recheck_id, now: d.now, host: runs.hostProof(row.recheck_id)!,
    actions: { attempt: 1, head_sha: row.new_head_sha, complete: true, conclusion: "success", digest: "d".repeat(64) } }).state).toBe(state);
  expect(d.ledger.collectable(100)).toEqual([]);
});

it("pages oldest first and breaks time ties by dispatch id", () => {
  // Combine independent fixtures for this read-only query. Two dispatches have the same timestamp.
  const fixtures = [publishedRecheck(), publishedRecheck(), publishedRecheck()] as const;
  for (const d of fixtures) { d.recordConfirmation(); d.confirm(); d.open(); }
  const [first, second, third] = fixtures;
  const db = first.f.db;
  db.prepare("ATTACH DATABASE ? AS second").run(second.f.path);
  db.prepare("ATTACH DATABASE ? AS third").run(third.f.path);
  const dispatches = "engineering_local_failure_dispatches", ledger = "engineering_local_failure_rechecks";
  db.exec(`CREATE TEMP VIEW ${dispatches} AS
    SELECT dispatch_id, request_id, child_mission_id, chain_id, created_at FROM main.${dispatches}
    UNION ALL SELECT dispatch_id, request_id, child_mission_id, chain_id, created_at FROM second.${dispatches}
    UNION ALL SELECT dispatch_id, request_id, child_mission_id, chain_id, created_at-1 FROM third.${dispatches};
    CREATE TEMP VIEW ${ledger} AS SELECT * FROM main.${ledger} UNION ALL SELECT * FROM second.${ledger} UNION ALL SELECT * FROM third.${ledger}`);
  const before = db.prepare("SELECT total_changes()").pluck().get();
  const rows = first.ledger.collectable(100);
  expect(rows.map(r => r.dispatch_id)).toEqual([third.dispatch.dispatch_id, ...[first.dispatch.dispatch_id, second.dispatch.dispatch_id].sort()]);
  expect(first.ledger.collectable(1)).toEqual(rows.slice(0, 1));
  expect(first.ledger.collectable(2, rows[0])).toEqual(rows.slice(1));
  expect(first.ledger.collectable(1, rows[1])).toEqual(rows.slice(2));
  expect(first.ledger.collectable(100, rows[2])).toEqual([]);
  for (const limit of [0, -1, 101, 1.1, NaN, Infinity]) expect(() => first.ledger.collectable(limit)).toThrowError("invalid_limit");
  expect(db.prepare("SELECT total_changes()").pluck().get()).toBe(before);
});
