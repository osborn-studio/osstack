import { expect, it } from 'vitest';
import { createTestsRequest, validateTestsResponse } from './tests.js';
it('passes only an acceptance reference, never command text', () => {
  const binding = { scope: { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' }, graphRunId: 'run', specHash: 'a'.repeat(64), epoch: 0, candidateRevision: 'b'.repeat(40), artifactDigest: 'c'.repeat(64), acceptanceRef: 'acceptance' };
  const request = createTestsRequest({ binding, generation: 1, requestId: 'req', nodeId: 'tests', effectSlot: 'invoke', workspaceLeaseRef: 'lease' });
  expect(request.action).toEqual({ kind: 'tests', candidateRevision: binding.candidateRevision, commandSpecRef: 'acceptance', workspaceLeaseRef: 'lease' });
  expect(() => validateTestsResponse(binding, { ...request, action: { ...request.action, command: 'arbitrary' } }, {})).toThrow();
});
