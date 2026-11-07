// Revision child Missions for the Grok bridge (phase 5-B, appendix §5.2): the child spec, the untrusted review-feedback text, the
// single-transaction reserve -> create -> dispatch, per-launch budget charging, and claim release. Lazy-imported only.
//
// Nothing here can publish: a child that reaches `delivering` stops (`ports.publish` refuses `publish_target`, and the runner halts
// before calling it). The revision publisher is phase 5-C.
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  RevisionChainError, RevisionGrantError, SAME_CHILD_RESUMABLE, combineFeedbackDigests, decideChainStep, parseStoredGrant, reduceReviewers, scratchPath,
  type ChainDecision, type ChainView, type ContainedMissionStore, type PrSnapshot, type ProducerRegistry, type RevisionChain, type RevisionChainStore, type RevisionGrant,
} from '@osstack/core';
import { redactSecrets } from '@osstack/governance';
import { normalizeSnapshot, reviewFeedbackOf, type PullRequestRead, type PullRequestRef } from './contained-mission-bridge-reader.js';
import { assertGrantLive, enforceGrantLive, type IssuerKey } from './contained-mission-grant.js';
import { validateContainedStart } from './contained-mission-host.js';
import { containedEvents, eventPayload } from './contained-mission-ports.js';
import {
  RevisionLaunchRefused, parseContainedMissionSpec, type ContainedLaunchKind, type ContainedMissionSpec, type ContainedRevisionPort,
} from './contained-mission-runner.js';
import type { EngineeringAccess } from './engineering-access.js';

// ------------------------------------------------------------------ feedback text

const MAX_TEXT = 16_384;
const MAX_COMMENT = 2_000;
/** `mission` rows are capped at 32 KiB of JSON; the feedback text only gets what the rest of the spec leaves. */
const MAX_SPEC_JSON = 30_000;
// Control characters other than newline, and invisible format characters (bidi overrides, zero-width), never reach the prompt or the ledger.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}]/gu;
const escapedLength = (text: string): number => JSON.stringify(text).length - 2;

export interface ReviewFeedbackPiece { review_id: number; top_level: string; comments: ReadonlyArray<{ threadId: string; databaseId: number; body: string }> }

/** Reviewer text -> one bounded, redacted string. The delimiter word is neutralised everywhere, so no reviewer text can close the prompt block, whatever its nonce. */
export function renderFeedbackText(pieces: readonly ReviewFeedbackPiece[], limit: number = MAX_TEXT): string {
  const clean = (value: string, max: number): string => {
    const text = redactSecrets(value).replace(UNSAFE, '').replace(/REVIEW-FEEDBACK/gi, 'REVIEW_FEEDBACK');
    return text.length > max ? `${text.slice(0, max)} [truncated]` : text;
  };
  const lines: string[] = [];
  for (const piece of pieces) {
    lines.push(`Review ${piece.review_id}:`);
    if (piece.top_level) lines.push(clean(piece.top_level, MAX_TEXT));
    for (const c of piece.comments) lines.push(`- thread ${clean(c.threadId, 80)} comment ${c.databaseId}: ${clean(c.body, MAX_COMMENT)}`);
  }
  let text = lines.join('\n');
  const room = Math.max(0, Math.min(MAX_TEXT, limit));
  if (text.length <= room && escapedLength(text) <= room) return text;
  const note = '\n[truncated]';
  // Cut on the escaped length: quotes and backslashes double in the JSON the ledger stores.
  let cut = Math.min(text.length, room);
  while (cut > 0 && escapedLength(text.slice(0, cut)) + note.length > room) cut = Math.floor(cut * 0.9);
  text = `${text.slice(0, cut)}${note}`;
  return text;
}

// ------------------------------------------------------------------ child spec

/** The tier the root Mission's published candidate had: T1 only if its last `candidate_committed` says so; anything else is the strict T0. */
export function rootTierOf(missions: ContainedMissionStore, rootMissionId: string): 'T0' | 'T1' {
  const committed = containedEvents(missions, rootMissionId).filter(e => e.kind === 'candidate_committed').at(-1);
  return committed && eventPayload(committed).tier === 'T1' ? 'T1' : 'T0';
}

