// Daemon surface for contained Missions (W11 M6c): `mission.*` RPC over the M6b host,
// authenticated by the engineering authority file, with recovery at start and a tick timer.
import { z } from 'zod';
import type { ContainedMissionStore, RevisionChainStore } from '@osstack/core';
import type { EngineeringAccess } from './engineering-access.js';
import { resolveContainedMissionStart, type ContainedMissionHost } from './contained-mission-host.js';
import { SANDBOX_CI_POLICY } from './contained-mission-ci-policy.js';
import { GITHUB_CI_SANDBOX, parseContainedMissionSpec } from './contained-mission-runner.js';
import { chainEventsView } from './bridge-chain-events.js';
import type { RevisionGrantService } from './contained-mission-grant.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: request text must not carry control characters into the ledger.
const Text = (max: number) => z.string().min(1).max(max).refine(v => !/[\u0000-\u001f\u007f]/.test(v), 'control');
const Credential = z.string().min(32).max(4096);
const MissionId = z.string().regex(/^cm_[0-9a-f-]{36}$/);
const ChainId = z.string().regex(/^rc_[0-9a-f-]{36}$/);
const GrantTerms = {
  rounds: z.union([z.literal(1), z.literal(2)]).optional(), expires_ms: z.number().int().min(1).max(7 * 24 * 3_600_000).optional(),
  review_deadline_ms: z.number().int().min(60_000).max(7 * 24 * 3_600_000).optional(),
  budget: z.object({ max_executor_seconds: z.number().int().min(1).max(86_400).optional(), max_container_seconds: z.number().int().min(1).max(86_400).optional(),
    max_wall_clock_hours: z.number().int().min(1).max(168).optional() }).strict().optional(),
  key_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
};
export const ContainedMissionRpcRequests = {
  'mission.start': z.object({
    credential: Credential, scope_id: Text(256), supersedes: MissionId.optional(),
    request: z.object({
      goal: z.string().min(1).max(8000), repo_path: Text(4096), base_ref: Text(256),
      allowed_paths: z.array(Text(512)).min(1).max(64), verification_paths: z.array(Text(512)).max(64).optional(),
      verify: z.object({ argv: z.array(Text(4096)).max(64) }).strict(),
      verification_mode: z.literal('github_actions').optional(),
      max_repair_cycles: z.number().int().min(0).max(8).optional(),
      publication: z.object({ remote: Text(256), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), base: Text(256),
        draft: z.boolean(), title: Text(200).optional(), preauthorized: z.boolean().optional() }).strict().optional(),
      caps: z.object({ maxFiles: z.number().int().positive(), maxChangedLines: z.number().int().positive(), maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive() }).partial().strict().optional(),
    }).strict().refine(r => r.verification_mode ? r.verify.argv.length === 0 : r.verify.argv.length > 0, 'verification_mode'),
  }).strict(),
  'mission.status': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.cancel': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.publish_check': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.approve_ci_repair': z.object({ credential: Credential, mission_id: MissionId, candidate: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
  'mission.decide': z.object({ credential: Credential, mission_id: MissionId,
    decision: z.enum(['abandon', 'extra_repair', 'approve_publication', 'discard_changes', 'adopt_worktree', 'resume_workspace', 'retry_stop_check', 'resume_budget', 'resume_grant']) }).strict(),
  // Live revision grants (bridge phase 5-A). Handled by the lazily imported grant service; refused with `bridge_live_disabled` unless live is on.
  'mission.revision_grant_preview': z.object({ credential: Credential, mission_id: MissionId, ...GrantTerms }).strict(),
  'mission.revision_grant_renew_preview': z.object({ credential: Credential, chain_id: ChainId, ...GrantTerms }).strict(),
  'mission.grant_revisions': z.object({ credential: Credential, nonce: z.string().regex(/^[0-9a-f]{32}$/), preview_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict(),
  'mission.chain_decide': z.object({ credential: Credential, chain_id: ChainId, decision: z.enum(['abandon', 'takeover', 'reconcile']) }).strict(),
  // Shadow merger comparison report (merger design §4.3): read-only over the shadow tables.
  'mission.merger_report': z.object({ credential: Credential }).strict(),
} as const;
export type ContainedMissionRpcMethod = keyof typeof ContainedMissionRpcRequests;
/** Decisions that probe, launch an executor or write a commit: refused while draining, acknowledged without waiting. */
const PRODUCES_WORK = new Set(['extra_repair', 'discard_changes', 'adopt_worktree', 'resume_workspace', 'resume_budget', 'resume_grant']);

export interface ContainedMissionServiceOptions {
  host: ContainedMissionHost; access: EngineeringAccess;
  draining: () => boolean; tickMs?: number;
  /** How long `mission.decide` waits for a work-producing decision before acknowledging it (default 2000ms). */
  ackMs?: number;
  /** Resolves `base_ref` and picks branch/worktree; injectable for tests. */
  resolveStart?: typeof resolveContainedMissionStart;
  /** Bridge shadow reconciler (OSSTACK_BRIDGE=shadow): started after recovery, stopped on close. Never on the tick path. */
  shadow?: import('./contained-mission-bridge-shadow.js').ShadowHandle;
  /** Read-only receipt recovery. Runs in every mode, after host recovery and before any timer. */
  revisionRecovery?: (signal: AbortSignal) => Promise<void>;
  /** Independent live observation timer; no scan runs on the Mission tick path. */
  live?: Pick<import('./contained-mission-bridge-live.js').LiveReconciler, 'start' | 'stop'>;
  /** D7 stopped live-chain scan; starts after recovery and stops before the host closes. */
  stoppedScan?: Pick<import('./contained-mission-bridge-stopped-scan.js').StoppedChainScanService, 'start' | 'stop'>;
  checkRetry?: { start(): void; stop(): Promise<void> };
  githubCi?: { start(): void; stop(): Promise<void> };
  autoApproveCiRepair?: () => Promise<void>;
  /** Shadow merger (OSSTACK_MERGER=shadow): started after recovery, stopped on close. Never on the tick path. */
  merger?: import('./contained-mission-merger-shadow.js').MergerShadowHandle;
  /** Comparison report over the shadow merger tables (SELECT only). */
  mergerReport?: (readScopes: readonly string[]) => unknown;
  /** Revision-grant service (phase 5-A). Absent until live is wired (5-E): the grant methods then answer `bridge_live_disabled`. */
  grants?: Pick<RevisionGrantService, 'preview' | 'renewPreview' | 'grant' | 'chainDecide'>;
  /** Chain view for `mission.status` (live chain first, else shadow); null when the Mission has none. */
  chainOf?: (missionId: string) => ChainStatus | null;
}

/** What `mission status --json` reports as `chain`. No bodies, no digests, no identities. */
export interface ChainStatus {
  chain_id: string; mode: string; state: string; stop_reason: string | null; repository: string; pr_number: number;
  published_head: string; published_base: string; base_ref: string; updated_at: number;
  /** Live chains only (phase 5-A): rounds used, current child, and the grant without signature, digest, nonce or identities. */
  rounds_used: number; current_mission_id: string | null; review_deadline: number | null;
  grant: import('@osstack/core').GrantSummary | null;
  shadow_decisions: Array<{ head_sha: string; base_sha: string; action: string; reason: string; review_ids: number[]; observed_at: number }>;
  /** Latest chain events (allow-listed fields only, oldest first) and the chain's total event count. */
  events: import('./bridge-chain-events.js').ChainEventView[]; events_total: number; events_total_capped: boolean;
}
const STATUS_DECISIONS = 10;

export type BridgeMode = 'off' | 'shadow' | 'live';
/** `OSSTACK_BRIDGE`: unset or `0` -> off; `shadow` -> read-only shadow; `1` (live) is not implemented in phase 4; anything else is invalid. */
export function parseBridgeMode(value: string | undefined): BridgeMode {
  if (value === undefined || value === '0') return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === '1') {
    assertLiveBridgeAcceptance();
    return 'live';
  }
  throw new Error('BRIDGE_MODE_INVALID');
}

