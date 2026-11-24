import type { AttentionOwner, AttentionStore, ContainedMissionStore } from '@osstack/core';
import { DiagnosisStore, LocalFailureRecheckStore, type DiagnosisRequest } from '@osstack/core/verification-intake';
import { collectLocalFailureRecheck, type RecheckCollectorDeps } from './contained-mission-local-failure-recheck-collect.js';
import { createRecheckCollectorPorts, type RecheckCollectorPortsConfig } from './contained-mission-local-failure-recheck-ports.js';
import { recoverRecheckRuns, runRecheck, type RecheckRunPorts } from './contained-mission-local-failure-recheck-run.js';

interface Options {
  missions: ContainedMissionStore;
  diagnosis: DiagnosisStore;
  runPortsFor(request: DiagnosisRequest): RecheckRunPorts | null;
  collector: Omit<RecheckCollectorDeps, 'store' | 'now' | 'signal'>;
  rearmed?: () => { recheck_id: string; request_id: string } | undefined;
  enabled(): boolean;
  now(): number;
  log(line: string): void;
  intervalMs?: number;
  initialDelayMs?: number;
  batchLimit?: number;
}

const manualTrigger = "operator";
const prefix = 'osstack: local-failure recheck: ';
export class LocalFailureRecheckService {
  private readonly attempted = new Set<string>();
  private readonly controller = new AbortController();
  private readonly limit: number;
  private cursor: { created_at: number; dispatch_id: string } | undefined;
  private active: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private recovered = false;

  constructor(private readonly options: Options) {
    const limit = options.batchLimit ?? 5;
    if (!Number.isSafeInteger(limit)) throw Error('invalid_limit');
    this.limit = Math.min(10, Math.max(1, limit));
  }

  recover(): void {
    if (this.recovered) return;
    const { diagnosis, now, log } = this.options;
    const { recovered } = recoverRecheckRuns({ store: diagnosis, now });
    this.recovered = true;
    if (recovered.length) log(prefix + 'recovered=' + recovered.length);
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    const interval = this.options.intervalMs ?? 600_000;
    const schedule = (delay: number) => {
      this.timer = setTimeout(async () => {
        await this.runOnce();
        if (!this.controller.signal.aborted) schedule(interval);
      }, delay).unref();
    };
    schedule(this.options.initialDelayMs ?? interval);
  }

  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.active;
  }

  runOnce(): Promise<void> {
    this.active ??= Promise.resolve().then(() => this.pass()).catch(() => {
      // Store and logger exceptions cannot escape the timer.
    }).finally(() => { this.active = undefined; });
    return this.active;
  }

  private async pass(): Promise<void> {
    const { diagnosis, missions, now, collector, enabled, log } = this.options;
    const { signal } = this.controller;
    if (signal.aborted) return;
    while (!signal.aborted) {
      const request = this.options.rearmed?.();
      if (!request || !enabled()) break;
      await this.startRun(request.recheck_id, request.request_id, manualTrigger, signal);
    }
    if (!enabled()) return;
    const store = new LocalFailureRecheckStore(diagnosis);
    const rows = store.collectable(this.limit, this.cursor);
    for (const row of rows) {
      if (signal.aborted || !enabled()) break;
      this.cursor = { created_at: row.created_at, dispatch_id: row.dispatch_id };
      const wasAbsent = row.recheck_id === null;
      try {
        await collectLocalFailureRecheck({ store: missions, now, signal, ...collector }, row.child_mission_id);
      } catch {
        log(prefix + `child ${row.child_mission_id}: collect_failed`);
      }
      const ledger = store.forDispatch(row.dispatch_id);
      if (!wasAbsent || !ledger) continue;
      if (ledger.state === 'reverify_pending' && !signal.aborted && enabled() && !this.attempted.has(ledger.recheck_id))
        // Only the pass that opened this row can start it automatically. Later passes and
        // restarts collect its inputs, even after a refusal; another start needs a re-arm by a person at the host.
        await this.startRun(ledger.recheck_id, row.request_id, "automatic", signal);
      break;
    }
    if (rows.length < this.limit) this.cursor = undefined;
  }

  private async startRun(id: string, requestId: string, trigger: Parameters<typeof runRecheck>[2], signal: AbortSignal): Promise<void> {
    const { diagnosis, runPortsFor, enabled, log } = this.options;
    const manual = trigger === manualTrigger;
    const label = prefix + id + ': ' + (manual ? trigger + ' ' : '');
    let ports: RecheckRunPorts | null;
    try { ports = runPortsFor(diagnosis.get(requestId)); }
    catch { ports = null; }
    if (!ports) { log(label + 'host_ports_unavailable'); return; }
    if (signal.aborted || !enabled()) return;
    if (!manual) this.attempted.add(id);
    let message: string;
    try {
      const outcome = await runRecheck(ports, id, trigger, signal);
      if (outcome.status === 'refused') message = 'refused:' + outcome.reason;
      else if (outcome.status === 'existing') message = 'existing:' + outcome.run.state;
      else {
        const { state, conclusion_state, conclusion_reason } = outcome.run;
        const conclusion = conclusion_reason ?? conclusion_state;
        message = state + (conclusion ? ':' + conclusion : '');
      }
    } catch { message = 'run_failed'; }
    log(label + message);
  }
}

interface FactoryDeps extends Pick<Options, 'missions' | 'runPortsFor' | 'enabled' | 'now' | 'log' | 'intervalMs' | 'rearmed'> {
  attention: AttentionStore;
  owner: AttentionOwner;
  contracts: Pick<RecheckCollectorDeps, 'readOriginalContract' | 'readRecheckContracts'>;
  actions?: RecheckCollectorPortsConfig['actions'];
}

export function createLocalFailureRecheck(deps: FactoryDeps): LocalFailureRecheckService {
  const diagnosis = new DiagnosisStore(deps.attention, deps.owner, deps.now);
  const collector = { ...deps.contracts, ...createRecheckCollectorPorts({ store: deps.missions, now: deps.now,
    ...(deps.actions && { actions: deps.actions }) }) };
  return new LocalFailureRecheckService({ ...deps, diagnosis, collector });
}