export interface RevisionChildInput {
  chain: Pick<RevisionChain, 'chain_id' | 'pr_number' | 'branch' | 'repository' | 'base_ref' | 'published_head' | 'rounds_used'>;
  feedback: { review_ids: readonly number[]; feedback_digest: string; text: string };
  /** 12 random hex chars for the branch and worktree name; 32 hex chars for the prompt delimiter. */
  ids: { id: string; nonce: string };
  /** The tier the root's candidate was published at (`rootTierOf`). */
  rootTier: 'T0' | 'T1';
  worktreesRoot?: string;
}

/** The child's spec, field by field from the root Mission (appendix §5.2 table). Nothing the reviewer wrote reaches any field but `revision_feedback.text`. */
export function buildRevisionChildSpec(root: ContainedMissionSpec, input: RevisionChildInput): ContainedMissionSpec {
  const { chain, feedback, ids, rootTier } = input;
  const p = root.publication;
  if (!p || p.repository.toLowerCase() !== chain.repository.toLowerCase() || p.base !== chain.base_ref) throw Error('CONTAINED_SPEC_INVALID');
  if (!/^[0-9a-f]{12}$/.test(ids.id) || !/^[0-9a-f]{32}$/.test(ids.nonce)) throw Error('CONTAINED_SPEC_INVALID');
  const round = chain.rounds_used + 1;
  if (round !== 1 && round !== 2) throw Error('CONTAINED_SPEC_INVALID');
  const worktrees = resolve(input.worktreesRoot ?? scratchPath('worktrees'));
  const base: ContainedMissionSpec = {
    goal: root.goal, repo_path: root.repo_path, base_ref: root.base_ref, start_commit: chain.published_head,
    branch: `osstack/mission/${ids.id}`, worktree_path: join(worktrees, `mission-${ids.id}`),
    allowed_paths: [...root.allowed_paths],
    ...(root.caps ? { caps: { ...root.caps } } : {}),
    verify: { argv: [...root.verify.argv] },
    ...(root.max_repair_cycles !== undefined ? { max_repair_cycles: root.max_repair_cycles } : {}),
    ...(root.verification_paths ? { verification_paths: [...root.verification_paths] } : {}),
    publication: { remote: p.remote, repository: p.repository, base: p.base, draft: p.draft, ...(p.title !== undefined ? { title: p.title } : {}), preauthorized: true },
    publish_target: { kind: 'revision', chain_id: chain.chain_id, pr: chain.pr_number, remote_branch: chain.branch, round, chain_start_commit: root.start_commit, root_tier: rootTier },
  };
  const withText = (text: string): ContainedMissionSpec => ({ ...base, revision_feedback: { review_ids: [...feedback.review_ids], feedback_digest: feedback.feedback_digest, nonce: ids.nonce, text } });
  const room = MAX_SPEC_JSON - JSON.stringify(withText('')).length;
  if (room < 1_024) throw Error('CONTAINED_SPEC_INVALID');
  // The text arrives already rendered; re-bound it to what this spec can carry.
  const text = feedback.text.length <= room && escapedLength(feedback.text) <= room ? feedback.text : renderFeedbackText([{ review_id: 0, top_level: feedback.text, comments: [] }], room);
  const spec = withText(text);
  parseContainedMissionSpec(JSON.stringify(spec));
  return spec;
}

// ------------------------------------------------------------------ budget gate for the runner

export interface RevisionLaunchDeps {
  chains: RevisionChainStore;
  missions: ContainedMissionStore;
  access: Pick<EngineeringAccess, 'refresh'>;
  /** Synchronous view of the trusted issuer keys. The caller decides how fresh it is. */
  keys: () => ReadonlyMap<string, IssuerKey>;
  now: () => number;
  /** What one launch is charged: the Codex proxy's turn timeout and the verification container's own cap (both enforced elsewhere). */
  launchCaps: { executor_seconds: number; verify_seconds: number };
  enabled?: () => boolean;
}
const IN_FLIGHT = new Set(['revising', 'publishing']);

