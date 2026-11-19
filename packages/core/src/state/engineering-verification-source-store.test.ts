import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { verificationFixture } from "../bridge/verification-result-fixtures.js";
import { parseVerificationResultV1 } from "../bridge/verification-result.js";
import type { VerificationSourceObservation } from "../bridge/verification-source-ledger.js";
import { AttentionStore } from "./attention-store.js";
import { openDb } from "./db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { ENGINEERING_VERIFICATION_SOURCE_DDL } from "./engineering-verification-source-ddl.js";
import { VerificationSourceStore } from "./engineering-verification-source-store.js";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function setup() {
  const root = createScratchDirSync("tests", "verification-source"); const path = join(root, "state.db");
  const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("fixture");
  return { db, store: new VerificationSourceStore(attention, owner) };
}
function observation(id = 1): VerificationSourceObservation {
  const p = verificationFixture(); const parsed = parseVerificationResultV1(JSON.stringify(p));
  if (!parsed.ok) throw new Error(parsed.code);
  return { source_kind: "check_run", object_id: id, repository_id: p.repository_id, repository: p.repository, pr: p.pr,
    observed_head_sha: p.head_sha, app_id: 201, check_name: "fixture-check", response_digest: id.toString(16).padStart(64, "0"),
    contract_digest: "c".repeat(64), verdict: { ok: true }, result: parsed.result };
}
it("registers migration 57 after 56 and upgrades schema 56 without changing existing schema or data", () => {
  expect(MIGRATIONS.find(m => m.id === 57)).toEqual({ id: 57, name: "engineering_verification_sources", sql: ENGINEERING_VERIFICATION_SOURCE_DDL });
  expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
  expect(MIGRATIONS.map(m => m.id).filter(id => id >= 55 && id <= 57)).toEqual([55, 56, 57]);
  const root = createScratchDirSync("tests", "verification-upgrade"); const path = join(root, "state.db");
  let db = new Database(path);
  for (const m of MIGRATIONS.filter(m => m.id <= 56)) db.exec(m.sql);
  db.pragma("user_version=56");
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('fixture','retained','pending',1,1)");
  const objects = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all() as { name: string; tbl_name: string; sql: string }[];
  const before = objects(); db.close(); db = openDb({ path });
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
  expect(objects().filter(x => before.some(b => b.name === x.name))).toEqual(before);
  const added = objects().filter(x => !before.some(b => b.name === x.name) && !["engineering_mission_lineage_depth_cap","engineering_mission_depth_stop"].includes(x.name) && !x.name.startsWith("engineering_local_failure_dispatch_") && !["engineering_local_failure_rechecks","engineering_local_failure_dispatches","engineering_diagnosis_requests","engineering_host_receipts","engineering_local_failure_intakes"].includes(x.tbl_name) && !x.name.startsWith("engineering_root_exclusion_"));
  expect(added.length).toBe(7);
  expect(added.every(x => x.tbl_name === "engineering_verification_sources")).toBe(true);
  expect(db.prepare("SELECT title FROM tasks WHERE task_id='fixture'").get()).toEqual({ title: "retained" });
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.prepare("SELECT * FROM engineering_verification_sources").all()).toEqual([]);
});
it("records all verdicts atomically and returns stable sequences on reread", () => {
  const { store } = setup(); const a = observation(); const b = observation(2);
  const c = { ...observation(3), verdict: { ok: false as const, code: "verify_stale_head" as const }, result: null };
  const first = store.record([c, b, a], 1, 2);
  expect(first.map(x => x.outcome.decision)).toEqual(["accepted", "duplicate", "rejected"]);
  expect(store.record([a, b, c], 3, 4).map(x => x.seq)).toEqual(first.map(x => x.seq));
  expect(store.history(101, 7)).toHaveLength(3);
  expect(() => store.record([{ ...observation(4), pr: 8 }, { ...observation(5), object_id: -1, pr: 9 }], 1, 1)).toThrow();
  expect(store.history(101, 8)).toHaveLength(0);
  expect(() => store.record(Array(201).fill(a), 1, 1)).toThrow("verification_source_batch_limit");
});
it("restores summaries and fails closed on corrupt persisted references", () => {
  const { store, db } = setup(); const o = observation(); store.record([o], 1, 1);
  expect(store.history(101, 7)[0]?.summary).toEqual(o.result!.summary);
  expect(store.registration(o.result!.result_id)?.registered.seq).toBe(1);
  expect(store.registration("absent")).toBeNull();
  db.exec("DROP TRIGGER engineering_verification_sources_no_update");
  db.prepare("UPDATE engineering_verification_sources SET summary_reference_json=?").run('{"kind":"external_reference"}');
  expect(() => store.history(101, 7)).toThrow("verification_source_corrupt");
});
it("allows only a one-time accepted intake link", () => {
  const { store, db } = setup(); store.record([observation(), { ...observation(2), result: null, verdict: { ok: false, code: "verify_contract_invalid" } }], 1, 1);
  expect(() => db.exec("DELETE FROM engineering_verification_sources")).toThrow("verification_source_immutable");
  const columns = db.pragma("table_info(engineering_verification_sources)") as { name: string }[];
  for (const { name } of columns.filter(x => x.name !== "intake_id")) {
    expect(() => db.exec(`UPDATE engineering_verification_sources SET ${name}=${name} WHERE seq=1`)).toThrow("verification_source_immutable");
  }
  expect(() => store.linkIntake(1, "bad")).toThrow();
  const id = `lfi_${verificationFixture().result_id}`;
  store.linkIntake(1, id); expect(store.history(101, 7)[0]?.intake_id).toBe(id);
  expect(() => store.linkIntake(1, id)).toThrow(); expect(() => store.linkIntake(2, id)).toThrow();
  expect(() => store.linkIntake(999, id)).toThrow();
});
it("imports no process, network, Mission, chain or intake store", () => {
  const text = readFileSync(new URL("./engineering-verification-source-store.ts", import.meta.url), "utf8");
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]).join("\n");
  expect(imports).not.toMatch(/process|child_process|http|net|fetch|mission|chain|intake-store/);
});
it.each([
  { response_digest: `${"a".repeat(64)}\0hidden` },
  { observed_head_sha: `${"a".repeat(40)}\0hidden` },
  { skill_id: "fixture\0hidden" },
  { decision: "rejected", reason_code: "verify_duplicate" },
  { attempt: null }, { summary_reference_json: null },
  { decision: "duplicate", reason_code: "verify_duplicate", original_seq: null },
  { decision: "accepted", reason_code: "verify_stale_head" },
  { observed_at: 0.5 }, { contract_digest: "short" },
])("rejects malformed raw row %j", changes => {
  const { store, db } = setup(); store.record([observation()], 1, 1);
  const row = db.prepare("SELECT * FROM engineering_verification_sources WHERE seq=1").get() as Record<string, string | number | null>;
  delete row.seq;
  const inserted = { ...row, object_id: 99, result_id: "00000000-0000-4000-8000-000000000099", ...changes };
  const columns = Object.keys(inserted);
  expect(() => db.prepare(`INSERT INTO engineering_verification_sources(${columns.join(",")}) VALUES(${columns.map(c => `@${c}`).join(",")})`).run(inserted)).toThrow(/CHECK|NOT NULL/);
});
it("rejects a result id already registered under another PR without a uniqueness error", () => {
  const { store } = setup();
  store.record([observation()], 1, 1);
  const other = observation(2);
  other.pr = 8;
  other.result = { ...other.result!, pr: 8 };
  expect(store.record([other], 2, 2)[0]?.outcome).toEqual({ decision: "rejected", reason_code: "verify_attempt_ambiguous" });
  expect(store.history(101, 8)[0]?.decision).toBe("rejected");
});