/** This release has no 5-F/5-G acceptance record. Only a reviewed code change with that evidence can open the gate. */
function assertLiveBridgeAcceptance(): void {
  throw new Error('BRIDGE_LIVE_NOT_IMPLEMENTED:acceptance_required:5-F:5-G');
}

export type MergerMode = 'off' | 'shadow';
/** `OSSTACK_MERGER`: unset or `0` -> off; `shadow` -> read-only shadow. `1` and `live` need a later ADR (merger design §1, §5.3) and fail the service
 * start with MERGER_LIVE_NOT_IMPLEMENTED; any other value fails with MERGER_MODE_INVALID (it never degrades to off). Kept here so the module stays lazy. */
export function parseMergerMode(value: string | undefined): MergerMode {
  if (value === undefined || value === '0') return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === '1' || value === 'live') throw new Error('MERGER_LIVE_NOT_IMPLEMENTED');
  throw new Error('MERGER_MODE_INVALID');
}

/** Owns the timer. RPC handlers never run a step inline: they write the ledger, and the tick advances it. */
export class ContainedMissionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;
  private readonly recoveryAbort = new AbortController();
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly background = new Set<Promise<void>>();
  constructor(private readonly options: ContainedMissionServiceOptions) {}
  get store(): ContainedMissionStore { return this.options.host.store; }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(Error('mission_unavailable'));
    // Register before invoking ports, including synchronously reentrant test or host ports.
    this.starting ??= Promise.resolve().then(async () => {
      await this.options.host.recover();
      if (this.closed) return;
      await this.options.revisionRecovery?.(this.recoveryAbort.signal);
      if (this.closed) return;
      this.options.shadow?.start();
      this.options.live?.start();
      this.options.stoppedScan?.start();
      this.options.checkRetry?.start();
      this.options.githubCi?.start();
      this.options.merger?.start();
      this.timer = setInterval(() => { void this.tick(); }, this.options.tickMs ?? 1000);
      this.timer.unref();
    });
    return this.starting;
  }
  /** One tick at a time; a slow step never overlaps the next scan. */
  tick(): Promise<void> {
    if (this.closed || this.options.draining()) return Promise.resolve();
    if (!this.ticking) {
      const work = this.options.autoApproveCiRepair
        ? this.options.autoApproveCiRepair().then(async () => { if (!this.closed && !this.options.draining()) await this.options.host.tick(); })
        : this.options.host.tick();
      this.ticking = work.catch(() => undefined).finally(() => { this.ticking = undefined; });
    }
    return this.ticking;
  }
  close(): Promise<void> {
    this.closed = true;
    this.recoveryAbort.abort();
    this.closing ??= Promise.resolve().then(async () => {
      if (this.timer) clearInterval(this.timer);
      await this.starting?.catch(() => undefined);
      // Stop all readers before closing the host ledger, even when one stop rejects.
      const stopped = await Promise.allSettled([this.options.shadow, this.options.live, this.options.stoppedScan, this.options.checkRetry, this.options.githubCi, this.options.merger]
        .map(service => Promise.resolve().then(() => service?.stop())));
      await this.ticking; await Promise.allSettled([...this.background]); await this.options.host.close();
      const failure = stopped.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.closing;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new Error('mission_unavailable');
    if (!Object.hasOwn(ContainedMissionRpcRequests, method)) throw new Error('unknown_method');
    const parsed = ContainedMissionRpcRequests[method as ContainedMissionRpcMethod].safeParse(params);
    if (!parsed.success) throw new Error('bad_request');
    const actor = this.options.access.authenticate(parsed.data.credential);
    const { host } = this.options;
    switch (method as ContainedMissionRpcMethod) {
      case 'mission.start': {
        if (this.options.draining()) throw new Error('draining');
        const p = ContainedMissionRpcRequests['mission.start'].parse(params);
        if (!actor.write_scopes.includes(p.scope_id)) throw new Error('permission_denied');
        // The authority file must stay out of the executor's reach, as for Session adoption.
        this.options.access.assertOutsideRepository(p.request.repo_path);
        const r = p.request;
        const caps = r.caps ? Object.fromEntries(Object.entries(r.caps).filter(([, v]) => v !== undefined)) as Record<string, number> : undefined;
        const spec = await (this.options.resolveStart ?? resolveContainedMissionStart)({
          goal: r.goal, repo_path: r.repo_path, base_ref: r.base_ref, allowed_paths: [...r.allowed_paths], verify: { argv: [...r.verify.argv] },
          ...(r.verification_mode ? { verification_mode: r.verification_mode } : {}),
          ...(r.verification_paths ? { verification_paths: [...r.verification_paths] } : {}),
          ...(r.max_repair_cycles !== undefined ? { max_repair_cycles: r.max_repair_cycles } : {}), ...(caps ? { caps } : {}),
          ...(r.publication ? { publication: { remote: r.publication.remote, repository: r.publication.repository, base: r.publication.base, draft: r.publication.draft,
            ...(r.publication.title ? { title: r.publication.title } : {}), ...(r.publication.preauthorized !== undefined ? { preauthorized: r.publication.preauthorized } : {}) } } : {}) });
        parseContainedMissionSpec(JSON.stringify(spec));
        return view(host.start(actor, { scope_id: p.scope_id, spec, ...(p.supersedes ? { supersedes: p.supersedes } : {}) }));
      }
      case 'mission.status': {
        const p = ContainedMissionRpcRequests['mission.status'].parse(params);
        const status = host.status(actor, p.mission_id);
        return { ...status, chain: this.options.chainOf?.(p.mission_id) ?? null };
      }
      case 'mission.cancel': {
        const p = ContainedMissionRpcRequests['mission.cancel'].parse(params);
        return view(await host.cancel(actor, p.mission_id));
      }
      case 'mission.publish_check': {
        const p = ContainedMissionRpcRequests['mission.publish_check'].parse(params);
        return host.publishCheck(actor, p.mission_id);
      }
      case 'mission.approve_ci_repair': {
        if (this.options.draining() || !this.options.githubCi) throw Error('github_ci_scope_unavailable');
        const p = ContainedMissionRpcRequests['mission.approve_ci_repair'].parse(params);
        const { approveSandboxCiRepair } = await import('./contained-mission-github-ci-approval.js');
        if (this.closed || this.options.draining() || host.isBusy(p.mission_id)) throw Error('github_ci_scope_unavailable');
        if (parseContainedMissionSpec(this.store.readable(actor, p.mission_id).spec_json).publication?.repository !== GITHUB_CI_SANDBOX) {
          throw Error('github_ci_scope_unavailable');
        }
        return view(approveSandboxCiRepair(this.store, actor, p.mission_id, p.candidate, Date.now()));
      }
      case 'mission.revision_grant_preview': case 'mission.revision_grant_renew_preview': case 'mission.grant_revisions': case 'mission.chain_decide': {
        const grants = this.options.grants;
        if (!grants) throw new Error('bridge_live_disabled');
        if (this.options.draining()) throw new Error('draining');
        const { credential: _credential, ...rest } = parsed.data as Record<string, unknown> & { credential: string };
        // exactOptionalPropertyTypes: the service takes the parsed object as is.
        if (method === 'mission.revision_grant_preview') return grants.preview(actor, rest as never);
        if (method === 'mission.revision_grant_renew_preview') return grants.renewPreview(actor, rest as never);
        if (method === 'mission.grant_revisions') return grants.grant(actor, rest as never);
        return grants.chainDecide(actor, rest as never);
      }
      case 'mission.merger_report': {
        // Read scope: the report lists only PRs of Missions in the caller's read scopes. Ids, hashes and fixed codes only.
        if (actor.read_scopes.length === 0) throw new Error('permission_denied');
        if (!this.options.mergerReport) throw new Error('merger_report_unavailable');
        return this.options.mergerReport(actor.read_scopes);
      }
      case 'mission.decide': {
        const p = ContainedMissionRpcRequests['mission.decide'].parse(params);
        if (!PRODUCES_WORK.has(p.decision)) return view(await host.decide(actor, p.mission_id, { kind: p.decision }));
        if (this.options.draining()) throw new Error('draining');
        // A work-producing decision can run for minutes: return once it is accepted or rejected, and let it continue.
        const running = host.decide(actor, p.mission_id, { kind: p.decision });
        const settled = await Promise.race([running.then(m => ({ m })), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), this.options.ackMs ?? 2000).unref())]);
        if (settled) return view(settled.m);
        const tracked: Promise<void> = running.then(() => undefined, (error: unknown) => {
          try { host.store.record(p.mission_id, 'host_decision_failed', { decision: p.decision, code: error instanceof Error ? (error.message.split(':')[0] ?? 'error').slice(0, 64) : 'error' }, Date.now()); }
          catch { /* the Mission row is the authority; a missing event never blocks recovery */ }
        }).finally(() => { this.background.delete(tracked); });
        this.background.add(tracked);
        return { accepted: true, decision: p.decision, mission: view(host.store.get(p.mission_id)) };
      }
    }
  }
}

