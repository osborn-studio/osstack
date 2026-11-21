import type { LocalFailureOptIn } from "./revision-local-failure-grant.js";

type RenewalTerm = "pin" | "diagnostic_timeout_seconds" | "recheck_added" | "recheck_timeout_seconds";

export function checkLocalFailureRenewal(old: LocalFailureOptIn, next: LocalFailureOptIn, hasIntake: boolean):
  { ok: true; changed: RenewalTerm[] } | { ok: false; code: "grant_opt_in_changed" | "grant_not_monotonic" } {
  const changed: RenewalTerm[] = [];
  if (old.profile_id !== next.profile_id || old.profile_digest !== next.profile_digest
    || old.trusted_source.repository !== next.trusted_source.repository || old.trusted_source.commit !== next.trusted_source.commit
    || old.trusted_source.artifact_digest !== next.trusted_source.artifact_digest) {
    if (hasIntake) return { ok: false, code: "grant_opt_in_changed" };
    changed.push("pin");
  }
  if (next.diagnostic_timeout_seconds < old.diagnostic_timeout_seconds
    || (old.recheck && (!next.recheck || next.recheck.timeout_seconds < old.recheck.timeout_seconds))) {
    return { ok: false, code: "grant_not_monotonic" };
  }
  if (next.diagnostic_timeout_seconds > old.diagnostic_timeout_seconds) changed.push("diagnostic_timeout_seconds");
  if (next.recheck && !old.recheck) changed.push("recheck_added");
  if (next.recheck && old.recheck && next.recheck.timeout_seconds > old.recheck.timeout_seconds) changed.push("recheck_timeout_seconds");
  return { ok: true, changed };
}