export function createRevisionLaunchPort(deps: RevisionLaunchDeps): ContainedRevisionPort {
  const seconds = (kind: ContainedLaunchKind) => (kind === 'executor' ? deps.launchCaps.executor_seconds : deps.launchCaps.verify_seconds);
  const chainOf = (mission: { mission_id: string }, spec: ContainedMissionSpec): RevisionChain => {
    const target = spec.publish_target;
    if (!target) throw new RevisionLaunchRefused('not_revision_child');
    let chain: RevisionChain;
    try { chain = deps.chains.get(target.chain_id); } catch { throw new RevisionLaunchRefused('chain_missing'); }
    if (chain.mode !== 'live' || chain.current_mission_id !== mission.mission_id) throw new RevisionLaunchRefused('not_current_child');
    if (chain.state === 'closed') throw new RevisionLaunchRefused('chain_closed');
    // A stopped chain keeps its stop reason; a child resumed by a human does not restart the chain by itself (only a re-grant does).
    if (chain.state === 'awaiting_decision') throw new RevisionLaunchRefused(chain.stop_reason ?? 'stopped');
    if (!IN_FLIGHT.has(chain.state)) throw new RevisionLaunchRefused(`state_${chain.state}`);
    return chain;
  };
  /** `enforce` stops the chain on failure (a real launch); a resume check only looks. */
  const live = (chain: RevisionChain, enforce: boolean): RevisionGrant => {
    const ctx = { access: deps.access, keys: deps.keys(), now: deps.now() };
    try { return enforce ? enforceGrantLive(deps.chains, chain, ctx) : assertGrantLive(chain, ctx); }
    catch (error) { throw new RevisionLaunchRefused(error instanceof RevisionGrantError ? error.code : 'grant_invalid'); }
  };
  return {
    chargeLaunch(mission, spec, kind) {
      const chain = chainOf(mission, spec);
      live(chain, true);
      const charge = seconds(kind);
      try { deps.chains.chargeLaunch(chain.chain_id, mission.mission_id, kind === 'executor' ? 'executor' : 'container', charge, deps.now()); }
      catch (error) {
        if (error instanceof RevisionChainError && error.code === 'budget_exhausted') {
          try { const fresh = deps.chains.get(chain.chain_id); deps.chains.stopLive(fresh.chain_id, fresh.revision, 'budget_exhausted', deps.now()); } catch { /* already stopped or moved on */ }
          throw new RevisionLaunchRefused('budget_exhausted');
        }
        throw new RevisionLaunchRefused(error instanceof RevisionChainError ? error.code : 'charge_failed');
      }
      return {
        settle(elapsedMs) {
          const back = charge - Math.min(charge, Math.max(0, Math.ceil(elapsedMs / 1000)));
          if (back > 0) deps.chains.refundLaunch(chain.chain_id, mission.mission_id, kind === 'executor' ? 'executor' : 'container', back, deps.now());
        },
      };
    },
    assertActive(mission, spec) {
      live(chainOf(mission, spec), false);
    },
    assertResumable(mission, spec, _kind, blocked) {
      const chain = chainOf(mission, spec);
      live(chain, false);
      const slice = deps.chains.allocations(chain.chain_id)[mission.mission_id];
      if (!slice) throw new RevisionLaunchRefused('allocation_missing');
      const left = blocked === 'executor' ? slice.executor_seconds - slice.executor_used : slice.container_seconds - slice.container_used;
      if (left < seconds(blocked)) throw new RevisionLaunchRefused('budget_exhausted');
    },
    acknowledgeAdvance(mission, spec, decision) {
      const target = spec.publish_target;
      if (!target) throw new RevisionLaunchRefused('not_revision_child');
      if (!(deps.enabled?.() ?? process.env.OSSTACK_BRIDGE === '1')) throw new RevisionLaunchRefused('bridge_live_disabled');
      let chain: RevisionChain;
      try { chain = deps.chains.get(target.chain_id); } catch { throw new RevisionLaunchRefused('chain_missing'); }
      if (chain.current_mission_id !== mission.mission_id) throw new RevisionLaunchRefused('not_current_child');
      if (chain.state === 'closed') throw new RevisionLaunchRefused('chain_closed');
      if (chain.state === 'revising' || chain.state === 'publishing') return 'in_flight';
      if (chain.mode !== 'live' || chain.state !== 'awaiting_decision')
        throw new RevisionLaunchRefused(`chain_not_resumable:${chain.stop_reason ?? chain.state}`);
      const observation = deps.chains.db.prepare(
        "SELECT payload_json FROM engineering_revision_chain_events WHERE chain_id=? AND kind='stopped_chain_observed' ORDER BY seq DESC LIMIT 1"
      ).get(chain.chain_id) as { payload_json: string } | undefined;
      if (observation) {
        let facts: { pr_state?: string; head?: string; base_sha?: string; base_ref?: string };
        try { facts = JSON.parse(observation.payload_json) as typeof facts; } catch { throw new RevisionLaunchRefused('facts_changed'); }
        if (facts.pr_state !== 'OPEN' || facts.head !== chain.published_head || facts.base_sha !== chain.published_base || facts.base_ref !== chain.base_ref)
          throw new RevisionLaunchRefused('facts_changed');
      }
      const halt = containedEvents(deps.missions, mission.mission_id).filter(e => e.kind === 'halted').at(-1);
      const haltPayload = halt ? eventPayload(halt) : {};
      const landed = deps.chains.intents(chain.chain_id).filter(i => i.kind === 'push' && i.child_mission_id === mission.mission_id);
      const latest = landed.at(-1);
      if (latest?.state === 'confirmed') {
        const eligible = decision === 'approve_publication' && (chain.stop_reason === 'intent_uncertain' || SAME_CHILD_RESUMABLE.has(chain.stop_reason ?? ''))
          && mission.state === 'awaiting_decision' && typeof haltPayload.reason === 'string' && haltPayload.reason.startsWith('publication_failed:')
          && mission.candidate_head === latest.new_head && mission.stop_obligation === 0
          && latest.new_head === chain.published_head && latest.expected_base_sha === chain.published_base
          && !deps.chains.intents(chain.chain_id).some(i => i.kind === 'push' && (i.state === 'pending' || i.state === 'uncertain'))
          && deps.chains.reservations(chain.chain_id).some(r => r.child_mission_id === mission.mission_id && r.state === 'dispatched')
          && !deps.chains.db.prepare("SELECT 1 FROM engineering_host_processes WHERE mission_id=? AND state<>'stopped' LIMIT 1").get(mission.mission_id)
          && !!deps.chains.db.prepare("SELECT 1 FROM engineering_workspace_claims WHERE mission_id=? AND state='active'").get(mission.mission_id);
        if (!eligible) throw new RevisionLaunchRefused('round_landed');
        return 'landed';
      }
      if (!SAME_CHILD_RESUMABLE.has(chain.stop_reason ?? ''))
        throw new RevisionLaunchRefused(`chain_not_resumable:${chain.stop_reason ?? chain.state}`);
      const blocked = haltPayload.blocked;
      const kind: ContainedLaunchKind | undefined = decision === 'extra_repair' || decision === 'discard_changes' ? 'executor'
        : decision === 'resume_budget' || decision === 'resume_grant' ? blocked === 'verify' ? 'verify' : 'executor' : undefined;
      live(chain, false);
      if (kind) {
        const slice = deps.chains.allocations(chain.chain_id)[mission.mission_id];
        if (!slice) throw new RevisionLaunchRefused('allocation_missing');
        const left = kind === 'executor' ? slice.executor_seconds - slice.executor_used : slice.container_seconds - slice.container_used;
        if (left < seconds(kind)) throw new RevisionLaunchRefused('budget_exhausted');
      }
      try { deps.chains.resumeChild(chain.chain_id, chain.revision, { child_mission_id: mission.mission_id, expected_stop_reason: chain.stop_reason!, decision }, deps.now()); }
      catch (error) { throw new RevisionLaunchRefused(error instanceof RevisionChainError ? error.code : 'resume_failed'); }
      return 'resumed';
    },
  };
}

