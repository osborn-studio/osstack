import { expect, it } from "vitest";
import { classifyClaudeAttentionHook } from "./attention-hook.js";
const binding = {
  harness_version: "2.1.291",
  session_id: "s",
  scope_id: "scope",
  client_id: "c",
  token: "a".repeat(64),
  role: "foreground_owner" as const,
};
it("accepts observed Claude root Stop shape and ignores cancellation, worker and repeated-stop shapes", () => {
  const normal = {
    hook_event_name: "Stop",
    session_id: "s",
    stop_hook_active: false,
  };
  expect(classifyClaudeAttentionHook(normal, binding)).toBe("remind");
  for (const event of [
    { ...normal, session_id: "other" },
    { ...normal, stop_hook_active: true },
    { ...normal, agent_id: "worker" },
    { ...normal, hook_event_name: "SessionEnd", reason: "cancelled" },
  ])
    expect(classifyClaudeAttentionHook(event, binding)).toBe("ignore");
  expect(
    classifyClaudeAttentionHook(normal, {
      ...binding,
      harness_version: "unknown",
    })
  ).toBe("ignore");
});
