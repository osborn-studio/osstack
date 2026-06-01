// memory_facts CRUD — thin layer over the SQLite table defined in
// migrations.ts (id=2). All reads return rows validated against
// MemoryFactRow (schema.ts); all writes go through withWrite() so the
// disk-full preflight (G1) applies.
//
// PartnerOS feedback loop entry point: the orchestrator calls writeFact()
// whenever a human correction comes back from the Approval Desk, and
// readFactsForSubject() before each agent run so the prompt kernel can
// inject the latest preferences/corrections.
//
// Keep this module purely synchronous — better-sqlite3 is sync, and
// async wrappers would only hide ordering bugs.

import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { MemoryFactRow } from "./schema.js";

/** Input shape for writeFact — id + timestamps are filled in by the writer. */
export interface NewMemoryFact {
  fact_id: string;
  /** Tenant scope. Omit / pass null for single-tenant installs. */
  tenant_id?: string | null;
  subject_type: MemoryFactRow["subject_type"];
  subject_id: string;
  fact_type: MemoryFactRow["fact_type"];
  fact_text: string;
  source_type: MemoryFactRow["source_type"];
  source_id?: string | null;
  confidence?: number;
  status?: MemoryFactRow["status"];
}

/** INSERT one fact. Caller supplies fact_id (UUIDv7 recommended). */
export function writeFact(
  db: Database.Database,
  dbPath: string,
  fact: NewMemoryFact,
): MemoryFactRow {
  const now = Date.now() / 1000;
  const row: MemoryFactRow = MemoryFactRow.parse({
    fact_id: fact.fact_id,
    tenant_id: fact.tenant_id ?? null,
    subject_type: fact.subject_type,
    subject_id: fact.subject_id,
    fact_type: fact.fact_type,
    fact_text: fact.fact_text,
    source_type: fact.source_type,
    source_id: fact.source_id ?? null,
    confidence: fact.confidence ?? 1,
    status: fact.status ?? "active",
    created_at: now,
    updated_at: now,
  });
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO memory_facts (
        fact_id, tenant_id, subject_type, subject_id, fact_type, fact_text,
        source_type, source_id, confidence, status, created_at, updated_at
      ) VALUES (
        @fact_id, @tenant_id, @subject_type, @subject_id, @fact_type, @fact_text,
        @source_type, @source_id, @confidence, @status, @created_at, @updated_at
      )
    `).run(row);
  });
  return row;
}

/**
 * Read all *active* facts about a subject (e.g. all corrections for a client).
 *
 * Tenant scoping:
 *   - If `tenant_id` is undefined, returns facts from ALL tenants (legacy
 *     single-tenant behavior).
 *   - If `tenant_id` is a string, returns ONLY facts with matching tenant_id
 *     (NULL-tenant rows are excluded — those belong to "default" only).
 *   - If `tenant_id` is null, returns facts with tenant_id IS NULL.
 *
 * Wrapped in an explicit option object below.
 */
export function readFactsForSubject(
  db: Database.Database,
  subject_type: MemoryFactRow["subject_type"],
  subject_id: string,
  opts: { tenant_id?: string | null } = {},
): readonly MemoryFactRow[] {
  let sql = `
    SELECT * FROM memory_facts
    WHERE subject_type = ? AND subject_id = ? AND status = 'active'
  `;
  const params: unknown[] = [subject_type, subject_id];
  if (opts.tenant_id !== undefined) {
    if (opts.tenant_id === null) {
      sql += " AND tenant_id IS NULL";
    } else {
      sql += " AND tenant_id = ?";
      params.push(opts.tenant_id);
    }
  }
  sql += " ORDER BY created_at DESC";
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => MemoryFactRow.parse(r));
}

/**
 * Mark a fact superseded (kept for audit). Use when a newer correction
 * replaces an older one — preferred over hard delete.
 */
export function supersedeFact(
  db: Database.Database,
  dbPath: string,
  fact_id: string,
): void {
  const now = Date.now() / 1000;
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      UPDATE memory_facts
      SET status = 'superseded', updated_at = ?
      WHERE fact_id = ? AND status = 'active'
    `).run(now, fact_id);
  });
}

/** Archive (soft-delete) — kept for audit, hidden from active reads. */
export function archiveFact(
  db: Database.Database,
  dbPath: string,
  fact_id: string,
): void {
  const now = Date.now() / 1000;
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      UPDATE memory_facts
      SET status = 'archived', updated_at = ?
      WHERE fact_id = ?
    `).run(now, fact_id);
  });
}

/** Convenience: count active facts about a subject. */
export function countActiveFactsForSubject(
  db: Database.Database,
  subject_type: MemoryFactRow["subject_type"],
  subject_id: string,
  opts: { tenant_id?: string | null } = {},
): number {
  let sql = `
    SELECT COUNT(*) AS n FROM memory_facts
    WHERE subject_type = ? AND subject_id = ? AND status = 'active'
  `;
  const params: unknown[] = [subject_type, subject_id];
  if (opts.tenant_id !== undefined) {
    if (opts.tenant_id === null) {
      sql += " AND tenant_id IS NULL";
    } else {
      sql += " AND tenant_id = ?";
      params.push(opts.tenant_id);
    }
  }
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}
