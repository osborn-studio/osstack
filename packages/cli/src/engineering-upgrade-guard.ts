import type Database from "better-sqlite3";
import { containedUpgradeHolds, isEngineeringCancelledBeforeDispatch } from "@osstack/core";

/** Pure read used before stopping a daemon and again under the stopped-home
 * database lock. Only proven completion or proven non-dispatch clears a hold. */
export function engineeringUpgradeHolds(db: Database.Database): number {
  return sessionDispatchHolds(db) + containedUpgradeHolds(db);
}

function sessionDispatchHolds(db: Database.Database): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attention_dispatch_phases'").get()) return 0;
  const rows = db.prepare(`SELECT p.message_id,p.phase,m.state
    FROM attention_dispatch_phases p LEFT JOIN session_messages m ON m.message_id=p.message_id`).all() as Array<{
    message_id: string; phase: string; state: string | null;
  }>;
  let holds = 0;
  for (const row of rows) {
    if (row.phase === "dispatch_committed" && row.state === "applied") continue;
    if (row.phase === "cancelled_before_dispatch") {
      try { if (isEngineeringCancelledBeforeDispatch(db, row.message_id)) continue; }
      catch { /* Missing or malformed proof dependencies remain held. */ }
    }
    holds++;
  }
  return holds;
}
