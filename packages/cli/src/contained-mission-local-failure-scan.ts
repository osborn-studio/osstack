import type { KeyObject } from 'node:crypto';
import { verifyLocalFailureRevisionGrantSignature, type AttentionOwner, type AttentionStore, type RevisionChain, type RevisionChainStore } from '@osstack/core';
import {
  checkGrantPrincipal, checkGrantWindow, DiagnosisStore, parseLocalFailureRevisionGrant, VerificationSourceStore, type VerificationProducerPolicyV1,
} from '@osstack/core/verification-intake';
import { registerDiagnosis } from './contained-mission-diagnosis.js';
import { loadRevisionIssuer } from './contained-mission-grant.js';
import { createVerificationInstallationProof } from './contained-mission-verification-installation.js';
import { loadVerificationProducerConfig } from './contained-mission-verification-producer-config.js';
import { createVerificationRest } from './contained-mission-verification-read-transport.js';
import { readVerificationContractText, readVerificationResults, type VerificationReadDeps } from './contained-mission-verification-reader.js';
import type { EngineeringAccess } from './engineering-access.js';

export interface LocalFailureScanPorts {
  sources: VerificationSourceStore;
  diagnosis: DiagnosisStore;
  policy: VerificationProducerPolicyV1;
  repositories: ReadonlyMap<string, number>;
  rest: VerificationReadDeps['rest'];
  installationFor?: (target: { repository: string; repository_id: number }) => NonNullable<VerificationReadDeps['installationFor']>;
  keys(): ReadonlyMap<string, { public_key: KeyObject; max_validity_ms: number }>;
  access: { refresh(principalId: string, sessionId: string): { principal_id: string; client_session_id: string; write_scopes: readonly string[] } };
  now(): number;
}

export async function scanLocalFailureChain(ports: LocalFailureScanPorts, chain: RevisionChain, signal: AbortSignal) {
  if (chain.mode !== 'live' || chain.state === 'closed') return { code: 'chain_not_live' } as const;
  let grant: ReturnType<typeof parseLocalFailureRevisionGrant>;
  try { grant = parseLocalFailureRevisionGrant(chain.grant_json); }
  catch { return { code: 'grant_not_local_failure' } as const; }
  try {
    const key = ports.keys().get(grant.key_id);
    const now = ports.now();
    if (!key || !verifyLocalFailureRevisionGrantSignature(grant, key.public_key) || now < grant.issued_at
      || grant.root_mission_id !== chain.root_mission_id || grant.repository !== chain.repository
      || grant.pr_number !== chain.pr_number || grant.branch !== chain.branch || grant.base_ref !== chain.base_ref) return { code: 'grant_invalid' } as const;
    checkGrantWindow(grant, now, key.max_validity_ms, chain.budget_json);
    checkGrantPrincipal(grant, ports.access.refresh(grant.principal_id, grant.client_session_id));
  } catch { return { code: 'grant_invalid' } as const; }
  const repository_id = ports.repositories.get(chain.repository);
  if (repository_id === undefined) return { code: 'repository_unlisted' } as const;
  const target = { repository: chain.repository, repository_id, pr: chain.pr_number, branch: chain.branch,
    head: chain.published_head, base_ref: chain.base_ref, base_sha: chain.published_base };
  const { rest, policy, sources, diagnosis } = ports;
  const read = await readVerificationResults({ rest, now: () => new Date(ports.now()),
    ...(ports.installationFor && { installationFor: ports.installationFor(target) }) }, policy, target, { signal });
  if (read.status !== 'read') return { code: read.status } as const;
  if (signal.aborted) return { code: 'waiting_source' } as const;
  const entries = read.observations.length ? sources.record(read.observations, read.observed_at, ports.now()) : [];
  let registered = 0, register_failed = 0;
  for (const { observation, outcome } of entries) {
    if (signal.aborted) break;
    const result = observation.result;
    if (!observation.verdict.ok || result?.outcome !== 'failed' || outcome.decision === 'rejected') continue;
    try {
      const row = sources.registration(result.result_id)?.registered;
      if (!row || row.object_id !== observation.object_id || row.app_id !== observation.app_id
        || row.contract_digest !== observation.contract_digest || diagnosis.byResult(result.result_id)) continue;
      await registerDiagnosis({ store: diagnosis, registration: async () => {
        const contract = await readVerificationContractText({ rest }, policy, row, { signal });
        if (!contract.ok) throw Error(contract.code);
        if (signal.aborted) throw Error('verify_read_incomplete');
        return { contract_text: contract.text, root_mission_id: chain.root_mission_id, chain_id: chain.chain_id };
      } }, result.result_id, policy);
      registered++;
    } catch { register_failed++; }
  }
  const recorded = entries.filter(({ outcome }) => outcome.decision !== 'duplicate' || outcome.persist).length;
  return { code: 'read', pending: read.pending, recorded, registered, register_failed } as const;
}