/** Mission row without the stored spec text; status returns the full redacted view. */
function view(m: ReturnType<ContainedMissionHost['start']>) {
  const { spec_json: _spec, ...rest } = m; return rest;
}

export const HOST_PROCESS_RECHECK_MS = 60_000;

/** Daemon wiring, kept here so daemon.ts only gates and routes. Configuration is environment-only. */
export async function createContainedMissionService(deps: {
  attention: ConstructorParameters<typeof import('@osstack/core').ContainedMissionStore>[0];
  owner: ConstructorParameters<typeof import('@osstack/core').ContainedMissionStore>[1];
  access: EngineeringAccess; home: string; draining: () => boolean; env?: NodeJS.ProcessEnv;
  /** Service log lines (default: stderr). */
  log?: (line: string) => void;
  /** Test seam: how often unproven host-process records are re-checked (default `HOST_PROCESS_RECHECK_MS`). */
  hostProcessRecheckMs?: number;
  /** Test seams for the shadow reconciler; production callers pass nothing. */
  shadow?: { transport?: import('./contained-mission-bridge-reader.js').GraphqlTransport; now?: () => number };
  /** Test seam for D7's minimal PR query. */
  stoppedScan?: { transport?: import('./contained-mission-bridge-reader.js').GraphqlTransport; now?: () => number };
  /** Test seams for the shadow merger; production callers pass nothing. */
  merger?: { graphql?: import('./contained-mission-bridge-reader.js').GraphqlTransport; rest?: import('./contained-mission-merger-reader.js').RestGet; now?: () => number };
}): Promise<ContainedMissionService> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  // Fail before anything is built: live is not implemented in phase 4, and an unknown value never degrades to off.
  const bridgeMode = parseBridgeMode(env['OSSTACK_BRIDGE']);
  const mergerMode = parseMergerMode(env['OSSTACK_MERGER']);
  let registry: import('./contained-mission-bridge-registry.js').ProducerRegistryConfig | undefined;
  if (bridgeMode === 'shadow') {
    // Present but invalid -> BRIDGE_CONFIG_INVALID:producers.json:* stops the service; missing -> shadow stays off.
    registry = await (await import('./contained-mission-bridge-registry.js')).loadProducerRegistry(deps.home);
    if (!registry) log('osstack: bridge shadow: off (no bridge/producers.json)');
  }
  let mergerConfig: import('./contained-mission-merger-config.js').MergerConfig | undefined;
  if (mergerMode === 'shadow') {
    // Present but invalid -> MERGER_CONFIG_INVALID:merger.json:* stops the service; missing -> the merger stays off.
    mergerConfig = await (await import('./contained-mission-merger-config.js')).loadMergerConfig(deps.home);
    if (!mergerConfig) log('osstack: merger shadow: off (no bridge/merger.json)');
    else {
      // Both name lists must agree whenever both files exist (design §5.2), whether or not the bridge reconciler itself is on.
      const producers = registry ?? await (await import('./contained-mission-bridge-registry.js')).loadProducerRegistry(deps.home);
      if (producers && (producers.repository.toLowerCase() !== mergerConfig.repository.toLowerCase() || !producers.publisher.some((p) => p.actor_id === mergerConfig!.publisher.actor_id))) {
        throw new Error('MERGER_CONFIG_INVALID:merger.json:producers_mismatch');
      }
    }
  }
  const need = (key: string) => { const v = env[key]; if (!v) throw new Error(`contained_config_required:${key}`); return v; };
  const [{ ContainedMissionStore }, { createContainedMissionPorts }, { ContainedMissionHost }] = await Promise.all([
    import('@osstack/core'), import('./contained-mission-ports.js'), import('./contained-mission-host.js'),
  ]);
  const { join } = await import('node:path');
  const store = new ContainedMissionStore(deps.attention, deps.owner);
  // A bridge config error must stop the service (fail closed), never fall back to host credentials.
  const { assertBridgeAppInstallation, loadBridgeConfig } = await import('./contained-mission-github-app.js');
  const bridge = await loadBridgeConfig(deps.home);
  // OSSTACK_BRIDGE=0 (explicit) is a kill switch: with a bridge config present, Mission publication for that repository is refused
  // (BRIDGE_DISABLED) instead of falling back to host credentials. Read once, here; changing it needs a service restart.
  const bridgeKilled = env['OSSTACK_BRIDGE'] === '0';
  const githubCiSandboxScope = env['OSSTACK_CONTAINED_SANDBOX_CI_SCOPE'];
  const pilotMode = env['OSSTACK_CONTAINED_CI_PILOT'];
  if (pilotMode !== undefined && pilotMode !== 'shadow' && pilotMode !== 'live') throw Error('CI_PILOT_MODE_INVALID');
  if (pilotMode && (githubCiSandboxScope !== undefined || env['OSSTACK_CONTAINED_SANDBOX_CI_AUTO_GRANT'] !== undefined
    || env['OSSTACK_CONTAINED_SANDBOX_CI_MERGE_KEY'] !== undefined)) throw Error('CI_PILOT_MIXED_SCOPE');
  const pilot = pilotMode ? new (await import('./contained-mission-ci-pilot.js')).ProductionCiPilot(
    deps.home, pilotMode === 'live' && !bridgeKilled, deps.draining) : undefined;
  const scopeId = pilot?.config.scope_id ?? githubCiSandboxScope;
  const policy = pilot?.policy ?? SANDBOX_CI_POLICY;
  const pilotPolicy = pilot ? {
    ...(await import('./contained-mission-sandbox-app-e.js')).SANDBOX_MERGER_POLICY,
    repository: policy.repository, repositoryId: policy.repositoryId, ci: policy,
    installationId: pilot.config.merger_installation_id,
    qualityRulesetId: pilot.config.main_quality_ruleset_id, updateRulesetId: pilot.config.main_update_ruleset_id,
    missionRulesets: { writers: pilot.config.mission_writers_ruleset_id, history: pilot.config.mission_history_ruleset_id },
  } : undefined;
  if (pilot && (bridge?.repository !== policy.repository || bridge.publisher.installation_id !== pilot.config.publisher_installation_id
    || bridge.mission_ruleset_ids.length !== 2 || !bridge.mission_ruleset_ids.includes(pilot.config.mission_writers_ruleset_id)
    || !bridge.mission_ruleset_ids.includes(pilot.config.mission_history_ruleset_id))) throw Error('CI_PILOT_APP_CONFIGURATION_MISMATCH');
  if (pilot && bridge) {
    const { realpath } = await import('node:fs/promises');
    const mergerKey = await realpath(pilot.config.merger_key_path);
    if (mergerKey === await realpath(bridge.publisher.private_key_path) || mergerKey === await realpath(bridge.evidence.private_key_path)) {
      throw Error('CI_PILOT_APP_CONFIGURATION_MISMATCH');
    }
  }
  const autoGrantPath = env['OSSTACK_CONTAINED_SANDBOX_CI_AUTO_GRANT'];
  if (autoGrantPath !== undefined && !githubCiSandboxScope) throw Error('ci_auto_grant_scope_required');
  const autoGrant = autoGrantPath === undefined ? undefined
    : new (await import('./contained-mission-ci-auto-grant.js')).SandboxCiAutoGrant(autoGrantPath, githubCiSandboxScope!);
  const refreshCi = (principal: string, session: string) => deps.access.refresh(principal, session);
  const pilotCanWrite = (mission: import('@osstack/core').ContainedMission) => {
    try { return !!pilot?.assertWrite(store, mission, refreshCi, Date.now()); } catch { return false; }
  };
  const assertAutoGrant = (mission: import('@osstack/core').ContainedMission) => {
    const { payload_json: raw } = store.db.prepare("SELECT payload_json FROM engineering_contained_events WHERE mission_id=? AND kind='ci_auto_grant_reserved' ORDER BY seq DESC LIMIT 1")
      .get(mission.mission_id) as { payload_json?: string } | undefined ?? {};
    if (pilot) {
      const grant = pilot.assertWrite(store, mission, refreshCi, Date.now());
      if (!raw || JSON.parse(raw).digest !== grant.digest) throw Error('CI_REPAIR_STOPPED');
    } else if (raw && (!autoGrant || deps.draining() || !autoGrant.assert(store, mission, refreshCi, Date.now()).reserved)) throw Error('CI_REPAIR_STOPPED');
  };
  if (bridge && bridgeKilled) log('osstack: bridge: disabled by OSSTACK_BRIDGE=0 (Mission publication for the configured repository is refused)');
  const ports = createContainedMissionPorts({
    store, ...(bridge ? { bridge: { config: bridge, ...(bridgeKilled || pilotMode === 'shadow' ? { disabled: true } : {}) } } : {}),
    // Hold markers live in the daemon home, not the scratch root: `scratch:clean` must not turn a provable stop into an unknown one (W13 design 4.1).
    hostProcess: { markerDir: join(deps.home, 'contained', 'host-processes') },
    codex: { bin: need('OSSTACK_CONTAINED_CODEX_BIN'), sourceCodexHome: need('OSSTACK_CONTAINED_CODEX_HOME'),
      ...(env['OSSTACK_CONTAINED_CODEX_IDENTITY'] ? { identityBinary: env['OSSTACK_CONTAINED_CODEX_IDENTITY'] } : {}),
      ...(env['OSSTACK_CONTAINED_CODEX_MODEL'] ? { model: env['OSSTACK_CONTAINED_CODEX_MODEL'] } : {}) },
    ...(scopeId === undefined ? { verification: { socketPath: need('OSSTACK_CONTAINED_DOCKER_SOCKET'), daemonId: need('OSSTACK_CONTAINED_DOCKER_DAEMON_ID'),
      baseImageId: need('OSSTACK_CONTAINED_BASE_IMAGE_ID'), journalRoot: join(deps.home, 'contained-verification') } } : {
        ...(pilot && pilotPolicy && bridge ? { githubCiPilot: { scopeId: pilot.config.scope_id, policy,
          bindRoot: (actor, scope, spec) => pilot.bindNewRoot(store, actor, scope, spec, Date.now()),
          assertWrite: mission => { pilot.assertWrite(store, mission, refreshCi, Date.now()); },
          assertRemoteRules: async (branch, signal) => {
            const { assertCiPilotWriteRules } = await import('./contained-mission-sandbox-app-e-github.js');
            await assertCiPilotWriteRules(pilotPolicy, branch, signal);
          },
          assertInstallations: async signal => {
            const repository = pilotPolicy.repository;
            await Promise.all([
              assertBridgeAppInstallation(bridge.publisher, { repository, permissions: { contents: 'write', pull_requests: 'write' } }, signal),
              assertBridgeAppInstallation({ app_id: pilotPolicy.appId, installation_id: pilotPolicy.installationId,
                private_key_path: pilot.config.merger_key_path },
              { repository, permissions: { contents: 'write', pull_requests: 'read', checks: 'read' } }, signal),
            ]);
          },
        } } : { githubCiSandboxScope: scopeId }),
        githubCiAuthority: { assertAutoGrant, enabled: () => !deps.draining(), refresh: refreshCi },
      }),
    author: { name: env['OSSTACK_CONTAINED_AUTHOR_NAME'] ?? 'OSStack Mission', email: env['OSSTACK_CONTAINED_AUTHOR_EMAIL'] ?? 'mission@osstack.invalid' },
  });
  // Owner decision 2026-11-07 (W13 design section 10, decision 2): unproven host-process records are re-checked every 60 seconds.
  const host = new ContainedMissionHost({ ports, hostProcessRecheckMs: deps.hostProcessRecheckMs ?? HOST_PROCESS_RECHECK_MS });
  // Shadow bridge (appendix §5.3): independent of loadBridgeConfig above, which belongs to Mission publication. The reconciler is
  // built from a read-only Mission view, the shadow chain writer, a query-only transport and the producer registry, and nothing else.
  const { RevisionChainStore, shadowChainWriter, grantSummary } = await import('@osstack/core');
  const chainStore = new RevisionChainStore(deps.attention, deps.owner);
  let shadow: import('./contained-mission-bridge-shadow.js').ShadowHandle | undefined;
  if (bridgeMode === 'shadow' && registry) {
    const [{ ShadowReconciler, createShadowMissionView }, { ghGraphqlTransport }] = await Promise.all([
      import('./contained-mission-bridge-shadow.js'), import('./contained-mission-bridge-reader.js'),
    ]);
    shadow = new ShadowReconciler({
      missions: createShadowMissionView(store), chains: shadowChainWriter(chainStore), transport: deps.shadow?.transport ?? ghGraphqlTransport(),
      registry, now: deps.shadow?.now ?? Date.now, log,
    });
  }
  const live = bridgeMode === 'live' ? await (await import('./contained-mission-bridge-production.js')).createProductionLiveBridge({
    home: deps.home, chains: chainStore, missions: store, ports, host, access: deps.access,
    enabled: () => env['OSSTACK_BRIDGE'] === '1' && !deps.draining(), now: Date.now, log,
    launchCaps: ports.revisionLaunchCaps!,
  }) : undefined;
  // Shadow merger (design §5.3): its own factory, nothing shared with loadBridgeConfig above or with the bridge reconciler.
  const { MergerShadowStore } = await import('@osstack/core');
  const mergerStore = new MergerShadowStore(deps.attention, deps.owner);
  const merger = mergerConfig ? await createMergerShadow({ store, mergerStore, config: mergerConfig, log, ...(deps.merger ?? {}) }) : undefined;
  const mergerReport = async (readScopes: readonly string[]) => {
    const { buildMergerReport } = await import('./contained-mission-merger-report.js');
    return buildMergerReport(mergerStore.db, (deps.merger?.now ?? Date.now)(), readScopes);
  };
  const chainOf = (missionId: string): ChainStatus | null => {
    const chain = chainStore.chainForMission(missionId, 'live') ?? chainStore.chainForMission(missionId, 'shadow');
    if (!chain) return null;
    const events = chainEventsView(chainStore.db, chain.chain_id);
    return {
      rounds_used: chain.rounds_used, current_mission_id: chain.current_mission_id, review_deadline: chain.review_deadline,
      grant: chain.mode === 'live' ? grantSummary(chain.grant_json) : null,
      chain_id: chain.chain_id, mode: chain.mode, state: chain.state, stop_reason: chain.stop_reason, repository: chain.repository, pr_number: chain.pr_number,
      published_head: chain.published_head, published_base: chain.published_base, base_ref: chain.base_ref, updated_at: chain.updated_at,
      shadow_decisions: chain.mode === 'live' ? [] : chainStore.shadowDecisions(chain.chain_id).slice(-STATUS_DECISIONS).map(d => ({
        head_sha: d.head_sha, base_sha: d.base_sha, action: d.action, reason: d.reason, review_ids: JSON.parse(d.review_ids_json) as number[], observed_at: d.observed_at })),
      events: events.latest, events_total: events.total, events_total_capped: events.total_capped,
    };
  };
  // Receipt recovery is accounting for a possible prior write, so it also runs with the bridge off.
  // This adapter has only GET/GraphQL reads and constrained git reads. It cannot publish a check.
  const revisionRecovery = async (signal: AbortSignal) => {
    const [{ createReceiptReadAdapters }, { createRevisionReceiptRecovery }] = await Promise.all([
      import('./contained-mission-bridge-receipt-adapter.js'), import('./contained-mission-revision-publication.js'),
    ]);
    const read = await createReceiptReadAdapters({ signal });
    const recovery = createRevisionReceiptRecovery({ chains: chainStore, missions: store, host: ports.hostProcesses, now: Date.now, ...read, checkEnabled: false });
    let afterIntentId: string | undefined;
    while (!signal.aborted) {
      const page = await recovery.recoverPendingReceipts({ limit: 10, signal, ...(afterIntentId ? { afterIntentId } : {}) });
      if (page.complete) break;
      if (!page.afterIntentId || page.afterIntentId === afterIntentId) throw Error('receipt_recovery_cursor_stalled');
      afterIntentId = page.afterIntentId;
    }
    const { recoverBridgeLedgers, compareBridgeLedgerRange } = await import('./contained-mission-bridge-ledger.js');
    await recoverBridgeLedgers({ chains: chainStore, missions: store, remoteHead: read.remoteHead,
      compare: (repository, start, head, abort) => compareBridgeLedgerRange(repository, start, head, undefined, abort),
      now: Date.now, cancelChild: async chain => { if (chain.current_mission_id) await host.cancelFromBridge(chain.current_mission_id); } }, signal);
  };
  const appEKey = env['OSSTACK_CONTAINED_SANDBOX_CI_MERGE_KEY'];
  if (appEKey !== undefined && (!githubCiSandboxScope || bridge?.repository !== GITHUB_CI_SANDBOX)) {
    throw Error('ci_app_e_scope_required');
  }
  const githubCi = scopeId === undefined ? undefined : await (async () => {
    const { createSandboxCiObserver, createSandboxCiReader } = await import('./contained-mission-github-ci.js');
    const ci = createSandboxCiReader(policy);
    let merge: ReturnType<typeof import('./contained-mission-sandbox-ci-merge.js').createSandboxCiMerge> | undefined;
    const privateKeyPath = pilot?.config.merger_key_path ?? appEKey;
    if (privateKeyPath !== undefined) {
      const [{ createSandboxCiMerge }, { createSandboxAppEObserver, createSandboxAppEWriteAdapter }] = await Promise.all([
        import('./contained-mission-sandbox-ci-merge.js'), import('./contained-mission-sandbox-app-e-github.js'),
      ]);
      const mergerPolicy = pilotPolicy ? { policy: pilotPolicy } : {};
      const observe = createSandboxAppEObserver(mergerPolicy);
      merge = createSandboxCiMerge({ store, scopeId, now: Date.now, ci, ...mergerPolicy,
        ...(pilot ? { writeEnabled: pilotCanWrite } : {}),
        enabled: () => !bridgeKilled && !deps.draining(),
        github: signal => ({ observe, ...createSandboxAppEWriteAdapter({ privateKeyPath, signal, ...mergerPolicy }) }),
      });
    }
    return createSandboxCiObserver({ store, scopeId, enabled: () => !deps.draining(),
      now: Date.now, log, refresh: refreshCi, ci, policy, ...(pilot ? { writeEnabled: pilotCanWrite } : {}), ...(merge ? { merge } : {}) });
  })();
  const autoApproveCiRepair = autoGrant === undefined && (!pilot || pilotMode !== 'live' || bridgeKilled) ? undefined : async () => {
    const { latestCiEvent } = await import('./contained-mission-github-ci-approval.js');
    const { createSandboxCiReader, readSandboxCiJobs } = await import('./contained-mission-github-ci.js');
    const rows = store.db.prepare("SELECT * FROM engineering_contained_missions WHERE scope_id=? AND state='awaiting_decision' AND json_type(spec_json,'$.ci_repair')='object' LIMIT 16")
      .all(scopeId) as import('@osstack/core').ContainedMission[];
    for (const child of rows) {
      if (deps.draining()) return;
      if (latestCiEvent(store, child.mission_id, 'ci_repair_approval')) continue;
      try {
        if (pilot) pilot.assertWrite(store, child, refreshCi, Date.now());
        else autoGrant!.assert(store, child, refreshCi, Date.now());
        const spec = parseContainedMissionSpec(child.spec_json);
        const repair = spec.ci_repair!;
        const observed = await readSandboxCiJobs(createSandboxCiReader(policy), { pr: repair.pr, head: spec.start_commit, base: repair.base, branch: repair.branch }, AbortSignal.timeout(60000), undefined, policy);
        if (deps.draining() || observed.kind !== 'failure' || observed.job.check_run_id !== repair.check_run_id) continue;
        if (pilot) pilot.approveRepair(store, child, refreshCi, Date.now());
        else autoGrant!.approve(store, child, refreshCi, Date.now());
      } catch { /* Missing, expired, revoked or mismatched authority leaves the owner decision pending. */ }
    }
  };
  return new ContainedMissionService({ host, access: deps.access, draining: deps.draining, chainOf,
    ...(autoApproveCiRepair ? { autoApproveCiRepair } : {}), ...(githubCi ? { githubCi } : {}),
    revisionRecovery: live?.revisionRecovery ?? revisionRecovery, ...(shadow ? { shadow } : {}),
    ...(live ? { live: live.live, stoppedScan: live.stoppedScan, grants: live.grants,
      ...(live.checkRetry ? { checkRetry: live.checkRetry } : {}) } : {}), ...(merger ? { merger } : {}), mergerReport });
}

