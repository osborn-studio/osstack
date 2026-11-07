// Phase 5-E live observation service. Production wiring is a separate gate; this module does not enable live mode.
import { decideChainStep, parseStoredGrant, SAME_CHILD_RESUMABLE, type RevisionChain } from '@osstack/core';
import { normalizeSnapshot, type PullRequestRead, type PullRequestRef } from './contained-mission-bridge-reader.js';
import { dispatchRevision, type DispatchRevisionDeps } from './contained-mission-revision.js';

export interface LiveReconcilerOptions {
  dispatch: DispatchRevisionDeps;
  /** Synchronous host view, checked in the same synchronous section as the chain write. */
  isBusy: (missionId: string) => boolean;
  /** Must use the grant principal's stop permission, with the daemon fallback when revoked. */
  cancelChild: (chain: RevisionChain, reason: string, signal: AbortSignal) => Promise<void>;
  /** Read-only local ancestry check, including any required fetch. */
  headIsDescendant: (chain: RevisionChain, observedHead: string, signal: AbortSignal) => Promise<boolean>;
  log: (message: string) => void;
  /** Optional transport cancellation; late results are discarded even if the underlying reader cannot abort. */
  readPr?: (ref: PullRequestRef, signal: AbortSignal) => Promise<PullRequestRead>;
  intervalMs?: number;
  chainsPerScan?: number;
}

const IN_FLIGHT = new Set(['revision_reserved', 'revising', 'publishing']);
const HALTED = new Set(['awaiting_decision', 'needs_reconciliation', 'stop_unknown']);
const TERMINAL = new Set(['pr_opened', 'cancelled', 'abandoned', 'failed']);
const CANCEL = new Set(['external_write', 'head_regressed', 'base_changed', 'protected_set_changed', 'pr_closed', 'pr_merged', 'publish_refused:pr_head_ref_changed']);
type Cursor = { created_at: number; chain_id: string };

/** Reconcile a child's local outcome without running work or settling publication intents. */
export function syncLiveChild(deps: DispatchRevisionDeps, chainId: string, isBusy: (id: string) => boolean): void {
  const { chains, missions } = deps;
  chains.transaction(() => {
    let chain = chains.get(chainId);
    const childId = chain.current_mission_id;
    if (!childId) return;
    const child = missions.get(childId);
    if (isBusy(childId)) return;
    const now = deps.now();
    if (HALTED.has(child.state) && IN_FLIGHT.has(chain.state)) {
      const uncertain = chains.intents(chainId).some(intent => intent.child_mission_id === childId && intent.kind === 'push'
        && (intent.state === 'uncertain' || (intent.state === 'pending' && Boolean(chains.db.prepare(
          'SELECT 1 FROM engineering_host_processes WHERE intent_id=? AND released_at IS NOT NULL',
        ).get(intent.intent_id)))));
      chains.stopLive(chainId, chain.revision, uncertain ? 'intent_uncertain' : 'child_halted', now);
    }
    if (!TERMINAL.has(child.state) || child.stop_obligation !== 0) return;
    if (child.state !== 'pr_opened') {
      const reason = child.state === 'failed' ? 'child_failed' : 'child_cancelled';
      if (IN_FLIGHT.has(chain.state)) chain = chains.stopLive(chainId, chain.revision, reason, now);
      else if (chain.state === 'awaiting_decision' && SAME_CHILD_RESUMABLE.has(chain.stop_reason ?? '')) {
        chain = chains.restopLive(chainId, chain.revision, reason, now);
      }
      for (const reservation of chains.reservations(chainId)) {
        if (reservation.child_mission_id === childId && reservation.state === 'dispatched') {
          chain = chains.voidReservation(chainId, chain.revision, reservation.head_sha, `child_${child.state}`, now).chain;
        }
      }
    }
    if (missions.claim(childId).state === 'active') missions.releaseClaim(childId, 'revision_settled', now);
  });
}

