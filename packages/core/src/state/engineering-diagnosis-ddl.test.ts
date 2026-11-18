import { expect, it } from "vitest";
import { diagnosisFixture } from "./diagnosis-fixtures.js";
import { openDb } from "./db.js";
it("upgrades a populated schema 58 without starting or changing an intake", () => {
  const f = diagnosisFixture({ legacy: true });
  try {
    const { binding, grant, profile, ...facts } = f.facts;
    f.store.intakes.reserve({
      ...facts,
      ...binding,
      root_mission_id: grant.root_mission_id,
      chain_revision: 1,
      grant_id: grant.grant_id,
      profile_id: profile.profile_id,
      profile_digest: profile.profile_digest,
      trusted_source_digest: profile.trusted_source.artifact_digest,
      ci_hint_json: "{}",
    });
    const tables = [
      "engineering_revision_chains",
      "engineering_verification_sources",
      "engineering_local_failure_intakes",
      "engineering_contained_missions",
    ];
    const snapshot = (db: typeof f.db) => tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const old = snapshot(f.db);
    f.db.close();
    const db = openDb({ path: f.path });
    try {
      expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(59);
      expect(snapshot(db)).toEqual(old);
      for (const t of ["engineering_host_receipts", "engineering_diagnosis_requests"])
        expect(db.prepare(`SELECT * FROM ${t}`).all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});