/** Production stopped-chain wiring, callable by tests while the live-mode gate remains closed. */
export async function createStoppedChainScan(deps: {
  chains: RevisionChainStore;
  missions: Pick<ContainedMissionStore, 'get'>;
  access: Pick<EngineeringAccess, 'refresh'>;
  host: Pick<ContainedMissionHost, 'cancel' | 'cancelFromBridge'>;
  enabled: () => boolean;
  log: (line: string) => void;
  transport?: import('./contained-mission-bridge-reader.js').GraphqlTransport;
  now?: () => number;
}): Promise<import('./contained-mission-bridge-stopped-scan.js').StoppedChainScanService> {
  const [{ StoppedChainScanService, stoppedChainPrReader }, { ghGraphqlTransport }] = await Promise.all([
    import('./contained-mission-bridge-stopped-scan.js'), import('./contained-mission-bridge-reader.js'),
  ]);
  return new StoppedChainScanService({
    chains: deps.chains, enabled: deps.enabled, now: deps.now ?? Date.now,
    missionState: id => deps.missions.get(id).state, refreshPrincipal: (id, session) => deps.access.refresh(id, session),
    readPr: stoppedChainPrReader(deps.transport ?? ghGraphqlTransport()),
    cancelChild: (principal, id) => principal ? deps.host.cancel(principal, id) : deps.host.cancelFromBridge(id), log: deps.log,
  });
}

