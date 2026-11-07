// Test support for the bridge shadow reconciler (phase 4-D): a scripted GitHub GraphQL transport that serves pages built from
// PrSnapshots, and a ledger rig with pr_opened Missions. Not imported by production code.
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  AttentionStore,
  ContainedMissionStore,
  RevisionChainStore,
  createScratchDirSync,
  openDb,
  type EngineeringPrincipal,
  type PrState,
  type ProducerIdentity,
  type SnapshotReview,
} from '@osstack/core';
import {
  PULL_REQUEST_QUERY,
  SECOND_READ_QUERY,
  THREAD_COMMENTS_QUERY,
  type GraphqlTransport,
} from './contained-mission-bridge-reader.js';

export const oid = (c: string): string => c.repeat(40);

/** The mutable GitHub-side state of one PR. */
export interface ScriptedPr {
  state: PrState;
  head: string;
  base_sha: string;
  base_ref: string;
  author: ProducerIdentity;
  reviews: SnapshotReview[];
}

const identityOf = (id: ProducerIdentity) => ({ __typename: id.app_id === null ? 'User' : 'Bot', databaseId: id.actor_id });
const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] as unknown[] };

/** Raw `pullRequest` node as GitHub would return it for this state. Review bodies are synthetic: `feedback <id>` or empty. */
export function rawPullRequest(pr: ScriptedPr): Record<string, unknown> {
  return {
    state: pr.state, merged: pr.state === 'MERGED', closed: pr.state !== 'OPEN', headRefName: 'topic', headRefOid: pr.head,
    headRepository: { nameWithOwner: 'o/r' }, baseRefName: pr.base_ref, baseRefOid: pr.base_sha, author: identityOf(pr.author),
    reviews: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: pr.reviews.map((r) => ({
        databaseId: r.review_id, state: r.state, submittedAt: new Date(r.submitted_at).toISOString(),
        commit: r.review_commit === '' ? null : { oid: r.review_commit }, author: identityOf(r.reviewer), body: r.has_feedback ? `feedback ${r.review_id}` : '',
      })),
    },
    reviewThreads: empty,
    commits: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ commit: { oid: pr.head } }] },
    timelineItems: empty,
  };
}

export interface ScriptedTransport {
  transport: GraphqlTransport;
  /** Every document received, in order. */
  queries: string[];
  /** Number of full PR reads (PULL_REQUEST_QUERY) and second reads. */
  counts: () => { reads: number; second: number };
}

export interface ScriptedOptions {
  /** Called before each document is answered; may mutate `pr` or throw to fail the request. */
  before?: (kind: 'read' | 'second', pr: ScriptedPr) => void;
  /** Return a different body (e.g. `{ errors: [...] }`) instead of the PR. */
  override?: (kind: 'read' | 'second') => unknown;
}

export function scriptedTransport(prFor: (variables: Record<string, unknown>) => ScriptedPr, options: ScriptedOptions = {}): ScriptedTransport {
  const queries: string[] = [];
  let reads = 0;
  let second = 0;
  const transport: GraphqlTransport = async (query, variables) => {
    queries.push(query);
    const pr = prFor(variables);
    if (query === PULL_REQUEST_QUERY) {
      reads += 1;
      options.before?.('read', pr);
      const over = options.override?.('read');
      if (over !== undefined) return over;
      return { data: { repository: { pullRequest: rawPullRequest(pr) } } };
    }
    if (query === SECOND_READ_QUERY) {
      second += 1;
      options.before?.('second', pr);
      const over = options.override?.('second');
      if (over !== undefined) return over;
      return {
        data: { repository: { pullRequest: {
          headRefOid: pr.head, baseRefOid: pr.base_sha, baseRefName: pr.base_ref,
          reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: pr.reviews.map((r) => ({ databaseId: r.review_id, state: r.state })) },
        } } },
      };
    }
    if (query === THREAD_COMMENTS_QUERY) return { data: { node: { comments: empty } } };
    throw new Error('scripted_transport_unknown_query');
  };
  return { transport, queries, counts: () => ({ reads, second }) };
}

