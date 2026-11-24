import { RevisionChainStore, type ContainedMissionStore, type EngineeringPrincipal } from "@osstack/core";
import { DiagnosisStore, LocalFailureRecheckStore } from "@osstack/core/verification-intake";
import type { EngineeringAccess } from "./engineering-access.js";

export const RECHECK_REARM_TTL_MS = 15 * 60_000;
export interface RecheckRearmInput { mission_id: string; expected_attempt: number; decision_id: string }
export interface RecheckRearmResult {
  status: "armed"; mission_id: string; recheck_id: string; attempt: number; expires_at: number; replay: boolean;
}
interface Entry extends RecheckRearmResult {
  decision_id: string; chain_id: string; request_id: string; principal: string; session: string;
}

function operator(actor: EngineeringPrincipal, scope: string) {
  return actor.read_scopes.includes(scope) && actor.write_scopes.includes(scope) && actor.operator_scopes.includes(scope);
}

export function rearmFacts(missions: ContainedMissionStore, root: string) {
  const diagnosis = new DiagnosisStore(missions.attention, missions.owner);
  const chain = diagnosis.chain(root, null);
  const ledger = new LocalFailureRecheckStore(diagnosis);
  const pending = chain && ledger.forChain(chain.chain_id).filter(row => row.root_mission_id === root && row.state === "reverify_pending");
  const row = pending?.length === 1 ? pending[0] : undefined;
  if (!row) return { blocked: "recheck_rearm_not_waiting" } as const;
  const facts = ledger.runFacts(row.recheck_id);
  const blocked = facts.blocking ? "recheck_rearm_run_present" : facts.attempts.length >= 3 ? "recheck_run_attempts_exhausted" : null;
  return { row, facts, blocked, attempt: facts.attempts.length + 1 };
}

export function createRecheckRearm(deps: {
  missions: ContainedMissionStore; access: Pick<EngineeringAccess, "refresh">; enabled(): boolean; now(): number; log(line: string): void;
}) {
  const { missions } = deps;
  const entries = new Map<string, Entry>();
  const log = (id: string, code: string) => deps.log(`osstack: local-failure recheck: ${id}: ${code}`);
  return {
    request(actor: EngineeringPrincipal, input: RecheckRearmInput): RecheckRearmResult {
      const { mission_id, expected_attempt, decision_id } = input;
      const principal = actor.principal_id, session = actor.client_session_id;
      const entry = missions.db.transaction((): Entry => {
        missions.attention.assertOwner(missions.owner);
        if (!deps.enabled()) throw Error("recheck_rearm_unavailable");
        const mission = missions.readable(actor, mission_id);
        if (!operator(actor, mission.scope_id)) throw Error("permission_denied");
        const admission = rearmFacts(missions, mission_id);
        if (admission.blocked !== null) throw Error(admission.blocked);
        if (expected_attempt !== admission.attempt) throw Error("recheck_rearm_attempt_mismatch");
        const { recheck_id, chain_id, dispatch_id } = admission.row;
        const now = deps.now(), prior = entries.get(recheck_id);
        if (prior && now < prior.expires_at) {
          if (prior.decision_id === decision_id && prior.attempt === expected_attempt && prior.principal === principal && prior.session === session)
            return { ...prior, replay: true };
          throw Error("recheck_rearm_pending");
        }
        if (prior) entries.delete(recheck_id);
        if (missions.db.prepare(`SELECT 1 FROM engineering_revision_chain_events WHERE chain_id=?
          AND kind='local_recheck_rearm_requested' AND json_extract(payload_json,'$.decision_id')=?`).get(chain_id, decision_id))
          throw Error("decision_id_conflict");
        const request_id = missions.db.prepare("SELECT request_id FROM engineering_local_failure_dispatches WHERE dispatch_id=?").pluck().get(dispatch_id) as string | undefined;
        if (!request_id) throw Error("recheck_rearm_not_waiting");
        const expires_at = now + RECHECK_REARM_TTL_MS, attempt = expected_attempt;
        new RevisionChainStore(missions.attention, missions.owner).appendEvent(chain_id, "local_recheck_rearm_requested",
          { recheck_id, dispatch_id, attempt, decision_id, principal, session, expires_at }, now);
        return { status: "armed", mission_id, recheck_id, attempt, expires_at, replay: false, chain_id, request_id, principal, session, decision_id };
      }).immediate();
      if (!entry.replay) entries.set(entry.recheck_id, entry);
      const { status, recheck_id, attempt, expires_at, replay } = entry;
      return { status, mission_id, recheck_id, attempt, expires_at, replay };
    },
    next() {
      if (!deps.enabled()) {
        const ids = [...entries.keys()];
        entries.clear();
        for (const id of ids) log(id, "rearm_route_disabled");
        return undefined;
      }
      for (const [id, e] of entries) {
        entries.delete(id);
        if (deps.now() >= e.expires_at) { log(id, "rearm_expired"); continue; }
        try {
          const actor = deps.access.refresh(e.principal, e.session);
          if (actor.principal_id !== e.principal || actor.client_session_id !== e.session || !operator(actor, missions.get(e.mission_id).scope_id))
            throw Error("permission_denied");
        } catch { log(id, "rearm_authority_lost"); continue; }
        const admission = rearmFacts(missions, e.mission_id);
        if (admission.blocked !== null || admission.row.chain_id !== e.chain_id || admission.row.recheck_id !== id || admission.attempt !== e.attempt) {
          log(id, "rearm_stale"); continue;
        }
        return { recheck_id: id, request_id: e.request_id };
      }
      return undefined;
    },
    armed(id: string) {
      const entry = entries.get(id);
      return entry && deps.now() < entry.expires_at ? { expires_at: entry.expires_at } : null;
    },
  };
}
