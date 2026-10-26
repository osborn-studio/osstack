import type Database from "better-sqlite3";

export interface EngineeringDispatchPhase {
  action_id: string; message_id: string; mission_id: string; principal_id: string; client_session_id: string;
  protocol_version: 1; phase: "reserved" | "dispatch_committed" | "cancelled_before_dispatch";
  source_instance_id: string; source_generation: number; original_turn_id: string;
  source_version: number; reservation_version: number; reserved_by_generation: number;
  committed_by_generation: number | null; stop_intent_id: string | null; proof_json: string | null;
  created_at: number; updated_at: number;
}
export function getEngineeringDispatchPhase(db: Database.Database, messageId: string): EngineeringDispatchPhase | undefined {
  return db.prepare("SELECT * FROM attention_dispatch_phases WHERE message_id=?").get(messageId) as EngineeringDispatchPhase | undefined;
}

/** A phase label alone cannot release the uncertain-message guard. The original
 * message/action, immutable cancellation transition, and durable intent agree. */
export function isEngineeringCancelledBeforeDispatch(db: Database.Database, messageId: string): boolean {
  const phase = getEngineeringDispatchPhase(db, messageId);
  if (!phase || phase.phase !== "cancelled_before_dispatch") return false;
  const bound = db.prepare(`SELECT m.state,a.state action_state,a.action_id,a.message_id,i.session_id,i.turn_id,e.kind,e.payload_json
    FROM attention_actions a JOIN session_messages m ON m.message_id=a.message_id
    JOIN attention_items i ON i.item_id=a.item_id AND i.scope_id=a.scope_id
    JOIN engineering_missions x ON x.mission_id=? AND x.session_id=m.session_id AND x.scope_id=a.scope_id
    JOIN engineering_events e ON e.mission_id=x.mission_id
    WHERE a.action_id=? AND a.message_id=? AND i.session_id=m.session_id AND i.turn_id=m.turn_id AND e.seq=?`).get(
      phase.mission_id, phase.action_id, messageId, readProofSequence(phase.proof_json),
    ) as { state: string; action_state: string; action_id: string; message_id: string; session_id: string; turn_id: string; kind: string; payload_json: string } | undefined;
  if (!bound || bound.state === "applied" || bound.action_state !== "cancelled_before_dispatch" || bound.turn_id !== phase.original_turn_id || !["stop_requested", "observation_ended"].includes(bound.kind)
    || db.prepare("SELECT 1 FROM attention_receipt_resolutions WHERE message_id=?").get(messageId)) return false;
  try {
    const proof = JSON.parse(phase.proof_json ?? "null") as Record<string, unknown> | null;
    const event = JSON.parse(bound.payload_json) as Record<string, unknown>;
    return proof?.["version"] === 1 && proof["prior_phase"] === "reserved"
      && proof["action_id"] === phase.action_id && proof["message_id"] === messageId
      && proof["stop_intent_id"] === phase.stop_intent_id && event["stop_intent_id"] === phase.stop_intent_id
      && event["session_id"] === bound.session_id && Array.isArray(event["action_ids"]) && event["action_ids"].includes(phase.action_id)
      && event["owner_generation"] === proof["owner_generation"] && Number.isSafeInteger(proof["owner_generation"]) && Number(proof["owner_generation"]) > 0;
  } catch { return false; }
}
function readProofSequence(value: string | null): number {
  try { const v = JSON.parse(value ?? "null")?.event_seq; return Number.isSafeInteger(v) ? v : -1; } catch { return -1; }
}
