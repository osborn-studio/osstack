import { expect, it } from 'vitest';
import { parseReviewReport, createReviewRequest, validateReviewResponse } from './review.js';
it('accepts structured changes_requested and rejects identity self-claims and malformed reports', () => {
  const report = { schemaVersion: 1, verdict: 'changes_requested', summary: 'Fix bounds', findings: ['Index can overflow'] };
  expect(parseReviewReport(report)).toEqual(report);
  for (const value of [{ ...report, reviewerIdentity: 'trusted' }, { ...report, verdict: 'failed' }, { ...report, findings: [42] }, 'accept']) expect(() => parseReviewReport(value)).toThrow();
});
it('constructs only review protocol actions', () => {
  const binding = { scope: { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' }, graphRunId: 'run', specHash: 'a'.repeat(64), epoch: 0, candidateRevision: 'b'.repeat(40), artifactDigest: 'c'.repeat(64), acceptanceRef: 'acceptance' };
  const request = createReviewRequest({ binding, generation: 1, requestId: 'req', nodeId: 'review', effectSlot: 'invoke', workspaceLeaseRef: 'lease' });
  expect(request.action).toEqual({ kind: 'review', candidateRevision: binding.candidateRevision, acceptanceRef: 'acceptance', workspaceLeaseRef: 'lease' });
  expect(() => validateReviewResponse(binding, { ...request, action: { kind: 'tests', candidateRevision: binding.candidateRevision, commandSpecRef: 'acceptance', workspaceLeaseRef: 'lease' } }, {})).toThrow();
});
