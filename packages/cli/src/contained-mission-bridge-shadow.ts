// Bridge shadow reconciler (appendix §5.3, phase 4-D): observes Mission PRs read-only and records what the bridge WOULD do.
// It is constructed with exactly: a read-only Mission view, a ShadowChainWriter, a query-only transport, the producer
// registry, a clock and a logger. It is never handed the host, the runner, the ports, App credentials or the store's live
// chain APIs, and it is never awaited on the Mission tick path. Lazy-imported only.
import {
  decideChainStep,
  sameProducer,
  type ChainDecision,
  type ChainView,
  type ContainedMissionStore,
  type PrSnapshot,
  type RevisionChain,
  type ShadowChainWriter,
  type ShadowDecisionRow,
} from '@osstack/core';
import { readMissionPublication } from './contained-mission-publication.js';
import type { ProducerRegistryConfig } from './contained-mission-bridge-registry.js';
import {
  DEFAULT_READ_LIMITS,
  normalizeSnapshot,
  readPullRequest,
  reviewerOf,
  secondReadOutcome,
  type GraphqlTransport,
  type PullRequestRead,
  type ReadLimits,
} from './contained-mission-bridge-reader.js';

/** What the reconciler needs to know about a Mission that opened a PR. Everything else about a Mission stays out of reach. */
export interface ShadowMissionPublication {
  readonly repository: string;
  readonly branch: string;
  readonly base_ref: string;
  readonly pr_number: number;
  readonly pushed_commit: string;
  readonly base_head: string | null;
}
/** Read-only Mission view: no write method, no host, no runner. */
export interface ShadowMissionView {
  listPrOpened(limit: number, after?: { created_at: number; mission_id: string }): Array<{ mission_id: string; created_at: number }>;
  /** Null unless the Mission is `pr_opened` with publication kind `opened`. */
  publication(missionId: string): ShadowMissionPublication | null;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;

/** The production view, over a store used for reads only (`get`, `listPrOpened` and the publication query). */
export function createShadowMissionView(store: Pick<ContainedMissionStore, 'db' | 'get' | 'listPrOpened'>): ShadowMissionView {
  return {
    listPrOpened: (limit, after) => store.listPrOpened(limit, after),
    publication: (missionId) => {
      const mission = store.get(missionId);
      if (mission.state !== 'pr_opened') return null;
      const pub = readMissionPublication(store, missionId);
      if (pub?.kind !== 'opened') return null;
      let spec: { branch?: unknown; publication?: { repository?: unknown; base?: unknown } | null };
      try {
        spec = JSON.parse(mission.spec_json) as typeof spec;
      } catch {
        return null;
      }
      const repository = spec.publication?.repository;
      const base = spec.publication?.base;
      const branch = spec.branch;
      if (typeof repository !== 'string' || typeof base !== 'string' || typeof branch !== 'string') return null;
      if (!Number.isSafeInteger(pub.pr.number) || pub.pr.number < 1 || !SHA.test(pub.pushed_commit)) return null;
      if (pub.base_head !== null && !SHA.test(pub.base_head)) return null;
      return { repository, branch, base_ref: base, pr_number: pub.pr.number, pushed_commit: pub.pushed_commit, base_head: pub.base_head };
    },
  };
}

export interface ShadowReconcilerOptions {
  readonly missions: ShadowMissionView;
  readonly chains: ShadowChainWriter;
  readonly transport: GraphqlTransport;
  readonly registry: ProducerRegistryConfig;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Pause between the end of one scan and the start of the next (default 5 minutes). */
  readonly intervalMs?: number;
  /** Chain reads per scan, first sights included (default 10, at most 10). */
  readonly chainsPerScan?: number;
  /** Minimum time between two reads of one chain (default 5 minutes). */
  readonly minReadGapMs?: number;
  /** Delay before the first scan after `start()` (default: the read gap, so a restart never reads a chain sooner than the gap after its previous read). */
  readonly initialDelayMs?: number;
  readonly limits?: ReadLimits;
}

const FIVE_MINUTES = 5 * 60_000;
const MISSION_PAGE = 50;
const MISSION_PAGES_PER_SCAN = 4;
const STOP_GRACE_MS = 5_000;
const CHAIN_PAGE = 50;

/** Fixed `read_failed` codes: the event payload is one of these literals, so nothing from a response, a login or a URL can reach it
 * (and the App-credential module that owns `redactBridge` stays out of this import graph). */
export type ReadFailedCode =
  | 'request_cap' | 'request_failed' | 'graphql_errors' | 'malformed_response' | 'pull_request_not_found'
  | 'moved_during_read' | 'page_cap' | 'unexpected_error' | 'normalize_failed' | 'decide_failed' | 'second_read_failed';
const READ_FAILED_CODES: ReadonlySet<string> = new Set<ReadFailedCode>([
  'request_cap', 'request_failed', 'graphql_errors', 'malformed_response', 'pull_request_not_found',
  'moved_during_read', 'page_cap', 'unexpected_error', 'normalize_failed', 'decide_failed', 'second_read_failed',
]);
const failedCode = (reason: string): ReadFailedCode => (READ_FAILED_CODES.has(reason) ? (reason as ReadFailedCode) : 'unexpected_error');
const errorCode = (error: unknown): string => (error instanceof Error ? (error.message.split(':')[0] ?? 'error') : 'error').replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 64);