interface Schedule {
  chains: Pick<RevisionChainStore, 'listOpen'>;
  ports: LocalFailureScanPorts;
  enabled(): boolean;
  log(line: string): void;
  intervalMs?: number;
  initialDelayMs?: number;
  batchLimit?: number;
}
export class LocalFailureScanService {
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | undefined;
  private started = false;
  private readonly controller = new AbortController();
  private cursor: Pick<RevisionChain, 'created_at' | 'chain_id'> | undefined;
  private readonly interval: number;
  private readonly delay: number;
  private readonly limit: number;
  constructor(private readonly options: Schedule) {
    this.interval = options.intervalMs ?? 600_000;
    this.delay = options.initialDelayMs ?? this.interval;
    const limit = options.batchLimit ?? 10;
    if (!Number.isSafeInteger(this.interval) || this.interval <= 0 || this.interval > 2_147_483_647
      || !Number.isSafeInteger(this.delay) || this.delay < 0 || this.delay > 2_147_483_647 || !Number.isSafeInteger(limit))
      throw Error('invalid_local_failure_scan_schedule');
    this.limit = Math.min(10, Math.max(1, limit));
  }
  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.schedule(this.delay);
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().then(() => { if (!this.controller.signal.aborted) this.schedule(this.interval); });
    }, delay);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.running;
  }
  runOnce(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    this.running ??= Promise.resolve().then(() => this.pass()).catch(() => this.log('scan_failed'))
      .finally(() => { this.running = undefined; });
    return this.running;
  }
  private log(message: string): void {
    try { this.options.log('osstack: local-failure scan: ' + message); } catch { /* best effort */ }
  }
  private async pass(): Promise<void> {
    const { signal } = this.controller;
    if (signal.aborted || !this.options.enabled()) return;
    const batch = this.options.chains.listOpen('live', this.limit, this.cursor);
    let scanned = 0, pending = 0, recorded = 0, registered = 0, failed = 0;
    for (const chain of batch) {
      if (signal.aborted || !this.options.enabled()) break;
      this.cursor = { created_at: chain.created_at, chain_id: chain.chain_id };
      try {
        const result = await scanLocalFailureChain(this.options.ports, chain, signal);
        if (result.code === 'read') {
          scanned++; pending += result.pending; recorded += result.recorded;
          registered += result.registered; failed += result.register_failed;
        } else if (result.code === 'waiting_source' || result.code === 'target_changed') scanned++;
      } catch { this.log(`chain ${chain.chain_id}: scan_failed`); }
    }
    if (batch.length < this.limit) this.cursor = undefined;
    if (scanned) this.log(`chains=${scanned} pending=${pending} recorded=${recorded} registered=${registered} register_failed=${failed}`);
  }
}

export async function createLocalFailureScan(deps: {
  home: string; attention: AttentionStore; owner: AttentionOwner; chains: RevisionChainStore; access: Pick<EngineeringAccess, 'refresh'>;
  enabled(): boolean; now(): number; log(line: string): void; rest?: VerificationReadDeps['rest']; fetchImpl?: typeof fetch; intervalMs?: number;
}) {
  const config = await loadVerificationProducerConfig(deps.home);
  const issuer = await loadRevisionIssuer(deps.home);
  if (!issuer) throw Error('LOCAL_FAILURE_ROUTE_ISSUER_REQUIRED');
  const { app } = config;
  return new LocalFailureScanService({ ...deps, ports: {
    sources: new VerificationSourceStore(deps.attention, deps.owner), diagnosis: new DiagnosisStore(deps.attention, deps.owner, deps.now),
    policy: config.policy, repositories: new Map(config.repositories?.map(r => [r.repository, r.repository_id])),
    rest: deps.rest ?? createVerificationRest(), keys: () => issuer.keys, access: deps.access, now: deps.now,
    ...(app && { installationFor: target => createVerificationInstallationProof(app, target, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }),
  } });
}
