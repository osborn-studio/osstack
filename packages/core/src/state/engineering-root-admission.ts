import type Database from "better-sqlite3";

export type RootWriterKind = "review" | "actions_repair" | "local_failure";
export interface RootActivity {
  /** Live-chain reservation or unsettled current child. */
  review: { chain_id: string } | null;
  actions_repair: { child_mission_id: string } | null;
  local_failure: { intake_id: string; state: "reserved" | "running" | "stop_unknown" } | null;
}
export type RootAdmission = { ok: true } | {
  ok: false; code: "verify_chain_busy" | "verify_budget_exhausted"; holder: RootWriterKind | "budget";
};

export function readRootActivity(db: Database.Database, rootMissionId: string): RootActivity {
  return {
    local_failure: db.prepare(`SELECT intake_id,state FROM engineering_local_failure_intakes
      WHERE root_mission_id=? AND state<>'stopped' ORDER BY created_at,intake_id LIMIT 1`).get(rootMissionId) as RootActivity["local_failure"] ?? null,
    review: db.prepare(`SELECT c.chain_id FROM engineering_revision_chains c WHERE c.root_mission_id=? AND c.mode='live'
      AND (EXISTS (SELECT 1 FROM engineering_revision_reservations r WHERE r.chain_id=c.chain_id AND r.state IN ('reserved','dispatched'))
        OR EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE m.mission_id=c.current_mission_id
          AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)))
      ORDER BY c.chain_id LIMIT 1`).get(rootMissionId) as RootActivity["review"] ?? null,
    actions_repair: db.prepare(`SELECT mission_id AS child_mission_id FROM engineering_contained_missions
      WHERE json_type(spec_json,'$.ci_repair.root')='text' AND json_extract(spec_json,'$.ci_repair.root')=?
        AND NOT (state IN ('pr_opened','cancelled','abandoned','failed') AND stop_obligation=0)
      ORDER BY mission_id LIMIT 1`).get(rootMissionId) as RootActivity["actions_repair"] ?? null,
  };
}

/** Every unsettled intake retains its whole cap, even after its chain closes. */
export function readIntakeContainerDebit(db: Database.Database, chainId: string): number {
  const { debit } = db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='stopped' THEN container_used_seconds ELSE container_cap_seconds END),0) debit
    FROM engineering_local_failure_intakes WHERE chain_id=?`).get(chainId) as { debit: number };
  if (!Number.isSafeInteger(debit) || debit < 0) throw Error("intake_debit_overflow");
  return debit;
}

/** Shared slice accounting for both the grant budget and intake admission. */
export function childContainerDebit(db: Database.Database, allocations: Record<string, { container_used: number; container_seconds: number }>): number {
  let debit = 0;
  for (const [child, slice] of Object.entries(allocations)) {
    if (!slice || !Number.isSafeInteger(slice.container_used) || slice.container_used < 0
      || !Number.isSafeInteger(slice.container_seconds) || slice.container_seconds < 0) throw Error("spent_unreadable");
    const settled = db.prepare(`SELECT 1 FROM engineering_contained_missions WHERE mission_id=?
      AND state IN ('pr_opened','cancelled','abandoned','failed') AND stop_obligation=0`).get(child);
    debit += settled ? slice.container_used : slice.container_seconds;
  }
  return debit;
}

/** Pure reads. The caller must hold BEGIN IMMEDIATE through its subsequent write and commit.
 * Review callers ignore review activity; the chain store checks and database triggers govern their own in-flight state.
 * Review callers are refused by local_failure and actions_repair activity.
 * Local_failure and actions_repair callers are refused by all three kinds, including their own kind.
 */
export function checkRootAdmission(db: Database.Database, rootMissionId: string, kind: RootWriterKind,
  need?: { chain_id: string; container_seconds: number }): RootAdmission {
  if (!db.inTransaction) throw Error("root_admission_transaction_required");
  const activity = readRootActivity(db, rootMissionId);
  for (const holder of ["local_failure", "review", "actions_repair"] as const) {
    if (kind === "review" && holder === "review") continue;
    if (activity[holder]) return { ok: false, code: "verify_chain_busy", holder };
  }
  if (need) {
    const exhausted: RootAdmission = { ok: false, code: "verify_budget_exhausted", holder: "budget" };
    if (!Number.isSafeInteger(need.container_seconds) || need.container_seconds < 1) return exhausted;
    const chain = db.prepare("SELECT grant_json,spent_json FROM engineering_revision_chains WHERE chain_id=? AND root_mission_id=? AND mode='live'")
      .get(need.chain_id, rootMissionId) as { grant_json: string; spent_json: string | null } | undefined;
    if (!chain) return exhausted;
    try {
      const cap: unknown = JSON.parse(chain.grant_json).budget?.max_container_seconds;
      if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1) return exhausted;
      const allocations: unknown = chain.spent_json === null ? {} : JSON.parse(chain.spent_json).allocations;
      if (!allocations || typeof allocations !== "object" || Array.isArray(allocations)) return exhausted;
      const debit = childContainerDebit(db, allocations as Record<string, { container_used: number; container_seconds: number }>);
      if (need.container_seconds > Math.max(0, cap - debit - readIntakeContainerDebit(db, need.chain_id))) return exhausted;
    } catch { return exhausted; }
  }
  return { ok: true };
}