/** Release a finished revision child's workspace claim. The ledger's own rules apply (terminal, stop proven); this adds none and skips none. */
export function releaseRevisionChildClaim(missions: ContainedMissionStore, childMissionId: string, now: number) {
  return missions.releaseClaim(childMissionId, 'revision_settled', now);
}

// ------------------------------------------------------------------ dispatch

export type DispatchFaultStep = 'reserve' | 'authorize' | 'dispatch' | 'allocate' | 'event';
export interface DispatchRevisionDeps extends RevisionLaunchDeps {
  missions: ContainedMissionStore;
  readPr: (ref: PullRequestRef) => Promise<PullRequestRead>;
  registry: ProducerRegistry;
  /** `OSSTACK_BRIDGE=1`. */
  enabled: () => boolean;
  protectedSetDigest: () => string;
  worktreesRoot?: string;
  randomHex?: (bytes: number) => string;
  /** Test seam: runs inside the dispatch transaction after the named step; a throw there rolls everything back. */
  fault?: (step: DispatchFaultStep) => void;
}
export type DispatchOutcome =
  | { status: 'dispatched'; chain: RevisionChain; child_mission_id: string; round: number }
  | { status: 'no_reserve'; reason: string }
  | { status: 'snapshot_moved' }
  | { status: 'disabled' }
  | { status: 'conflict'; code: string }
  | { status: 'stopped'; reason: string }
  | { status: 'failed'; code: string; stopped: boolean };

