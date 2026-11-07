// App E shadow merger (merger design §5.3, M-C): observes Mission PRs read-only and records what App E WOULD do. It never merges.
// It is constructed with exactly: a read-only Mission view, a read-only view of its own outcome ledger, the MergerShadowWriter, two
// read-only transports (GraphQL query documents, REST GET), the merger config, a clock and a logger. It is never handed the host, the
// runner, the ports, App credentials, a token source or the Mission store's write API, it never calls loadBridgeConfig and it is never
// awaited on the Mission tick path. Lazy-imported only; the import-graph test keeps contained-mission-bridge.ts and
// contained-mission-github-app.ts out of its closure.
import { createHash } from 'node:crypto';
import {
  DEFAULT_MERGE_GATE_OPTIONS,
  evaluateMergeGates,
  type ContainedMissionStore,
  type MergeGateOptions,
  type MergerCycleEntry,
  type MergerDecisionInput,
  type MergerOutcomeInput,
  type MergerOutcomeKind,
  type MergerShadowStore,
  type MergerShadowWriter,
  type MergeVerdict,
  type MissionMergeEvidence,
} from '@osstack/core';
import { z } from 'zod';
import type { GraphqlTransport } from './contained-mission-bridge-reader.js';
import { createShadowMissionView, type ShadowMissionPublication, type ShadowMissionView } from './contained-mission-bridge-shadow.js';
import type { MergerConfig } from './contained-mission-merger-config.js';
import { DEFAULT_MERGER_READ_LIMITS, readMergeGateInput, type MergerReadLimits, type RestGet } from './contained-mission-merger-reader.js';
import { readMissionPublication } from './contained-mission-publication.js';

// ---------------------------------------------------------------- Mission view (read-only)

/** Read-only Mission view plus the one query the merger adds (design §5.3). No write method, no host, no runner. */
export interface MergerMissionView extends ShadowMissionView {
  /** The ledger side of the merge gates for a `pr_opened` Mission, or null when the evidence cannot be read (the Mission is then skipped, never guessed). */
  deliveryEvidence(missionId: string): MissionMergeEvidence | null;
}

const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const lower = (s: string): string => s.toLowerCase();
/** Same canonical form the runner hashes `delivery_evidence` with (contained-mission-runner.ts); the runner is not importable from here. */
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

/** The production view, over a store used for reads only (`get`, `listPrOpened`, and SELECTs on the event table). */
export function createMergerMissionView(store: Pick<ContainedMissionStore, 'db' | 'get' | 'listPrOpened'>): MergerMissionView {
  const base = createShadowMissionView(store);
  return {
    ...base,
    deliveryEvidence: (missionId) => {
      const mission = store.get(missionId);
      if (mission.state !== 'pr_opened') return null;
      const publication = readMissionPublication(store, missionId);
      if (!publication) return null;
      const opened = store.db.prepare("SELECT seq,payload_json FROM engineering_contained_events WHERE mission_id=? AND kind='pr_opened' ORDER BY seq DESC LIMIT 1")
        .get(missionId) as { seq: number; payload_json: string } | undefined;
      if (!opened) return null;
      let event: { evidence_digest?: unknown; pr?: { number?: unknown } };
      try { event = JSON.parse(opened.payload_json) as typeof event; } catch { return null; }
      if (typeof event.evidence_digest !== 'string') return null;
      const row = store.db.prepare("SELECT payload_json FROM engineering_contained_events WHERE mission_id=? AND kind='delivery_evidence' AND seq<? AND json_extract(payload_json,'$.evidence_digest')=? ORDER BY seq DESC LIMIT 1")
        .get(missionId, opened.seq, event.evidence_digest) as { payload_json: string } | undefined;
      if (!row) return null;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { return null; }
      const str = (k: string): string | null => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
      const pr = payload['pr'] as { number?: unknown } | undefined;
      const repository = str('repository'); const branch = str('branch'); const baseRef = str('base'); const start = str('start_commit'); const head = str('head');
      const prNumber = Number(pr?.number);
      const recordDigest = str('evidence_digest');
      if (!repository || !branch || !baseRef || !start || !head || !recordDigest || !Number.isSafeInteger(prNumber) || prNumber < 1) return null;
      if (!HEX.test(head) || !mission.candidate_head || !HEX.test(mission.candidate_head)) return null;
      const baseHead = payload['base_head'] === null ? null : str('base_head');
      if (baseHead !== null && !HEX.test(baseHead)) return null;
      const { evidence_digest: _own, ...body } = payload;
      const joined = store.db.prepare(`SELECT COUNT(DISTINCT e.mission_id) AS n FROM engineering_contained_events e JOIN engineering_contained_missions m ON m.mission_id=e.mission_id
        WHERE e.kind='pr_opened' AND json_extract(e.payload_json,'$.pr.number')=? AND lower(json_extract(m.spec_json,'$.publication.repository'))=?`)
        .get(prNumber, lower(repository)) as { n: number };
      return {
        mission_id: missionId, spec_digest: mission.spec_digest, start_commit: start, candidate_head: mission.candidate_head, repository, branch, base: baseRef,
        base_head: baseHead, head, pr_number: prNumber, publication_kind: publication.kind,
        pushed_commit: 'pushed_commit' in publication ? publication.pushed_commit : null,
        record_digest: recordDigest, recomputed_digest: createHash('sha256').update(canonical(body)).digest('hex'), event_digest: event.evidence_digest,
        join_count: joined.n,
      };
    },
  };
}

