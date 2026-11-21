import { expect, it } from "vitest";
import type { LocalFailureOptIn } from "./revision-local-failure-grant.js";
import { checkLocalFailureRenewal } from "./revision-local-failure-renewal.js";
const opt: LocalFailureOptIn = {
  enabled: true, max_diagnostics_per_head: 1, diagnostic_timeout_seconds: 20, profile_id: "fixture",
  profile_digest: "a".repeat(64), trusted_source: { repository: "o/r", commit: "b".repeat(40), artifact_digest: "c".repeat(64) },
};
const recheck = { ...opt, recheck: { enabled: true as const, timeout_seconds: 10 } };
it.each([false, true])("compares opt-in terms with hasIntake=%s", hasIntake => {
  const check = (old: LocalFailureOptIn, next: LocalFailureOptIn) => checkLocalFailureRenewal(old, next, hasIntake);
  const lowered = { ok: false, code: "grant_not_monotonic" };
  expect(check(opt, opt)).toEqual({ ok: true, changed: [] });
  expect(check(opt, { ...opt, profile_id: "updated" })).toEqual(hasIntake ? { ok: false, code: "grant_opt_in_changed" } : { ok: true, changed: ["pin"] });
  expect(check(opt, { ...opt, diagnostic_timeout_seconds: 21 })).toEqual({ ok: true, changed: ["diagnostic_timeout_seconds"] });
  expect(check(opt, { ...opt, diagnostic_timeout_seconds: 19 })).toEqual(lowered);
  expect(check(opt, recheck)).toEqual({ ok: true, changed: ["recheck_added"] });
  expect(check(recheck, opt)).toEqual(lowered);
  expect(check(recheck, { ...opt, recheck: { enabled: true, timeout_seconds: 9 } })).toEqual(lowered);
  expect(check(recheck, { ...opt, recheck: { enabled: true, timeout_seconds: 11 } })).toEqual({ ok: true, changed: ["recheck_timeout_seconds"] });
});
