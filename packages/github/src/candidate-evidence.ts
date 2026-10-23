import { z } from "zod";
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const CandidateEvidenceContextSchema = z
  .object({
    environmentFingerprint: Fingerprint,
    policyFingerprint: Fingerprint,
    testsFingerprint: Fingerprint,
  })
  .strict();
export const CandidateEvidenceSchema = CandidateEvidenceContextSchema.extend({
  schemaVersion: z.literal(1),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  headSha: Sha,
  baseSha: Sha,
  requiredChecks: z.array(z.string().min(1).max(256)).min(1).max(128),
  observedAt: z.string().datetime(),
}).strict();
export type CandidateEvidence = z.infer<typeof CandidateEvidenceSchema>;
export type CandidateEvidenceContext = z.infer<
  typeof CandidateEvidenceContextSchema
>;
// A bounded deduplication hint, never a receipt authorizing cached CI success.
export function assertCandidateEvidenceBinding(
  evidence: CandidateEvidence,
  context: CandidateEvidenceContext,
  repo: string,
  head: string,
  requiredChecks: readonly string[],
): void {
  const age = Date.now() - Date.parse(evidence.observedAt);
  if (
    age < 0 ||
    age > 3_600_000 ||
    evidence.repo !== repo ||
    evidence.headSha !== head ||
    Object.keys(context).some(
      (key) =>
        evidence[key as keyof CandidateEvidenceContext] !==
        context[key as keyof CandidateEvidenceContext],
    ) ||
    new Set(evidence.requiredChecks).size !== evidence.requiredChecks.length ||
    JSON.stringify([...evidence.requiredChecks].sort()) !==
      JSON.stringify([...requiredChecks].sort())
  ) {
    throw new Error("candidate evidence binding is stale or mismatched");
  }
}