// ---------------------------------------------------------------- outcome ledger view (read-only)

export interface MergerLatestOutcome { readonly outcome: MergerOutcomeKind; readonly observed_at: number }
/** What the merger may read of its own outcome ledger: the latest segment of one PR. No decision, no cycle, no write. */
export interface MergerLedgerView {
  latestOutcome(repository: string, prNumber: number): MergerLatestOutcome | null;
  /** Local wall time the PR's latest observation started (persisted with the fence, so it survives a restart); null when unknown. */
  lastPollAt(repository: string, prNumber: number): number | null;
}
export function createMergerLedgerView(store: Pick<MergerShadowStore, 'outcomes' | 'lastPollAt'>): MergerLedgerView {
  return {
    lastPollAt: (repository, prNumber) => store.lastPollAt(repository, prNumber),
    latestOutcome: (repository, prNumber) => {
      const last = store.outcomes(repository, prNumber).at(-1);
      return last ? { outcome: last.outcome, observed_at: last.observed_at } : null;
    },
  };
}

// ---------------------------------------------------------------- outcome reads (GraphQL query documents only)

export const MERGER_PR_STATE_QUERY = `query MergerPullRequestState($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { number state headRefOid } }
}`;
export const MERGER_PR_OUTCOME_QUERY = `query MergerPullRequestOutcome($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    number state headRefOid mergedAt mergeCommit { oid }
    mergedBy { __typename ... on User { databaseId } ... on Bot { databaseId } }
    reviews(last: 100, before: $before, states: [APPROVED]) { pageInfo { hasPreviousPage startCursor } nodes { databaseId submittedAt commit { oid } author { __typename ... on User { databaseId } } } }
  } }
}`;

const oidSchema = z.string().regex(HEX);
const APPROVAL_PAGES = 5;
const stateSchema = z.enum(['OPEN', 'CLOSED', 'MERGED']);
const stateEnvelope = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ repository: z.object({ pullRequest: z.object({ number: z.number().int(), state: stateSchema, headRefOid: oidSchema }).nullable() }).nullable() }) });
const outcomeEnvelope = z.object({ errors: z.array(z.unknown()).optional(), data: z.object({ repository: z.object({ pullRequest: z.object({
  number: z.number().int(), state: stateSchema, headRefOid: oidSchema, mergedAt: z.string().min(10).max(40).nullable(), mergeCommit: z.object({ oid: oidSchema }).nullable(),
  mergedBy: z.object({ __typename: z.string(), databaseId: z.number().int().positive().optional() }).nullable(),
  reviews: z.object({ pageInfo: z.object({ hasPreviousPage: z.boolean(), startCursor: z.string().nullable().optional() }), nodes: z.array(z.object({
    databaseId: z.number().int(), submittedAt: z.string().nullable(), commit: z.object({ oid: z.string() }).nullable(),
    author: z.object({ __typename: z.string(), databaseId: z.number().int().optional() }).nullable() })) }),
}).nullable() }).nullable() }) });

