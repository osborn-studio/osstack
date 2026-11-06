/** Additive revision-chain ledger (bridge phase 4-A, appendix §3). New tables only: migration 51
 * never rebuilds a table that child rows reference. Shadow chains record decisions; the database
 * itself refuses reservations and publication intents on them (`bridge_shadow_write_denied`). */
export const ENGINEERING_REVISION_CHAIN_DDL = `
CREATE TABLE engineering_revision_chains (
  chain_id TEXT PRIMARY KEY CHECK(chain_id LIKE 'rc_%'),
  mode TEXT NOT NULL CHECK(mode IN ('shadow','live')),
  root_mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  current_mission_id TEXT REFERENCES engineering_contained_missions(mission_id),
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number>0),
  branch TEXT NOT NULL, base_ref TEXT NOT NULL,
  published_head TEXT NOT NULL, published_base TEXT NOT NULL,
  grant_json TEXT NOT NULL CHECK(length(grant_json)<=4096),
  rounds_used INTEGER NOT NULL DEFAULT 0 CHECK(rounds_used BETWEEN 0 AND 2),
  state TEXT NOT NULL CHECK(state IN ('awaiting_review','revision_reserved','revising','publishing',
    'ready_for_human','closed','awaiting_decision')),
  stop_reason TEXT,
  review_deadline INTEGER, budget_json TEXT, spent_json TEXT, trace_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(state<>'awaiting_decision' OR stop_reason IS NOT NULL),
  CHECK(mode<>'shadow' OR (rounds_used=0 AND current_mission_id IS NULL
    AND state NOT IN ('revision_reserved','revising','publishing'))),
  -- Per-mode grant shape. A missing field makes the branch false, never NULL.
  CHECK(COALESCE(CASE
    WHEN NOT json_valid(grant_json) THEN 0
    WHEN mode='live' THEN
      COALESCE(json_extract(grant_json,'$.kind') IS 'live',0)
      AND COALESCE(json_type(grant_json,'$.rounds')='integer',0)
      AND COALESCE(json_extract(grant_json,'$.rounds') IN (1,2),0)
      AND COALESCE(rounds_used<=json_extract(grant_json,'$.rounds'),0)
    WHEN mode='shadow' THEN
      COALESCE(json_extract(grant_json,'$.kind') IS 'shadow_hypothetical',0)
      AND json_type(grant_json,'$.rounds') IS NULL
    ELSE 0 END,0)=1)
);
CREATE UNIQUE INDEX engineering_chain_root ON engineering_revision_chains(root_mission_id,mode);
CREATE UNIQUE INDEX engineering_chain_pr_live ON engineering_revision_chains(repository,pr_number) WHERE mode='live';
CREATE INDEX engineering_chain_scan ON engineering_revision_chains(created_at,chain_id);
CREATE TRIGGER engineering_chain_insert BEFORE INSERT ON engineering_revision_chains
WHEN NEW.current_mission_id IS NOT NULL OR NEW.revision<>1
BEGIN SELECT RAISE(ABORT,'chain_insert_denied'); END;
CREATE TRIGGER engineering_chain_fixed BEFORE UPDATE ON engineering_revision_chains
WHEN OLD.chain_id<>NEW.chain_id OR OLD.mode<>NEW.mode OR OLD.root_mission_id<>NEW.root_mission_id
  OR OLD.repository<>NEW.repository OR OLD.pr_number<>NEW.pr_number OR OLD.branch<>NEW.branch
  OR OLD.base_ref<>NEW.base_ref OR OLD.created_at<>NEW.created_at OR OLD.trace_id<>NEW.trace_id
  OR NEW.revision<>OLD.revision+1 OR NEW.rounds_used<OLD.rounds_used OR NEW.rounds_used>OLD.rounds_used+1
BEGIN SELECT RAISE(ABORT,'chain_immutable'); END;
CREATE TRIGGER engineering_chain_terminal BEFORE UPDATE ON engineering_revision_chains
WHEN OLD.state='closed'
BEGIN SELECT RAISE(ABORT,'chain_terminal'); END;
CREATE TRIGGER engineering_chain_current_child_set BEFORE UPDATE OF current_mission_id ON engineering_revision_chains
WHEN NEW.current_mission_id IS NOT NULL AND NEW.current_mission_id IS NOT OLD.current_mission_id
  AND NOT EXISTS (SELECT 1 FROM engineering_revision_reservations r WHERE r.chain_id=NEW.chain_id
    AND r.state='dispatched' AND r.child_mission_id=NEW.current_mission_id)
BEGIN SELECT RAISE(ABORT,'chain_current_child_denied'); END;
CREATE TRIGGER engineering_chain_current_child_release BEFORE UPDATE OF current_mission_id ON engineering_revision_chains
WHEN OLD.current_mission_id IS NOT NULL AND NEW.current_mission_id IS NOT OLD.current_mission_id
  AND (NOT EXISTS (SELECT 1 FROM engineering_contained_missions m WHERE m.mission_id=OLD.current_mission_id
        AND m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)
    OR EXISTS (SELECT 1 FROM engineering_revision_reservations r WHERE r.chain_id=OLD.chain_id
        AND r.child_mission_id=OLD.current_mission_id AND r.state IN ('reserved','dispatched')))
BEGIN SELECT RAISE(ABORT,'chain_current_child_busy'); END;

CREATE TABLE engineering_revision_reservations (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number>0), head_sha TEXT NOT NULL CHECK(length(head_sha)>0),
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  review_ids_json TEXT NOT NULL CHECK(json_valid(review_ids_json) AND length(review_ids_json)<=4096),
  feedback_digest TEXT NOT NULL,
  child_mission_id TEXT REFERENCES engineering_contained_missions(mission_id),
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','void')),
  settled_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(repository,pr_number,head_sha),
  CHECK((state='reserved' AND child_mission_id IS NULL AND settled_reason IS NULL)
     OR (state='dispatched' AND child_mission_id IS NOT NULL AND settled_reason IS NULL)
     OR (state='void' AND settled_reason IS NOT NULL))
);
CREATE UNIQUE INDEX engineering_reservation_active ON engineering_revision_reservations(chain_id) WHERE state IN ('reserved','dispatched');
CREATE UNIQUE INDEX engineering_reservation_child ON engineering_revision_reservations(child_mission_id) WHERE child_mission_id IS NOT NULL;
CREATE TRIGGER engineering_reservation_live_only BEFORE INSERT ON engineering_revision_reservations
WHEN (SELECT mode FROM engineering_revision_chains WHERE chain_id=NEW.chain_id)='shadow'
BEGIN SELECT RAISE(ABORT,'bridge_shadow_write_denied'); END;
CREATE TRIGGER engineering_reservation_insert BEFORE INSERT ON engineering_revision_reservations
WHEN NEW.state<>'reserved' OR NOT EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.chain_id=NEW.chain_id
  AND c.repository=NEW.repository AND c.pr_number=NEW.pr_number)
BEGIN SELECT RAISE(ABORT,'reservation_insert_denied'); END;
-- Invariant 3 in the database: no new reservation, and no reservation becoming dispatched, while any child this chain
-- ever dispatched (or its current_mission_id) is not terminal with the stop proven. Voiding a reservation therefore never
-- frees the chain while a child may still run, whatever the current_mission_id pointer says.
CREATE TRIGGER engineering_reservation_child_exclusive_insert BEFORE INSERT ON engineering_revision_reservations
WHEN (EXISTS (SELECT 1 FROM engineering_revision_chains c JOIN engineering_contained_missions m ON m.mission_id=c.current_mission_id
    WHERE c.chain_id=NEW.chain_id AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0))
  OR EXISTS (SELECT 1 FROM engineering_revision_reservations r JOIN engineering_contained_missions m ON m.mission_id=r.child_mission_id
    WHERE r.chain_id=NEW.chain_id AND r.head_sha<>NEW.head_sha AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)))
BEGIN SELECT RAISE(ABORT,'reservation_child_busy'); END;
CREATE TRIGGER engineering_reservation_child_exclusive_dispatch BEFORE UPDATE ON engineering_revision_reservations
WHEN NEW.state='dispatched' AND OLD.state<>'dispatched' AND (EXISTS (SELECT 1 FROM engineering_revision_chains c JOIN engineering_contained_missions m ON m.mission_id=c.current_mission_id
    WHERE c.chain_id=NEW.chain_id AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0))
  OR EXISTS (SELECT 1 FROM engineering_revision_reservations r JOIN engineering_contained_missions m ON m.mission_id=r.child_mission_id
    WHERE r.chain_id=NEW.chain_id AND r.head_sha<>NEW.head_sha AND NOT (m.state IN ('pr_opened','cancelled','abandoned','failed') AND m.stop_obligation=0)))
BEGIN SELECT RAISE(ABORT,'reservation_child_busy'); END;
CREATE TRIGGER engineering_reservation_fixed BEFORE UPDATE ON engineering_revision_reservations
WHEN OLD.chain_id<>NEW.chain_id OR OLD.repository<>NEW.repository OR OLD.pr_number<>NEW.pr_number OR OLD.head_sha<>NEW.head_sha
  OR OLD.review_ids_json<>NEW.review_ids_json OR OLD.feedback_digest<>NEW.feedback_digest OR OLD.created_at<>NEW.created_at
  OR (OLD.child_mission_id IS NOT NULL AND NEW.child_mission_id IS NOT OLD.child_mission_id)
BEGIN SELECT RAISE(ABORT,'reservation_immutable'); END;
CREATE TRIGGER engineering_reservation_transition BEFORE UPDATE ON engineering_revision_reservations
WHEN OLD.state='void' OR (NEW.state<>OLD.state AND NOT (
  (OLD.state='reserved' AND NEW.state IN ('dispatched','void')) OR (OLD.state='dispatched' AND NEW.state='void')))
BEGIN SELECT RAISE(ABORT,'reservation_transition_denied'); END;
CREATE TRIGGER engineering_reservation_no_delete BEFORE DELETE ON engineering_revision_reservations
BEGIN SELECT RAISE(ABORT,'reservation_immutable'); END;

CREATE TABLE engineering_publication_intents (
  intent_id TEXT PRIMARY KEY CHECK(intent_id LIKE 'pi_%'),
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  kind TEXT NOT NULL CHECK(kind IN ('push','open_pr','check')),
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number>0), branch TEXT NOT NULL,
  expected_old_head TEXT, new_head TEXT, expected_base_sha TEXT,
  child_mission_id TEXT REFERENCES engineering_contained_missions(mission_id),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(binding_json)<=4096),
  state TEXT NOT NULL CHECK(state IN ('pending','confirmed','failed','uncertain')),
  detail TEXT CHECK(detail IS NULL OR length(detail)<=1024),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(kind<>'push' OR (new_head IS NOT NULL AND expected_old_head IS NOT NULL AND expected_base_sha IS NOT NULL))
);
CREATE INDEX engineering_intent_chain ON engineering_publication_intents(chain_id,created_at);
CREATE TRIGGER engineering_intent_live_only BEFORE INSERT ON engineering_publication_intents
WHEN (SELECT mode FROM engineering_revision_chains WHERE chain_id=NEW.chain_id)='shadow'
BEGIN SELECT RAISE(ABORT,'bridge_shadow_write_denied'); END;
CREATE TRIGGER engineering_intent_insert BEFORE INSERT ON engineering_publication_intents
WHEN NEW.state<>'pending' OR NOT EXISTS (SELECT 1 FROM engineering_revision_chains c WHERE c.chain_id=NEW.chain_id
  AND c.repository=NEW.repository AND c.pr_number=NEW.pr_number)
BEGIN SELECT RAISE(ABORT,'intent_insert_denied'); END;
-- A push intent is bound to the chain it extends: same branch, old head and base as published, and the chain's
-- current child holding a dispatched reservation.
CREATE TRIGGER engineering_intent_push_binding BEFORE INSERT ON engineering_publication_intents
WHEN NEW.kind='push' AND (SELECT mode FROM engineering_revision_chains WHERE chain_id=NEW.chain_id)='live' AND NOT EXISTS (SELECT 1 FROM engineering_revision_chains c
  JOIN engineering_revision_reservations r ON r.chain_id=c.chain_id AND r.child_mission_id=c.current_mission_id AND r.state='dispatched'
  WHERE c.chain_id=NEW.chain_id AND c.branch=NEW.branch AND c.published_head=NEW.expected_old_head
    AND c.published_base=NEW.expected_base_sha AND c.current_mission_id IS NEW.child_mission_id AND NEW.child_mission_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'intent_binding_mismatch'); END;
CREATE TRIGGER engineering_intent_fixed BEFORE UPDATE ON engineering_publication_intents
WHEN OLD.intent_id<>NEW.intent_id OR OLD.chain_id<>NEW.chain_id OR OLD.kind<>NEW.kind OR OLD.repository<>NEW.repository
  OR OLD.pr_number<>NEW.pr_number OR OLD.branch<>NEW.branch OR OLD.expected_old_head IS NOT NEW.expected_old_head
  OR OLD.new_head IS NOT NEW.new_head OR OLD.expected_base_sha IS NOT NEW.expected_base_sha
  OR OLD.child_mission_id IS NOT NEW.child_mission_id OR OLD.binding_json<>NEW.binding_json OR OLD.created_at<>NEW.created_at
BEGIN SELECT RAISE(ABORT,'intent_immutable'); END;
CREATE TRIGGER engineering_intent_transition BEFORE UPDATE ON engineering_publication_intents
WHEN OLD.state IN ('confirmed','failed') OR (NEW.state<>OLD.state AND NOT (
  (OLD.state='pending' AND NEW.state IN ('confirmed','failed','uncertain')) OR (OLD.state='uncertain' AND NEW.state IN ('confirmed','failed'))))
BEGIN SELECT RAISE(ABORT,'intent_transition_denied'); END;
CREATE TRIGGER engineering_intent_no_delete BEFORE DELETE ON engineering_publication_intents
BEGIN SELECT RAISE(ABORT,'intent_immutable'); END;

CREATE TABLE engineering_revision_chain_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
  payload_json TEXT NOT NULL CHECK(length(payload_json)<=32768), created_at INTEGER NOT NULL
);
CREATE INDEX engineering_chain_events_chain ON engineering_revision_chain_events(chain_id,seq);
CREATE TRIGGER engineering_chain_events_append_only BEFORE UPDATE ON engineering_revision_chain_events
BEGIN SELECT RAISE(ABORT,'chain_event_immutable'); END;
CREATE TRIGGER engineering_chain_events_no_delete BEFORE DELETE ON engineering_revision_chain_events
BEGIN SELECT RAISE(ABORT,'chain_event_immutable'); END;

CREATE TABLE engineering_shadow_decisions (
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  head_sha TEXT NOT NULL, base_sha TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('would_reserve','would_mark_ready','would_stop')),
  reason TEXT NOT NULL, review_ids_json TEXT NOT NULL CHECK(json_valid(review_ids_json) AND length(review_ids_json)<=4096),
  feedback_digest TEXT,
  observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(chain_id,head_sha,action)
);
CREATE TRIGGER engineering_shadow_decisions_shadow_only BEFORE INSERT ON engineering_shadow_decisions
WHEN (SELECT mode FROM engineering_revision_chains WHERE chain_id=NEW.chain_id) IS NOT 'shadow'
BEGIN SELECT RAISE(ABORT,'shadow_decision_shadow_only'); END;
CREATE TRIGGER engineering_shadow_decisions_append_only BEFORE UPDATE ON engineering_shadow_decisions
BEGIN SELECT RAISE(ABORT,'shadow_decision_immutable'); END;
CREATE TRIGGER engineering_shadow_decisions_no_delete BEFORE DELETE ON engineering_shadow_decisions
BEGIN SELECT RAISE(ABORT,'shadow_decision_immutable'); END;
`;
