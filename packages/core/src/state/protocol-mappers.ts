// Protocol adoption layer (R1.2) — pure mappers from core's persisted row shapes
// to the cross-process `@osstack/protocol` contracts.
//
// These are additive: they do NOT replace core's own RunRow/EventRow/ApprovalRow
// schemas (the persistence projection stays authoritative). They give an external
// consumer a way to lift a stored row into the shared protocol shape without
// pulling in the persistence layer.
//
// Design rules:
//   - Pure & total on VALID inputs: no I/O, no DB access, no throw on a row that
//     satisfies the documented preconditions.
//   - Honest mapping: where the source enum is richer than the protocol enum we
//     map to the value the rest of the codebase already treats it as (see the
//     `expired -> failed` note), never fabricate data.
//   - core persists epoch SECONDS (REAL); protocol uses ISO-8601 datetime strings
//     — every timestamp is converted with {@link epochSecondsToIso}.

import type * as protocol from "@osstack/protocol";
import type { ApprovalRow, ContractApprovalRow, RunRow } from "./schema.js";
import type { StoredEventRow } from "./run-store.js";

/** Unix seconds (float ok) -> ISO-8601 UTC string accepted by z.string().datetime(). */
function epochSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The `runs`-row columns needed to build a {@link protocol.RunSummary}. A
 * structural subset of {@link RunRow} so a caller may pass a full validated row
 * or just these columns.
 */
export type RunSummaryRow = Pick<
  RunRow,
  "run_id" | "task_id" | "agent_id" | "outcome" | "started_at" | "completed_at" | "duration_ms"
>;

/**
 * The `approvals`-row columns needed to build a {@link protocol.ApprovalRequest}.
 */
export type ApprovalRequestRow = Pick<
  ApprovalRow,
  "approval_id" | "run_id" | "action_summary" | "risk" | "requested_at"
>;

/**
 * Lift a stored `events` row into a {@link protocol.EventEnvelope}.
 *
 * - `terminal` is stored 0/1 in SQLite (no boolean type) -> mapped to a boolean.
 * - `payload_json` is the serialized payload -> parsed back to a record.
 *
 * Unparseable / non-object payload_json — DOCUMENTED CHOICE: ESCALATE (throw).
 * In practice every writer feeds `appendEvent` a HermesEvent whose payload is an
 * object, but `StoredEventInput.payload` is typed `unknown`, so a scalar/array/
 * null payload IS representable — this throw is a genuine defensive branch, not
 * only corruption handling. protocol's `EventEnvelope.payload` requires an
 * object; coercing anything else would fabricate structure, so we throw. This
 * keeps the mapper total over every object-payload row while surfacing
 * non-object rows loudly.
 */
export function storedEventToEnvelope(row: StoredEventRow): protocol.EventEnvelope {
  return {
    event_id: row.event_id,
    seq: row.seq,
    run_id: row.run_id,
    session_id: row.session_id,
    created_at: row.created_at,
    terminal: row.terminal !== 0,
    type: row.type,
    payload: parsePayloadJson(row.payload_json),
  };
}

function parsePayloadJson(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error("storedEventToEnvelope: payload_json is not valid JSON", { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new Error(
      `storedEventToEnvelope: payload_json must encode a JSON object (protocol EventEnvelope.payload is a record); got ${kind}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Lift a finalized `runs` row into a {@link protocol.RunSummary}.
 *
 * NULL-outcome CHOICE: this mapper takes only FINALIZED rows. `runs.outcome` is
 * NULL until {@link finalizeRun} sets it; a run with a NULL outcome is not yet a
 * summary of a completed run, so the mapper returns `undefined` (rather than
 * inventing an outcome). Callers filter these out.
 *
 * Outcome mapping: core's RunOutcome enum has an extra `"expired"` the protocol's
 * three-value {@link protocol.RunOutcome} (completed | failed | cancelled) lacks.
 * We map `expired -> failed`, which is exactly how the rest of core already treats
 * it: the executor coerces an expired adapter status to "failed"
 * (packages/loop/src/executor.ts) and the policy layer scores it as a failure
 * (`outcome IN ('failed','expired')` in policy/history.ts and agent-scorecard.ts).
 *
 * `duration_ms` is rounded to an integer and clamped to >=0 to satisfy protocol's
 * `int().nonnegative()` (core stores it as a REAL derived from epoch-second
 * arithmetic, so it can carry float noise or, under clock skew, go negative).
 */
export function runRowToRunSummary(row: RunSummaryRow): protocol.RunSummary | undefined {
  if (row.outcome === null) return undefined;
  const outcome: protocol.RunOutcome = row.outcome === "expired" ? "failed" : row.outcome;
  return {
    run_id: row.run_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    outcome,
    started_at: epochSecondsToIso(row.started_at),
    ...(row.completed_at !== null ? { completed_at: epochSecondsToIso(row.completed_at) } : {}),
    ...(row.duration_ms !== null
      ? { duration_ms: Math.max(0, Math.round(row.duration_ms)) }
      : {}),
  };
}

/**
 * Lift an `approvals` row into a {@link protocol.ApprovalRequest}.
 *
 * - `action_summary` (core column) -> `action` (protocol field).
 * - `risk` passes through (both are the same low|medium|high enum).
 * - `requested_at` epoch seconds -> ISO string.
 * - `run_id` is non-null in core's ApprovalRow and passes through to protocol's
 *   optional `run_id`.
 */
export function approvalRowToRequest(row: ApprovalRequestRow): protocol.ApprovalRequest {
  return {
    approval_id: row.approval_id,
    run_id: row.run_id,
    action: row.action_summary,
    risk: row.risk,
    requested_at: epochSecondsToIso(row.requested_at),
  };
}

/**
 * Lift a `contract_approvals` row (R1.5) into a {@link protocol.ApprovalRequest}.
 * Contract approvals have no run (control does not spawn deliver in v1), so
 * `run_id` is omitted — protocol makes it optional. `action` / `risk` pass
 * through; `requested_at` epoch seconds -> ISO.
 */
export function contractApprovalRowToRequest(
  row: Pick<ContractApprovalRow, "approval_id" | "action" | "risk" | "requested_at">,
): protocol.ApprovalRequest {
  return {
    approval_id: row.approval_id,
    action: row.action,
    risk: row.risk,
    requested_at: epochSecondsToIso(row.requested_at),
  };
}

/**
 * Lift a resolved `contract_approvals` row into a {@link protocol.ApprovalDecision}.
 *
 * Returns `undefined` while the row is `pending` OR `revising` — neither has an
 * approve/reject VERDICT yet (a revise sends the contract back for edits; the
 * protocol ApprovalDecision's `approved` boolean cannot honestly represent it),
 * so the mapper refuses to fabricate one. `approved` maps to `approved: true`;
 * `stopped` maps to `approved: false`. Callers filter the undefined case. The
 * full approve/revise/stop history lives in `contract_approval_decisions`
 * (human-facing trail), not in this protocol shape.
 */
export function contractApprovalRowToDecision(
  row: Pick<
    ContractApprovalRow,
    "approval_id" | "status" | "decided_by_type" | "decided_by_id" | "decided_at" | "reason"
  >,
): protocol.ApprovalDecision | undefined {
  if (row.status === "pending" || row.status === "revising") return undefined;
  if (row.decided_by_type === null || row.decided_by_id === null || row.decided_at === null) {
    return undefined;
  }
  return {
    approval_id: row.approval_id,
    approved: row.status === "approved",
    decided_by: { type: row.decided_by_type, id: row.decided_by_id },
    decided_at: epochSecondsToIso(row.decided_at),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}