interface PrState { readonly state: 'OPEN' | 'CLOSED' | 'MERGED'; readonly head: string }
interface PrOutcome extends PrState {
  readonly mergedAt: string | null; readonly mergeCommit: string | null; readonly mergedBy: { type: 'User' | 'Bot'; id: number } | null;
  readonly approvals: ReadonlyArray<{ id: number; author: number | null; commit: string | null; submittedMs: number | null }>; readonly approvalsTruncated: boolean;
}

// ---------------------------------------------------------------- reconciler

export interface MergerShadowOptions {
  readonly missions: MergerMissionView;
  readonly ledger: MergerLedgerView;
  readonly writer: MergerShadowWriter;
  readonly graphql: GraphqlTransport;
  readonly rest: RestGet;
  readonly config: MergerConfig;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Pause between the end of one scan and the start of the next (default 5 minutes). */
  readonly intervalMs?: number;
  /** PRs examined per scan (default and maximum 10). */
  readonly prsPerScan?: number;
  /** Minimum time between two evaluations of one PR (default 5 minutes). */
  readonly minReadGapMs?: number;
  /** Minimum time between two polls of a closed PR (default 1 hour). */
  readonly closedPollMs?: number;
  /** A PR closed this long ago is no longer observed (default 30 days). */
  readonly expiryMs?: number;
  /** Delay before the first scan after `start()` (default: the read gap, so a restart never reads a PR sooner than the gap after its previous read). */
  readonly initialDelayMs?: number;
  /** GitHub requests per scan across all PRs (default 400); no new PR is started once it is reached. */
  readonly requestsPerScan?: number;
  readonly limits?: Partial<MergerReadLimits>;
  /** Owner decisions of design §8 that are still open; the strict defaults unless the owner decides otherwise. */
  readonly gateOptions?: MergeGateOptions;
}

export interface MergerShadowHandle {
  start(): void;
  stop(): Promise<void>;
  /** One scan; never rejects. */
  scan(): Promise<void>;
}

const FIVE_MINUTES = 5 * 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MISSION_PAGE = 50;
const MISSION_PAGES_PER_SCAN = 4;
const STOP_GRACE_MS = 5_000;
const REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;

/** Failure codes that reach a log line or a `unevaluated` record are fixed literals or pass through this filter; nothing from a response, a login or a URL does. */
/** Only a fixed-looking code (`MERGER_READ_DENIED`, `merger_stale_observation`, ...) survives; any other message, which could carry a token or a URL, becomes `error`. */
const errorCode = (error: unknown): string => {
  const head = error instanceof Error ? (error.message.split(':')[0] ?? '') : '';
  return /^(?:[A-Z][A-Z0-9_]{2,63}|merger_[a-z_]{1,48}|durability_required)$/u.test(head) ? head : 'error';
};
const safeCode = (code: string): string => (/^U\.[A-Za-z0-9_.:-]{1,190}$/u.test(code) ? code : 'U.read_failed:unexpected');

interface PrRef { readonly owner: string; readonly name: string; readonly number: number }

