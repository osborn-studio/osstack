import type Database from "better-sqlite3";
import { readRootActivity } from "./engineering-root-admission.js";

function renewalActivity(db: Database.Database, rootMissionId: string) {
  const activity = readRootActivity(db, rootMissionId);
  const child = activity.local_failure_child;
  const waiting = child && db.prepare(`SELECT m.mission_id AS child_mission_id,m.candidate_head FROM engineering_contained_missions m
    WHERE m.mission_id=? AND m.state='awaiting_decision' AND m.stop_obligation=0
    AND (SELECT CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.reason') END FROM engineering_contained_events e
      WHERE e.mission_id=m.mission_id AND e.kind='halted' ORDER BY e.seq DESC LIMIT 1)='publication_pending'
    AND NOT EXISTS (SELECT 1 FROM engineering_contained_events e WHERE e.mission_id=m.mission_id AND e.kind='verify_repair_approval')`)
    .get(child.child_mission_id) as { child_mission_id: string; candidate_head: string | null } | null | undefined;
  return { busy: Boolean(activity.local_failure || activity.recheck || (child && !waiting)), waiting_child: waiting ?? null };
}

export function localFailureRenewalBusy(db: Database.Database, rootMissionId: string): boolean {
  return renewalActivity(db, rootMissionId).busy;
}

export function chainHasLocalFailureIntake(db: Database.Database, chainId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM engineering_local_failure_intakes WHERE chain_id=? LIMIT 1").get(chainId));
}

export function readLocalFailureCarryForward(db: Database.Database, chain: { chain_id: string; root_mission_id: string }) {
  const has_intake = chainHasLocalFailureIntake(db, chain.chain_id);
  const eligible_diagnoses = db.prepare(`SELECT r.request_id,r.head_sha FROM engineering_diagnosis_requests r
    WHERE r.chain_id=? AND r.state='eligible' AND NOT EXISTS
      (SELECT 1 FROM engineering_local_failure_dispatches d WHERE d.request_id=r.request_id)
    ORDER BY r.request_id LIMIT 10`).all(chain.chain_id) as { request_id: string; head_sha: string }[];
  const pending_recheck = db.prepare(`SELECT l.recheck_id,
    (SELECT count(*) FROM engineering_local_failure_recheck_runs r WHERE r.recheck_id=l.recheck_id) AS attempts
    FROM engineering_local_failure_rechecks l WHERE l.root_mission_id=? AND l.state='reverify_pending'`)
    .get(chain.root_mission_id) as { recheck_id: string; attempts: number } | undefined;
  return { has_intake, ...renewalActivity(db, chain.root_mission_id), eligible_diagnoses, pending_recheck: pending_recheck ?? null };
}