export interface RigMission {
  repository?: string;
  base_ref?: string;
  branch?: string;
  pr_number: number;
  head: string;
  /** Null means the delivery evidence carries no base head. */
  base_head: string | null;
  /** Extra spec fields (a full spec for revision tests). */
  spec?: Record<string, unknown>;
  /** Merger tests: the full `delivery_evidence` payload (including `evidence_digest`), built once the Mission id and spec digest exist. */
  evidence?: (mission: { mission_id: string; spec_digest: string }) => Record<string, unknown>;
}

/** A migrated ledger with a registered scope, plus helpers to seed `pr_opened` Missions the way the publish path leaves them. */
export interface Rig {
  root: string;
  db: AttentionStore['db'];
  path: string;
  attention: AttentionStore;
  owner: ReturnType<AttentionStore['claimOwner']>;
  scope: ReturnType<AttentionStore['registerScope']>;
  missions: ContainedMissionStore;
  chains: RevisionChainStore;
  principal: EngineeringPrincipal;
  seedMission(m: RigMission): string;
  ledger(): string;
  close(): void;
}

export function createRig(): Rig {
  const root = realpathSync(createScratchDirSync('tests', 'shadow-rig'));
  const path = join(root, 'state.db');
  const db: AttentionStore['db'] = openDb({ path });
  db.pragma('synchronous=FULL');
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path);
  const owner = attention.claimOwner('owner');
  const scope = attention.registerScope(owner, 't', root);
  const missions = new ContainedMissionStore(attention, owner);
  const chains = new RevisionChainStore(attention, owner);
  const principal: EngineeringPrincipal = {
    principal_id: 'human', client_session_id: 'cli', read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [],
  };
  let clock = 1_000;
  let n = 0;
  const seedMission = (m: RigMission): string => {
    n += 1;
    clock += 1;
    const branch = m.branch ?? `osstack/mission/m${n}`;
    const mission = missions.authorize(principal, {
      scope_id: scope.scope_id,
      spec: { goal: `g${n}`, branch, publication: { remote: 'origin', repository: m.repository ?? 'o/r', base: m.base_ref ?? 'main', draft: true }, ...(m.spec ?? {}) },
      claim: { repo_identity: `repo${n}`, branch, worktree_identity: `wt${n}` },
    }, clock);
    const full = m.evidence?.({ mission_id: mission.mission_id, spec_digest: mission.spec_digest });
    const digest = typeof full?.['evidence_digest'] === 'string' ? full['evidence_digest'] : String(n).padStart(64, 'e');
    // Walk the real state machine to pr_opened, as the runner does, then leave the delivery events the publish path writes.
    const id = mission.mission_id;
    let rev = mission.revision;
    const step = (to: Parameters<ContainedMissionStore['transition']>[1]['to'], extra: { expected_head?: string; candidate?: { head: string; tree: string; diff_digest: string } } = {}) => {
      clock += 1;
      rev = missions.transition(id, { if_revision: rev, to, event: { kind: `to_${to}`, payload: {} }, ...extra }, clock).revision;
    };
    const stopped = () => { clock += 1; rev = missions.recordStopEvidence(id, rev, { stop_proof: 'test' }, clock).revision; };
    step('workspace_ready');
    step('executing', { expected_head: oid('c') });
    stopped();
    step('candidate_ready', { candidate: { head: m.head, tree: oid('d'), diff_digest: 'd'.repeat(64) } });
    step('verifying');
    stopped();
    step('verified');
    step('revalidating');
    step('delivering');
    missions.record(id, 'delivery_evidence', full ?? { head: m.head, base_head: m.base_head, repository: m.repository ?? 'o/r', evidence_digest: digest, verify: { argv: ['true'], exit_code: 0 } }, ++clock);
    // The runner records the evidence, then transitions with a `pr_opened` event that carries the PR (contained-mission-runner deliver()).
    clock += 1;
    missions.transition(id, { if_revision: rev, to: 'pr_opened', event: { kind: 'pr_opened', payload: { pr: { number: m.pr_number, url: `https://example.invalid/pull/${m.pr_number}`, reused: false }, evidence_digest: digest } } }, clock);
    return mission.mission_id;
  };
  /** Every Mission-side row, serialised, to compare byte for byte before and after a shadow run. */
  const ledger = (): string => JSON.stringify(['engineering_contained_missions', 'engineering_contained_events', 'engineering_workspace_claims'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const close = (): void => { db.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, db, path, attention, owner, scope, missions, chains, principal, seedMission, ledger, close };
}