export class MergerShadowReconciler implements MergerShadowHandle {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private cursor: { created_at: number; mission_id: string } | undefined;
  private readonly lastEval = new Map<string, number>();
  /** Missions that can never be observed (decided once per process) or whose PR reached a terminal segment. */
  private readonly skipped = new Set<string>();
  private readonly intervalMs: number;
  private readonly prsPerScan: number;
  private readonly gapMs: number;
  private readonly closedPollMs: number;
  private readonly expiryMs: number;
  private readonly requestsPerScan: number;
  private readonly limits: Partial<MergerReadLimits>;
  private readonly gateOptions: MergeGateOptions;
  private readonly graphql: GraphqlTransport;
  private readonly rest: RestGet;
  private used = 0;

  constructor(private readonly options: MergerShadowOptions) {
    this.intervalMs = options.intervalMs ?? FIVE_MINUTES;
    this.prsPerScan = Math.max(1, Math.min(10, Math.floor(options.prsPerScan ?? 10)));
    this.gapMs = options.minReadGapMs ?? FIVE_MINUTES;
    this.closedPollMs = options.closedPollMs ?? HOUR;
    this.expiryMs = options.expiryMs ?? 30 * DAY;
    this.requestsPerScan = options.requestsPerScan ?? 400;
    this.limits = options.limits ?? DEFAULT_MERGER_READ_LIMITS;
    this.gateOptions = options.gateOptions ?? DEFAULT_MERGE_GATE_OPTIONS;
    // Every request of a scan is counted here, whichever read made it.
    this.graphql = async (query, variables) => { this.used += 1; return options.graphql(query, variables); };
    this.rest = async (path) => { this.used += 1; return options.rest(path); };
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
    try { this.options.log(`osstack: merger shadow: ${line}`); } catch { /* logging never affects the merger */ }
  }

  // ------------------------------------------------------------------ discovery and cadence

  private async scanOnce(): Promise<void> {
    const startedAt = this.options.now();
    const entries: MergerCycleEntry[] = [];
    const seenPrs = new Set<string>();
    this.used = 0;
    // The scan id is database-issued, taken just before the scan's first observation and shared by its cycle row and its outcomes, so the report
    // resolves "the detecting scan" by id even when another process scans at the same time.
    let scanId: number | undefined;
    const ensureScan = (): number => { scanId ??= this.options.writer.beginScan(startedAt, this.options.now()); return scanId; };
    let examined = 0;
    let touched = 0;
    scan: for (let page = 0; page < MISSION_PAGES_PER_SCAN; page += 1) {
      const rows = this.options.missions.listPrOpened(MISSION_PAGE, this.cursor);
      for (const row of rows) {
        if (this.stopped) break scan;
        if (this.skipped.has(row.mission_id)) { this.cursor = row; continue; }
        const candidate = this.candidate(row.mission_id, seenPrs);
        if (!candidate) { this.cursor = row; continue; }
        if (examined >= this.prsPerScan || this.used >= this.requestsPerScan) break scan;
        this.cursor = row;
        examined += 1;
        if (await this.cycleOne(row.mission_id, candidate.pub, candidate.last, entries, ensureScan)) touched += 1;
      }
      if (rows.length < MISSION_PAGE) { this.cursor = undefined; break; }
    }
    if (this.stopped || touched === 0 || scanId === undefined) return;
    try {
      this.options.writer.recordCycle(scanId, startedAt, this.options.now(), entries, this.options.now());
    } catch (error) {
      this.log(`cycle_unrecorded code=${errorCode(error)}`);
    }
  }

