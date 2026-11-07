// Test helper: the host process ledger exists once migration 54 is registered; until then apply its DDL when the table is missing.
import { join } from "node:path";
import { ENGINEERING_HOST_PROCESS_DDL } from "@osstack/core";
import type Database from "better-sqlite3";
import type { HostProcessKitOptions } from "./contained-mission-host-process.js";

export function ensureHostProcessLedger(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='engineering_host_processes'").get()) db.exec(ENGINEERING_HOST_PROCESS_DDL);
}
export const hostProcessOptions = (root: string, over: Partial<HostProcessKitOptions> = {}): HostProcessKitOptions => ({ markerDir: join(root, "host-processes"), ...over });
