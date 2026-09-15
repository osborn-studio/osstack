import { expect, it } from 'vitest';
import { computeGraphEffectKey } from '@osstack/protocol';
import { joinVerificationBranches } from './join.js';
const binding = { scope: { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'owner', workspaceId: 'workspace' }, graphRunId: 'run', specHash: 'a'.repeat(64), epoch: 0, candidateRevision: 'b'.repeat(40), artifactDigest: 'c'.repeat(64), acceptanceRef: 'acceptance' };
// Effect keys are computed over the protocol identity, never extra candidate fields.
function sample() {
  const branches = (['review', 'tests'] as const).map(kind => { const { scope, graphRunId, specHash, epoch } = binding;
    const value = { schemaVersion: 1 as const, binding, kind, nodeId: kind, effectSlot: 'invoke', logicalAttempt: 1, state: 'confirmed' as const,
      effectKey: computeGraphEffectKey({ schemaVersion: 1, scope, graphRunId, specHash, epoch, nodeId: kind, effectSlot: 'invoke', logicalAttempt: 1 }),
      result: { schemaVersion: 1 as const, kind, candidateRevision: binding.candidateRevision, evidenceRefs: [kind], evidenceDigest: (kind === 'review' ? 'd' : 'e').repeat(64), ...(kind === 'review' ? { verdict: 'accept' as const } : { passed: true }) } };
    return value;
  });
  return { binding, expected: { review: { nodeId: 'review', effectSlot: 'invoke', logicalAttempt: 1 }, tests: { nodeId: 'tests', effectSlot: 'invoke', logicalAttempt: 1 } }, branches };
}
it('joins both verified current results in stable order independent of completion order', () => {
  const input = sample(); const seen: string[] = [];
  const first = joinVerificationBranches(input, b => { seen.push(b.kind); });
  const reverse = joinVerificationBranches({ ...input, branches: [...input.branches].reverse() }, () => {});
  expect(first).toEqual(reverse); expect(first.status).toBe('complete'); expect(seen).toEqual(['review', 'tests']);
  expect(first.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
});
it.each(['scope', 'epoch', 'candidate', 'attempt', 'duplicate'])('rejects %s mismatch rather than combining stale evidence', kind => {
  const input = structuredClone(sample());
  if (kind === 'scope') input.branches[0]!.binding.scope.tenantId = 'other';
  if (kind === 'epoch') input.branches[0]!.binding.epoch = 1;
  if (kind === 'candidate') input.branches[0]!.result.candidateRevision = 'f'.repeat(40);
  if (kind === 'attempt') input.expected.review.logicalAttempt = 2;
  if (kind === 'duplicate') input.branches.push(input.branches[0]!);
  expect(() => joinVerificationBranches(input, () => {})).toThrow();
});
it('reports a missing predecessor as blocked without manufacturing a wait or pass', () => {
  const input = sample(); input.branches.pop();
  const joined = joinVerificationBranches(input, () => {});
  expect(joined).toMatchObject({ status: 'blocked', missing: ['tests'] });
});
it('requires synchronous trusted evidence verification and freezes the resulting bundle', () => {
  expect(() => joinVerificationBranches(sample(), () => { throw Error('evidence altered'); })).toThrow('evidence altered');
  expect(() => joinVerificationBranches(sample(), async () => {})).toThrow(/synchronous/);
  const input = sample(); const joined = joinVerificationBranches(input, () => {});
  (input.branches[0]!.result.evidenceRefs as string[])[0] = 'tampered';
  expect(joined.branches[0]).toMatchObject({ result: { evidenceRefs: ['review'] } }); expect(Object.isFrozen(joined)).toBe(true);
});