  /** The Mission's PR when it is due: registered repository, `opened` publication, not terminal, and past its minimum gap. */
  private candidate(missionId: string, seenPrs: Set<string>): { pub: ShadowMissionPublication; last: ReturnType<MergerLedgerView['latestOutcome']> } | null {
    let pub: ShadowMissionPublication | null;
    try { pub = this.options.missions.publication(missionId); } catch { this.log(`skip mission=${missionId} reason=publication_unreadable`); return null; }
    if (!pub) return this.skip(missionId, 'publication_not_opened');
    if (lower(pub.repository) !== lower(this.options.config.repository)) return this.skip(missionId, 'repository_not_registered');
    if (!REPOSITORY.test(pub.repository)) return this.skip(missionId, 'repository_invalid');
    const key = `${lower(pub.repository)}#${pub.pr_number}`;
    // Two Missions on one PR: the pure gates refuse both with G0.join_ambiguous; observing it once per scan is enough.
    if (seenPrs.has(key)) return null;
    let last: ReturnType<MergerLedgerView['latestOutcome']>;
    try { last = this.options.ledger.latestOutcome(pub.repository, pub.pr_number); } catch { this.log(`skip mission=${missionId} reason=ledger_unreadable`); return null; }
    if (last?.outcome === 'merged' || last?.outcome === 'observation_expired') return this.skip(missionId, 'terminal');
    seenPrs.add(key);
    let at = this.lastEval.get(key);
    if (last?.outcome === 'closed_unmerged') {
      // The hourly poll of a closed PR must survive restarts and other processes: the next poll is due one poll gap after the latest persisted
      // observation start. A row from before migration 55 has no marker; its durable baseline is the observation start of the closing segment
      // itself, never "now", so repeated restarts cannot keep pushing the first poll out.
      let persisted: number | null = null;
      try { persisted = this.options.ledger.lastPollAt(pub.repository, pub.pr_number); } catch { this.log(`skip mission=${missionId} reason=ledger_unreadable`); return null; }
      const baseline = persisted ?? last.observed_at;
      // A baseline in the future (a clock that was ahead when it was written and has been corrected since) must not silence the poll: it is
      // ignored, and this process anchors on its own first look instead, which it then keeps (the interval is not reset on every scan).
      const usable = baseline <= this.options.now() ? baseline : undefined;
      at = at === undefined ? (usable ?? this.options.now()) : usable === undefined ? at : Math.max(at, usable);
      this.lastEval.set(key, at);
    }
    const gap = last?.outcome === 'closed_unmerged' ? this.closedPollMs : this.gapMs;
    if (at !== undefined && this.options.now() - at < gap) return null;
    return { pub, last };
  }

  private skip(missionId: string, reason: string): null {
    this.skipped.add(missionId);
    this.log(`skip mission=${missionId} reason=${reason}`);
    return null;
  }

  // ------------------------------------------------------------------ one observation

  /** True when the PR was observed (a decision, an outcome, or a recorded failure), so the cycle row lists it. */
  private async cycleOne(
    missionId: string, pub: ShadowMissionPublication, last: ReturnType<MergerLedgerView['latestOutcome']>, entries: MergerCycleEntry[], ensureScan: () => number,
  ): Promise<boolean> {
    const { writer, missions } = this.options;
    const key = `${lower(pub.repository)}#${pub.pr_number}`;
    let evidence: MissionMergeEvidence | null;
    try { evidence = missions.deliveryEvidence(missionId); } catch { evidence = null; }
    // Set before any read so a PR whose reads keep failing is retried at the gap, never in a tight loop.
    this.lastEval.set(key, this.options.now());
    if (!evidence) { this.log(`skip mission=${missionId} reason=evidence_unreadable`); return false; }
    const parts = REPOSITORY.exec(pub.repository);
    if (!parts) return false;
    const ref: PrRef = { owner: parts[1] as string, name: parts[2] as string, number: pub.pr_number };
    const startedAt = this.options.now();
    // The observation number is taken, and committed, before the first GitHub read of the cycle (the fence of design §4.1).
    let seq: number;
    let scanId: number;
    try { scanId = ensureScan(); seq = writer.beginObservation(pub.repository, pub.pr_number, startedAt); } catch (error) { this.log(`observation_failed mission=${missionId} code=${errorCode(error)}`); return false; }
    const ctx: Ctx = { missionId, pub, ref, evidence, seq, startedAt, entries, scanId };
    if (last?.outcome === 'closed_unmerged') await this.pollClosed(ctx, last);
    else await this.evaluate(ctx);
    return true;
  }

