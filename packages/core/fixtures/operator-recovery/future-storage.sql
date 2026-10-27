-- Structural templates for J08/J10/J13. No migration number is reserved here.
CREATE TABLE joint_method_objects (
  digest TEXT PRIMARY KEY CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK(kind IN ('binding','material','artifact','permit','qualification')),
  content_ref TEXT NOT NULL CHECK(length(content_ref) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version>0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(digest,kind)
) STRICT;
CREATE TRIGGER joint_method_no_update BEFORE UPDATE ON joint_method_objects
  BEGIN SELECT RAISE(ABORT,'method object immutable'); END;
CREATE TRIGGER joint_method_no_delete BEFORE DELETE ON joint_method_objects
  BEGIN SELECT RAISE(ABORT,'method object immutable'); END;
CREATE TABLE joint_method_active (
  scope_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT 'binding' CHECK(binding_kind='binding'),
  qualification_digest TEXT NOT NULL,
  qualification_kind TEXT NOT NULL DEFAULT 'qualification' CHECK(qualification_kind='qualification'),
  revision INTEGER NOT NULL CHECK(revision>0),
  owner_generation INTEGER NOT NULL CHECK(owner_generation>0),
  PRIMARY KEY(scope_id,recipe_id),
  FOREIGN KEY(binding_digest,binding_kind) REFERENCES joint_method_objects(digest,kind),
  FOREIGN KEY(qualification_digest,qualification_kind) REFERENCES joint_method_objects(digest,kind)
) STRICT;
CREATE TABLE trial_permit_consumptions (
  permit_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  root_effect_id TEXT NOT NULL UNIQUE,
  binding_digest TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT 'binding' CHECK(binding_kind='binding'),
  request_id TEXT NOT NULL,
  input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^0-9a-f]*'),
  owner_generation INTEGER NOT NULL CHECK(owner_generation>0),
  consumption_state TEXT NOT NULL CHECK(consumption_state IN ('consumed','unknown','reconciled')),
  consumption_revision INTEGER NOT NULL CHECK(consumption_revision>0),
  FOREIGN KEY(binding_digest,binding_kind) REFERENCES joint_method_objects(digest,kind)
) STRICT;
CREATE TABLE engineering_goal_specs (
  goal_id TEXT PRIMARY KEY,
  spec_digest TEXT NOT NULL CHECK(length(spec_digest)=64 AND spec_digest NOT GLOB '*[^0-9a-f]*'),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
) STRICT;
CREATE TABLE engineering_goal_effects (
  effect_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES engineering_goal_specs(goal_id),
  binding_digest TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT 'binding' CHECK(binding_kind='binding'),
  phase TEXT NOT NULL CHECK(phase IN ('reserved','dispatch_committed','observed')),
  resolution TEXT NOT NULL CHECK(resolution IN ('none','abandoned_unknown','cancelled_before_dispatch','resolved_stopped','applied_observed')),
  owner_generation INTEGER NOT NULL CHECK(owner_generation>0),
  binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
  revision INTEGER NOT NULL CHECK(revision>0),
  stop_intent INTEGER NOT NULL CHECK(stop_intent IN (0,1)),
  budget_reserved_microusd INTEGER NOT NULL CHECK(budget_reserved_microusd>=0),
  FOREIGN KEY(binding_digest,binding_kind) REFERENCES joint_method_objects(digest,kind),
  CHECK(resolution!='cancelled_before_dispatch' OR (phase='reserved' AND stop_intent=1)),
  CHECK(resolution NOT IN ('resolved_stopped','applied_observed') OR phase!='reserved')
) STRICT;

CREATE TRIGGER joint_method_no_replace BEFORE INSERT ON joint_method_objects
WHEN EXISTS(SELECT 1 FROM joint_method_objects WHERE digest=NEW.digest)
BEGIN SELECT RAISE(ABORT,'method object immutable'); END;
CREATE TRIGGER engineering_goal_no_replace BEFORE INSERT ON engineering_goal_specs
WHEN EXISTS(SELECT 1 FROM engineering_goal_specs WHERE goal_id=NEW.goal_id)
BEGIN SELECT RAISE(ABORT,'goal specification immutable'); END;
CREATE TRIGGER engineering_goal_no_update BEFORE UPDATE ON engineering_goal_specs
BEGIN SELECT RAISE(ABORT,'goal specification immutable'); END;
CREATE TRIGGER engineering_goal_no_delete BEFORE DELETE ON engineering_goal_specs
BEGIN SELECT RAISE(ABORT,'goal specification immutable'); END;
CREATE TRIGGER trial_consumption_no_replace BEFORE INSERT ON trial_permit_consumptions
WHEN NEW.consumption_state<>'consumed' OR NEW.consumption_revision<>1
  OR EXISTS(SELECT 1 FROM trial_permit_consumptions WHERE permit_id=NEW.permit_id OR root_effect_id=NEW.root_effect_id)
BEGIN SELECT RAISE(ABORT,'permit already consumed or invalid initial state'); END;
CREATE TRIGGER trial_consumption_no_delete BEFORE DELETE ON trial_permit_consumptions
BEGIN SELECT RAISE(ABORT,'permit consumption permanent'); END;
CREATE TRIGGER trial_consumption_forward BEFORE UPDATE ON trial_permit_consumptions
WHEN NEW.permit_id<>OLD.permit_id OR NEW.root_effect_id<>OLD.root_effect_id OR NEW.binding_digest<>OLD.binding_digest
  OR NEW.scope_id<>OLD.scope_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.binding_kind<>OLD.binding_kind
  OR NEW.request_id<>OLD.request_id OR NEW.input_digest<>OLD.input_digest OR NEW.owner_generation<>OLD.owner_generation
  OR NEW.consumption_revision<>OLD.consumption_revision+1
  OR NOT ((OLD.consumption_state='consumed' AND NEW.consumption_state IN ('unknown','reconciled'))
    OR (OLD.consumption_state='unknown' AND NEW.consumption_state='reconciled'))
BEGIN SELECT RAISE(ABORT,'invalid permit transition'); END;
