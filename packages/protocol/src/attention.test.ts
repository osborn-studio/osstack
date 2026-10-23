import { expect, it } from "vitest";
import { AttentionStatus } from "./attention.js";
const snapshot = { schema_version: 1, mode: "snapshot_only", scope: { scope_id: "s", task_id: "t", tenant_id: null, repo_path: "/repo" },
  sampled_at_ms: 1, coverage: { state: "not_monitored" }, runs: [], sessions: [],
  completeness: { latest_turn_only: true, truncated: false, omitted_binding_unknown: 0, next_cursor: null, next_after: { run: null, session: null } }, limitations: [] };
it("accepts a bounded snapshot and refuses invented live coverage or unscoped fields", () => {
  expect(AttentionStatus.safeParse(snapshot).success).toBe(true);
  expect(AttentionStatus.safeParse({ ...snapshot, coverage: { state: "covered" } }).success).toBe(false);
  expect(AttentionStatus.safeParse({ ...snapshot, sampled_at_ms: Infinity }).success).toBe(false);
  expect(AttentionStatus.safeParse({ ...snapshot, approve: true }).success).toBe(false);
});
