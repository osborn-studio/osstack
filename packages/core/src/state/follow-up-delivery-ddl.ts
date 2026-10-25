/** Migration 45. Services never run schema creation themselves. */
export const FOLLOW_UP_DELIVERY_DDL = `
CREATE TABLE follow_up_delivery_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1),observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms BETWEEN 0 AND 8640000000000000));
INSERT INTO follow_up_delivery_clock(singleton,observed_at_ms) VALUES(1,0);
CREATE TABLE follow_up_delivery_attempts (
 attempt_id TEXT PRIMARY KEY NOT NULL,repo_path TEXT NOT NULL,tenant TEXT NOT NULL CHECK(tenant='default'),
 obligation_id TEXT NOT NULL REFERENCES follow_up_obligations(obligation_id),obligation_revision INTEGER NOT NULL CHECK(obligation_revision>0),
 idempotency_key TEXT NOT NULL,create_digest TEXT NOT NULL,envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json) AND length(CAST(envelope_json AS BLOB))<=49152),
 state TEXT NOT NULL CHECK(state IN ('prepared','started','delivered','delivery_unknown','definitely_not_sent')),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms),
 qualification TEXT NOT NULL CHECK(qualification IN ('qualification_pending','test_only','sandbox_qualified','production_qualified')),
 receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=8192)),receipt_sha256 TEXT,reason TEXT,
 UNIQUE(repo_path,tenant,idempotency_key),CHECK((state='delivered')=(receipt_json IS NOT NULL)),CHECK((receipt_json IS NULL)=(receipt_sha256 IS NULL))
);
CREATE UNIQUE INDEX follow_up_delivery_active_obligation ON follow_up_delivery_attempts(repo_path,tenant,obligation_id) WHERE state IN ('prepared','started','delivery_unknown');
CREATE INDEX follow_up_delivery_scope_page ON follow_up_delivery_attempts(repo_path,tenant,attempt_id);
CREATE TABLE follow_up_delivery_grants (
 grant_id TEXT PRIMARY KEY NOT NULL,attempt_id TEXT NOT NULL UNIQUE REFERENCES follow_up_delivery_attempts(attempt_id),
 key_id TEXT NOT NULL,signed_json TEXT NOT NULL CHECK(json_valid(signed_json) AND length(CAST(signed_json AS BLOB))<=16384),
 state TEXT NOT NULL CHECK(state IN ('active','consumed','revoked')),created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=created_at_ms)
);
CREATE TABLE follow_up_delivery_events (
 attempt_id TEXT NOT NULL REFERENCES follow_up_delivery_attempts(attempt_id),revision INTEGER NOT NULL,transition TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=16384),created_at_ms INTEGER NOT NULL,
 PRIMARY KEY(attempt_id,revision)
);
CREATE TRIGGER follow_up_delivery_identity_immutable BEFORE UPDATE OF attempt_id,repo_path,tenant,obligation_id,obligation_revision,idempotency_key,create_digest,envelope_json,created_at_ms ON follow_up_delivery_attempts BEGIN SELECT RAISE(ABORT,'delivery identity immutable'); END;
CREATE TRIGGER follow_up_delivery_terminal_immutable BEFORE UPDATE ON follow_up_delivery_attempts WHEN OLD.state IN ('delivered','definitely_not_sent') BEGIN SELECT RAISE(ABORT,'delivery terminal immutable'); END;
CREATE TRIGGER follow_up_delivery_state_forward BEFORE UPDATE OF state ON follow_up_delivery_attempts WHEN
 (OLD.state='prepared' AND NEW.state NOT IN ('prepared','started','definitely_not_sent')) OR
 (OLD.state='started' AND NEW.state NOT IN ('delivered','delivery_unknown')) OR
 (OLD.state='delivery_unknown' AND NEW.state NOT IN ('delivered','delivery_unknown'))
 BEGIN SELECT RAISE(ABORT,'delivery state cannot rewind'); END;
CREATE TRIGGER follow_up_delivery_grant_no_rearm BEFORE UPDATE OF state ON follow_up_delivery_grants WHEN
 (OLD.state='consumed' AND NEW.state!='consumed') OR (OLD.state='revoked' AND NEW.state!='revoked')
 BEGIN SELECT RAISE(ABORT,'delivery grant cannot rearm'); END;
CREATE TRIGGER follow_up_delivery_attempts_no_delete BEFORE DELETE ON follow_up_delivery_attempts BEGIN SELECT RAISE(ABORT,'delivery history immutable'); END;
CREATE TRIGGER follow_up_delivery_grants_identity_immutable BEFORE UPDATE OF grant_id,attempt_id,key_id,signed_json,created_at_ms ON follow_up_delivery_grants BEGIN SELECT RAISE(ABORT,'delivery grant immutable'); END;
CREATE TRIGGER follow_up_delivery_grants_no_delete BEFORE DELETE ON follow_up_delivery_grants BEGIN SELECT RAISE(ABORT,'delivery history immutable'); END;
CREATE TRIGGER follow_up_delivery_events_no_update BEFORE UPDATE ON follow_up_delivery_events BEGIN SELECT RAISE(ABORT,'delivery history immutable'); END;
CREATE TRIGGER follow_up_delivery_events_no_delete BEFORE DELETE ON follow_up_delivery_events BEGIN SELECT RAISE(ABORT,'delivery history immutable'); END;
`;
