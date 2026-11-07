// Phase 5-C: revision push receipts and their Mission/chain commit boundary.
// This module has no scheduler. Phase 5-D selects it for publish_target attempts.
import { createHash } from 'node:crypto';
import { parseStoredGrant, type ContainedMission, type ContainedMissionStore, type PublicationIntent, type RevisionChainStore } from '@osstack/core';
import type { DeliveryCommandRunner } from '@osstack/github';
import { z } from 'zod';
import { fencedDeliveryRunner } from './contained-mission-ports.js';
import { assertGrantLive, type GrantLiveContext } from './contained-mission-grant.js';
import { defaultGhExec, ghGraphqlTransport, type GhExec, type GraphqlTransport } from './contained-mission-bridge-reader.js';
import type { HostProcessKit } from './contained-mission-host-process.js';
import type { ContainedMissionSpec, ContainedPublicationPermit, ContainedPublicationResult } from './contained-mission-runner.js';

export type RevisionRefusalCode = 'repo_config_changed' | 'local_head_mismatch' | 'push_url_invalid' | 'transport_unsupported'
  | 'start_mismatch' | 'publisher_unavailable' | 'intent_binding_mismatch' | 'grant_expired' | 'chain_state'
  | 'pr_closed' | 'pr_merged' | 'pr_head_ref_changed' | 'base_changed' | 'external_write' | 'head_regressed'
  | 'not_descendant' | 'range_too_large' | 'token_unavailable' | 'push_in_flight' | 'bridge_live_disabled'
  | 'fence_chain_state' | 'fence_intent_moved' | 'fence_not_current_child' | 'grant_invalid' | 'budget_exhausted' | 'child_cancelled' | 'push_rejected' | 'never_released';
/** D4/R5: only these local or transient refusals may resume on the same child after a human decision. */
export const REVISION_SAME_CHILD_RESUMABLE: ReadonlySet<RevisionRefusalCode> = new Set([
  'repo_config_changed', 'local_head_mismatch', 'push_url_invalid', 'transport_unsupported', 'publisher_unavailable',
  'token_unavailable', 'push_in_flight', 'bridge_live_disabled', 'never_released',
]);

export interface RevisionPrFacts {
  state: 'OPEN' | 'CLOSED' | 'MERGED'; repository: string; headRefName: string; headRefOid: string;
  baseRefName: string; baseRefOid: string; url: string;
}
const PR_FACTS_QUERY = `query RevisionPublicationPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    state headRepository { nameWithOwner } headRefName headRefOid baseRefName baseRefOid url
  } }
}`;
const prFacts = z.object({ data: z.object({ repository: z.object({ pullRequest: z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']), headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  headRefName: z.string(), headRefOid: z.string(), baseRefName: z.string(), baseRefOid: z.string(), url: z.string(),
}).nullable() }).nullable() }) });

/** Host-credential GraphQL read by PR number. A null repository/head repository is a refusal, never a fallback to a branch search. */
export async function readRevisionPr(repository: string, number: number, transport: GraphqlTransport = ghGraphqlTransport()): Promise<RevisionPrFacts> {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match || !Number.isSafeInteger(number) || number < 1) throw Error('CONTAINED_REVISION_PR_TARGET_INVALID');
  const parsed = prFacts.parse(await transport(PR_FACTS_QUERY, { owner: match[1], name: match[2], number }));
  const pr = parsed.data.repository?.pullRequest;
  if (!pr?.headRepository) throw Error('CONTAINED_REVISION_PR_MISSING');
  return { state: pr.state, repository: pr.headRepository.nameWithOwner, headRefName: pr.headRefName, headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName, baseRefOid: pr.baseRefOid, url: pr.url };
}