/** The shadow merger's own factory: a read-only Mission view, the shadow writer, read-only transports, config and clock, and nothing else.
 * It does not call loadBridgeConfig and imports neither contained-mission-bridge.ts nor contained-mission-github-app.ts. */
export async function createMergerShadow(deps: {
  store: Pick<ContainedMissionStore, 'db' | 'get' | 'listPrOpened'>;
  mergerStore: import('@osstack/core').MergerShadowStore;
  config: import('./contained-mission-merger-config.js').MergerConfig;
  log: (line: string) => void;
  graphql?: import('./contained-mission-bridge-reader.js').GraphqlTransport;
  rest?: import('./contained-mission-merger-reader.js').RestGet;
  now?: () => number;
}): Promise<import('./contained-mission-merger-shadow.js').MergerShadowHandle> {
  const [{ mergerShadowWriter }, shadow, reader] = await Promise.all([
    import('@osstack/core'), import('./contained-mission-merger-shadow.js'), import('./contained-mission-merger-reader.js'),
  ]);
  const c = deps.config;
  return new shadow.MergerShadowReconciler({
    missions: shadow.createMergerMissionView(deps.store), ledger: shadow.createMergerLedgerView(deps.mergerStore), writer: mergerShadowWriter(deps.mergerStore),
    graphql: deps.graphql ?? reader.ghGraphqlTransport(),
    rest: deps.rest ?? reader.ghRestGetTransport({ repository: c.repository, rulesetIds: [c.main_quality_ruleset_id, c.main_update_ruleset_id, ...c.mission_ruleset_ids] }),
    config: c, now: deps.now ?? Date.now, log: deps.log,
  });
}
