import { statSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AttentionOwner, AttentionStore, ContainedMissionStore } from '@osstack/core';
import { DiagnosisStore, type DiagnosisRequest } from '@osstack/core/verification-intake';
import { runDiagnosis, recoverDiagnoses, type DiagnosisPorts } from './contained-mission-diagnosis.js';
import { loadRevisionIssuer } from './contained-mission-grant.js';
import { createRecheckRunPorts } from './contained-mission-local-failure-recheck-ports.js';
import { parseContainedMissionSpec } from './contained-mission-runner.js';
import { loadVerificationProfileHostConfig } from './contained-mission-verification-profile-host-config.js';

interface Options {
  diagnosis: DiagnosisStore;
  portsFor(request: DiagnosisRequest): Omit<DiagnosisPorts, 'registration'> | null;
  enabled(): boolean;
  log(line: string): void;
  intervalMs?: number;
  initialDelayMs?: number;
}

const prefix = 'osstack: local-failure diagnosis: ';
type Cursor = Pick<DiagnosisRequest, 'created_at' | 'request_id'>;
const capacity = 1000;
export class LocalFailureDiagnosisService {
  private readonly skipped = new Set<string>();
  private readonly attempted = new Set<string>();
  private readonly abort = new AbortController();
  private after: Cursor | undefined;
  private processedThrough: Cursor | undefined;
  private recovered = false;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;

  constructor(private readonly options: Options) {}

  portsFor(request: DiagnosisRequest): Omit<DiagnosisPorts, 'registration'> | null {
    return this.options.portsFor(request);
  }

  recover(): void {
    if (this.recovered) return;
    const { recovered } = recoverDiagnoses({ store: this.options.diagnosis });
    this.recovered = true;
    if (recovered.length) this.options.log(prefix + 'recovered=' + recovered.length);
  }

  start(): void {
    if (this.timer || this.abort.signal.aborted) return;
    const interval = this.options.intervalMs ?? 60_000;
    const schedule = (delay: number) => {
      this.timer = setTimeout(async () => {
        await this.runOnce();
        if (!this.abort.signal.aborted) schedule(interval);
      }, delay).unref();
    };
    schedule(this.options.initialDelayMs ?? interval);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    clearTimeout(this.timer);
    await this.active;
  }

  runOnce(): Promise<void> {
    if (this.active) return this.active;
    this.active = Promise.resolve().then(() => this.tick()).catch(() => {
      // Never propagate a store, port or logger exception from a timer.
    }).finally(() => { this.active = undefined; });
    return this.active;
  }

  private remember(ids: Set<string>, request: DiagnosisRequest): void {
    if (ids.size < capacity) {
      ids.add(request.request_id);
    } else {
      // The creation key is immutable. At capacity, retire this scanned prefix
      // instead of evicting an id that could still be registered on a later tick.
      this.processedThrough = { created_at: request.created_at, request_id: request.request_id };
      this.after = this.processedThrough;
    }
  }

  private async tick(): Promise<void> {
    const { diagnosis, enabled, portsFor, log } = this.options;
    const { signal } = this.abort;
    if (signal.aborted || !enabled()) return;
    for (let page = 0; page < 10; page++) {
      const rows = diagnosis.registered(100, this.after ?? this.processedThrough);
      for (const request of rows) {
        const id = request.request_id;
        if (this.skipped.has(id) || this.attempted.has(id)) continue;
        const ports = portsFor(request);
        if (!ports) {
          this.remember(this.skipped, request);
          continue;
        }
        if (signal.aborted) return;
        this.remember(this.attempted, request);
        this.after = undefined;
        try {
          await runDiagnosis(ports, id, signal);
        } catch {
          log(prefix + `request ${id}: run_failed`);
          return;
        }
        const { state, reason } = diagnosis.get(id);
        log(prefix + `request ${id}: ${state}${reason ? ':' + reason : ''}`);
        return;
      }
      if (rows.length < 100) { this.after = undefined; return; }
      const { created_at, request_id } = rows[rows.length - 1]!;
      this.after = { created_at, request_id };
    }
  }
}

interface FactoryDeps extends Pick<Options, 'enabled' | 'log' | 'intervalMs'>, Pick<DiagnosisPorts, 'now' | 'access' | 'prepare' | 'run'> {
  home: string;
  attention: AttentionStore;
  owner: AttentionOwner;
  missions: ContainedMissionStore;
  docker: { socketPath: string; daemonId: string; baseImageId: string };
}

export async function createLocalFailureDiagnosis(deps: FactoryDeps): Promise<LocalFailureDiagnosisService> {
  const profileHost = await loadVerificationProfileHostConfig(deps.home);
  const issuer = await loadRevisionIssuer(deps.home);
  if (!issuer) throw Error('LOCAL_FAILURE_ROUTE_ISSUER_REQUIRED');
  const diagnosis = new DiagnosisStore(deps.attention, deps.owner, deps.now);
  if (!profileHost) {
    deps.log(prefix + 'off (no bridge/verification-profile-host.json)');
    return new LocalFailureDiagnosisService({ ...deps, diagnosis, portsFor: () => null });
  }
  const journalRoot = join(deps.home, 'local-failure-diagnosis');
  try {
    await mkdir(journalRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(journalRoot);
    if (!info.isDirectory() || info.uid !== profileHost.ownerUid || (info.mode & 0o077) !== 0) throw Error();
  } catch { throw Error('LOCAL_FAILURE_DIAGNOSIS_JOURNAL_INVALID'); }

  return new LocalFailureDiagnosisService({ ...deps, diagnosis, portsFor(request) {
    let repositoryPath: string;
    try {
      repositoryPath = parseContainedMissionSpec(deps.missions.get(request.root_mission_id).spec_json).repo_path;
      if (!isAbsolute(repositoryPath) || !statSync(repositoryPath).isDirectory()) return null;
    } catch { return null; }
    return {
      ...createRecheckRunPorts({ store: deps.missions, now: deps.now, keys: () => issuer.keys,
        access: deps.access, profileHost, repositoryPath, docker: { ...deps.docker, journalRoot } }),
      ...(deps.prepare && { prepare: deps.prepare }), ...(deps.run && { run: deps.run }),
    };
  } });
}
