import { expect, it } from 'vitest';
import { deliveryCheckReference, freezeDeliveryContract } from '@osstack/core';
import { computeGraphInputDigest, type StartGraphRequest } from '@osstack/protocol';
import { bindGraphDeliveryContract, verifyGraphContractEnvelope } from './graph-delivery-contract.js';

function fixture() {
  const request: StartGraphRequest = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' },
    idempotencyKey: 'key', inputArtifactRef: 'original', source: { product: 'osstack', requestId: 'request' },
    spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
      input: { repositoryRef: 'repo', taskRef: 'task', baseRevision: 'a'.repeat(40), acceptanceRef: 'accept' },
      limits: { maxEpochs: 1, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 10, tokenReservationLimit: 200000, deadlineSeconds: 60 } } };
  const frozen = freezeDeliveryContract({ schema_version: 2, contract_id: 'contract', task_id: 'task', canonical_repo: '/repo', mode: 'implement',
    base_head: request.spec.input.baseRevision, goal: 'change', required_checks: [{ id: 'test', registry_ref: deliveryCheckReference('test -f answer') }],
    review_policy_ref: 'graph:independent', requested_completion: 'local_verified', allowed_paths: ['answer'], requested_actions: ['build', 'verify'],
    budget_ref: `policy:${'b'.repeat(64)}`, policy_digest: 'b'.repeat(64), publication_scope: { mode: 'none' }, merge_authority: { mode: 'none' } });
  return { request, registration: { repositoryPath: '/repo', task: 'change', acceptanceRegistry: [{ ref: 'accept', command: 'test -f answer', passExitCodes: [0], failExitCodes: [1] }],
    deliveryContract: { frozen, policy: { policyDigest: 'b'.repeat(64), reviewPolicyRef: 'graph:independent', limits: structuredClone(request.spec.limits) } } } };
}
it('binds the entire trusted envelope into existing input identity and retains the caller input reference', () => {
  const f = fixture(); const bound = bindGraphDeliveryContract(f.request, f.registration);
  expect(bound.envelope.sourceInputArtifactRef).toBe('original'); expect(bound.request.inputArtifactRef).toMatch(/^graph-contract-input:[a-f0-9]{64}$/);
  expect(computeGraphInputDigest(bound.request)).not.toBe(computeGraphInputDigest(f.request));
  expect(verifyGraphContractEnvelope(bound.envelope, bound.request, f.registration)).toEqual(bound.envelope);
  const frozen = freezeDeliveryContract({ ...f.registration.deliveryContract.frozen.contract, contract_id: 'different' });
  expect(computeGraphInputDigest(bindGraphDeliveryContract(f.request, { ...f.registration, deliveryContract: { ...f.registration.deliveryContract, frozen } }).request)).not.toBe(computeGraphInputDigest(bound.request));
  expect(() => verifyGraphContractEnvelope({ ...bound.envelope, sourceInputArtifactRef: 'changed' }, bound.request, f.registration)).toThrow('MISMATCH');
});
it.each(['registry', 'duplicate_registry', 'nonzero_pass', 'multiple_checks', 'repo', 'goal', 'task', 'base', 'policy', 'review', 'budget_ref', 'digest'])(
  'rejects %s mismatch without treating caller values as authority', change => {
    const f = fixture(); const contract = f.registration.deliveryContract.frozen.contract;
    if (change === 'registry') f.registration.acceptanceRegistry[0]!.command = 'touch injected';
    if (change === 'duplicate_registry') f.registration.acceptanceRegistry.push(f.registration.acceptanceRegistry[0]!);
    if (change === 'nonzero_pass') f.registration.acceptanceRegistry[0]!.passExitCodes = [1];
    if (change === 'multiple_checks') contract.required_checks.push({ id: 'second', registry_ref: deliveryCheckReference('second') });
    if (change === 'repo') f.registration.repositoryPath = '/different';
    if (change === 'goal') f.registration.task = 'other';
    if (change === 'task') f.request.spec.input.taskRef = 'other';
    if (change === 'base') f.request.spec.input.baseRevision = 'c'.repeat(40);
    if (change === 'policy') f.registration.deliveryContract.policy.policyDigest = 'c'.repeat(64);
    if (change === 'review') f.registration.deliveryContract.policy.reviewPolicyRef = 'other';
    if (change === 'budget_ref') contract.budget_ref = 'unbound';
    f.registration.deliveryContract.frozen = freezeDeliveryContract(contract);
    if (change === 'digest') f.registration.deliveryContract.frozen.digest = 'e'.repeat(64);
    expect(() => bindGraphDeliveryContract(f.request, f.registration)).toThrow();
  });
it.each(['maxEpochs', 'maxBranchAttempts', 'maxConcurrentReaders', 'maxActionStarts', 'tokenReservationLimit', 'deadlineSeconds'] as const)(
  'enforces the existing host %s ceiling', key => {
    const f = fixture(); f.request.spec.limits[key] += 1;
    expect(() => bindGraphDeliveryContract(f.request, f.registration)).toThrow('BUDGET_EXCEEDED');
  });
