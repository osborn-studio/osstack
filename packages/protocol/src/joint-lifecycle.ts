import { z } from 'zod';
import { Digest, GitId, Ref, UInt, issue, unique } from './contract-primitives.js';
import { jointDigest } from './joint-json.js';
const assigned = { authors: z.array(Ref).min(1).max(64), reviewers: z.array(Ref).max(64), implementation_principals: z.array(Ref).min(1).max(64), custodian: Ref, critical_safety: z.boolean() };
const identity = { kind: z.literal('oracle_lifecycle'), schema_version: z.literal(1), oracle_id: Ref, revision: UInt };
const frozen = { pinned_digest: Digest, frozen_at_ms: UInt, freeze_record_ref: Ref };
const candidate = { candidate_created_at_ms: UInt, candidate_sha: GitId, support_profile_digest: Digest };
export const OracleLifecycle = z.discriminatedUnion('status', [
  z.object({ ...identity, status: z.literal('unassigned') }).strict(),
  z.object({ ...identity, status: z.literal('assigned'), ...assigned }).strict(),
  z.object({ ...identity, status: z.literal('frozen'), ...assigned, ...frozen }).strict(),
  z.object({ ...identity, status: z.literal('executed'), ...assigned, ...frozen, ...candidate, result_ref: Ref, executed_at_ms: UInt }).strict(),
]).superRefine((v, ctx) => {
  if (v.status === 'unassigned') return;
  if (![v.authors, v.reviewers, v.implementation_principals].every(unique)) issue(ctx, 'DUPLICATE_PRINCIPAL');
  if (v.authors.some(p => v.implementation_principals.includes(p)) || v.reviewers.some(p => v.implementation_principals.includes(p) || v.authors.includes(p))) issue(ctx, 'ORACLE_NOT_INDEPENDENT');
  if (v.implementation_principals.includes(v.custodian) || v.authors.includes(v.custodian)) issue(ctx, 'CUSTODIAN_NOT_INDEPENDENT');
  if (v.critical_safety && !v.reviewers.length) issue(ctx, 'MISSING_INDEPENDENT_REVIEWER');
  if (v.status === 'executed') {
    if (v.frozen_at_ms >= v.candidate_created_at_ms) issue(ctx, 'ORACLE_FROZEN_TOO_LATE');
    if (v.status === 'executed' && v.executed_at_ms < v.candidate_created_at_ms) issue(ctx, 'RESULT_BEFORE_CANDIDATE');
  }
});
export type OracleLifecycle = z.infer<typeof OracleLifecycle>;
/** Caller must resolve principal aliases with the trusted host identity registry. */
export const GateEvidence = z.object({
  kind: z.literal('gate_evidence'), schema_version: z.literal(1), gate_id: Ref,
  stage: z.enum(['development', 'merge', 'trial', 'qualification', 'default_enablement']),
  candidate_sha: GitId, support_profile_digest: Digest, dependency_evidence_refs: z.array(Ref).max(256),
  oracle: OracleLifecycle, result: z.enum(['passed', 'failed', 'blocked']),
  evidence_refs: z.array(Ref).min(1).max(256), verifier_ref: Ref, observed_at_ms: UInt,
}).strict().superRefine((v, ctx) => {
  if (v.result !== 'passed') return;
  const o = v.oracle;
  if (o.status !== 'executed') { issue(ctx, 'ORACLE_NOT_EXECUTED'); return; }
  if (o.candidate_sha !== v.candidate_sha || o.support_profile_digest !== v.support_profile_digest || o.executed_at_ms > v.observed_at_ms) issue(ctx, 'GATE_EVIDENCE_MISMATCH');
});
export const MigrationSpec = z.object({
  kind: z.literal('migration_spec'), schema_version: z.literal(1), schema_change_id: Ref,
  source_schema: UInt, target_schema: UInt, ddl_digest: Digest, fixture_digest: Digest,
  source_schema_digest: Digest, target_schema_digest: Digest,
  expected_lineage_tables: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(512),
}).strict().superRefine((v, ctx) => {
  if (v.target_schema !== v.source_schema + 1) issue(ctx, 'NONADJACENT_MIGRATION');
  if (!unique(v.expected_lineage_tables)) issue(ctx, 'DUPLICATE_LINEAGE_TABLE');
});
export type MigrationSpec = z.infer<typeof MigrationSpec>;
export function schemaSpecDigest(input: unknown): string {
  const v = MigrationSpec.parse(input);
  return jointDigest('osstack.joint.schema-spec.v1', {
    schema_change_id: v.schema_change_id, source_schema: v.source_schema, target_schema: v.target_schema,
    ddl_digest: v.ddl_digest, fixture_digest: v.fixture_digest, source_schema_digest: v.source_schema_digest, target_schema_digest: v.target_schema_digest, expected_lineage_tables: [...v.expected_lineage_tables].sort(),
  });
}
export const JointError = z.object({ kind: z.literal('joint_error'), schema_version: z.literal(1), code: z.enum(['INVALID_INPUT', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'AUTHORIZATION_REQUIRED', 'UNKNOWN_EXECUTION', 'PROOF_MISMATCH', 'SCHEMA_MISMATCH', 'CAPABILITY_UNSUPPORTED']), request_id: Ref, evidence_refs: z.array(Ref).max(256) }).strict();
