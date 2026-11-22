import type { AttentionOwner, AttentionStore } from '@osstack/core';
import { DiagnosisStore, type DiagnosisRequest } from '@osstack/core/verification-intake';
import type { DiagnosisPorts } from './contained-mission-diagnosis.js';
import { dispatchLocalFailureRepair, recoverLocalFailureDispatch, type LocalFailureDispatchPorts } from './contained-mission-local-failure-dispatch.js';

type HostPorts = Pick<LocalFailureDispatchPorts, 'store' | 'now' | 'keys' | 'access' | 'loadInstalledProfile'>;
interface Options {
  diagnosis: DiagnosisStore;
  portsFor(request: DiagnosisRequest): HostPorts | null;
  launchCaps: LocalFailureDispatchPorts['launchCaps'];
  enabled(): boolean;
  log(line: string): void;
  intervalMs?: number;
  initialDelayMs?: number;
  fault?: LocalFailureDispatchPorts['fault'];
}

type Cursor = Pick<DiagnosisRequest, 'created_at' | 'request_id'>;
const capacity = 1000;
const prefix = 'osstack: local-failure dispatch: request ';

export class LocalFailureDispatchService {
  private readonly skipped = new Set<string>();
  private readonly attempted = new Set<string>();
  private after: Cursor | undefined;
  private processedThrough: Cursor | undefined;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;

  constructor(private readonly options: Options) {}

  start(): void {
    if (this.timer || this.stopped) return;
    const interval = this.options.intervalMs ?? 60_000;
    const schedule = (delay: number) => {
      this.timer = setTimeout(async () => {
        await this.runOnce();
        if (!this.stopped) schedule(interval);
      }, delay).unref();
    };
    schedule(this.options.initialDelayMs ?? interval);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  runOnce(): Promise<void> {
    if (this.active) return this.active;
    this.active = Promise.resolve().then(() => this.tick()).catch(() => {
      // Store and logger errors cannot escape the timer.
    }).finally(() => { this.active = undefined; });
    return this.active;
  }

  private remember(ids: Set<string>, request: DiagnosisRequest): void {
    if (ids.size < capacity) ids.add(request.request_id);
    else {
      // Retire the scanned prefix so an id cannot be retried after the set fills.
      this.processedThrough = { created_at: request.created_at, request_id: request.request_id };
      this.after = this.processedThrough;
    }
  }

  private tick(): void {
    const { diagnosis, enabled, portsFor, launchCaps, fault, log } = this.options;
    if (this.stopped || !enabled()) return;
    for (let page = 0; page < 10; page++) {
      const rows = diagnosis.dispatchable(100, this.after ?? this.processedThrough);
      for (const request of rows) {
        const id = request.request_id;
        if (this.skipped.has(id) || this.attempted.has(id)) continue;
        let outcome: string;
        try {
          const ports = portsFor(request);
          if (this.stopped) return;
          if (!ports) {
            this.remember(this.skipped, request);
            continue;
          }
          if (recoverLocalFailureDispatch({ store: ports.store }, id)) outcome = 'already_dispatched';
          else {
            const { store, now, keys, access, loadInstalledProfile } = ports;
            const result = dispatchLocalFailureRepair({ store, now, keys, access, loadInstalledProfile, launchCaps, ...(fault && { fault }) }, id);
            outcome = result.status === 'dispatched' ? `dispatched ${result.dispatch_id} ${result.child_mission_id}` : `${result.status}:${result.reason}`;
          }
        } catch {
          outcome = 'dispatch_failed';
        }
        this.remember(this.attempted, request);
        this.after = undefined;
        log(prefix + id + ': ' + outcome);
        return;
      }
      if (rows.length < 100) { this.after = undefined; return; }
      const { created_at, request_id } = rows[rows.length - 1]!;
      this.after = { created_at, request_id };
    }
  }
}

interface FactoryDeps extends Pick<Options, 'enabled' | 'log' | 'launchCaps' | 'intervalMs'> {
  attention: AttentionStore;
  owner: AttentionOwner;
  now(): number;
  portsFor(request: DiagnosisRequest): Omit<DiagnosisPorts, 'registration'> | null;
}

export function createLocalFailureDispatch(deps: FactoryDeps): LocalFailureDispatchService {
  const caps = deps.launchCaps;
  if (!caps || !Number.isSafeInteger(caps.executor_seconds) || caps.executor_seconds < 1
    || !Number.isSafeInteger(caps.verify_seconds) || caps.verify_seconds < 1) throw Error('LOCAL_FAILURE_DISPATCH_CAPS_INVALID');
  return new LocalFailureDispatchService({ ...deps, diagnosis: new DiagnosisStore(deps.attention, deps.owner, deps.now) });
}
