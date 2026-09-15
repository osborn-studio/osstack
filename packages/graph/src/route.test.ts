import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { computeGraphEffectKey, workerCanonical } from '@osstack/protocol';
import { joinVerificationBranches } from './join.js';
import { routeVerification } from './route.js';
function fixture(epoch = 0, failure: 'code' | 'schema' | 'unknown' | 'none' = 'none') {
  const spec = { schemaVersion: 1 as const, template: 'code-delivery-v1' as const, publication: 'artifact_only' as const,
    input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'b'.repeat(40), acceptanceRef: 'acceptance' },
    limits: { maxEpochs: 3, maxBranchAttempts: 2, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1 as const, maxActionStarts: 30, deadlineSeconds: 60, tokenReservationLimit: 1000 } };
  const binding = { scope: { schemaVersion: 1 as const, tenantId: 'tenant', principalId: 'owner', workspaceId: 'workspace' }, graphRunId: 'run',
    specHash: createHash('sha256').update(`osstack.graph.spec.v1\n${workerCanonical(spec)}`).digest('hex'), epoch, candidateRevision: 'c'.repeat(40), artifactDigest: 'd'.repeat(64), acceptanceRef: 'acceptance' };
  const expected = { review: { nodeId: 'review', effectSlot: 'invoke', logicalAttempt: 1 }, tests: { nodeId: 'tests', effectSlot: 'invoke', logicalAttempt: 1 } };
  const branches = (['review','tests'] as const).map(kind => {
    const effectKey = computeGraphEffectKey({ schemaVersion: 1, scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash, epoch, nodeId: kind, effectSlot: 'invoke', logicalAttempt: 1 });
    const base = { schemaVersion: 1, binding, kind, nodeId: kind, effectSlot: 'invoke', logicalAttempt: 1, effectKey };
    if (kind === 'review' && failure === 'schema') return { ...base, state: 'failed', error: { schemaVersion: 1, code: 'OUTPUT_CONTRACT_INVALID', message: 'invalid JSON', retryable: true, nextAction: 'retry' } };
    if (kind === 'review' && failure === 'unknown') return { ...base, state: 'unknown', error: { schemaVersion: 1, code: 'ACTION_OUTCOME_UNKNOWN', message: 'stop uncertain', retryable: false, nextAction: 'reconcile' } };
    return { ...base, state: 'confirmed', result: { schemaVersion: 1, kind, candidateRevision: binding.candidateRevision, evidenceRefs: [kind], evidenceDigest: (kind === 'review' ? 'e' : 'f').repeat(64), ...(kind === 'review' ? { verdict: failure === 'code' ? 'changes_requested' : 'accept' } : { passed: true }) } };
  });
  const join = joinVerificationBranches({ binding, expected, branches }, () => {});
  const state = { binding, spec, runStatus: 'running', runCreatedAt: 1000, now: 2000, actionStarts: 5, reservedTokens: '0', chargedTokens: '20', accountingBlocked: false,
    pendingAdmissions: 0, unresolvedActions: 0, branchAttemptsSpent: { review: 1, tests: 1 }, nextCost: { repair: { actions: 5, tokens: 50 }, review: { actions: 1, tokens: 10 }, tests: { actions: 1, tokens: 0 } } };
  return { join, state, branches, binding, expected };
}
it('allows a complete ready result at the exact action/token limit without starting more actions', () => {
  const f = fixture(); f.state.actionStarts = 30; f.state.chargedTokens = '1000';
  expect(routeVerification(f.join, f.state)).toMatchObject({ kind: 'ready', epoch: 0 });
});
it('routes valid negative reports to repair, with at most two repairs', () => {
  const f = fixture(0, 'code'); expect(routeVerification(f.join, f.state)).toMatchObject({ kind: 'repair_required', nextEpoch: 1 });
  const last = fixture(2, 'code'); expect(routeVerification(last.join, last.state)).toMatchObject({ kind: 'stop', reason: 'epoch_budget' });
});
it('uses the shared branch attempt budget for schema/infrastructure failures without spending an epoch', () => {
  const f = fixture(1, 'schema');
  expect(routeVerification(f.join, f.state)).toMatchObject({ kind: 'retry_required', epoch: 1, branches: ['review'] });
  f.state.branchAttemptsSpent.review = 2;
  expect(routeVerification(f.join, f.state)).toMatchObject({ kind: 'stop', reason: 'branch_budget' });
});
it.each(['unknown', 'release', 'cancel'])('requires reconciliation for %s instead of repair or retry', kind => {
  const f = fixture(0, kind === 'unknown' ? 'unknown' : 'code');
  if (kind === 'release') f.state.pendingAdmissions = 1;
  if (kind === 'cancel') f.state.runStatus = 'cancel_pending';
  expect(routeVerification(f.join, f.state)).toMatchObject({ kind: 'reconcile' });
});
it.each(['actions', 'tokens', 'deadline', 'accounting'])('stops new actions at the %s budget boundary', kind => {
  const f = fixture(0, 'code');
  if (kind === 'actions') f.state.actionStarts = 26;
  if (kind === 'tokens') f.state.chargedTokens = '951';
  if (kind === 'deadline') f.state.now = 61000;
  if (kind === 'accounting') f.state.accountingBlocked = true;
  expect(routeVerification(f.join, f.state)).toMatchObject({ kind: 'stop' });
});
it('rejects substituted original limits, clock rollback, or cross-run routing state', () => {
  const f = fixture(); f.state.spec.limits.maxEpochs = 2;
  expect(() => routeVerification(f.join, f.state)).toThrow(/SPEC_MISMATCH/);
  const time = fixture(); time.state.now = 0; expect(() => routeVerification(time.join, time.state)).toThrow();
  const wrong = fixture(); wrong.state.binding.graphRunId = 'other'; expect(() => routeVerification(wrong.join, wrong.state)).toThrow();
});
it('stops for absent results or a terminal run rather than leaving a join waiting forever', () => {
  const f = fixture(); const missing = joinVerificationBranches({ binding: f.binding, expected: f.expected, branches: [f.branches[0]] }, () => {});
  expect(routeVerification(missing, f.state)).toMatchObject({ kind: 'stop', reason: 'missing_predecessor' });
  f.state.runStatus = 'cancelled'; expect(routeVerification(f.join, f.state)).toMatchObject({ kind: 'stop', reason: 'terminal_run' });
});
