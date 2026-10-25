import { expect, it } from "vitest";
import { AttentionInbox, AttentionStatus } from "./attention.js";
const snapshot = { schema_version: 1, mode: "snapshot_only", scope: { scope_id: "s", task_id: "t", tenant_id: null, repo_path: "/repo" },
  sampled_at_ms: 1, coverage: { state: "not_monitored" }, runs: [], sessions: [],
  completeness: { latest_turn_only: true, truncated: false, omitted_binding_unknown: 0, next_cursor: null, next_after: { run: null, session: null } }, limitations: [] };
it("accepts a bounded snapshot and refuses invented live coverage or unscoped fields", () => {
  expect(AttentionStatus.safeParse(snapshot).success).toBe(true);
  expect(AttentionStatus.safeParse({ ...snapshot, coverage: { state: "covered" } }).success).toBe(false);
  expect(AttentionStatus.safeParse({ ...snapshot, sampled_at_ms: Infinity }).success).toBe(false);
  expect(AttentionStatus.safeParse({ ...snapshot, approve: true }).success).toBe(false);
});

it("represents a proven cancelled answer without declaring it applied", () => {
  const item = { item_id: "item", scope_id: "scope", session_id: "session", turn_id: "turn", decision_id: "decision", content_hash: "a".repeat(64), decision: { decision_id: "decision", question: "Choose?", choices: [] }, source_version: 1, revision: 2, state: "answer_cancelled", created_at: 1, updated_at: 2, external_message_id: null };
  const inbox = AttentionInbox.parse({ schema_version: 1, scope_id: "scope", coverage: "covered", execution_takeover: false, counts: [{ state: "answer_cancelled", total: 1 }], next_after: null, items: [item] });
  expect(inbox.items[0]?.state).toBe("answer_cancelled");
  expect(inbox.execution_takeover).toBe(false);
});
