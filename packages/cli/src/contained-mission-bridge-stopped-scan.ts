// D7: bounded, low-frequency observation of stopped live revision chains.
import { parseStoredGrant, scanStoppedChains, type EngineeringPrincipal, type RevisionChain, type RevisionChainStore, type StoppedPrFacts } from '@osstack/core';
import { ghGraphqlTransport, type GraphqlTransport } from './contained-mission-bridge-reader.js';
import { readRevisionPr } from './contained-mission-revision-publication.js';
import { BridgeReadLimiter } from './contained-mission-bridge-read-limiter.js';
import { recordChildCancelFailure, safeReasonCode } from './contained-mission-bridge-cancel-failure.js';

const TEN_MINUTES = 600_000;
const TERMINAL = new Set(['pr_opened', 'cancelled', 'abandoned', 'failed', 'cancel_requested']);
type Cursor = { updated_at: number; chain_id: string };
export interface StoppedChainScanOptions {
  chains: Pick<RevisionChainStore, 'listStoppedLive' | 'listClosedPrLive' | 'get' | 'events' | 'appendEvent' | 'applyDecision' | 'reservations'>;
  enabled: () => boolean;
  now: () => number;
  missionState: (missionId: string) => string;
  refreshPrincipal: (principalId: string, sessionId: string) => EngineeringPrincipal;
  cancelChild: (principal: EngineeringPrincipal | null, missionId: string) => Promise<unknown>;
  readPr: (chain: RevisionChain, signal: AbortSignal) => Promise<StoppedPrFacts>;
  log: (line: string) => void;
  readLimiter?: BridgeReadLimiter;
  auditLedger?: (chain: RevisionChain, signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  initialDelayMs?: number;
  batchLimit?: number;
  minReadGapMs?: number;
}

/** The existing minimal PR query uses the host's read identity and never calls a GitHub write API. */
export function stoppedChainPrReader(transport: GraphqlTransport = ghGraphqlTransport()): (chain: RevisionChain, signal: AbortSignal) => Promise<StoppedPrFacts> {
  return async (chain, signal) => {
    if (signal.aborted) throw Error('scan_stopped');
    const pr = await readRevisionPr(chain.repository, chain.pr_number, transport);
    if (signal.aborted) throw Error('scan_stopped');
    return { pr_state: pr.state, head: pr.headRefOid, head_repository: pr.repository,
      head_ref: pr.headRefName, base_sha: pr.baseRefOid, base_ref: pr.baseRefName, complete: true };
  };
}

export class StoppedChainScanService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private cursor: Cursor | undefined;
  private closedCursor: Cursor | undefined;
  private readonly readLimiter: BridgeReadLimiter;
  private readonly abort = new AbortController();
  private readFailures = 0;
  private readonly intervalMs: number;
  private readonly gapMs: number;
  private readonly limit: number;
  constructor(private readonly options: StoppedChainScanOptions) {
    this.readLimiter = options.readLimiter ?? new BridgeReadLimiter();
    this.intervalMs = options.intervalMs ?? TEN_MINUTES;
    this.gapMs = options.minReadGapMs ?? TEN_MINUTES;
    this.limit = Math.max(1, Math.min(10, Math.floor(options.batchLimit ?? 10)));
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0 || !Number.isFinite(this.gapMs) || this.gapMs <= 0
      || !Number.isFinite(this.limit) || (options.initialDelayMs !== undefined && (!Number.isFinite(options.initialDelayMs) || options.initialDelayMs < 0))) {
      throw Error('invalid_stopped_scan_schedule');
    }
  }
  start(): void {
    if (this.started || this.stopped || !this.options.enabled()) return;
    this.started = true;
    this.schedule(this.options.initialDelayMs ?? this.intervalMs);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }
  scan(): Promise<void> {
    if (this.stopped || !this.options.enabled()) return Promise.resolve();
    if (!this.running) this.running = this.scanOnce().catch(error => this.log(`scan_failed reason=${safeReasonCode(error)}`)).finally(() => { this.running = undefined; });
    return this.running;
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan().finally(() => { if (!this.stopped && this.options.enabled()) this.schedule(this.intervalMs); });
    }, delay);
    this.timer.unref();
  }
  private log(code: string): void { try { this.options.log(`osstack: bridge stopped scan: ${code}`); } catch { /* logging is best effort */ } }
  private async requestCancel(chain: RevisionChain): Promise<void> {
    const child = chain.current_mission_id;
    if (!child || TERMINAL.has(this.options.missionState(child))) return;
    let principal: EngineeringPrincipal | null = null;
    try {
      const grant = parseStoredGrant(chain.grant_json);
      const current = this.options.refreshPrincipal(grant.principal_id, grant.client_session_id);
      if (current.stop_scopes.includes(grant.scope_id) || current.write_scopes.includes(grant.scope_id)) principal = current;
    } catch { /* Lost or invalid grant authority uses the daemon stop path. */ }
    let actor = principal?.principal_id ?? 'daemon';
    try {
      try { await this.options.cancelChild(principal, child); }
      catch (error) {
        if (!principal || safeReasonCode(error) !== 'permission_denied') throw error;
        actor = 'daemon';
        await this.options.cancelChild(null, child);
      }
      this.options.chains.appendEvent(chain.chain_id, 'child_cancel_requested', { child, principal: actor }, this.options.now());
    } catch (error) {
      recordChildCancelFailure(this.options.chains, chain.chain_id, child, error, this.options.now(), actor);
      this.log(`cancel_failed reason=${safeReasonCode(error)}`);
    }
  }
  private async sweepClosed(): Promise<void> {
    const page = this.options.chains.listClosedPrLive(this.limit, this.closedCursor);
    for (const chain of page) {
      if (this.stopped || !this.options.enabled()) return;
      try { await this.requestCancel(chain); }
      catch (error) { this.log(`chain_failed chain=${chain.chain_id} reason=${safeReasonCode(error)}`); }
    }
    this.closedCursor = page.length === this.limit ? { updated_at: page.at(-1)!.updated_at, chain_id: page.at(-1)!.chain_id } : undefined;
  }
  private async scanOnce(): Promise<void> {
    await this.sweepClosed();
    if (this.stopped || !this.options.enabled()) return;
    const report = await scanStoppedChains({ store: this.options.chains, now: this.options.now(), limit: this.limit,
      signal: this.abort.signal, ...(this.cursor ? { after: this.cursor } : {}),
      onClosed: async entry => {
        try { await this.requestCancel(this.options.chains.get(entry.chain_id)); }
        catch (error) { this.log(`chain_failed chain=${entry.chain_id} reason=${safeReasonCode(error)}`); }
      },
      readPr: async chain => {
        if (this.stopped || !this.options.enabled()) throw Error('scan_stopped');
        try {
          const facts = await this.readLimiter.run(chain.chain_id, {
            now: this.options.now, gapMs: this.gapMs, signal: this.abort.signal,
          }, async () => {
            const result = await this.options.readPr(chain, this.abort.signal);
            if (result.complete && result.pr_state === 'OPEN') await this.options.auditLedger?.(chain, this.abort.signal);
            if (!result.complete) this.readLimiter.fail(chain.chain_id, this.options.now(), this.gapMs);
            return result;
          });
          if (!facts) throw Error('read_gap');
          return facts;
        } catch (error) {
          if (!this.abort.signal.aborted && safeReasonCode(error) !== 'read_gap') {
            this.readFailures++;
            this.log(`read_failed chain=${chain.chain_id} reason=${safeReasonCode(error)} count=${this.readFailures}`);
          }
          throw error;
        }
      },
    });
    if (this.stopped || !this.options.enabled()) return;
    this.cursor = report.next_cursor ?? undefined;
  }
}
