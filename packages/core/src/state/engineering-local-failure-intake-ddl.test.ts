import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createScratchDirSync } from "../scratch.js";
import { openDb } from "./db.js";
import { AttentionStore } from "./attention-store.js";
import { ContainedMissionStore } from "./engineering-contained-store.js";
import { RevisionChainStore } from "./engineering-revision-chain-store.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

it("registers intake migration 58 and leaves exactly the reserved 57 gap", () => {
  expect(MIGRATIONS.filter(m => m.id >= 52).map(m => m.id)).toEqual([52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66]);
  expect(MIGRATIONS.find(m => m.id === 58)?.name).toBe("engineering_local_failure_intakes");
});

it("upgrades schema 57 additively without changing existing objects, rows or active reservations", () => {
  const root = realpathSync(createScratchDirSync("tests", "intake-ddl"));
  const path = join(root, "state.db");
  let db = new Database(path);
  try {
    db.pragma("foreign_keys=ON"); db.pragma("synchronous=FULL");
    for (const migration of MIGRATIONS.filter(m => m.id <= 57)) {
      db.exec(migration.sql); db.pragma(`user_version=${migration.id}`);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(57);
    db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
    const attention = new AttentionStore(db, path), owner = attention.claimOwner("owner");
    const scope = attention.registerScope(owner, "t", root);
    const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [scope.scope_id], operator_scopes: [] };
    const mission = new ContainedMissionStore(attention, owner).authorize(principal, { scope_id: scope.scope_id,
      spec: { goal: "upgrade fixture" }, claim: { repo_identity: "fixture", branch: "fixture", worktree_identity: "fixture" } }, 1000);
    const chains = new RevisionChainStore(attention, owner, () => 1000);
    const chain = chains.createLiveChain({ root_mission_id: mission.mission_id, repository: "fixture/repo", pr_number: 1,
      branch: "fixture", base_ref: "main", published_head: "a".repeat(40), published_base: "b".repeat(40), trace_id: "fixture",
      grant: { version: 1, rounds: 2, expires_at: 10000 } }, 1000);
    db.prepare(`INSERT INTO engineering_revision_reservations(repository,pr_number,head_sha,chain_id,
      review_ids_json,feedback_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'reserved',1000,1000)`)
      .run(chain.repository, chain.pr_number, chain.published_head, chain.chain_id, "[7]", "d".repeat(64));
    db.prepare("UPDATE engineering_revision_chains SET state='revision_reserved',revision=revision+1 WHERE chain_id=?").run(chain.chain_id);
    const reservedRevision = chains.get(chain.chain_id).revision;
    const objects = () => db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all() as Array<{ type: string; name: string; sql: string | null }>;
    const tables = ["tasks", "engineering_contained_missions", "engineering_contained_events", "engineering_mission_lineage", "engineering_revision_chains", "engineering_revision_reservations", "engineering_revision_chain_events"];
    const dump = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = objects(), rows = dump();
    db.close(); db = openDb({ path });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    const after = objects();
    for (const object of before) expect(after.find(o => o.name === object.name && o.type === object.type)).toEqual(object);
    const added = after.filter(o => !before.some(b => b.name === o.name));
    expect(added.some(o => o.name === "engineering_local_failure_intakes")).toBe(true);
    expect(added.every(o => ["engineering_mission_lineage_depth_cap","engineering_mission_depth_stop","decision_probes","decision_probes_answer_id","decision_probes_pending_expiry", "engineering_merger_alerts", "engineering_merger_alerts_due", "engineering_merger_alerts_no_delete"].includes(o.name) || o.name.startsWith("engineering_local_failure_") || o.name.startsWith("sqlite_autoindex_engineering_local_failure_") || o.name.startsWith("engineering_root_exclusion_") || /^(sqlite_autoindex_)?engineering_(diagnosis_|host_receipt)/.test(o.name))).toBe(true);
    expect(db.prepare("SELECT count(*) n FROM engineering_local_failure_intakes").get()).toEqual({ n: 0 });
    expect(dump()).toEqual(rows);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const columns = db.pragma("table_info(engineering_local_failure_intakes)") as Array<{ name: string }>;
    expect(columns.map(c => c.name)).toContain("receipt_bytes_sha256");
    expect(columns.map(c => c.name)).not.toContain("receipt_digest");
    db.pragma("synchronous=FULL");
    const reopened = new RevisionChainStore(new AttentionStore(db, path), owner, () => 1000);
    expect(reopened.voidReservation(chain.chain_id, reservedRevision, chain.published_head, "fixture", 1001).reservation.state).toBe("void");
  } finally {
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
