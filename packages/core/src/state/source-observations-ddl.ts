/** Migration 46: local snapshot observations only, never source bodies or external effects. */
export const SOURCE_OBSERVATIONS_DDL = `
CREATE TABLE source_observation_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>=0));
INSERT INTO source_observation_clock VALUES(1,0);
CREATE TABLE source_observation_streams(
 stream_key TEXT PRIMARY KEY,repo_path TEXT NOT NULL,source_id TEXT NOT NULL,
 record_revision INTEGER NOT NULL CHECK(record_revision BETWEEN 1 AND 9007199254740990),
 state TEXT NOT NULL CHECK(state IN ('ready','gap','unknown')),reason TEXT,
 accepted_json TEXT NOT NULL CHECK(json_valid(accepted_json)),proposed_json TEXT CHECK(proposed_json IS NULL OR json_valid(proposed_json)),
 updated_at_ms INTEGER NOT NULL,UNIQUE(repo_path,source_id)
);
CREATE TABLE source_observation_generations(stream_key TEXT NOT NULL REFERENCES source_observation_streams(stream_key),generation TEXT NOT NULL,PRIMARY KEY(stream_key,generation));
CREATE TABLE source_observation_events(stream_key TEXT NOT NULL REFERENCES source_observation_streams(stream_key),sequence INTEGER NOT NULL,event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(stream_key,sequence));
`;
