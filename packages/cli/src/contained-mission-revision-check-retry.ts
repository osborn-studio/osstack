import type { ContainedMissionStore, RevisionChainStore } from '@osstack/core';

export interface RevisionCheckRetryOptions {
  chains: RevisionChainStore;
  missions: ContainedMissionStore;
  now: () => number;
  enabled: () => boolean;
  /** The shared publication port owns check deduplication and the App B sender. */
  publishCheck: (childId: string) => Promise<unknown>;
  intervalMs?: number;
  retryBaseMs?: number;
  log?: (message: string) => void;
}

/** Evidence-only recovery. Failed checks need an explicit manual retry; uncertain checks need reconciliation. */
export class RevisionCheckRetryScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  private cursor = '';
  private readonly abort = new AbortController();
  private readonly backoff = new Map<string, { attempts: number; due: number }>();
  private readonly interval: number;
  private readonly retryBase: number;

  constructor(private readonly options: RevisionCheckRetryOptions) {
    this.interval = options.intervalMs ?? 60_000;
    this.retryBase = options.retryBaseMs ?? 60_000;
    if (!Number.isFinite(this.interval) || this.interval <= 0 || !Number.isFinite(this.retryBase) || this.retryBase <= 0) throw Error('invalid_check_schedule');
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
    this.backoff.clear();
  }

  scan(): Promise<void> { return this.tick(); }

  async tick(input: { limit?: number; signal?: AbortSignal } = {}): Promise<void> {
    input.signal?.throwIfAborted();
    if (this.stopped || !this.options.enabled()) return Promise.resolve();
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return Promise.reject(Error('invalid_limit'));
    if (!this.running) this.running = this.scanOnce(limit, input.signal).finally(() => { this.running = undefined; });
    return this.running;
  }

  private active(signal?: AbortSignal): boolean {
    signal?.throwIfAborted();
    if (this.stopped || this.abort.signal.aborted || !this.options.enabled()) return false;
    this.options.chains.attention.assertOwner(this.options.chains.owner);
    return true;
  }

  private async scanOnce(limit: number, signal?: AbortSignal): Promise<void> {
    if (!this.active(signal)) return;
    const { chains, missions } = this.options;
    const page = chains.unsettledCheckIntents(this.cursor, limit);
    for (const listed of page) {
      if (!this.active(signal)) return;
      // Advance even on errors/backoff: a bad oldest row must never starve later work.
      this.cursor = listed.intent_id;
      const intent = chains.getIntent(listed.intent_id);
      const chain = chains.get(intent.chain_id);
      if (chain.mode !== 'live' || !['pending', 'uncertain'].includes(intent.state)) continue;
      if (chain.state === 'closed') {
        chains.transaction(() => {
          chains.settleIntent(intent.intent_id, 'failed', this.options.now(), 'chain_closed');
          chains.appendEvent(chain.chain_id, 'check_skipped', { child: intent.child_mission_id, reason: 'chain_closed', intent_id: intent.intent_id }, this.options.now());
        });
        this.backoff.delete(intent.intent_id);
        continue;
      }
      // An uncertain delivery is never converted into an automatic POST.
      if (intent.state !== 'pending') continue;
      const retry = this.backoff.get(intent.intent_id);
      if (retry && retry.due > this.options.now()) continue;
      try {
        const child = intent.child_mission_id ? missions.get(intent.child_mission_id) : undefined;
        const target = child ? (JSON.parse(child.spec_json) as { publish_target?: { chain_id?: string } }).publish_target : undefined;
        const binding = JSON.parse(intent.binding_json) as { external_id?: string };
        if (!child || child.state !== 'pr_opened' || child.candidate_head !== intent.new_head || target?.chain_id !== chain.chain_id
          || binding.external_id !== child.mission_id || !chains.intents(chain.chain_id).some(push => push.kind === 'push'
            && push.state === 'confirmed' && push.child_mission_id === child.mission_id && push.new_head === intent.new_head)) {
          chains.settleIntent(intent.intent_id, 'failed', this.options.now(), 'check_binding_mismatch');
          continue;
        }
        if (!this.active(signal)) return;
        await this.options.publishCheck(child.mission_id);
        this.backoff.delete(intent.intent_id);
      } catch (error) {
        // Owner loss and cancellation abort the scan; neither may append diagnostics.
        if (!this.active(signal)) return;
        if (chains.getIntent(intent.intent_id).state === 'pending') {
          const attempts = (retry?.attempts ?? 0) + 1;
          this.backoff.set(intent.intent_id, { attempts, due: this.options.now() + Math.min(3_600_000, this.retryBase * 2 ** Math.min(attempts - 1, 10)) });
        } else this.backoff.delete(intent.intent_id);
        this.options.log?.(`revision_check_retry_failed:${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    if (page.length < limit) this.cursor = '';
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch(() => this.options.log?.('revision_check_retry_scan_failed')).finally(() => { if (!this.stopped) this.schedule(); });
    }, this.interval);
    this.timer.unref();
  }
}

export function createRevisionCheckRetryScheduler(options: RevisionCheckRetryOptions): RevisionCheckRetryScheduler {
  return new RevisionCheckRetryScheduler(options);
}
