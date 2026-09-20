import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
/** No migrations, no recovery: only determine whether an upgrade may forget executors. */
export function graphUpgradeHolds(db: Database.Database): number {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
  let count = 0;
  if (tables.has('graph_runs')) count += (db.prepare("SELECT count(*) n FROM graph_runs WHERE status NOT IN ('ready','failed','cancelled')").get() as { n: number }).n;
  if (tables.has('graph_action_admissions')) count += (db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get() as { n: number }).n;
  return count;
}
export async function assertGraphUpgradeSafe(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { if (graphUpgradeHolds(db) > 0) throw new Error('GRAPH_UPGRADE_REQUIRES_RECONCILIATION'); }
  finally { db.close(); }
}