  private async evaluate(ctx: Ctx): Promise<void> {
    const { evidence } = ctx;
    const read = await readMergeGateInput({ graphql: this.graphql, rest: this.rest, limits: this.limits }, evidence, this.options.config, this.gateOptions)
      .catch(() => ({ ok: false as const, codes: ['U.read_failed:unexpected'] }));
    const readMs = [ctx.startedAt, this.options.now()] as const;
    if (this.stopped) return;
    if (!read.ok) {
      const codes = [...new Set(read.codes.map(safeCode))];
      this.decide(ctx, { verdict: 'unevaluated', head: evidence.head, base: null, codes, gates: { start_is_base: evidence.base_head !== null && evidence.start_commit === evidence.base_head, second_read: false }, readMs });
      return;
    }
    const { snapshot } = read.input;
    if (snapshot.pr.state === 'CLOSED') { this.settleClosed(ctx, snapshot.pr.head_oid, 'closed_unmerged'); return; }
    if (snapshot.pr.state === 'MERGED') { await this.settleMerged(ctx, false); return; }
    let verdict: MergeVerdict;
    try { verdict = evaluateMergeGates(read.input, this.gateOptions); } catch {
      this.decide(ctx, { verdict: 'unevaluated', head: evidence.head, base: null, codes: ['U.read_failed:evaluate_failed'], gates: { start_is_base: false, second_read: false }, readMs });
      return;
    }
    const head = HEX.test(snapshot.pr.head_oid) ? snapshot.pr.head_oid : evidence.head;
    const base = snapshot.pr.base_tip_oid !== null && HEX.test(snapshot.pr.base_tip_oid) ? snapshot.pr.base_tip_oid : null;
    if (verdict.verdict !== 'unevaluated' && base === null) {
      this.decide(ctx, { verdict: 'unevaluated', head, base: null, codes: ['U.read_failed:base_missing'], gates: { ...verdict.gates }, readMs });
      return;
    }
    this.decide(ctx, { verdict: verdict.verdict, head, base, codes: verdict.codes, gates: { ...verdict.gates }, readMs, ...(verdict.verdict === 'would_merge' ? { request: verdict.request } : {}) });
  }

  /** Writes one decision through the fence. A stale observation (a newer cycle, possibly in another process, was accepted first) abandons this one. */
  private decide(ctx: Ctx, d: DecisionDraft, fallback = true): void {
    if (this.stopped) return;
    const { pub, evidence } = ctx;
    const gates = JSON.parse(JSON.stringify({ ...d.gates, read_ms: [...d.readMs] })) as Record<string, unknown>;
    const input: MergerDecisionInput = {
      repository: pub.repository, pr_number: pub.pr_number, mission_id: ctx.missionId, head_sha: d.head, base_sha: d.base, verdict: d.verdict, codes: d.codes, gates,
      merge_request: d.request ?? null, evidence_digest: HEX64.test(evidence.record_digest) ? evidence.record_digest : '0'.repeat(64), observed_at: ctx.startedAt,
    };
    try {
      this.options.writer.recordDecision(input, ctx.seq, this.options.now());
      ctx.entries.push([pub.repository, pub.pr_number, ctx.seq, d.head, d.verdict]);
    } catch (error) {
      const code = errorCode(error);
      // The store validates in code first; a value outside its closed schema (for example a check context with an unexpected character) must
      // stay visible as an unevaluated record, not vanish. The failed transaction rolled back, fence included, so the same number is reusable.
      if (fallback && code === 'merger_invalid_input') {
        this.decide(ctx, { verdict: 'unevaluated', head: d.head, base: null, codes: ['U.read_failed:record_rejected'], gates: { start_is_base: false, second_read: false }, readMs: d.readMs }, false);
        return;
      }
      // merger_stale_observation, merger_pr_merged and the like: this cycle is abandoned; the next one starts from a new number.
      this.log(`decision_abandoned mission=${ctx.missionId} code=${code}`);
    }
  }

  // ------------------------------------------------------------------ outcomes

