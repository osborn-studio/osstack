import type { ContainedMissionStore } from "@osstack/core";
import { DiagnosisStore, LocalFailureRecheckStore } from "@osstack/core/verification-intake";
import { rearmFacts } from "./contained-mission-local-failure-recheck-rearm.js";

const refusalReasons = new Set([
  "recheck_run_state_denied", "recheck_run_attempts_exhausted", "verify_recheck_not_started",
  "verify_grant_missing", "verify_grant_invalid", "verify_profile_unavailable", "verify_infrastructure_error",
  "verify_withdrawn", "verify_stale_head", "verify_base_changed", "verify_chain_busy", "verify_budget_exhausted",
]);

function missing(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value) && value.every(code => ["result", "actions", "host"].includes(code))) return value;
  } catch { /* Unreadable ledger value. */ }
  return [];
}

export function readLocalFailureRecheckView(deps: {
  missions: ContainedMissionStore; now(): number; armed(id: string): { expires_at: number } | null;
}, root: string) {
  const { missions } = deps;
  const admission = rearmFacts(missions, root);
  const ledger = new LocalFailureRecheckStore(new DiagnosisStore(missions.attention, missions.owner));
  const id = admission.row?.recheck_id ?? missions.db.prepare(`SELECT r.recheck_id FROM engineering_local_failure_rechecks r
    LEFT JOIN engineering_revision_chains c ON c.chain_id=r.chain_id AND c.root_mission_id=r.root_mission_id
    WHERE r.root_mission_id=? ORDER BY (c.mode='live' AND c.state<>'closed') DESC,r.created_at DESC,r.recheck_id LIMIT 1`).pluck().get(root) as string | undefined;
  if (!id) return null;
  const row = admission.row ?? ledger.get(id);
  const { attempts } = admission.facts ?? ledger.runFacts(id);
  const event = `FROM engineering_revision_chain_events WHERE chain_id=? AND json_extract(payload_json,'$.recheck_id')=? AND kind=? ORDER BY seq DESC LIMIT 1`;
  const refusal = missions.db.prepare(`SELECT json_extract(payload_json,'$.trigger') AS "trigger",
    json_extract(payload_json,'$.state') state,json_extract(payload_json,'$.reason') reason,created_at at ${event}`).get(row.chain_id, id, "local_recheck_refused") as
    { trigger: string; state: string; reason: string; at: number } | undefined;
  const last = missions.db.prepare(`SELECT created_at ${event}`).pluck().get(row.chain_id, id, "local_recheck_rearm_requested") as number | undefined;
  return {
    chain_id: row.chain_id, recheck_id: id, dispatch_id: row.dispatch_id, repository: row.repository, pr_number: row.pr_number,
    head: row.new_head_sha, base: row.base_sha, state: row.state, reason: row.reason, missing: missing(row.missing_json), opened_at: row.created_at,
    waited_ms: row.state === "reverify_pending" ? Math.max(0, deps.now() - row.created_at) : null,
    attempts_used: attempts.length, attempts_max: 3, attempts: attempts.map(({ created_at: _opened, ...attempt }) => attempt),
    last_refusal: refusal && ["automatic", "operator"].includes(refusal.trigger)
      && ["closed", "awaiting_decision"].includes(refusal.state) && refusalReasons.has(refusal.reason) ? refusal : null,
    rearm: { allowed: admission.blocked === null, expected_attempt: admission.blocked === null ? admission.attempt : null,
      blocked_by: admission.blocked, armed: deps.armed(id), last_requested_at: last ?? null },
  };
}
