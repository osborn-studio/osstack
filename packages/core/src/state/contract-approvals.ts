// Contract approval storage (R1.5) — a minimal repository over the
// `contract_approvals` table (migration #8) that backs the `osstack control`
// approval lifecycle. Follows the repository style of improvement-proposals.ts:
// standalone functions, Zod-validated rows, all writes through withWrite().
//
// One row per Execution Contract. The row is created at `osstack start` (status
// `pending`) and mutated by `control approve` / `revise` / `stop`. The same
// approval_id lives for the contract's whole life so the protocol
// ApprovalRequest (start) and ApprovalDecision (approve) refer to one record.
//
// State machine (enforced by the callers in the CLI, not here — this module is
// pure persistence):
//   pending --approve--> approved --revise--> pending ... --stop--> stopped

import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { ContractApprovalRow } from "./schema.js";

export type ContractApprovalStatus = "pending" | "approved" | "stopped";
export type ContractApprovalRisk = "low" | "medium" | "high";

export interface NewContractApproval {
  approval_id: string;
  contract_id: string;
  action: string;
  risk: ContractApprovalRisk;
  requested_at: number;
}

/** Insert the initial pending approval request for a contract. */
export function insertContractApproval(
  db: Database.Database,
  dbPath: string,
  input: NewContractApproval,
): ContractApprovalRow {
  const now = Date.now() / 1000;
  const row = ContractApprovalRow.parse({
    approval_id: input.approval_id,
    contract_id: input.contract_id,
    action: input.action,
    risk: input.risk,
    status: "pending",
    requested_at: input.requested_at,
    decided_by_type: null,
    decided_by_id: null,
    decided_at: null,
    reason: null,
    created_at: now,
    updated_at: now,
  });
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO contract_approvals (
        approval_id, contract_id, action, risk, status, requested_at,
        decided_by_type, decided_by_id, decided_at, reason, created_at, updated_at
      ) VALUES (
        @approval_id, @contract_id, @action, @risk, @status, @requested_at,
        @decided_by_type, @decided_by_id, @decided_at, @reason, @created_at, @updated_at
      )
    `).run(row);
  });
  return row;
}

/** The (single) approval record for a contract, or undefined if none exists. */
export function getContractApprovalByContract(
  db: Database.Database,
  contract_id: string,
): ContractApprovalRow | undefined {
  const r = db
    .prepare(
      "SELECT * FROM contract_approvals WHERE contract_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(contract_id);
  return r ? ContractApprovalRow.parse(r) : undefined;
}

/** Fetch by approval id (protocol ApprovalRequest/Decision key). */
export function getContractApproval(
  db: Database.Database,
  approval_id: string,
): ContractApprovalRow | undefined {
  const r = db.prepare("SELECT * FROM contract_approvals WHERE approval_id = ?").get(approval_id);
  return r ? ContractApprovalRow.parse(r) : undefined;
}

export interface ContractApprovalDecision {
  status: "approved" | "stopped";
  decided_by_type: "human" | "agent";
  decided_by_id: string;
  decided_at: number;
  reason?: string | null;
}

/**
 * Resolve a pending approval to a terminal-ish decision (`approved` or
 * `stopped`) with the deciding actor. Used by `control approve` and
 * `control stop`.
 */
export function resolveContractApproval(
  db: Database.Database,
  dbPath: string,
  approval_id: string,
  decision: ContractApprovalDecision,
): ContractApprovalRow {
  const now = Date.now() / 1000;
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      UPDATE contract_approvals
      SET status = ?, decided_by_type = ?, decided_by_id = ?, decided_at = ?, reason = ?, updated_at = ?
      WHERE approval_id = ?
    `).run(
      decision.status,
      decision.decided_by_type,
      decision.decided_by_id,
      decision.decided_at,
      decision.reason ?? null,
      now,
      approval_id,
    );
  });
  return getContractApproval(db, approval_id)!;
}

/**
 * Re-open an approval for revision: back to `pending`, decision cleared, the
 * revise reason recorded. Used by `control revise`.
 */
export function reopenContractApproval(
  db: Database.Database,
  dbPath: string,
  approval_id: string,
  reason: string,
): ContractApprovalRow {
  const now = Date.now() / 1000;
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      UPDATE contract_approvals
      SET status = 'pending', decided_by_type = NULL, decided_by_id = NULL, decided_at = NULL, reason = ?, updated_at = ?
      WHERE approval_id = ?
    `).run(reason, now, approval_id);
  });
  return getContractApproval(db, approval_id)!;
}
