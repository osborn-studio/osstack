/** Additive Session-adoption pilot schema. The existing attention action remains
 * the only outbound message authority; this table only gates its first dispatch. */
export const ENGINEERING_DDL = `
CREATE TABLE engineering_missions (
  mission_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES attention_scopes(scope_id),
  task_id TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  source_instance_id TEXT NOT NULL, source_generation INTEGER NOT NULL CHECK(source_generation=1),
  owner_principal_id TEXT NOT NULL, owner_client_session_id TEXT NOT NULL,
  goal TEXT NOT NULL, completion_level TEXT NOT NULL CHECK(completion_level='observed_turn'),
  state TEXT NOT NULL CHECK(state IN ('observing','awaiting_decision','answer_recorded','needs_reconciliation','completed','failed','cancel_requested','observation_ended')),
  revision INTEGER NOT NULL CHECK(revision>0), stop_intent_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  policy_digest TEXT NOT NULL, observation_proof_json TEXT
);
CREATE UNIQUE INDEX engineering_active_source ON engineering_missions(session_id)
  WHERE state NOT IN ('completed','failed','cancel_requested','observation_ended');
CREATE INDEX engineering_mission_scan ON engineering_missions(created_at,mission_id);
CREATE TABLE engineering_waits (
  wait_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES engineering_missions(mission_id),
  item_id TEXT NOT NULL UNIQUE REFERENCES attention_items(item_id),
  revision INTEGER NOT NULL CHECK(revision>0), decision_ref_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','deferred','answer_recorded','delivery_unknown','cleared','superseded','needs_reconciliation','cancelled_before_dispatch')),
  action_id TEXT UNIQUE REFERENCES attention_actions(action_id), revisit_at INTEGER, reason TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0 CHECK(reminder_sent IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX engineering_waits_mission ON engineering_waits(mission_id,created_at,wait_id);
CREATE TABLE engineering_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL REFERENCES engineering_missions(mission_id),
  kind TEXT NOT NULL, actor TEXT, payload_json TEXT NOT NULL CHECK(length(payload_json)<=32768), created_at INTEGER NOT NULL
);
CREATE INDEX engineering_events_mission ON engineering_events(mission_id,seq);
CREATE TABLE engineering_requests (
  principal_id TEXT NOT NULL, client_session_id TEXT NOT NULL, request_id TEXT NOT NULL,
  operation TEXT NOT NULL, payload_hash TEXT NOT NULL, mission_id TEXT NOT NULL REFERENCES engineering_missions(mission_id),
  response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(principal_id,client_session_id,request_id)
);
CREATE TABLE engineering_interactions (
  token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL, client_session_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES engineering_missions(mission_id), mission_revision INTEGER NOT NULL,
  wait_id TEXT NOT NULL REFERENCES engineering_waits(wait_id), item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL, content_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX engineering_request_budget ON engineering_requests(mission_id,operation);
CREATE INDEX engineering_interactions_expiry ON engineering_interactions(expires_at);
CREATE INDEX engineering_interactions_mission ON engineering_interactions(mission_id,issued_at);
CREATE TABLE attention_dispatch_phases (
  action_id TEXT PRIMARY KEY REFERENCES attention_actions(action_id),
  message_id TEXT NOT NULL UNIQUE REFERENCES session_messages(message_id),
  mission_id TEXT NOT NULL REFERENCES engineering_missions(mission_id),
  principal_id TEXT NOT NULL, client_session_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK(protocol_version=1),
  phase TEXT NOT NULL CHECK(phase IN ('reserved','dispatch_committed','cancelled_before_dispatch')),
  source_instance_id TEXT NOT NULL, source_generation INTEGER NOT NULL CHECK(source_generation=1),
  original_turn_id TEXT NOT NULL, source_version INTEGER NOT NULL CHECK(source_version>0),
  reservation_version INTEGER NOT NULL CHECK(reservation_version=source_version+1),
  reserved_by_generation INTEGER NOT NULL CHECK(reserved_by_generation>0), committed_by_generation INTEGER,
  stop_intent_id TEXT, proof_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((phase='reserved' AND committed_by_generation IS NULL AND stop_intent_id IS NULL AND proof_json IS NULL)
     OR (phase='dispatch_committed' AND committed_by_generation>0 AND stop_intent_id IS NULL AND proof_json IS NULL)
     OR (phase='cancelled_before_dispatch' AND committed_by_generation IS NULL AND stop_intent_id IS NOT NULL AND proof_json IS NOT NULL))
);
CREATE INDEX attention_dispatch_scan ON attention_dispatch_phases(phase,created_at,action_id);
CREATE INDEX attention_dispatch_mission ON attention_dispatch_phases(mission_id,action_id);
CREATE TRIGGER attention_dispatch_no_rewind BEFORE UPDATE ON attention_dispatch_phases
WHEN OLD.phase<>'reserved' OR NEW.phase='reserved' OR OLD.action_id<>NEW.action_id OR OLD.message_id<>NEW.message_id
  OR OLD.mission_id<>NEW.mission_id OR OLD.source_instance_id<>NEW.source_instance_id
  OR OLD.source_generation<>NEW.source_generation OR OLD.original_turn_id<>NEW.original_turn_id
  OR OLD.source_version<>NEW.source_version OR OLD.reservation_version<>NEW.reservation_version
  OR OLD.principal_id<>NEW.principal_id OR OLD.client_session_id<>NEW.client_session_id
  OR OLD.protocol_version<>NEW.protocol_version OR OLD.reserved_by_generation<>NEW.reserved_by_generation
BEGIN SELECT RAISE(ABORT,'dispatch_phase_immutable'); END;
CREATE TABLE engineering_completions (
  action_id TEXT PRIMARY KEY REFERENCES attention_actions(action_id),
  message_id TEXT NOT NULL UNIQUE REFERENCES session_messages(message_id),
  mission_id TEXT NOT NULL REFERENCES engineering_missions(mission_id),
  completed_turn_id TEXT NOT NULL, session_version INTEGER NOT NULL,
  proof_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX engineering_completion_mission ON engineering_completions(mission_id,completed_turn_id,session_version);
`;
