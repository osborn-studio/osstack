import type { AutonomyHealthReport } from "./autonomy-health.js";

export function healthyAutonomyHealth(
  overrides: Partial<AutonomyHealthReport> = {},
): AutonomyHealthReport {
  return {
    ok: true,
    can_run_local: true,
    can_merge: true,
    can_push_deploy: true,
    drain_required: false,
    disk_free_bytes: 20 * 1024 ** 3,
    checks: [],
    active_freezes: [],
    resumable_runs: [],
    proof_failures: [],
    notification_outbox: {
      pending_count: 0,
      dead_letter_count: 0,
      oldest_pending_at: null,
      oldest_dead_letter_at: null,
      oldest_attention_age_seconds: 0,
    },
    host_evidence: {
      power_policy: {
        mode: "process_assertion",
        assertion_active: true,
        recorded: true,
      },
      clock_monitor: {
        mode: "monotonic-v1",
        active: true,
      },
      retention: {
        checked_at: 1,
        max_log_bytes: 25 * 1024 ** 2,
        max_log_files: 5,
        proof_retention_days: 30,
        proof_min_keep: 100,
        largest_log_bytes: 0,
        oversized_log_count: 0,
        expired_terminal_proof_count: 0,
        rotated_logs: [],
        removed_proof_dirs: [],
      },
      launchd: {
        required: true,
        loaded: true,
        print_sha256: "a".repeat(64),
      },
    },
    external_blockers: [],
    write_blockers: [],
    next_actions: [],
    ...overrides,
  };
}
