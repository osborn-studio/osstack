import { createHash } from 'node:crypto';
import { GraphRunState, GraphSpec, freezeWorkerData, workerCanonical } from '@osstack/protocol';
import { parseVerificationJoin } from './join.js';
import { parseVerificationBinding, verificationCanonical, verificationObject, type VerificationBinding } from './nodes/branch.js';
export interface VerificationActionCost { actions: number; tokens: number }
export interface VerificationRoutingState {
  binding: VerificationBinding; spec: GraphSpec; runStatus: GraphRunState;
  runCreatedAt: number; now: number; actionStarts: number;
  reservedTokens: string; chargedTokens: string; accountingBlocked: boolean;
  pendingAdmissions: number; unresolvedActions: number;
  branchAttemptsSpent: { review: number; tests: number };
  nextCost: { repair: VerificationActionCost; review: VerificationActionCost; tests: VerificationActionCost };
}
export type VerificationRoute =
  | { kind: 'ready'; epoch: number; evidenceDigest: string }
  | { kind: 'repair_required'; epoch: number; nextEpoch: number; evidenceDigest: string }
  | { kind: 'retry_required'; epoch: number; branches: Array<'review' | 'tests'> }
  | { kind: 'reconcile'; epoch: number; reason: string }
  | { kind: 'stop'; epoch: number; reason: string };
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('INPUT_CONTRACT_INVALID: counter');
  return value;
}
function tokens(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,127})$/.test(value)) throw Error('INPUT_CONTRACT_INVALID: token counter');
  return value;
}
function cost(value: unknown): VerificationActionCost {
  const object = verificationObject(value, ['actions', 'tokens']);
  const actions = count(object.actions); if (!actions) throw Error('INPUT_CONTRACT_INVALID: action cost');
  return { actions, tokens: count(object.tokens) };
}
function parseState(value: unknown): VerificationRoutingState {
  const s = verificationObject(value, ['binding', 'spec', 'runStatus', 'runCreatedAt', 'now', 'actionStarts', 'reservedTokens', 'chargedTokens', 'accountingBlocked', 'pendingAdmissions', 'unresolvedActions', 'branchAttemptsSpent', 'nextCost']);
  const binding = parseVerificationBinding(s.binding); const spec = GraphSpec.parse(s.spec);
  if (createHash('sha256').update(`osstack.graph.spec.v1\n${workerCanonical(spec)}`).digest('hex') !== binding.specHash
    || spec.input.acceptanceRef !== binding.acceptanceRef) throw Error('SPEC_MISMATCH: original routing limits');
  const attempts = verificationObject(s.branchAttemptsSpent, ['review', 'tests']);
  const costs = verificationObject(s.nextCost, ['repair', 'review', 'tests']);
  const runCreatedAt = count(s.runCreatedAt); const now = count(s.now);
  if (now < runCreatedAt || typeof s.accountingBlocked !== 'boolean') throw Error('INPUT_CONTRACT_INVALID: time/accounting');
  return { binding, spec, runStatus: GraphRunState.parse(s.runStatus), runCreatedAt, now, actionStarts: count(s.actionStarts),
    reservedTokens: tokens(s.reservedTokens), chargedTokens: tokens(s.chargedTokens), accountingBlocked: s.accountingBlocked,
    pendingAdmissions: count(s.pendingAdmissions), unresolvedActions: count(s.unresolvedActions),
    branchAttemptsSpent: { review: count(attempts.review), tests: count(attempts.tests) },
    nextCost: { repair: cost(costs.repair), review: cost(costs.review), tests: cost(costs.tests) } };
}
/** Deterministic recommendation over a host-verified join and original ledger
 * snapshot. It never allocates attempts, advances durable epochs, or authorizes
 * execution. The host must recheck the current fence/grant and atomically reserve
 * through the existing ledger before acting on retry_required/repair_required.
 * now is supplied by that host; the replayable orchestration does not read clocks. */
