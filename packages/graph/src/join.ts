import { createHash } from 'node:crypto';
import { GraphEffectIdentity, computeGraphEffectKey, freezeWorkerData } from '@osstack/protocol';
import { parseVerificationBinding, validateVerificationBranch, verificationCanonical, verificationObject, type VerificationBinding, type VerificationBranch } from './nodes/branch.js';
export interface ExpectedVerificationBranch { nodeId: string; effectSlot: string; logicalAttempt: number }
export interface VerificationJoinInput {
  binding: VerificationBinding;
  /** Current ledger attempts; zero means no invocation was admitted. */
  expected: { review: ExpectedVerificationBranch; tests: ExpectedVerificationBranch };
  branches: VerificationBranch[];
}
export interface VerificationJoin {
  schemaVersion: 1;
  binding: VerificationBinding;
  expected: VerificationJoinInput['expected'];
  status: 'complete' | 'blocked';
  branches: VerificationBranch[];
  missing: Array<'review' | 'tests'>;
  evidenceDigest: string;
}
function parseExpected(value: unknown, binding: VerificationBinding): ExpectedVerificationBranch {
  const row = verificationObject(value, ['nodeId', 'effectSlot', 'logicalAttempt']);
  if (!Number.isSafeInteger(row.logicalAttempt) || (row.logicalAttempt as number) < 0) throw Error('OUTPUT_CONTRACT_INVALID: expected attempt');
  const effect = GraphEffectIdentity.parse({ schemaVersion: 1, scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash,
    epoch: binding.epoch, nodeId: row.nodeId, effectSlot: row.effectSlot, logicalAttempt: row.logicalAttempt === 0 ? 1 : row.logicalAttempt });
  return { nodeId: effect.nodeId, effectSlot: effect.effectSlot, logicalAttempt: row.logicalAttempt as number };
}
/** Pure assembly over a trusted ledger snapshot. verifyEvidence must compare each
 * envelope to host-verified durable evidence, not just accept its reported digest.
 * This function grants no authority, schedules no tasks, and has no second FSM.
 * Recomputing this deterministic bundle after recovery is not a new external effect. */
export function joinVerificationBranches(value: unknown, verifyEvidence: (branch: VerificationBranch) => void): VerificationJoin {
  if (typeof verifyEvidence !== 'function') throw Error('trusted evidence verifier required');
  const input = verificationObject(value, ['binding', 'expected', 'branches']);
  const binding = parseVerificationBinding(input.binding);
  const expectedInput = verificationObject(input.expected, ['review', 'tests']);
  const expected = { review: parseExpected(expectedInput.review, binding), tests: parseExpected(expectedInput.tests, binding) };
  if (expected.review.nodeId === expected.tests.nodeId) throw Error('JOIN_REVISION_MISMATCH: independent predecessor nodes required');
  if (!Array.isArray(input.branches) || input.branches.length > 2) throw Error('OUTPUT_CONTRACT_INVALID: predecessor count');
  const byKind = new Map<'review' | 'tests', VerificationBranch>();
  for (const raw of input.branches) {
    const branch = validateVerificationBranch(raw, binding); const target = expected[branch.kind];
    if (byKind.has(branch.kind)) throw Error('JOIN_REVISION_MISMATCH: duplicate predecessor');
    if (branch.nodeId !== target.nodeId || branch.effectSlot !== target.effectSlot || (branch.logicalAttempt ?? 0) !== target.logicalAttempt) throw Error('JOIN_REVISION_MISMATCH: stale predecessor');
    if (target.logicalAttempt > 0) {
      const key = computeGraphEffectKey({ schemaVersion: 1, scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash,
        epoch: binding.epoch, nodeId: target.nodeId, effectSlot: target.effectSlot, logicalAttempt: target.logicalAttempt });
      if (branch.effectKey !== key) throw Error('JOIN_REVISION_MISMATCH: missing or incorrect effect key');
    }
    byKind.set(branch.kind, freezeWorkerData(branch));
  }
  const branches: VerificationBranch[] = []; const missing: Array<'review' | 'tests'> = [];
  for (const kind of ['review', 'tests'] as const) {
    const branch = byKind.get(kind);
    if (!branch) { missing.push(kind); continue; }
    const verified: unknown = verifyEvidence(branch);
    if (verified !== undefined) { void Promise.resolve(verified).catch(() => {}); throw Error('evidence verification must be synchronous'); }
    branches.push(branch);
  }
  const body = { schemaVersion: 1 as const, binding, expected, status: missing.length === 0 && branches.every(b => b.state === 'confirmed') ? 'complete' as const : 'blocked' as const, branches, missing };
  return freezeWorkerData({ ...body, evidenceDigest: createHash('sha256').update(`osstack.graph.join.v1\n${verificationCanonical(body)}`).digest('hex') });
}
/** Recheck a serialized join's structure and digest. This is not evidence authentication. */
export function parseVerificationJoin(value: unknown): VerificationJoin {
  const input = verificationObject(value, ['schemaVersion', 'binding', 'expected', 'status', 'branches', 'missing', 'evidenceDigest']);
  const rebuilt = joinVerificationBranches({ binding: input.binding, expected: input.expected, branches: input.branches }, () => {});
  if (verificationCanonical(rebuilt) !== verificationCanonical(value)) throw Error('OUTPUT_CONTRACT_INVALID: join bundle');
  return rebuilt;
}
