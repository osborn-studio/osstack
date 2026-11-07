import { GRANT_LIMITS, type RevisionGrantPreview } from "./revision-grant.js";

/** Test support for revision grants. Not imported by production code. */
export const GRANT_NOW = 1_800_000_000_000;
export const samplePreview = (over: Partial<RevisionGrantPreview> = {}): RevisionGrantPreview => ({
  kind: "live", version: 1, grant_id: "rg_00000000-0000-4000-8000-000000000001", rounds: 1,
  principal_id: "human", client_session_id: "cli", scope_id: "a".repeat(64), root_mission_id: "cm_00000000-0000-4000-8000-000000000002",
  repository: "o/r", pr_number: 7, branch: "osstack/mission/abc", base_ref: "main", base_sha: "b".repeat(40), head_sha: "c".repeat(40),
  issued_at: GRANT_NOW, expires_at: GRANT_NOW + GRANT_LIMITS.default_validity_ms, review_deadline_ms: GRANT_LIMITS.default_review_deadline_ms,
  budget: { ...GRANT_LIMITS.default_budget }, protected_set_digest: "d".repeat(64), nonce: "e".repeat(32), key_id: "k1", ...over,
});