/** Read only the compared commit list. GitHub's 100-per-page cap covers the 64-commit publication limit. */
export async function compareRevisionRange(repository: string, oldHead: string, newHead: string, exec: GhExec = defaultGhExec): Promise<readonly string[]> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !SHA.test(oldHead) || !SHA.test(newHead)) throw Error('CONTAINED_REVISION_COMPARE_TARGET_INVALID');
  const done = await exec(['api', `repos/${repository}/compare/${oldHead}...${newHead}?per_page=100`], { timeoutMs: 30_000 });
  if (done.exitCode !== 0) throw Error('CONTAINED_REVISION_COMPARE_FAILED');
  const parsed = z.object({ total_commits: z.number().int().nonnegative(), commits: z.array(z.object({ sha: z.string().regex(SHA) })) }).parse(JSON.parse(done.stdout) as unknown);
  if (parsed.total_commits > 64 || parsed.total_commits !== parsed.commits.length) throw Error('CONTAINED_REVISION_COMPARE_INCOMPLETE');
  return parsed.commits.map(c => c.sha);
}
export interface RevisionPublicationDeps {
  chains: RevisionChainStore; missions: ContainedMissionStore; host: Pick<HostProcessKit, 'recordForIntent'>;
  runner: DeliveryCommandRunner; now: () => number;
  readPr: (repository: string, number: number) => Promise<RevisionPrFacts>;
  /** Local hardened git reads. */
  localGit: (cwd: string, args: readonly string[]) => Promise<{ stdout: string; exitCode: number }>;
  /** Remote read; the caller uses host credentials and the same remote as the push. */
  remoteHead: (cwd: string, remote: string, branch: string) => Promise<string | null>;
  compare: (repository: string, oldHead: string, newHead: string) => Promise<readonly string[]>;
  preflight: (spec: ContainedMissionSpec, permit: ContainedPublicationPermit) => Promise<void>;
  checkEnabled: boolean;
  /** Required for a release. Read the current authority and live switch inside the W13 release transaction. */
  fenceAuthority?: () => GrantLiveContext & { enabled: boolean };
  /** Host cancellation for remote facts that invalidate the in-flight child. */
  cancelChild: (missionId: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}
export interface RevisionPublicationInput {
  mission: ContainedMission; spec: ContainedMissionSpec; permit: ContainedPublicationPermit;
  beforeRemoteMutation: (kind: 'push') => void; signal: AbortSignal;
}
export interface RevisionPublicationResult extends ContainedPublicationResult {
  intent_id: string; op_id: string; push_range: readonly string[]; range_sha256: string;
}
/** 5-D attaches this to ContainedMissionPorts and selects it for a revision spec. */
export interface RevisionPublicationPort {
  publishRevision: (input: RevisionPublicationInput) => Promise<RevisionPublicationResult>;
  confirm: (input: ConfirmRevisionInput) => ContainedMission;
  reconcileReceipt: (intentId: string, reason: 'pr_closed' | 'pr_merged' | 'base_changed' | 'route_changed') => void;
  publishCheck: (childId: string, send: (mission: ContainedMission) => Promise<{ check_run_id: number; created: boolean }>) => Promise<{ check_run_id: number; created: boolean; skipped?: true }>;
}

/** Synchronous W13 release fence. Missing authority is a refusal, including in direct port calls. */
export function assertRevisionPublishable(deps: RevisionPublicationDeps, input: RevisionPublicationInput, intentId: string): void {
  const fail = (code: string): never => { throw Error(`CONTAINED_REVISION_FENCE:${code}`); };
  try { deps.chains.attention.assertOwner(deps.chains.owner); } catch { fail('stale_owner'); }
  const target = input.spec.publish_target;
  if (!target) fail('chain_state');
  const chain = deps.chains.get(target!.chain_id);
  if (chain.mode !== 'live' || chain.state !== 'publishing') fail('chain_state');
  if (chain.current_mission_id !== input.mission.mission_id) fail('not_current_child');
  const intent = deps.chains.getIntent(intentId);
  if (intent.kind !== 'push' || intent.state !== 'pending' || intent.chain_id !== chain.chain_id || intent.child_mission_id !== input.mission.mission_id
    || intent.new_head !== input.permit.head || chain.published_head !== intent.expected_old_head || chain.published_base !== intent.expected_base_sha
    || chain.branch !== intent.branch) fail('intent_moved');
  const child = deps.missions.get(input.mission.mission_id);
  const reservation = deps.chains.reservations(chain.chain_id).find(r => r.head_sha === intent.expected_old_head);
  if (child.state === 'cancel_requested' || child.state === 'cancelled') fail('child_cancelled');
  if (child.state !== 'delivering' || child.revision !== input.permit.revision || child.stop_obligation !== 0 || child.candidate_verified !== 1
    || child.candidate_head !== input.permit.head || deps.missions.claim(child.mission_id).state !== 'active') fail('chain_state');
  if (reservation?.state !== 'dispatched' || reservation.child_mission_id !== child.mission_id) fail('intent_moved');
  let authority: ReturnType<NonNullable<RevisionPublicationDeps['fenceAuthority']>> | undefined;
  try { authority = deps.fenceAuthority?.(); } catch { fail('grant_invalid'); }
  if (!authority?.enabled) fail('bridge_live_disabled');
  try { assertGrantLive(chain, { ...authority!, now: deps.now() }); } catch (error) {
    const code = error instanceof Error ? error.message : 'grant_invalid';
    fail(code === 'grant_expired' || code === 'budget_exhausted' ? code : 'grant_invalid');
  }
}
export function createRevisionPublicationPort(deps: RevisionPublicationDeps): RevisionPublicationPort {
  const checkDeliveries = new Map<string, ReturnType<RevisionPublicationPort['publishCheck']>>();
  return {
    publishRevision: input => publishRevision(deps, input),
    confirm: input => confirmRevisionPublication(deps, input),
    reconcileReceipt: (intentId, reason) => reconcileReceipt(deps, intentId, reason),
    publishCheck: (childId, send) => {
      const pending = checkDeliveries.get(childId);
      if (pending) return pending;
      // One sender owns the pending intent until its terminal settlement finishes.
      const delivery = Promise.resolve().then(() => publishRevisionCheck(deps, childId, send))
        .finally(() => { checkDeliveries.delete(childId); });
      checkDeliveries.set(childId, delivery);
      return delivery;
    },
  };
}

/** Step 7: deliver App B's check after confirmation; a failed check never rolls the confirmed push back. */
export async function publishRevisionCheck(deps: Pick<RevisionPublicationDeps, 'chains' | 'missions' | 'now'>, childId: string,
  send: (mission: ContainedMission) => Promise<{ check_run_id: number; created: boolean }>): Promise<{ check_run_id: number; created: boolean; skipped?: true }> {
  const mission = deps.missions.get(childId);
  if (mission.state !== 'pr_opened' || !mission.candidate_head) throw Error('CONTAINED_REVISION_CHECK_NOT_OPENED');
  const target = (JSON.parse(mission.spec_json) as ContainedMissionSpec).publish_target;
  if (!target) throw Error('CONTAINED_REVISION_CHAIN_MISSING');
  const chain = deps.chains.get(target.chain_id);
  const push = deps.chains.intents(chain.chain_id).find(i => i.kind === 'push' && i.state === 'confirmed'
    && i.child_mission_id === childId && i.new_head === mission.candidate_head);
  if (chain.mode !== 'live' || !push) throw Error('CONTAINED_REVISION_CHAIN_MISSING');
  const existing = deps.chains.intents(chain.chain_id).filter(i => i.kind === 'check' && i.child_mission_id === childId && i.new_head === mission.candidate_head).at(-1);
  if (chain.state === 'closed') {
    if (existing?.state === 'pending' || existing?.state === 'uncertain') deps.chains.settleIntent(existing.intent_id, 'failed', deps.now(), 'chain_closed');
    deps.chains.appendEvent(chain.chain_id, 'check_skipped', { child: childId, reason: 'chain_closed', push_intent_id: push.intent_id }, deps.now());
    return { check_run_id: 0, created: false, skipped: true };
  }
  if (existing?.state === 'confirmed') return { check_run_id: Number(existing.detail ?? 0), created: false };
  if (existing?.state === 'uncertain') throw Error('CONTAINED_REVISION_CHECK_UNCERTAIN');
  const intent = existing?.state === 'pending' ? existing : deps.chains.recordCheckIntent(chain.chain_id, childId, mission.candidate_head, deps.now());
  let result: { check_run_id: number; created: boolean };
  try { result = await send(mission); } catch (error) {
    deps.chains.settleIntent(intent.intent_id, 'failed', deps.now(), codeOf(error));
    throw error;
  }
  deps.chains.settleIntent(intent.intent_id, 'confirmed', deps.now(), String(result.check_run_id));
  return result;
}
export type ConfirmFaultStep = 'settle' | 'deadline' | 'void' | 'evidence' | 'pr_opened' | 'check_intent' | 'event';
export interface ConfirmRevisionInput {
  chain_id: string; intent_id: string; child_mission_id: string; permit_revision: number;
  evidence: Record<string, unknown>; pr: { number: number; url: string; reused: true }; range_sha256: string;
  variant?: 'normal' | 'cancelled'; fault?: (step: ConfirmFaultStep) => void;
}

const digest = (items: readonly string[]) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const codeOf = (error: unknown) => error instanceof Error ? error.message : 'unknown';
// Best effort: the note itself may fail (e.g. stale_owner during a handover); it must never
// escape as an unhandled rejection from the fire-and-forget cancellation path.
function recordCancelFailure(deps: RevisionPublicationDeps, chainId: string, childId: string, error: unknown): void {
  try {
    deps.chains.appendEvent(chainId, 'child_cancel_failed', { child: childId,
      code: (error instanceof Error ? error.message.split(':')[0] ?? 'error' : 'error').slice(0, 64) }, deps.now());
  } catch { /* the chain stop is already committed; the missing note is visible as no child_cancelled event */ }
}

function uncertainPublication(deps: RevisionPublicationDeps, intentId: string, childId: string, detail: string): void {
  deps.chains.transaction(() => {
    deps.chains.settleIntent(intentId, 'uncertain', deps.now(), detail);
    const child = deps.missions.get(childId);
    if (child.state === 'delivering') deps.missions.transition(childId, { if_revision: child.revision, to: 'awaiting_decision',
      event: { kind: 'halted', payload: { reason: `publication_failed:${detail}` } } }, deps.now());
  });
}

/** A released push without stop proof may still run. Keep the chain and child stops atomic. */
function unprovenPublication(deps: RevisionPublicationDeps, chainId: string, childId: string, opId: string): void {
  deps.chains.transaction(() => {
    const chain = deps.chains.get(chainId);
    if (chain.state !== 'closed' && chain.state !== 'awaiting_decision') deps.chains.stopLive(chainId, chain.revision, 'intent_uncertain', deps.now());
    const child = deps.missions.get(childId);
    if (child.state === 'delivering') deps.missions.transition(childId, { if_revision: child.revision, to: 'stop_unknown',
      event: { kind: 'halted', payload: { reason: `host_process_unproven:${opId}`, op_id: opId, route: 'delivering', prior_obligation: child.stop_obligation } } }, deps.now());
  });
}

/** D4: preserve the particular stop reason before settling a failed push. All three ledgers share one transaction. */
export function refuseRevisionPublication(deps: Pick<RevisionPublicationDeps, 'chains' | 'missions' | 'now'>,
  chainId: string, childId: string, intentId: string | undefined, code: RevisionRefusalCode): void {
  deps.chains.transaction(() => {
    let chain = deps.chains.get(chainId);
    if (chain.state !== 'closed' && chain.state !== 'awaiting_decision') {
      if (code === 'pr_closed' || code === 'pr_merged') chain = deps.chains.closeLive(chainId, chain.revision, code, deps.now());
      else {
        const reason = ['base_changed', 'external_write', 'head_regressed', 'grant_expired', 'grant_invalid', 'budget_exhausted', 'child_cancelled'].includes(code) ? code : `publish_refused:${code}`;
        chain = deps.chains.stopLive(chainId, chain.revision, reason, deps.now());
      }
    }
    if (intentId !== undefined && deps.chains.getIntent(intentId).state === 'pending') deps.chains.settleIntent(intentId, 'failed', deps.now(), code);
    const child = deps.missions.get(childId);
    if (child.state === 'delivering') deps.missions.transition(childId, { if_revision: child.revision, to: 'awaiting_decision',
      event: { kind: 'halted', payload: { reason: `publication_failed:${code}` } } }, deps.now());
  });
}

function assertConfirmRoute(deps: RevisionPublicationDeps, input: ConfirmRevisionInput): PublicationIntent {
  const intent = deps.chains.getIntent(input.intent_id);
  const chain = deps.chains.get(input.chain_id);
  const child = deps.missions.get(input.child_mission_id);
  const row = deps.host.recordForIntent(input.intent_id);
  const reservation = deps.chains.reservations(input.chain_id).find(r => r.head_sha === intent.expected_old_head);
  if (intent.state !== 'pending' || intent.kind !== 'push' || intent.chain_id !== input.chain_id || intent.child_mission_id !== input.child_mission_id
    || row?.state !== 'stopped' || row.released_at === null || row.mission_id !== input.child_mission_id
    || chain.state !== 'publishing' || chain.current_mission_id !== input.child_mission_id || chain.published_head !== intent.expected_old_head
    || chain.published_base !== intent.expected_base_sha || chain.branch !== intent.branch
    || child.candidate_head !== intent.new_head || child.state !== (input.variant === 'cancelled' ? 'cancel_requested' : 'delivering')
    || (input.variant !== 'cancelled' && child.revision !== input.permit_revision)
    || reservation?.state !== 'dispatched' || reservation.child_mission_id !== input.child_mission_id) throw Error('confirm_route_changed');
  return intent;
}

/** D10. Call only after the W13 stopped row committed and read-back passed. A throw rolls every ledger write back. */
export function confirmRevisionPublication(deps: RevisionPublicationDeps, input: ConfirmRevisionInput): ContainedMission {
  return deps.chains.transaction(() => {
    const intent = assertConfirmRoute(deps, input);
    const fault = (step: ConfirmFaultStep) => input.fault?.(step);
    let chain = deps.chains.settleIntent(input.intent_id, 'confirmed', deps.now()).chain; fault('settle');
    const grant = parseStoredGrant(chain.grant_json);
    chain = deps.chains.resetReviewDeadline(chain.chain_id, chain.revision, deps.now() + grant.review_deadline_ms, deps.now()); fault('deadline');
    chain = deps.chains.voidReservation(chain.chain_id, chain.revision, intent.expected_old_head!, 'published', deps.now()).chain; fault('void');
    deps.missions.record(input.child_mission_id, 'delivery_evidence', { ...input.evidence, intent_id: input.intent_id, range_sha256: input.range_sha256 }, deps.now()); fault('evidence');
    const child = deps.missions.get(input.child_mission_id);
    const cancelled = input.variant === 'cancelled';
    const opened = deps.missions.transition(child.mission_id, { if_revision: child.revision, to: cancelled ? 'cancelled' : 'pr_opened',
      event: cancelled ? { kind: 'revision_pushed_before_cancel', payload: { intent_id: input.intent_id } }
        : { kind: 'pr_opened', payload: { pr: input.pr, evidence_digest: input.evidence.evidence_digest, intent_id: input.intent_id } } }, deps.now()); fault('pr_opened');
    if (cancelled) { deps.chains.stopLive(chain.chain_id, chain.revision, 'child_cancelled', deps.now()); }
    else if (deps.checkEnabled) { deps.chains.recordCheckIntent(chain.chain_id, child.mission_id, intent.new_head!, deps.now()); fault('check_intent'); }
    deps.chains.appendEvent(chain.chain_id, 'round_published', { intent_id: input.intent_id, child: child.mission_id, head: intent.new_head, range_sha256: input.range_sha256 }, deps.now()); fault('event');
    return opened;
  });
}

/** Recovery/confirm-only entry. Its caller must supply fresh read-back evidence; this function never issues a push. */
export function reconcileReceipt(deps: RevisionPublicationDeps, input: ConfirmRevisionInput): ContainedMission;
export function reconcileReceipt(deps: RevisionPublicationDeps, intentId: string, reason: 'pr_closed' | 'pr_merged' | 'base_changed' | 'route_changed'): void;
export function reconcileReceipt(deps: RevisionPublicationDeps, inputOrIntent: ConfirmRevisionInput | string,
  reason?: 'pr_closed' | 'pr_merged' | 'base_changed' | 'route_changed'): ContainedMission | undefined {
  if (typeof inputOrIntent !== 'string') {
    try { return confirmRevisionPublication(deps, inputOrIntent); }
    catch (error) {
      if (codeOf(error) !== 'confirm_route_changed') throw error;
      const row = deps.host.recordForIntent(inputOrIntent.intent_id);
      if (row?.state !== 'stopped' || row.released_at === null) throw error;
      refuseRevisionPublicationAfterPush(deps, deps.chains.getIntent(inputOrIntent.intent_id), 'route_changed');
      return deps.missions.get(inputOrIntent.child_mission_id);
    }
  }
  if (!reason) throw Error('CONTAINED_REVISION_RECEIPT_REASON_REQUIRED');
  refuseRevisionPublicationAfterPush(deps, deps.chains.getIntent(inputOrIntent), reason);
  return undefined;
}

function refuseRevisionPublicationAfterPush(deps: RevisionPublicationDeps, intent: PublicationIntent, reason: 'pr_closed' | 'pr_merged' | 'base_changed' | 'route_changed'): void {
  deps.chains.transaction(() => {
    const chain = deps.chains.get(intent.chain_id);
    if (reason !== 'route_changed' && chain.state !== 'closed' && chain.state !== 'awaiting_decision') {
      if (reason === 'base_changed') deps.chains.stopLive(chain.chain_id, chain.revision, reason, deps.now());
      else deps.chains.closeLive(chain.chain_id, chain.revision, reason, deps.now());
    }
    if (reason === 'route_changed' && chain.state !== 'closed' && chain.state !== 'awaiting_decision') {
      deps.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', deps.now());
    }
    const child = deps.missions.get(intent.child_mission_id!);
    if (child.state === 'delivering') deps.missions.transition(child.mission_id, { if_revision: child.revision, to: 'awaiting_decision',
      event: { kind: 'halted', payload: { reason: reason === 'route_changed' ? 'publication_failed:route_changed' : 'publication_failed:pr_changed_after_push' } } }, deps.now());
    if (intent.state === 'pending') deps.chains.settleIntent(intent.intent_id, 'confirmed', deps.now());
  });
}

/** One lease push. Pending/uncertain receipts are routed to reconciliation; this function never retries them. */
export async function publishRevision(deps: RevisionPublicationDeps, input: RevisionPublicationInput): Promise<RevisionPublicationResult> {
  const { mission, spec, permit, signal } = input;
  const target = spec.publish_target; const publication = spec.publication;
  if (!target || !publication) throw Error('CONTAINED_REVISION_TARGET_REQUIRED');
  const chainId = target.chain_id;
  const chain = deps.chains.get(chainId);
  const previous = deps.chains.intents(chainId).filter(i => i.kind === 'push' && i.child_mission_id === mission.mission_id).at(-1);
  if (previous && previous.state !== 'failed') throw Error(`CONTAINED_REVISION_RECEIPT_${previous.state.toUpperCase()}`);
  const reject = (code: RevisionRefusalCode, intentId?: string): never => {
    refuseRevisionPublication(deps, chainId, mission.mission_id, intentId, code);
    if (['pr_closed', 'pr_merged', 'pr_head_ref_changed', 'base_changed', 'external_write', 'head_regressed'].includes(code)) {
      void Promise.resolve().then(() => deps.cancelChild(mission.mission_id))
        .catch(error => recordCancelFailure(deps, chainId, mission.mission_id, error));
    }
    throw Error(`CONTAINED_REVISION_REFUSED:${code}`);
  };
  if (publication.repository.toLowerCase() !== chain.repository.toLowerCase() || target.pr !== chain.pr_number || target.remote_branch !== chain.branch) reject('intent_binding_mismatch');
  if (spec.start_commit !== chain.published_head) reject('start_mismatch');
  try { await deps.preflight(spec, permit); } catch (error) {
    const code = codeOf(error);
    reject(code === 'local_head_mismatch' || code === 'push_url_invalid' || code === 'transport_unsupported' || code === 'repo_config_changed'
      ? code : 'repo_config_changed');
  }
  const old = chain.published_head;
  let rangeResult!: Awaited<ReturnType<RevisionPublicationDeps['localGit']>>;
  try { rangeResult = await deps.localGit(spec.worktree_path, ['rev-list', '--reverse', `${old}..${permit.head}`]); }
  catch { reject('not_descendant'); }
  const commits = rangeResult.exitCode === 0 ? rangeResult.stdout.trim().split('\n').filter(Boolean) : [];
  if (commits.length > 64) reject('range_too_large');
  if (commits.length === 0 || commits.some(c => !SHA.test(c))) reject('not_descendant');
  let ancestor!: Awaited<ReturnType<RevisionPublicationDeps['localGit']>>;
  try { ancestor = await deps.localGit(spec.worktree_path, ['merge-base', '--is-ancestor', old, permit.head]); }
  catch { reject('not_descendant'); }
  if (ancestor.exitCode !== 0) reject('not_descendant');
  let pr!: RevisionPrFacts;
  try { pr = await deps.readPr(chain.repository, chain.pr_number); } catch { throw Error('CONTAINED_REVISION_PREFLIGHT_RETRYABLE:pr_read'); }
  if (pr.state !== 'OPEN') reject(pr.state === 'MERGED' ? 'pr_merged' : 'pr_closed');
  if (pr.repository.toLowerCase() !== chain.repository.toLowerCase() || pr.headRefName !== chain.branch) reject('pr_head_ref_changed');
  if (pr.baseRefName !== chain.base_ref || pr.baseRefOid !== chain.published_base) reject('base_changed');
  let beforeRemote!: string | null;
  try { beforeRemote = await deps.remoteHead(spec.worktree_path, publication.remote, chain.branch); }
  catch { throw Error('CONTAINED_REVISION_PREFLIGHT_RETRYABLE:remote_head'); }
  if (pr.headRefOid !== old || beforeRemote !== old) {
    const moved = pr.headRefOid !== old ? pr.headRefOid : beforeRemote;
    let descendant: Awaited<ReturnType<RevisionPublicationDeps['localGit']>> | undefined;
    if (moved && SHA.test(moved)) {
      try { descendant = await deps.localGit(spec.worktree_path, ['merge-base', '--is-ancestor', old, moved]); }
      catch { throw Error('CONTAINED_REVISION_PREFLIGHT_RETRYABLE:merge_base'); }
    }
    reject(descendant?.exitCode === 0 ? 'external_write' : 'head_regressed');
  }
  let intentId = '';
  try {
    deps.chains.transaction(() => {
      const recorded = deps.chains.recordIntent(chainId, deps.chains.get(chainId).revision, { kind: 'push', branch: chain.branch,
        expected_old_head: old, new_head: permit.head, expected_base_sha: chain.published_base, child_mission_id: mission.mission_id,
        binding: { repository: chain.repository, pr: chain.pr_number, head_repository: chain.repository, remote_branch: chain.branch,
          local_branch: spec.branch, expected_base_ref: chain.base_ref, child_revision: permit.revision, spec_digest: permit.spec_digest,
          commit_count: commits.length, range_sha256: digest(commits) } }, deps.now());
      intentId = recorded.intent.intent_id;
      deps.chains.appendEvent(chainId, 'push_range', { intent_id: intentId, commits }, deps.now());
    });
  } catch (error) { reject(codeOf(error) === 'grant_expired' ? 'grant_expired' : 'intent_binding_mismatch'); }
  const runner = fencedDeliveryRunner(deps.runner, kind => { if (kind !== 'push') throw Error('CONTAINED_REVISION_PR_CREATE_DENIED'); input.beforeRemoteMutation(kind); assertRevisionPublishable(deps, input, intentId); },
    { remote: publication.remote, repository: chain.repository, missionId: mission.mission_id, httpsOnly: true });
  const ref = `refs/heads/${chain.branch}`;
  let push: Awaited<ReturnType<DeliveryCommandRunner['run']>>;
  try { push = await runner.run('git', ['push', '--porcelain', `--force-with-lease=${ref}:${old}`, publication.remote, `${permit.head}:${ref}`],
    { cwd: spec.worktree_path, timeoutMs: 60_000, signal, intentId }); }
  catch (error) {
    const row = deps.host.recordForIntent(intentId);
    if (!row || row.released_at === null) {
      const code = codeOf(error);
      const fence = /^CONTAINED_REVISION_FENCE:([a-z_]+)$/.exec(code)?.[1];
      if (fence === 'stale_owner' || code === 'stale_owner') throw error;
      reject(code === 'CONTAINED_REMOTE_BRANCH_BUSY' ? 'push_in_flight' : code === 'CONTAINED_BRIDGE_TRANSPORT_UNSUPPORTED' ? 'transport_unsupported'
        : fence === 'grant_expired' ? 'grant_expired' : fence === 'base_changed' ? 'base_changed'
          : fence === 'grant_invalid' ? 'grant_invalid' : fence === 'budget_exhausted' ? 'budget_exhausted' : fence === 'child_cancelled' ? 'child_cancelled'
          : fence === 'external_write' ? 'external_write' : fence === 'head_regressed' ? 'head_regressed'
            : fence === 'bridge_live_disabled' ? 'bridge_live_disabled'
          : fence === 'intent_moved' ? 'fence_intent_moved' : fence === 'not_current_child' ? 'fence_not_current_child'
            : code.includes('TOKEN') ? 'token_unavailable' : code.includes('FENCE') ? 'fence_chain_state' : 'push_url_invalid', intentId);
    }
    if (!row) throw error;
    if (row.state !== 'stopped') {
      unprovenPublication(deps, chainId, mission.mission_id, row.op_id);
      throw error;
    }
    uncertainPublication(deps, intentId, mission.mission_id, 'push_uncertain');
    throw error;
  }
  const row = deps.host.recordForIntent(intentId);
  if (!row || row.op_id !== push.opId || row.state !== 'stopped' || row.released_at === null) {
    unprovenPublication(deps, chainId, mission.mission_id, row?.op_id ?? push.opId ?? 'unknown');
    throw Error('CONTAINED_REVISION_STOP_UNPROVEN');
  }
  let remote: string | null;
  // After intent creation, a read failure cannot prove whether the push landed. Keep the fail-safe uncertain receipt for recovery.
  try { remote = await deps.remoteHead(spec.worktree_path, publication.remote, chain.branch); }
  catch { uncertainPublication(deps, intentId, mission.mission_id, 'readback_mismatch'); throw Error('CONTAINED_REVISION_READBACK_MISMATCH'); }
  if (push.exitCode !== 0 && remote === old) reject('push_rejected', intentId);
  if (push.exitCode !== 0 && remote !== old && remote !== permit.head) {
    uncertainPublication(deps, intentId, mission.mission_id, 'readback_mismatch');
    throw Error('CONTAINED_REVISION_READBACK_MISMATCH');
  }
  if (remote !== permit.head) {
    uncertainPublication(deps, intentId, mission.mission_id, 'readback_mismatch');
    throw Error('CONTAINED_REVISION_READBACK_MISMATCH');
  }
  // PR and compare reads below also happen after the intent exists; failures remain uncertain until reconciliation.
  let readback = pr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { readback = await deps.readPr(chain.repository, chain.pr_number); }
    catch { uncertainPublication(deps, intentId, mission.mission_id, 'readback_mismatch'); throw Error('CONTAINED_REVISION_READBACK_MISMATCH'); }
    if (readback.headRefOid === permit.head || readback.state !== 'OPEN') break;
    if (attempt < 4) await (deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(2_000);
  }
  let compared: readonly string[];
  try { compared = await deps.compare(chain.repository, old, permit.head); }
  catch { uncertainPublication(deps, intentId, mission.mission_id, 'readback_mismatch'); throw Error('CONTAINED_REVISION_READBACK_MISMATCH'); }
  if (digest(compared) !== digest(commits) || (readback.state === 'OPEN' && readback.headRefOid !== permit.head)) {
    uncertainPublication(deps, intentId, mission.mission_id, 'readback_mismatch');
    throw Error('CONTAINED_REVISION_READBACK_MISMATCH');
  }
  if (readback.state !== 'OPEN' || readback.baseRefName !== chain.base_ref || readback.baseRefOid !== chain.published_base) {
    const reason = readback.state === 'MERGED' ? 'pr_merged' : readback.state === 'CLOSED' ? 'pr_closed' : 'base_changed';
    reconcileReceipt(deps, intentId, reason);
    try { await deps.cancelChild(mission.mission_id); } catch (error) { recordCancelFailure(deps, chainId, mission.mission_id, error); }
    throw Error('CONTAINED_REVISION_PR_CHANGED_AFTER_PUSH');
  }
  return { pushed_commit: permit.head, pr: { number: chain.pr_number, url: readback.url, reused: true }, base_head: chain.published_base,
    stop_proof_scope: 'app_isolated', intent_id: intentId, op_id: row.op_id, push_range: commits, range_sha256: digest(commits) };
}
