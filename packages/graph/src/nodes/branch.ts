import { GraphEffectIdentity, GraphError, GraphJsonValue, GraphResult, WorkerActionRequest, computeGraphEffectKey, validateWorkerActionResponse, type GraphScope } from '@osstack/protocol';

export interface VerificationBinding {
  scope: GraphScope; graphRunId: string; specHash: string; epoch: number;
  candidateRevision: string; artifactDigest: string; acceptanceRef: string;
}
export interface VerificationBranch {
  schemaVersion: 1; binding: VerificationBinding; kind: 'review' | 'tests'; nodeId: string; effectSlot: string;
  logicalAttempt?: number; state: 'confirmed' | 'failed' | 'unknown' | 'cancel_pending' | 'cancelled';
  result?: GraphResult; error?: GraphError; effectKey?: string;
}
export interface VerificationRequestInput {
  binding: VerificationBinding; generation: number; requestId: string; nodeId: string; effectSlot: string; workspaceLeaseRef: string;
}
export function verificationCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(verificationCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${verificationCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function verificationObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  GraphJsonValue.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('OUTPUT_CONTRACT_INVALID: unexpected fields');
  return value as Record<string, unknown>;
}
export function parseVerificationBinding(value: unknown): VerificationBinding {
  const object = verificationObject(value, ['scope', 'graphRunId', 'specHash', 'epoch', 'candidateRevision', 'artifactDigest', 'acceptanceRef']);
  // Reuse protocol identity constraints without allocating an actual effect/attempt.
  const request = WorkerActionRequest.parse({ schemaVersion: 1, kind: 'worker_action', requestId: 'validate', generation: 1,
    scope: object.scope, graphRunId: object.graphRunId, specHash: object.specHash, epoch: object.epoch, nodeId: 'validate', effectSlot: 'validate',
    action: { kind: 'review', candidateRevision: object.candidateRevision, acceptanceRef: object.acceptanceRef, workspaceLeaseRef: 'validate' } });
  const candidate = GraphResult.parse({ schemaVersion: 1, kind: 'candidate_ready', candidateRevision: object.candidateRevision, artifactDigest: object.artifactDigest, artifactRefs: ['validate'] });
  if (candidate.kind !== 'candidate_ready' || request.action.kind !== 'review') throw new Error('invalid binding');
  return { scope: request.scope, graphRunId: request.graphRunId, specHash: request.specHash, epoch: request.epoch,
    candidateRevision: candidate.candidateRevision, artifactDigest: candidate.artifactDigest, acceptanceRef: request.action.acceptanceRef };
}
export function validateVerificationBranch(value: unknown, expected: VerificationBinding): VerificationBranch {
  const object = verificationObject(value, ['schemaVersion', 'binding', 'kind', 'nodeId', 'effectSlot', 'logicalAttempt', 'state', 'result', 'error', 'effectKey']);
  const binding = parseVerificationBinding(object.binding);
  if (verificationCanonical(binding) !== verificationCanonical(parseVerificationBinding(expected))) throw new Error('JOIN_REVISION_MISMATCH: binding');
  if (object.schemaVersion !== 1 || (object.kind !== 'review' && object.kind !== 'tests') || !['confirmed', 'failed', 'unknown', 'cancel_pending', 'cancelled'].includes(String(object.state))) throw new Error('OUTPUT_CONTRACT_INVALID: branch');
  const request = WorkerActionRequest.parse({ schemaVersion: 1, kind: 'worker_action', requestId: 'validate', generation: 1, scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash, epoch: binding.epoch, nodeId: object.nodeId, effectSlot: object.effectSlot, action: { kind: 'review', candidateRevision: binding.candidateRevision, acceptanceRef: binding.acceptanceRef, workspaceLeaseRef: 'validate' } });
  if (object.logicalAttempt !== undefined) {
    const effect = GraphEffectIdentity.parse({ schemaVersion: 1, scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash, epoch: binding.epoch, nodeId: request.nodeId, effectSlot: request.effectSlot, logicalAttempt: object.logicalAttempt });
    if (object.effectKey !== undefined && object.effectKey !== computeGraphEffectKey(effect)) throw new Error('RESPONSE_MISMATCH: effect key');
  } else if (object.state !== 'failed' || object.effectKey !== undefined) throw new Error('OUTPUT_CONTRACT_INVALID: missing ledger attempt');
  if (object.state === 'confirmed') {
    const result = GraphResult.parse(object.result);
    if (result.kind !== object.kind || !('candidateRevision' in result) || result.candidateRevision !== binding.candidateRevision || object.error !== undefined) throw new Error('OUTPUT_CONTRACT_INVALID: result');
  } else {
    if (object.result !== undefined) throw new Error('OUTPUT_CONTRACT_INVALID: nonconfirmed result');
    if (object.state !== 'cancelled') {
      const error = GraphError.parse(object.error);
      if ((error.nodeId !== undefined && error.nodeId !== request.nodeId) || (error.epoch !== undefined && error.epoch !== binding.epoch)) throw new Error('OUTPUT_CONTRACT_INVALID: error binding');
      if (object.state === 'cancel_pending' && error.code !== 'CANCEL_UNCONFIRMED') throw new Error('OUTPUT_CONTRACT_INVALID: cancellation code');
      if ((object.state === 'unknown' || object.state === 'cancel_pending') && !['ACTION_OUTCOME_UNKNOWN', 'CANCEL_UNCONFIRMED'].includes(error.code)) throw new Error('OUTPUT_CONTRACT_INVALID: uncertainty');
      if (object.state === 'failed' && ['ACTION_OUTCOME_UNKNOWN', 'CANCEL_UNCONFIRMED'].includes(error.code)) throw new Error('OUTPUT_CONTRACT_INVALID: failure');
    } else if (object.error !== undefined) throw new Error('OUTPUT_CONTRACT_INVALID: cancellation');
  }
  return structuredClone(value) as VerificationBranch;
}
export function verificationBranchFromResponse(bindingValue: unknown, requestValue: unknown, responseValue: unknown): VerificationBranch {
  const binding = parseVerificationBinding(bindingValue);
  const request = WorkerActionRequest.parse(requestValue);
  if (!['review', 'tests'].includes(request.action.kind)) throw new Error('INPUT_CONTRACT_INVALID: verification action');
  const action = request.action;
  if ((action.kind !== 'review' && action.kind !== 'tests') || action.candidateRevision !== binding.candidateRevision
    || (action.kind === 'review' ? action.acceptanceRef : action.commandSpecRef) !== binding.acceptanceRef
    || verificationCanonical(request.scope) !== verificationCanonical(binding.scope)
    || request.graphRunId !== binding.graphRunId || request.specHash !== binding.specHash || request.epoch !== binding.epoch) throw new Error('RESPONSE_MISMATCH: request binding');
  const response = validateWorkerActionResponse(request, responseValue);
  const base = { schemaVersion: 1 as const, binding, kind: action.kind, nodeId: request.nodeId, effectSlot: request.effectSlot };
  if (response.kind === 'worker_action_rejected') return validateVerificationBranch({ ...base, state: 'failed', error: response.error }, binding);
  const identity = { logicalAttempt: response.effect.logicalAttempt, effectKey: computeGraphEffectKey(response.effect) };
  const outcome = response.outcome;
  if (outcome.state === 'cancel_pending') return validateVerificationBranch({ ...base, ...identity, state: 'cancel_pending', error: outcome.error }, binding);
  if (outcome.state === 'confirmed' || outcome.state === 'failed') return validateVerificationBranch({ ...base, ...identity, ...outcome }, binding);
  if (outcome.state === 'cancelled') return validateVerificationBranch({ ...base, ...identity, state: 'cancelled' }, binding);
  return validateVerificationBranch({ ...base, ...identity, state: 'unknown', error: 'error' in outcome ? outcome.error : { schemaVersion: 1, code: 'ACTION_OUTCOME_UNKNOWN', message: 'Action is not settled', retryable: false, nextAction: 'reconcile' } }, binding);
}
