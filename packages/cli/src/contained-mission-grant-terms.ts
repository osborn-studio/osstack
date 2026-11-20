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
