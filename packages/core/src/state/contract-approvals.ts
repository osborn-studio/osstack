// Contract approval storage (R1.5) — a minimal repository over the
// `contract_approvals` + `contract_approval_decisions` tables (migration #8)
// that backs the `osstack control` approval lifecycle. Follows the repository
// style of improvement-proposals.ts: standalone functions, Zod-validated rows,
// all writes through withWrite().
//
// AUTHORITY MODEL (cross-review B2 ruling): the `contract_approvals` row is
// the AUTHORITATIVE current lifecycle state of a contract; the kanban card is
// a best-effort projection maintained by the CLI. Guards and status derive
// SOLELY from this row.
//
// One current-state row per Execution Contract, created at `osstack start`
// (status `pending`). Every `control approve` / `revise` / `stop` goes through
// {@link recordContractDecision}, which — in ONE transaction — appends an
// immutable row to `contract_approval_decisions` (the audit trail) and updates
// the current-state row (the O(1) guard). The same approval_id lives for the
// contract's whole life so the protocol ApprovalRequest (start) and
// ApprovalDecision (approve) refer to one record.
//
// State machine (guards enforced by the CLI callers; this module is pure
// persistence):
//   pending --approve--> approved
//   pending|approved --revise--> revising --approve--> approved
//   any non-stopped --stop--> stopped (terminal)

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { ContractApprovalDecisionRow, ContractApprovalRow } from "./schema.js";

export type ContractApprovalStatus = "pending" | "approved" | "revising" | "stopped";
export type ContractApprovalRisk = "low" | "medium" | "high";
export type ContractDecisionAction = "approve" | "revise" | "stop";

/** Decision action -> the current-state status it moves the contract to. */
const ACTION_TO_STATUS: Record<ContractDecisionAction, ContractApprovalStatus> = {
  approve: "approved",
  revise: "revising",
  stop: "stopped",
};

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

/** The (single) current-state approval record for a contract, or undefined. */
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

export interface NewContractDecision {
  approval_id: string;
  contract_id: string;
  action: ContractDecisionAction;
  actor_type: "human" | "agent";
  actor_id: string;
  decided_at: number;
  reason?: string | null;
  /** Override for deterministic tests; defaults to `cd_<12-hex>`. */
  decision_id?: string;
}

/**
 * Record an approve/revise/stop decision: in ONE transaction, append an
 * immutable row to `contract_approval_decisions` (audit trail) and update the
 * current-state row's status + latest-decision columns. Returns the updated
 * current-state row.
 *
 * For `revise` the current-state row keeps the revising actor in the
 * decided_by columns (who sent it back) — the protocol mapper still reports
 * "no ApprovalDecision yet" for a revising contract, because a revise is not
 * an approve/reject verdict (see contractApprovalRowToDecision).
 */
export function recordContractDecision(
  db: Database.Database,
  dbPath: string,
  decision: NewContractDecision,
): ContractApprovalRow {
  const now = Date.now() / 1000;
  const decisionRow = ContractApprovalDecisionRow.parse({
    decision_id: decision.decision_id ?? `cd_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    approval_id: decision.approval_id,
    contract_id: decision.contract_id,
    action: decision.action,
    actor_type: decision.actor_type,
    actor_id: decision.actor_id,
    reason: decision.reason ?? null,
    decided_at: decision.decided_at,
    created_at: now,
  });
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO contract_approval_decisions (
        decision_id, approval_id, contract_id, action, actor_type, actor_id,
        reason, decided_at, created_at
      ) VALUES (
        @decision_id, @approval_id, @contract_id, @action, @actor_type, @actor_id,
        @reason, @decided_at, @created_at
      )
    `).run(decisionRow);
    d.prepare(`
      UPDATE contract_approvals
      SET status = ?, decided_by_type = ?, decided_by_id = ?, decided_at = ?, reason = ?, updated_at = ?
      WHERE approval_id = ?
    `).run(
      ACTION_TO_STATUS[decision.action],
      decision.actor_type,
      decision.actor_id,
      decision.decided_at,
      decision.reason ?? null,
      now,
      decision.approval_id,
    );
  });
  return getContractApproval(db, decision.approval_id)!;
}

/** The append-only decision trail for a contract, oldest first. */
export function listContractDecisions(
  db: Database.Database,
  contract_id: string,
): ContractApprovalDecisionRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM contract_approval_decisions WHERE contract_id = ? ORDER BY decided_at ASC, created_at ASC",
    )
    .all(contract_id) as unknown[];
  return rows.map((r) => ContractApprovalDecisionRow.parse(r));
}

export function getContractDecision(
  db: Database.Database,
  decisionId: string,
): ContractApprovalDecisionRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM contract_approval_decisions WHERE decision_id = ?",
    )
    .get(decisionId);
  return row === undefined
    ? undefined
    : ContractApprovalDecisionRow.parse(row);
}
