import { LocalFailureOptInSchema } from '@osstack/core';
import type { z } from 'zod';

export const LocalFailureGrantTerms = LocalFailureOptInSchema.omit({
  enabled: true, max_diagnostics_per_head: true, recheck: true,
}).extend({
  recheck_timeout_seconds: LocalFailureOptInSchema.shape.recheck.unwrap().shape.timeout_seconds.optional(),
});
export type LocalFailureGrantInput = z.infer<typeof LocalFailureGrantTerms>;

export function localFailureOptIn({ recheck_timeout_seconds, ...pins }: LocalFailureGrantInput) {
  return { ...pins, enabled: true as const, max_diagnostics_per_head: 1 as const,
    ...(recheck_timeout_seconds === undefined ? {} : { recheck: { enabled: true as const, timeout_seconds: recheck_timeout_seconds } }) };
}

export const LocalFailureRenewTerms = LocalFailureGrantTerms.extend({
  trusted_source: LocalFailureOptInSchema.shape.trusted_source.partial(),
}).partial().strict();
export type LocalFailureRenewInput = z.infer<typeof LocalFailureRenewTerms>;
export type LocalFailureOptIn = z.infer<typeof LocalFailureOptInSchema>;

export function mergeLocalFailureTerms(old: LocalFailureOptIn, terms: LocalFailureRenewInput = {}): LocalFailureOptIn {
  return { ...old, profile_id: terms.profile_id ?? old.profile_id, profile_digest: terms.profile_digest ?? old.profile_digest,
    trusted_source: { repository: terms.trusted_source?.repository ?? old.trusted_source.repository,
      commit: terms.trusted_source?.commit ?? old.trusted_source.commit,
      artifact_digest: terms.trusted_source?.artifact_digest ?? old.trusted_source.artifact_digest },
    diagnostic_timeout_seconds: terms.diagnostic_timeout_seconds ?? old.diagnostic_timeout_seconds,
    ...(terms.recheck_timeout_seconds === undefined ? {} : { recheck: { enabled: true, timeout_seconds: terms.recheck_timeout_seconds } }) };
}