export class LiveReconciler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private readonly abort = new AbortController();
  private cursor: Cursor | undefined;
  private settledCursor: Cursor | undefined;
  private readonly due = new Map<string, { at: number; failures: number }>();
  private readonly interval: number;
  private readonly limit: number;

  constructor(private readonly options: LiveReconcilerOptions) {
    this.interval = options.intervalMs ?? 60_000;
    this.limit = Math.max(1, Math.min(10, Math.floor(options.chainsPerScan ?? 10)));
    if (!Number.isFinite(this.interval) || this.interval <= 0 || !Number.isFinite(this.limit)) throw Error('invalid_live_schedule');
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  scan(): Promise<void> {
    if (this.stopped || !this.options.dispatch.enabled()) return Promise.resolve();
    if (!this.running) this.running = this.scanOnce().catch(() => this.log('scan_failed')).finally(() => { this.running = undefined; });
    return this.running;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan().finally(() => { if (!this.stopped) this.schedule(); });
    }, this.interval);
    this.timer.unref();
  }

  private active(): boolean { return !this.stopped && this.options.dispatch.enabled(); }
  private readPr(ref: PullRequestRef): Promise<PullRequestRead> {
    return this.interruptible(() => this.options.readPr ? this.options.readPr(ref, this.abort.signal) : this.options.dispatch.readPr(ref));
  }
  private interruptible<T>(operation: () => Promise<T>): Promise<T> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.reject(Error('live_stopped'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(Error('live_stopped'));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        if (signal.aborted) throw Error('live_stopped');
        return operation();
      }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private log(code: string): void { try { this.options.log(`osstack: bridge live: ${code}`); } catch { /* logging cannot stop a scan */ } }
  private async cancel(chain: RevisionChain, reason: string): Promise<void> {
    try { await this.interruptible(() => this.options.cancelChild(chain, reason, this.abort.signal)); }
    catch (error) {
      if (this.active()) {
        try { this.options.dispatch.chains.appendEvent(chain.chain_id, 'child_cancel_failed', { child: chain.current_mission_id, reason, code: 'cancel_failed' }, this.options.dispatch.now()); }
        catch { /* stale owners cannot append diagnostics */ }
      }
      throw error;
    }
  }

  private async scanOnce(): Promise<void> {
    const { chains } = this.options.dispatch;
    const rows = chains.listOpen('live', this.limit, this.cursor);
    for (const chain of rows) {
      if (!this.active()) return;
      this.cursor = { created_at: chain.created_at, chain_id: chain.chain_id };
      if ((this.due.get(chain.chain_id)?.at ?? 0) > this.options.dispatch.now()) continue;
      try { await this.cycle(chain); } catch { this.backoff(chain.chain_id); this.log('cycle_failed'); }
    }
    if (rows.length < this.limit) this.cursor = undefined;
    // Local cleanup also visits stopped and closed chains. It performs no GitHub reads; the separate D7 service owns those.
    const settled = chains.db.prepare(`SELECT * FROM engineering_revision_chains WHERE mode='live'
      AND state IN ('awaiting_decision','closed') AND current_mission_id IS NOT NULL
      AND (created_at>? OR (created_at=? AND chain_id>?)) ORDER BY created_at,chain_id LIMIT ?`)
      .all(this.settledCursor?.created_at ?? -1, this.settledCursor?.created_at ?? -1, this.settledCursor?.chain_id ?? '', this.limit) as RevisionChain[];
    for (const row of settled) {
      if (!this.active()) return;
      this.settledCursor = { created_at: row.created_at, chain_id: row.chain_id };
      if ((this.due.get(row.chain_id)?.at ?? 0) > this.options.dispatch.now()) continue;
      try {
        syncLiveChild(this.options.dispatch, row.chain_id, this.options.isBusy);
        const fresh = chains.get(row.chain_id);
        // A close can race a crash before cancellation. The transition is the durable cancellation obligation.
        const close = fresh.state === 'closed' ? chains.db.prepare(`SELECT payload_json FROM engineering_revision_chain_events
          WHERE chain_id=? AND kind='transition' ORDER BY seq DESC LIMIT 1`).get(fresh.chain_id) as { payload_json: string } | undefined : undefined;
        const reason = fresh.stop_reason ?? (close ? (JSON.parse(close.payload_json) as { reason?: string }).reason : undefined);
        const child = this.options.dispatch.missions.get(fresh.current_mission_id!);
        if (reason && CANCEL.has(reason) && !TERMINAL.has(child.state) && child.state !== 'cancel_requested') await this.cancel(fresh, reason);
      } catch { this.backoff(row.chain_id); this.log('settled_cycle_failed'); }
    }
    if (settled.length < this.limit) this.settledCursor = undefined;
  }

  private backoff(chainId: string): void {
    const failures = Math.min(6, (this.due.get(chainId)?.failures ?? 0) + 1);
    this.due.set(chainId, { failures, at: this.options.dispatch.now() + Math.min(3_600_000, this.interval * 2 ** (failures - 1)) });
  }

  private async cycle(listed: RevisionChain): Promise<void> {
    const { dispatch: deps } = this.options;
    const { chains, registry } = deps;
    this.due.set(listed.chain_id, { at: deps.now() + this.interval, failures: this.due.get(listed.chain_id)?.failures ?? 0 });
    const parts = listed.repository.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return;
    const ref = { owner: parts[0], name: parts[1], number: listed.pr_number };
    const read = await this.readPr(ref);
    if (!this.active()) return;
    if (!read.complete) { this.backoff(listed.chain_id); return; }
    // No ledger writes happen before a complete read. Backoff therefore leaves both chain and child unchanged.
    if (chains.get(listed.chain_id).revision !== listed.revision) return;
    syncLiveChild(deps, listed.chain_id, this.options.isBusy);
    let chain = chains.get(listed.chain_id);
    if (chain.state === 'closed' || chain.state === 'awaiting_decision') return;
    const snapshot = normalizeSnapshot(read, registry, deps.now());
    if (snapshot.pr_state === 'OPEN') {
      const reason = read.pr.headRefName !== chain.branch || read.pr.headRepository?.toLowerCase() !== chain.repository.toLowerCase()
        ? 'publish_refused:pr_head_ref_changed'
        : parseStoredGrant(chain.grant_json).protected_set_digest !== deps.protectedSetDigest() ? 'protected_set_changed' : undefined;
      if (reason) {
        chain = chains.stopLive(chain.chain_id, chain.revision, reason, deps.now());
        if (chain.current_mission_id) await this.cancel(chain, reason);
        this.due.set(chain.chain_id, { failures: 0, at: deps.now() + this.interval });
        return;
      }
    }
    const confirmed = chains.nextConfirmedPushHead(chain.chain_id);
    const pending = chains.intents(chain.chain_id).find(i => i.kind === 'push' && ['pending', 'uncertain'].includes(i.state)
      && i.expected_old_head === chain.published_head && i.expected_base_sha === chain.published_base && i.new_head === snapshot.head)?.new_head;
    const descendant = snapshot.head === chain.published_head || snapshot.head === confirmed || snapshot.head === pending
      ? undefined : await this.interruptible(() => this.options.headIsDescendant(chain, snapshot.head, this.abort.signal));
    if (!this.active() || chains.get(chain.chain_id).revision !== chain.revision) return;
    const view = {
      mode: chain.mode, state: chain.state, published_head: chain.published_head, published_base: chain.published_base, base_ref: chain.base_ref,
      rounds_used: chain.rounds_used, grant_rounds: parseStoredGrant(chain.grant_json).rounds, review_deadline: chain.review_deadline,
      reserved_heads: chains.reservations(chain.chain_id).map(r => r.head_sha),
    };
    const decision = decideChainStep(view, snapshot, registry, deps.now(), {
      ...(confirmed ? { confirmed_push_head: confirmed } : {}), ...(pending ? { pending_push_head: pending } : {}),
      ...(descendant === undefined ? {} : { head_is_descendant: descendant }),
    });
    if (decision.kind === 'reserve') {
      const result = await dispatchRevision({ ...deps, enabled: () => this.active(), readPr: ref => this.readPr(ref) }, chain.chain_id, { firstRead: read });
      if (result.status === 'snapshot_moved' || result.status === 'failed' || (result.status === 'no_reserve' && result.reason === 'read_incomplete')) {
        this.backoff(chain.chain_id);
        return;
      }
    } else {
      if (decision.kind === 'transition' && decision.to === 'ready_for_human') {
        const second = await this.readPr(ref);
        if (!this.active()) return;
        if (!second.complete) { this.backoff(chain.chain_id); return; }
        if (!sameRead(read, second, registry, deps.now())) return;
      }
      if (!this.active() || chains.get(chain.chain_id).revision !== chain.revision) return;
      chain = chains.applyDecision(chain.chain_id, chain.revision, decision, deps.now());
      if ((decision.kind === 'transition' || decision.kind === 'stop') && CANCEL.has(decision.reason) && chain.current_mission_id) {
        await this.cancel(chain, decision.reason);
      }
    }
    this.due.set(chain.chain_id, { failures: 0, at: deps.now() + this.interval });
  }
}

function sameRead(first: PullRequestRead, second: PullRequestRead, registry: DispatchRevisionDeps['registry'], now: number): boolean {
  if (!first.complete || !second.complete) return false;
  const a = normalizeSnapshot(first, registry, now);
  const b = normalizeSnapshot(second, registry, now);
  return a.pr_state === b.pr_state && a.head === b.head && a.base_sha === b.base_sha && a.base_ref === b.base_ref
    && JSON.stringify(a.reviews) === JSON.stringify(b.reviews);
}
