import { WorkerActionRequest } from '@osstack/protocol';
import { parseVerificationBinding, verificationBranchFromResponse, type VerificationBinding, type VerificationRequestInput } from './branch.js';
export function createTestsRequest(input: VerificationRequestInput): WorkerActionRequest {
  const binding = parseVerificationBinding(input.binding);
  return WorkerActionRequest.parse({ schemaVersion: 1, kind: 'worker_action', requestId: input.requestId, generation: input.generation,
    scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash, epoch: binding.epoch, nodeId: input.nodeId, effectSlot: input.effectSlot,
    action: { kind: 'tests', candidateRevision: binding.candidateRevision, commandSpecRef: binding.acceptanceRef, workspaceLeaseRef: input.workspaceLeaseRef } });
}
export function validateTestsResponse(binding: VerificationBinding, request: unknown, response: unknown) {
  if (WorkerActionRequest.parse(request).action.kind !== 'tests') throw new Error('INPUT_CONTRACT_INVALID: expected tests');
  return verificationBranchFromResponse(binding, request, response);
}