export function routeVerification(joinValue: unknown, stateValue: unknown): VerificationRoute {
  const joined = parseVerificationJoin(joinValue); const state = parseState(stateValue);
  if (verificationCanonical(joined.binding) !== verificationCanonical(state.binding)) throw Error('JOIN_REVISION_MISMATCH: routing snapshot');
  const epoch = state.binding.epoch; const limits = state.spec.limits;
  for (const kind of ['review', 'tests'] as const) {
    if (state.branchAttemptsSpent[kind] < joined.expected[kind].logicalAttempt) throw Error('INPUT_CONTRACT_INVALID: branch accounting');
  }
  const stop = (reason: string): VerificationRoute => ({ kind: 'stop', epoch, reason });
  const reconcile = (reason: string): VerificationRoute => ({ kind: 'reconcile', epoch, reason });
  if (['ready', 'failed', 'cancelled'].includes(state.runStatus)) return stop('terminal_run');
  if (state.runStatus === 'cancel_pending' || state.runStatus === 'reconciliation_required' || state.unresolvedActions > 0
    || joined.branches.some(b => b.state === 'unknown' || b.state === 'cancel_pending')) return reconcile('unresolved_execution');
  if (state.pendingAdmissions > 0) return reconcile('resource_release_pending');
  if (state.runStatus !== 'running') return stop('run_not_running');
  if (joined.branches.some(b => b.state === 'cancelled')) return stop('cancelled_branch');
  if (epoch >= limits.maxEpochs) return stop('epoch_budget');
  if (state.now - state.runCreatedAt >= limits.deadlineSeconds * 1000) return stop('deadline_budget');
  const spentTokens = BigInt(state.reservedTokens) + BigInt(state.chargedTokens);
  if (state.accountingBlocked || spentTokens > BigInt(limits.tokenReservationLimit) || state.actionStarts > limits.maxActionStarts) return stop('accounting_budget');
  if (joined.missing.length) return stop('missing_predecessor');
  const capacity = (costs: VerificationActionCost[]): boolean => {
    const actions = costs.reduce((sum, c) => sum + BigInt(c.actions), BigInt(state.actionStarts));
    const totalTokens = costs.reduce((sum, c) => sum + BigInt(c.tokens), spentTokens);
    return actions <= BigInt(limits.maxActionStarts) && totalTokens <= BigInt(limits.tokenReservationLimit);
  };
  const failed = joined.branches.filter(b => b.state === 'failed');
  if (failed.length) {
    if (failed.some(b => !b.error?.retryable || !b.logicalAttempt || !['OUTPUT_CONTRACT_INVALID', 'INTERNAL_ERROR'].includes(b.error.code))) return stop('branch_failure');
    if (failed.some(b => state.branchAttemptsSpent[b.kind] >= limits.maxBranchAttempts)) return stop('branch_budget');
    if (!capacity(failed.map(b => state.nextCost[b.kind]))) return stop('action_or_token_budget');
    return freezeWorkerData({ kind: 'retry_required', epoch, branches: failed.map(b => b.kind) });
  }
  const review = joined.branches.find(b => b.kind === 'review')?.result;
  const tests = joined.branches.find(b => b.kind === 'tests')?.result;
  if (joined.status !== 'complete' || review?.kind !== 'review' || tests?.kind !== 'tests') return stop('invalid_predecessor');
  if (review.verdict === 'accept' && tests.passed) return freezeWorkerData({ kind: 'ready', epoch, evidenceDigest: joined.evidenceDigest });
  if (epoch >= 2 || epoch + 1 >= limits.maxEpochs) return stop('epoch_budget');
  if (!capacity([state.nextCost.repair])) return stop('action_or_token_budget');
  return freezeWorkerData({ kind: 'repair_required', epoch, nextEpoch: epoch + 1, evidenceDigest: joined.evidenceDigest });
}
