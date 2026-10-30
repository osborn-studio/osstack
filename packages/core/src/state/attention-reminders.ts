/** Opt-in overdue-decision reminders (Firstmate 1973897). Reminders only
 * notify; they never answer, approve or extend any execution authority. */
export interface AttentionReminderPolicy {
  /** Age of an open decision before its first reminder, and the first repeat interval. */
  overdueMs: number;
  /** Repeat intervals double after each reminder and stop growing here. */
  backoffMaxMs: number;
}

const SECONDS = /^[1-9][0-9]{0,8}$/;

/** Undefined when disabled. Enabled settings that are not canonical positive
 * integers of at most nine digits, or a cap below the threshold, are refused
 * rather than silently creating an unbounded reminder loop. */
export function parseAttentionReminderPolicy(
  env: Record<string, string | undefined>
): AttentionReminderPolicy | undefined {
  const flag = env["OSSTACK_ATTENTION_REMINDERS"];
  if (flag === undefined || flag === "0") return undefined;
  if (flag !== "1") throw new Error("invalid_attention_reminder_policy");
  const overdue = env["OSSTACK_ATTENTION_REMINDER_OVERDUE_SECS"] ?? "1800";
  const cap = env["OSSTACK_ATTENTION_REMINDER_BACKOFF_MAX_SECS"] ?? "14400";
  if (!SECONDS.test(overdue) || !SECONDS.test(cap) || Number(cap) < Number(overdue))
    throw new Error("invalid_attention_reminder_policy");
  return { overdueMs: Number(overdue) * 1000, backoffMaxMs: Number(cap) * 1000 };
}