  private settleClosed(ctx: Ctx, head: string, kind: 'closed_unmerged' | 'observation_expired' | 'reopened'): void {
    if (!HEX.test(head)) { this.log(`outcome_unrecorded mission=${ctx.missionId} code=head_invalid`); return; }
    this.outcome(ctx, { outcome: kind, head_at_close: head, facts: { published_head: ctx.evidence.pushed_commit } });
  }

  private async settleMerged(ctx: Ctx, reopenUnobserved: boolean): Promise<void> {
    const o = await this.readOutcome(ctx.ref, this.options.config.inspection_evidence);
    if (this.stopped) return;
    if (o?.state !== 'MERGED' || !o.mergedAt || !o.mergeCommit) { this.log(`outcome_unreadable mission=${ctx.missionId} code=merged_fields`); return; }
    if (!o.mergedBy) { this.log(`outcome_unreadable mission=${ctx.missionId} code=merged_by_missing`); return; }
    const { config } = this.options;
    const by = o.mergedBy;
    const counted = config.counted_approvers.some((a) => a.actor_id === by.id);
    const klass = by.type === 'Bot' && by.id === config.merger.actor_id ? 'merger_app'
      : by.type === 'Bot' && by.id === config.publisher.actor_id ? 'publisher_app'
      : by.type === 'User' && counted ? 'owner'
      : by.type === 'User' ? 'other_user' : 'other_bot';
    const mergedMs = Date.parse(o.mergedAt);
    // Inspection evidence (design §4.3): a counted approver's APPROVED on the head that merged, submitted before the merge. Only where the registry says approvals mean a person read the PR.
    const approved = config.inspection_evidence
      ? o.approvals.some((r) => r.author !== null && config.counted_approvers.some((a) => a.actor_id === r.author) && r.commit === o.head && r.submittedMs !== null && Number.isFinite(mergedMs) && r.submittedMs < mergedMs)
      : null;
    // A "no approval" that rests on an incomplete list would be recorded for good: wait for a complete read instead.
    if (approved === false && o.approvalsTruncated) { this.log(`outcome_unreadable mission=${ctx.missionId} code=approvals_incomplete`); return; }
    this.outcome(ctx, {
      outcome: 'merged', head_at_close: o.head, merged_at: o.mergedAt, merge_commit: o.mergeCommit, merged_by_actor_id: by.id, merged_by_type: by.type, owner_approved_head: approved,
      facts: { published_head: ctx.evidence.pushed_commit, merged_by_class: klass, ...(reopenUnobserved ? { reopen_unobserved: true } : {}) },
    });
  }

  private outcome(ctx: Ctx, o: Omit<MergerOutcomeInput, 'repository' | 'pr_number' | 'mission_id' | 'observed_at' | 'scan_id'>): void {
    if (this.stopped) return;
    try {
      this.options.writer.recordOutcome({ ...o, scan_id: ctx.scanId, repository: ctx.pub.repository, pr_number: ctx.pub.pr_number, mission_id: ctx.missionId, observed_at: ctx.startedAt }, ctx.seq, this.options.now());
      this.log(`outcome mission=${ctx.missionId} outcome=${o.outcome}`);
    } catch (error) {
      this.log(`outcome_rejected mission=${ctx.missionId} code=${errorCode(error)}`);
    }
  }

  /** Hourly poll of a PR whose latest segment is `closed_unmerged`: one field read, then a reopen, a merge, an expiry or nothing. */
  private async pollClosed(ctx: Ctx, last: MergerLatestOutcome): Promise<void> {
    const state = await this.readState(ctx.ref);
    if (this.stopped) return;
    if (!state) return;
    if (state.state === 'OPEN') { this.settleClosed(ctx, state.head, 'reopened'); return; }
    // Reopened and merged between two polls: no evaluation happened in between (design §4.3).
    if (state.state === 'MERGED') { await this.settleMerged(ctx, true); return; }
    if (this.options.now() - last.observed_at >= this.expiryMs) this.settleClosed(ctx, state.head, 'observation_expired');
  }

