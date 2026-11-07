// Test support for revision children (phase 5-B): a live chain with a really signed grant over a rig ledger, a scripted PR with review text, and
// the dispatch dependencies. Not imported by production code.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { grantPreviewOf, signRevisionGrant, type EngineeringPrincipal, type RevisionGrant, type SnapshotReview } from '@osstack/core';
import { afterEach } from 'vitest';
import { PULL_REQUEST_QUERY, readPullRequest } from './contained-mission-bridge-reader.js';
import { createRig, oid, scriptedTransport, type ScriptedPr } from './contained-mission-bridge-shadow.testkit.js';
import { type DispatchFaultStep, type DispatchRevisionDeps, dispatchRevision } from './contained-mission-revision.js';
import { parseContainedMissionSpec, type ContainedMissionSpec } from './contained-mission-runner.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
export const T0 = 1_800_000_000_000;
export const H = 3_600_000;
export const PD = 'd'.repeat(64);
export const PUBLISHER = { actor_id: 501, app_id: 11 };
export const REVIEWER = { actor_id: 900, app_id: null };
// Built by concatenation so this file never trips a secret scanner.
export const FAKE_TOKEN = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
export const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof Error ? e.message : String(e); } return 'no_error'; };

export const changesRequested = (id: number, head: string): SnapshotReview => ({ review_id: id, state: 'CHANGES_REQUESTED', submitted_at: T0 - 1000, review_commit: head, reviewer: REVIEWER, has_feedback: true, feedback_digest: null });

