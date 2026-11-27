import { afterAll, afterEach, expect, it } from "vitest";
import { diagnosisFixture } from "./diagnosis-fixtures.js";
import { openDb } from "./db.js";
import { DecisionProbes } from "./decision-probes.js";

const db = openDb({ path: ":memory:" });
afterAll(() => db.close());
afterEach(() => { db.exec("DELETE FROM decision_probes"); });
const store = new DecisionProbes(db);
const create = (now: number) => store.create({ now, created_by: "owner" });
const changes = () => db.prepare("SELECT total_changes()").pluck().get();

it("reuses a pending card up to its exact expiry and derives expiry without writes", () => {
  const { probe, created } = create(100);
  expect(created).toBe(true);
  expect(probe.probe_id).toMatch(/^[a-f0-9]{32}$/);
  expect(probe).toMatchObject({ revision: 1, created_at: 100, expires_at: 3600100, state: "pending" });
  const before = changes();
  expect(create(probe.expires_at - 1)).toEqual({ probe, created: false });
  expect(store.status(probe.probe_id, probe.expires_at)).toMatchObject({ state: "pending", expired: true });
  expect(store.continue(probe.probe_id, 101).code).toBe("pending");
  expect(store.continue(probe.probe_id, probe.expires_at).code).toBe("expired");
  expect(changes()).toBe(before);
  expect(create(probe.expires_at).probe.probe_id).not.toBe(probe.probe_id);
});

it("orders receipts, resolution, revision and colour checks and continues exactly once", () => {
  const { probe } = create(1);
  const req = { probe_id: probe.probe_id, answer: "red", answer_id: "one", digest: "digest", actor: "human", expected_revision: 1, now: 2 };
  expect(store.answer({ ...req, probe_id: "missing" }).code).toBe("not_found");
  expect(store.continue("missing", 2).code).toBe("not_found");
  expect(store.answer({ ...req, now: probe.expires_at, expected_revision: 0 }).code).toBe("already_resolved");
  expect(store.answer({ ...req, expected_revision: 0, answer: "pink" }).code).toBe("stale_revision");
  expect(store.answer({ ...req, answer: "pink" }).code).toBe("invalid_answer");
  expect(store.answer(req).code).toBe("applied");
  expect(store.status(probe.probe_id, 2)).toMatchObject({ answered_by: "human", answered_at: 2, answer: "red", revision: 2 });
  const continued = store.continue(probe.probe_id, 3);
  expect(continued).toMatchObject({ code: "continued", probe: { state: "continued", continued_at: 3 } });
  const before = changes();
  expect(store.continue(probe.probe_id, 4)).toEqual(continued);
  expect(store.answer(req).code).toBe("replay");
  expect(store.answer({ ...req, digest: "other" }).code).toBe("answer_id_conflict");
  expect(store.answer({ ...req, answer_id: "two" }).code).toBe("already_resolved");
  expect(changes()).toBe(before);
  const next = create(4).probe;
  expect(() => db.prepare("UPDATE decision_probes SET answer_id=? WHERE probe_id=?").run("one", next.probe_id)).toThrow(/UNIQUE/);
});

it("upgrades a populated schema 64 and shares the single pending card between connections", () => {
  const fixture = diagnosisFixture({ legacy: 64 });
  try {
    const missions = fixture.db.prepare("SELECT * FROM engineering_contained_missions").all();
    fixture.db.close();
    const first = openDb({ path: fixture.path });
    try {
      expect(first.pragma("user_version", { simple: true })).toBe(66);
      expect(first.prepare("SELECT * FROM engineering_contained_missions").all()).toEqual(missions);
      const card = new DecisionProbes(first).create({ now: 1, created_by: "one" });
      const second = openDb({ path: fixture.path });
      try {
        expect(new DecisionProbes(second).create({ now: 2, created_by: "two" })).toEqual({ ...card, created: false });
      } finally { second.close(); }
    } finally { first.close(); }
  } finally { fixture.close(); }
});