/** Errors that only mean someone else moved the chain first. They are not dispatch failures and are never counted. */
const BENIGN = new Set(['version_conflict', 'chain_busy', 'head_already_reserved', 'state_denied', 'head_mismatch']);
const MAX_DISPATCH_FAILURES = 3;
const asView = (chain: RevisionChain, chains: RevisionChainStore, grant: RevisionGrant): ChainView => ({
  mode: chain.mode, state: chain.state, published_head: chain.published_head, published_base: chain.published_base, base_ref: chain.base_ref, rounds_used: chain.rounds_used,
  grant_rounds: grant.rounds, review_deadline: chain.review_deadline, reserved_heads: chains.reservations(chain.chain_id).map(r => r.head_sha),
});

/** Reserve, create the child Mission and dispatch it, atomically (appendix §5.2). All I/O (two PR reads, feedback extraction, checks) happens
 * before one `BEGIN IMMEDIATE`; inside it there are only ledger writes, so a crash leaves exactly one child with its reservation, or nothing. */
export async function dispatchRevision(deps: DispatchRevisionDeps, chainId: string, options: { firstRead?: PullRequestRead } = {}): Promise<DispatchOutcome> {
  if (!deps.enabled()) return { status: 'disabled' };
  const { chains, missions } = deps;
  const chain = chains.get(chainId);
  if (chain.mode !== 'live') return { status: 'no_reserve', reason: 'not_live' };
  if (chain.state !== 'awaiting_review' && chain.state !== 'ready_for_human') return { status: 'no_reserve', reason: `state_${chain.state}` };
  let grant: RevisionGrant;
  try { grant = parseStoredGrant(chain.grant_json); } catch { return { status: 'no_reserve', reason: 'grant_unreadable' }; }
  const ref = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(chain.repository);
  if (!ref) return { status: 'no_reserve', reason: 'repository_invalid' };
  const prRef: PullRequestRef = { owner: ref[1]!, name: ref[2]!, number: chain.pr_number };
  const decide = (read: PullRequestRead): { snapshot: PrSnapshot; decision: ChainDecision } => {
    const at = deps.now();
    const snapshot = normalizeSnapshot(read, deps.registry, at);
    const pending = chains.intents(chainId).find(i => i.kind === 'push' && i.state === 'pending')?.new_head;
    const confirmed = chains.nextConfirmedPushHead(chainId);
    return { snapshot, decision: decideChainStep(asView(chain, chains, grant), snapshot, deps.registry, at,
      { ...(confirmed ? { confirmed_push_head: confirmed } : {}), ...(pending ? { pending_push_head: pending } : {}) }) };
  };

  // Step 1: the cycle's own read and decision.
  const firstRead = options.firstRead ?? await deps.readPr(prRef);
  if (!firstRead.complete) return { status: 'no_reserve', reason: 'read_incomplete' };
  const first = decide(firstRead);
  if (first.decision.kind !== 'reserve') return { status: 'no_reserve', reason: first.decision.kind === 'none' ? first.decision.reason : first.decision.kind };

  // Step 2: a second full read, a fresh decision, and the two must agree on everything the reservation depends on.
  const secondRead = await deps.readPr(prRef);
  if (!secondRead.complete) return { status: 'snapshot_moved' };
  const second = decide(secondRead);
  const a = first.decision; const b = second.decision;
  if (b.kind !== 'reserve') return { status: 'snapshot_moved' };
  const roster = (snap: PrSnapshot) => JSON.stringify([...reduceReviewers(chain.published_head, snap.reviews, deps.registry, deps.now()).participating]
    .map(([actor, r]) => [actor, r.review.review_id, r.state]).sort((x, y) => (x[0] as number) - (y[0] as number)));
  const sameRepo = (r: PullRequestRead) => r.complete && r.pr.headRepository?.toLowerCase() === chain.repository.toLowerCase() && r.pr.headRefName === chain.branch;
  if (a.head !== b.head || a.base !== b.base || a.base_ref !== b.base_ref || a.feedback_digest !== b.feedback_digest || JSON.stringify(a.review_ids) !== JSON.stringify(b.review_ids)
    || roster(first.snapshot) !== roster(second.snapshot) || !sameRepo(firstRead) || !sameRepo(secondRead)) return { status: 'snapshot_moved' };
  const pieces = reviewFeedbackOf(secondRead.pr, b.review_ids);
  if (!pieces || combineFeedbackDigests(pieces.map(p => p.digest)) !== b.feedback_digest) return { status: 'snapshot_moved' };

  // Step 3: synchronous checks, directly followed by the transaction. No await from here on.
  const fresh = chains.get(chainId);
  if (fresh.revision !== chain.revision) return { status: 'conflict', code: 'version_conflict' };
  // Both PR reads awaited: the switch is read again, synchronously, right before the write path.
  if (!deps.enabled()) return { status: 'disabled' };
  const failure = (code: string): DispatchOutcome => recordFailure(deps, fresh, b.head, code);
  try { grant = enforceGrantLive(chains, fresh, { access: deps.access, keys: deps.keys(), now: deps.now() }); }
  catch (error) { return { status: 'stopped', reason: error instanceof RevisionGrantError ? error.code : 'grant_invalid' }; }
  const stop = (reason: 'protected_set_changed' | 'budget_exhausted'): DispatchOutcome => {
    chains.stopLive(fresh.chain_id, fresh.revision, reason, deps.now());
    return { status: 'stopped', reason };
  };
  if (deps.protectedSetDigest() !== grant.protected_set_digest) return stop('protected_set_changed');
  let principal: ReturnType<typeof deps.access.refresh>;
  try { principal = deps.access.refresh(grant.principal_id, grant.client_session_id); } catch { return { status: 'stopped', reason: 'grant_invalid' }; }
  const rootMission = missions.get(fresh.root_mission_id);
  if (rootMission.scope_id !== grant.scope_id) return failure('root_scope_mismatch');
  let rootSpec: ContainedMissionSpec;
  try { rootSpec = parseContainedMissionSpec(rootMission.spec_json); } catch { return failure('root_spec_invalid'); }
  const repair = Math.min(rootSpec.max_repair_cycles ?? 2, 8);
  const slice = { executor_seconds: (1 + repair) * deps.launchCaps.executor_seconds, container_seconds: (1 + repair) * deps.launchCaps.verify_seconds };
  const left = chains.remainingBudget(fresh.chain_id);
  if (left.executor_seconds < slice.executor_seconds || left.container_seconds < slice.container_seconds) return stop('budget_exhausted');
  if (fresh.current_mission_id !== null) {
    const previous = missions.get(fresh.current_mission_id);
    const terminal = ['pr_opened', 'cancelled', 'abandoned', 'failed'].includes(previous.state);
    if (!terminal || previous.stop_obligation !== 0) return failure('previous_child_busy');
    if (missions.claim(previous.mission_id).state !== 'released') return failure('previous_claim_active');
  }
  const hex = deps.randomHex ?? ((n: number) => randomBytes(n).toString('hex'));
  let spec: ContainedMissionSpec; let claim: { repo_identity: string; branch: string; worktree_identity: string };
  try {
    spec = buildRevisionChildSpec(rootSpec, { chain: fresh, feedback: { review_ids: b.review_ids, feedback_digest: b.feedback_digest, text: renderFeedbackText(pieces) },
      ids: { id: hex(6), nonce: hex(16) }, rootTier: rootTierOf(missions, fresh.root_mission_id), ...(deps.worktreesRoot ? { worktreesRoot: deps.worktreesRoot } : {}) });
    claim = validateContainedStart(spec, deps.worktreesRoot).claim;
  } catch (error) { return failure(error instanceof Error ? error.message.split(':')[0]!.slice(0, 64) : 'spec_failed'); }

  // Step 4: one transaction. Any throw rolls back the reservation, the child and the allocation together.
  try {
    const outcome = chains.transaction(() => {
      const fault = (step: DispatchFaultStep) => deps.fault?.(step);
      const at = deps.now();
      // The filesystem checks above ran after the grant check; judge the grant again at the last moment, inside the same write lock.
      assertGrantLive(chains.get(fresh.chain_id), { access: deps.access, keys: deps.keys(), now: at });
      const reserved = chains.reserve(fresh.chain_id, fresh.revision, { head: b.head, review_ids: b.review_ids, feedback_digest: b.feedback_digest }, at);
      fault('reserve');
      const child = missions.authorize(principal, { scope_id: grant.scope_id, spec: spec as unknown as Record<string, unknown>, claim }, at);
      fault('authorize');
      const dispatched = chains.dispatch(fresh.chain_id, reserved.chain.revision, b.head, child.mission_id, at);
      fault('dispatch');
      const allocated = chains.allocateChild(fresh.chain_id, dispatched.chain.revision, child.mission_id, slice, at);
      fault('allocate');
      chains.appendEvent(fresh.chain_id, 'child_dispatched', { child: child.mission_id, round: reserved.chain.rounds_used, review_ids: b.review_ids, feedback_digest: b.feedback_digest }, at);
      fault('event');
      return { chain: chains.get(allocated.chain_id), child_mission_id: child.mission_id, round: reserved.chain.rounds_used };
    });
    return { status: 'dispatched', ...outcome };
  } catch (error) {
    if (error instanceof RevisionGrantError) {
      const reason = error.code === 'grant_signature_invalid' ? 'grant_invalid' : error.code;
      try { const now = chains.get(fresh.chain_id); chains.stopLive(now.chain_id, now.revision, reason, deps.now()); } catch { /* moved on or already stopped */ }
      return { status: 'stopped', reason };
    }
    const code = error instanceof Error ? error.message.split(':')[0]!.slice(0, 64) : 'error';
    if (BENIGN.has(code)) return { status: 'conflict', code };
    return failure(code);
  }
}

/** A discarded cycle: recorded outside any transaction, and three in a row for the same head stop the chain for a human. */
function recordFailure(deps: DispatchRevisionDeps, chain: RevisionChain, head: string, code: string): DispatchOutcome {
  const { chains } = deps;
  try { chains.appendEvent(chain.chain_id, 'dispatch_failed', { head, code }, deps.now()); } catch { /* a closed chain takes no more events */ }
  let seen = 0;
  let after = 0;
  for (;;) {
    const page = chains.events(chain.chain_id, after, 500);
    for (const e of page) {
      if (e.kind === 'grant_replaced') seen = 0;
      else if (e.kind === 'dispatch_failed' && (JSON.parse(e.payload_json) as { head?: string }).head === head) seen += 1;
    }
    if (page.length < 500) break;
    after = page.at(-1)!.seq;
  }
  if (seen >= MAX_DISPATCH_FAILURES) {
    try { const now = chains.get(chain.chain_id); chains.stopLive(now.chain_id, now.revision, 'dispatch_failed', deps.now()); return { status: 'failed', code, stopped: true }; }
    catch { /* moved on or already stopped */ }
  }
  return { status: 'failed', code, stopped: false };
}