export function setup(opts: { rounds?: 1 | 2; budget?: { max_executor_seconds: number; max_container_seconds: number; max_wall_clock_hours: number }; expiresIn?: number } = {}) {
  const rig = createRig();
  cleanup.push(() => { rig.close(); });
  const repoDir = join(rig.root, 'repo'); mkdirSync(repoDir);
  const wtRoot = join(rig.root, 'worktrees'); mkdirSync(wtRoot);
  const rootSpec = {
    goal: 'make the parser faster', repo_path: realpathSync(repoDir), base_ref: 'main', start_commit: oid('9'), worktree_path: join(wtRoot, 'mission-root'),
    allowed_paths: ['src/**'], caps: { maxFiles: 5, maxChangedLines: 200 }, verify: { argv: ['pnpm', 'test'] }, verification_paths: ['test/**'], max_repair_cycles: 1,
  };
  const rootId = rig.seedMission({ pr_number: 7, head: oid('1'), base_head: oid('a'), branch: 'topic', spec: rootSpec });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keys = new Map([['k1', { key_id: 'k1', public_key: publicKey, max_validity_ms: 7 * 24 * H }]]);
  const grant = signRevisionGrant({
    kind: 'live', version: 1, grant_id: `rg_${randomUUID()}`, rounds: opts.rounds ?? 1, principal_id: 'human', client_session_id: 'cli', scope_id: rig.scope.scope_id,
    root_mission_id: rootId, repository: 'o/r', pr_number: 7, branch: 'topic', base_ref: 'main', base_sha: oid('a'), head_sha: oid('1'), issued_at: T0, expires_at: T0 + (opts.expiresIn ?? 24 * H),
    review_deadline_ms: 24 * H, budget: opts.budget ?? { max_executor_seconds: 3600, max_container_seconds: 3600, max_wall_clock_hours: 48 }, protected_set_digest: PD,
    nonce: 'e'.repeat(32), key_id: 'k1',
  }, privateKey);
  const chain = rig.chains.createLiveChain({ root_mission_id: rootId, repository: 'o/r', pr_number: 7, branch: 'topic', base_ref: 'main', published_head: oid('1'), published_base: oid('a'),
    trace_id: 't', review_deadline: T0 + 24 * H, budget_origin: T0, grant }, T0);
  const pr: ScriptedPr = { state: 'OPEN', head: oid('1'), base_sha: oid('a'), base_ref: 'main', author: PUBLISHER, reviews: [changesRequested(77, oid('1'))] };
  const body = { review: 'please rename the helper', comments: [] as string[] };
  const inner = scriptedTransport(() => pr);
  const transport = async (query: string, variables: Record<string, unknown>) => {
    const reply = await inner.transport(query, variables) as { data?: { repository?: { pullRequest?: Record<string, any> } } };
    const node = query === PULL_REQUEST_QUERY ? reply.data?.repository?.pullRequest : undefined;
    if (node) {
      for (const review of node.reviews.nodes) review.body = review.databaseId === 77 || review.databaseId === 78 ? body.review : '';
      node.reviewThreads = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: body.comments.length === 0 ? [] : [{
        id: 'thread-1', isResolved: false, comments: { pageInfo: { hasNextPage: false, endCursor: null },
          nodes: body.comments.map((text, i) => ({ databaseId: 1000 + i, createdAt: new Date(T0 - 5000 + i).toISOString(), pullRequestReview: { databaseId: 77 }, body: text, author: { __typename: 'User', databaseId: 900 } })) } }] };
    }
    return reply;
  };
  const clock = { now: T0 };
  const flags = { enabled: true, access: true, protectedDigest: PD };
  const principal: EngineeringPrincipal = { principal_id: 'human', client_session_id: 'cli', read_scopes: [rig.scope.scope_id], write_scopes: [rig.scope.scope_id], stop_scopes: [], operator_scopes: [] };
  const faults: { at?: DispatchFaultStep | undefined } = {};
  const deps: DispatchRevisionDeps = {
    chains: rig.chains, missions: rig.missions,
    access: { refresh: () => { if (!flags.access) throw new Error('permission_denied'); return principal; } },
    keys: () => keys, now: () => clock.now, launchCaps: { executor_seconds: 600, verify_seconds: 120 },
    readPr: ref => readPullRequest(transport, ref), registry: { publisher: [PUBLISHER], reviewers: [REVIEWER] },
    enabled: () => flags.enabled, protectedSetDigest: () => flags.protectedDigest, worktreesRoot: wtRoot,
    fault: step => { if (faults.at === step) throw new Error('crash_here'); },
  };
  const missionCount = () => (rig.db.prepare('SELECT COUNT(*) n FROM engineering_contained_missions').get() as { n: number }).n;
  const reservations = () => rig.chains.reservations(chain.chain_id);
  const children = () => (rig.db.prepare('SELECT mission_id FROM engineering_contained_missions WHERE mission_id<>? AND spec_json LIKE ?').all(rootId, '%publish_target%') as Array<{ mission_id: string }>).map(r => r.mission_id);
  const childSpec = (id: string): ContainedMissionSpec => parseContainedMissionSpec(rig.missions.get(id).spec_json);
  const dispatch = () => dispatchRevision(deps, chain.chain_id);
  /** Round one is over: the child is terminal, its reservation voided as published, and the chain waits on a new head. */
  const finishRound = (childId: string, newHead: string, reviewId: number, proven = true) => {
    const { db } = rig;
    db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=1,revision=revision+1 WHERE mission_id=?").run(childId);
    if (proven) db.prepare("UPDATE engineering_contained_missions SET stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(childId);
    db.prepare("UPDATE engineering_revision_reservations SET state='void',settled_reason='published' WHERE child_mission_id=?").run(childId);
    db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',published_head=?,revision=revision+1 WHERE chain_id=?").run(newHead, chain.chain_id);
    pr.head = newHead; pr.reviews = [changesRequested(reviewId, newHead)];
  };
  /** The re-grant a human would sign for the chain as it is now: same binding, `over` applied on top (budget, expiry, time). */
  const renew = (over: Partial<Pick<RevisionGrant, 'budget' | 'expires_at' | 'issued_at' | 'rounds'>> = {}): RevisionGrant => {
    const current = rig.chains.get(chain.chain_id);
    const old = JSON.parse(current.grant_json) as RevisionGrant;
    const preview = grantPreviewOf(old);
    return signRevisionGrant({ ...preview, grant_id: `rg_${randomUUID()}`, issued_at: clock.now, expires_at: clock.now + 24 * H, renews: { chain_id: chain.chain_id, revision: current.revision }, ...over }, privateKey);
  };
  return { rig, renew, privateKey, rootId, rootSpec, chain, grant, pr, body, clock, flags, faults, deps, dispatch, missionCount, reservations, children, childSpec, finishRound, wtRoot, keys, principal };
}
export type Fixture = ReturnType<typeof setup>;
export const dispatched = async (f: Fixture) => {
  const out = await f.dispatch();
  if (out.status !== 'dispatched') throw new Error(`not dispatched: ${JSON.stringify(out)}`);
  return out;
};