export interface ShadowHandle {
  start(): void;
  stop(): Promise<void>;
  /** One scan (discovery, then at most `chainsPerScan` chain cycles); never rejects. */
  scan(): Promise<void>;
}

export class ShadowReconciler implements ShadowHandle {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private missionCursor: { created_at: number; mission_id: string } | undefined;
  private chainCursor: { created_at: number; chain_id: string } | undefined;
  private readonly lastRead = new Map<string, number>();
  /** Missions that can never get a chain (decided once per process). */
  private readonly skipped = new Set<string>();
  private readonly intervalMs: number;
  private readonly chainsPerScan: number;
  private readonly gapMs: number;
  private readonly limits: ReadLimits;

  constructor(private readonly options: ShadowReconcilerOptions) {
    this.intervalMs = options.intervalMs ?? FIVE_MINUTES;
    this.chainsPerScan = Math.max(1, Math.min(10, Math.floor(options.chainsPerScan ?? 10)));
    this.gapMs = options.minReadGapMs ?? FIVE_MINUTES;
    this.limits = options.limits ?? DEFAULT_READ_LIMITS;
  }

  /** Starts the timer and returns at once. The first scan runs after `initialDelayMs`, never inline. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(this.options.initialDelayMs ?? this.gapMs);
  }

  /** Stops scheduling and waits briefly for a scan in flight; a late scan performs no further write. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const running = this.scanning;
    if (!running) return;
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([running, new Promise<void>((resolve) => { grace = setTimeout(resolve, STOP_GRACE_MS); grace.unref(); })]);
    if (grace) clearTimeout(grace);
  }

  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.scanning) {
      this.scanning = this.scanOnce().catch(() => this.log('scan_failed')).finally(() => { this.scanning = undefined; });
    }
    return this.scanning;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan().finally(() => { if (!this.stopped) this.schedule(this.intervalMs); });
    }, delayMs);
    this.timer.unref();
  }

  private log(line: string): void {
    try { this.options.log(`osstack: bridge shadow: ${line}`); } catch { /* logging never affects the reconciler */ }
  }

  private async scanOnce(): Promise<void> {
    // One budget for the whole scan: a first sight is a chain read like any other. Discovery takes at most half, so Missions whose
    // reads keep failing can never starve the chains already being observed.
    const used = await this.discover(Math.ceil(this.chainsPerScan / 2));
    await this.cycleChains(this.chainsPerScan - used);
  }

  // ------------------------------------------------------------------ discovery

  /** Walks `pr_opened` Missions with a cursor (wrapping at the end) and creates a shadow chain on first sight.
   * Returns the number of chain reads it spent; stops once `budget` is used. */
  private async discover(budget: number): Promise<number> {
    let spent = 0;
    for (let page = 0; page < MISSION_PAGES_PER_SCAN; page += 1) {
      const rows = this.options.missions.listPrOpened(MISSION_PAGE, this.missionCursor);
      for (const row of rows) {
        if (this.stopped) return spent;
        if (this.skipped.has(row.mission_id) || this.options.chains.shadowChainForMission(row.mission_id)) {
          this.missionCursor = row;
          continue;
        }
        if (spent >= budget) return spent;
        this.missionCursor = row;
        if (await this.discoverOne(row.mission_id)) spent += 1;
      }
      if (rows.length < MISSION_PAGE) { this.missionCursor = undefined; return spent; }
    }
    return spent;
  }

  private skip(missionId: string, reason: string): void {
    this.skipped.add(missionId);
    this.log(`skip mission=${missionId} reason=${reason}`);
  }

  /** True when a PR read was spent on the Mission. */
  private async discoverOne(missionId: string): Promise<boolean> {
    const { chains, registry } = this.options;
    let pub: ShadowMissionPublication | null;
    try { pub = this.options.missions.publication(missionId); } catch { this.log(`skip mission=${missionId} reason=publication_unreadable`); return false; }
    if (!pub) { this.skip(missionId, 'publication_not_opened'); return false; }
    if (pub.repository !== registry.repository) { this.skip(missionId, 'repository_not_registered'); return false; }
    if (pub.base_head === null) { this.skip(missionId, 'base_head_missing'); return false; }
    if (chains.shadowChainForPr(pub.repository, pub.pr_number)) { this.skip(missionId, 'pr_has_shadow_chain'); return false; }
    const ref = REPOSITORY.exec(pub.repository);
    if (!ref) { this.skip(missionId, 'repository_invalid'); return false; }
    const startedAt = this.options.now();
    const read = await readPullRequest(this.options.transport, { owner: ref[1]!, name: ref[2]!, number: pub.pr_number }, this.limits);
    if (this.stopped) return true;
    if (!read.complete) { this.log(`discovery_read_failed mission=${missionId} code=${failedCode(read.reason)}`); return true; }
    const author = reviewerOf(read.pr.author ?? undefined, registry);
    if (author.actor_id === 0 || !registry.publisher.some((p) => sameProducer(p, author))) { this.skip(missionId, 'author_not_publisher'); return true; }
    let chain: RevisionChain;
    try {
      chain = chains.createShadowChain({
        root_mission_id: missionId, repository: pub.repository, pr_number: pub.pr_number, branch: pub.branch, base_ref: pub.base_ref,
        published_head: pub.pushed_commit, published_base: pub.base_head, trace_id: `bridge-shadow:${missionId}`,
      }, startedAt);
    } catch (error) {
      this.log(`create_failed mission=${missionId} code=${errorCode(error)}`);
      return true;
    }
    this.log(`chain_created mission=${missionId} chain=${chain.chain_id}`);
    await this.cycle(chain, read, startedAt);
    return true;
  }

  // ------------------------------------------------------------------ cadence

  /** Reads up to `budget` open chains that are due, continuing from the cursor and wrapping once to the start. */
  private async cycleChains(budget: number): Promise<void> {
    const { chains } = this.options;
    let spent = 0;
    let wrapped = false;
    const seen = new Set<string>();
    while (spent < budget) {
      const rows = chains.listOpenShadowChains(CHAIN_PAGE, this.chainCursor);
      if (rows.length === 0) {
        if (this.chainCursor === undefined || wrapped) return;
        this.chainCursor = undefined;
        wrapped = true;
        continue;
      }
      for (const chain of rows) {
        if (this.stopped) return;
        if (seen.has(chain.chain_id)) { this.chainCursor = { created_at: chain.created_at, chain_id: chain.chain_id }; continue; }
        const last = this.lastRead.get(chain.chain_id);
        const now = this.options.now();
        const due = last === undefined || now - last >= this.gapMs;
        if (due && spent >= budget) return;
        seen.add(chain.chain_id);
        this.chainCursor = { created_at: chain.created_at, chain_id: chain.chain_id };
        if (!due) continue;
        spent += 1;
        await this.cycle(chain, undefined, now);
      }
    }
  }

  // ------------------------------------------------------------------ one observation cycle

  private viewOf(chain: RevisionChain, decisions: readonly ShadowDecisionRow[]): ChainView {
    return {
      mode: 'shadow', state: chain.state, published_head: chain.published_head, published_base: chain.published_base, base_ref: chain.base_ref,
      rounds_used: 0, grant_rounds: null, review_deadline: chain.review_deadline,
      reserved_heads: decisions.filter((d) => d.action === 'would_reserve').map((d) => d.head_sha),
    };
  }

  /** `pre` is a read the caller already made (first sight); otherwise the PR is read here. Failures become `read_failed`. */
  private async cycle(listed: RevisionChain, pre: PullRequestRead | undefined, now: number): Promise<void> {
    const { chains, registry, transport } = this.options;
    if (this.stopped) return;
    this.lastRead.set(listed.chain_id, now);
    let chain: RevisionChain;
    try { chain = chains.get(listed.chain_id); } catch { return; }
    if (chain.state === 'closed' || chain.state === 'awaiting_decision') return;
    const ref = REPOSITORY.exec(chain.repository);
    if (!ref) return;
    const prRef = { owner: ref[1]!, name: ref[2]!, number: chain.pr_number };

    const read = pre ?? await readPullRequest(transport, prRef, this.limits);
    if (this.stopped) return;
    if (!read.complete) return this.readFailed(chain, failedCode(read.reason), now);

    let snapshot: PrSnapshot;
    try { snapshot = normalizeSnapshot(read, registry, now); } catch { return this.readFailed(chain, 'normalize_failed', now); }

    let decision: ChainDecision;
    try {
      const view = this.viewOf(chain, chains.shadowDecisions(chain.chain_id));
      decision = decideChainStep(view, snapshot, registry, now);
      if (isRecordable(decision)) {
        const ids = 'review_ids' in decision ? decision.review_ids : [];
        const wanted = snapshot.reviews.filter((r) => ids.includes(r.review_id)).map((r) => ({ review_id: r.review_id, state: r.state }));
        const outcome = await secondReadOutcome(transport, prRef, { head: snapshot.head, base_sha: snapshot.base_sha, base_ref: snapshot.base_ref, reviews: wanted }, this.limits);
        if (this.stopped) return;
        // A confirmation that could not be obtained is a read failure, not a movement: nothing is recorded and the chain is unchanged.
        if (outcome === 'failed') return this.readFailed(chain, 'second_read_failed', now);
        if (outcome === 'moved') decision = decideChainStep(view, { ...snapshot, moved: true }, registry, now);
      }
    } catch {
      return this.readFailed(chain, 'decide_failed', now);
    }

    try {
      chains.applyShadowDecision(chain.chain_id, chain.revision, decision, now);
      chains.appendEvent(chain.chain_id, 'observation_cycle', observation(snapshot, decision, now), now);
    } catch (error) {
      // A lost optimistic race (`version_conflict`) or a decision computed against an older row (`stale_decision`) abandons the
      // cycle; the next one starts from the current row.
      this.log(`cycle_abandoned chain=${chain.chain_id} code=${errorCode(error)}`);
    }
  }

  private readFailed(chain: RevisionChain, code: ReadFailedCode, now: number): void {
    if (this.stopped) return;
    try {
      this.options.chains.appendEvent(chain.chain_id, 'read_failed', { code }, now);
    } catch (error) {
      this.log(`read_failed_unrecorded chain=${chain.chain_id} code=${errorCode(error)}`);
    }
  }
}

/** would_reserve and would_mark_ready are confirmed by a second read before they are recorded (§5.1). */
function isRecordable(decision: ChainDecision): boolean {
  return decision.kind === 'would_reserve' || (decision.kind === 'transition' && decision.shadow_action === 'would_mark_ready');
}

/** Compact, body-free record of one cycle. */
function observation(snapshot: PrSnapshot, decision: ChainDecision, now: number): Record<string, unknown> {
  return {
    observed_at: now, pr_state: snapshot.pr_state, head: snapshot.head, base: snapshot.base_sha, reviews: snapshot.reviews.length,
    decision: decision.kind,
    ...(decision.kind === 'none' ? { reason: decision.reason } : {}),
    ...(decision.kind === 'transition' || decision.kind === 'stop' ? { to: decision.to, reason: decision.reason } : {}),
    ...(decision.kind === 'would_reserve' ? { reason: 'changes_requested' } : {}),
    ...('shadow_action' in decision && decision.shadow_action ? { action: decision.shadow_action } : {}),
    discards: decision.discards.map((d) => `${d.review_id}:${d.reason}`),
  };
}