  private async readState(ref: PrRef): Promise<PrState | null> {
    try {
      const parsed = stateEnvelope.safeParse(await this.graphql(MERGER_PR_STATE_QUERY, { owner: ref.owner, name: ref.name, number: ref.number }));
      // Partial data next to GraphQL errors is never trusted (the gate reader does the same).
      if (parsed.success && parsed.data.errors?.length) { this.log(`state_unreadable pr=${ref.number} code=graphql_errors`); return null; }
      const pr = parsed.success ? parsed.data.data.repository?.pullRequest : null;
      if (!pr || pr.number !== ref.number) { this.log(`state_unreadable pr=${ref.number} code=malformed_response`); return null; }
      return { state: pr.state, head: pr.headRefOid };
    } catch (error) {
      this.log(`state_unreadable pr=${ref.number} code=${errorCode(error)}`);
      return null;
    }
  }

  /** `needApprovals`: page through APPROVED reviews (newest first, at most APPROVAL_PAGES pages) only where inspection evidence is wanted. */
  private async readOutcome(ref: PrRef, needApprovals: boolean): Promise<PrOutcome | null> {
    try {
      let before: string | undefined;
      let first: PrOutcome | undefined;
      const approvals: PrOutcome['approvals'][number][] = [];
      let truncated = false;
      for (let page = 0; page < APPROVAL_PAGES; page += 1) {
        const parsed = outcomeEnvelope.safeParse(await this.graphql(MERGER_PR_OUTCOME_QUERY, { owner: ref.owner, name: ref.name, number: ref.number, ...(before ? { before } : {}) }));
        if (parsed.success && parsed.data.errors?.length) { this.log(`outcome_unreadable pr=${ref.number} code=graphql_errors`); return null; }
        const pr = parsed.success ? parsed.data.data.repository?.pullRequest : null;
        if (!pr || pr.number !== ref.number) { this.log(`outcome_unreadable pr=${ref.number} code=malformed_response`); return null; }
        const by = pr.mergedBy;
        first ??= {
          state: pr.state, head: pr.headRefOid, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid ?? null,
          mergedBy: by && by.databaseId !== undefined && (by.__typename === 'User' || by.__typename === 'Bot') ? { type: by.__typename, id: by.databaseId } : null,
          approvals: [], approvalsTruncated: false,
        };
        approvals.push(...pr.reviews.nodes.map((r) => ({ id: r.databaseId, author: r.author?.__typename === 'User' ? (r.author.databaseId ?? null) : null, commit: r.commit?.oid ?? null,
          submittedMs: r.submittedAt ? Date.parse(r.submittedAt) : null })));
        const more = pr.reviews.pageInfo.hasPreviousPage && typeof pr.reviews.pageInfo.startCursor === 'string';
        if (!needApprovals || !more) { truncated = needApprovals && pr.reviews.pageInfo.hasPreviousPage; break; }
        before = pr.reviews.pageInfo.startCursor as string;
        truncated = page === APPROVAL_PAGES - 1;
      }
      return first ? { ...first, approvals, approvalsTruncated: truncated } : null;
    } catch (error) {
      this.log(`outcome_unreadable pr=${ref.number} code=${errorCode(error)}`);
      return null;
    }
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
interface Ctx {
  readonly missionId: string; readonly pub: ShadowMissionPublication; readonly ref: PrRef; readonly evidence: MissionMergeEvidence;
  readonly seq: number; readonly startedAt: number; readonly entries: MergerCycleEntry[]; readonly scanId: number;
}
interface DecisionDraft {
  readonly verdict: 'would_merge' | 'refused' | 'unevaluated'; readonly head: string; readonly base: string | null; readonly codes: readonly string[];
  readonly gates: Record<string, unknown>; readonly readMs: readonly [number, number]; readonly request?: { sha: string; merge_method: 'squash' };
}
