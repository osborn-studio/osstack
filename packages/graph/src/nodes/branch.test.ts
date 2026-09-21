import { expect, it } from 'vitest';
import { parseVerificationBinding, validateVerificationBranch, verificationBranchFromResponse } from './branch.js';
const binding = { scope: { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' }, graphRunId: 'run', specHash: 'a'.repeat(64), epoch: 0, candidateRevision: 'b'.repeat(40), artifactDigest: 'c'.repeat(64), acceptanceRef: 'acceptance' };
const request = { schemaVersion: 1, kind: 'worker_action', requestId: 'req', generation: 1, scope: binding.scope, graphRunId: 'run', specHash: binding.specHash, epoch: 0, nodeId: 'tests', effectSlot: 'invoke', action: { kind: 'tests', candidateRevision: binding.candidateRevision, commandSpecRef: 'acceptance', workspaceLeaseRef: 'lease' } };
const result = { schemaVersion: 1, kind: 'tests', candidateRevision: binding.candidateRevision, passed: false, evidenceRefs: ['evidence'], evidenceDigest: 'd'.repeat(64) };
const response = { schemaVersion: 1, kind: 'worker_action_response', requestId: 'req', generation: 1, effect: { schemaVersion: 1, scope: binding.scope, graphRunId: 'run', specHash: binding.specHash, epoch: 0, nodeId: 'tests', effectSlot: 'invoke', logicalAttempt: 2 }, outcome: { state: 'confirmed', result } };
it('preserves legitimate code failure and ledger-issued attempt', () => {
  const branch = verificationBranchFromResponse(binding, request, response);
  expect(branch).toMatchObject({ state: 'confirmed', logicalAttempt: 2, result: { passed: false } });
  expect(validateVerificationBranch(branch, binding)).toEqual(branch);
});
it('rejects malformed, replayed and non-JSON branches', () => {
  const branch = verificationBranchFromResponse(binding, request, response);
  for (const value of [{ ...branch, binding: { ...binding, artifactDigest: 'f'.repeat(64) } }, { ...branch, state: 'failed' }, { ...branch, logicalAttempt: 0 }, { ...branch, result: { ...result, kind: 'review' } }, { ...branch, fn: () => {} }]) expect(() => validateVerificationBranch(value, binding)).toThrow();
  expect(() => parseVerificationBinding({ ...binding, epoch: 3 })).toThrow();
  expect(() => verificationBranchFromResponse(binding, request, { ...response, generation: 2 })).toThrow();
  expect(() => verificationBranchFromResponse(binding, { ...request, action: { ...request.action, commandSpecRef: 'evil' } }, response)).toThrow();
});
it('does not invent an attempt on admission rejection or turn unknown into code failure', () => {
  const rejected = verificationBranchFromResponse(binding, request, { schemaVersion: 1, kind: 'worker_action_rejected', requestId: 'req', error: { schemaVersion: 1, code: 'POLICY_DENIED', message: 'denied', retryable: false, nextAction: 'stop' } });
  expect(rejected.logicalAttempt).toBeUndefined(); expect(rejected.result).toBeUndefined();
  const uncertain = verificationBranchFromResponse(binding, request, { ...response, outcome: { state: 'running', executionRef: 'execution' } });
  expect(uncertain.state).toBe('unknown'); expect(uncertain.result).toBeUndefined();
});
it('preserves cancellation uncertainty and rejects accessors without reading them', () => {
  const branch = verificationBranchFromResponse(binding, request, { ...response, outcome: { state: 'cancel_pending', executionRef: 'execution', error: { schemaVersion: 1, code: 'CANCEL_UNCONFIRMED', message: 'stopping', retryable: false, nextAction: 'reconcile' } } });
  expect(branch.state).toBe('cancel_pending'); expect(branch.result).toBeUndefined();
  let reads = 0; const hostile = { ...binding }; Object.defineProperty(hostile, 'epoch', { enumerable: true, get: () => { reads++; return 0; } });
  expect(() => parseVerificationBinding(hostile)).toThrow(); expect(reads).toBe(0);
});
