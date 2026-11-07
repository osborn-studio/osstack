// Daemon surface for contained Missions (W11 M6c): `mission.*` RPC over the M6b host,
// authenticated by the engineering authority file, with recovery at start and a tick timer.
import { z } from 'zod';
import type { ContainedMissionStore } from '@osstack/core';
import type { EngineeringAccess } from './engineering-access.js';
import { resolveContainedMissionStart, type ContainedMissionHost } from './contained-mission-host.js';
import { parseContainedMissionSpec } from './contained-mission-runner.js';
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
      verify: z.object({ argv: z.array(Text(4096)).min(1).max(64) }).strict(),
      max_repair_cycles: z.number().int().min(0).max(8).optional(),
      publication: z.object({ remote: Text(256), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), base: Text(256),
        draft: z.boolean(), title: Text(200).optional(), preauthorized: z.boolean().optional() }).strict().optional(),
      caps: z.object({ maxFiles: z.number().int().positive(), maxChangedLines: z.number().int().positive(), maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive() }).partial().strict().optional(),
    }).strict(),
  }).strict(),
  'mission.status': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.cancel': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.publish_check': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.decide': z.object({ credential: Credential, mission_id: MissionId,
    decision: z.enum(['abandon', 'extra_repair', 'approve_publication', 'discard_changes', 'adopt_worktree', 'retry_stop_check']) }).strict(),
  // Live revision grants (bridge phase 5-A). Handled by the lazily imported grant service; refused with `bridge_live_disabled` unless live is on.
  'mission.revision_grant_preview': z.object({ credential: Credential, mission_id: MissionId, ...GrantTerms }).strict(),
  'mission.revision_grant_renew_preview': z.object({ credential: Credential, chain_id: ChainId, ...GrantTerms }).strict(),
  'mission.grant_revisions': z.object({ credential: Credential, nonce: z.string().regex(/^[0-9a-f]{32}$/), preview_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict(),
  'mission.chain_decide': z.object({ credential: Credential, chain_id: ChainId, decision: z.enum(['abandon', 'takeover', 'reconcile']) }).strict(),
} as const;
export type ContainedMissionRpcMethod = keyof typeof ContainedMissionRpcRequests;
/** Decisions that probe, launch an executor or write a commit: refused while draining, acknowledged without waiting. */
const PRODUCES_WORK = new Set(['extra_repair', 'discard_changes', 'adopt_worktree']);

export interface ContainedMissionServiceOptions {
  host: ContainedMissionHost; access: EngineeringAccess;
  draining: () => boolean; tickMs?: number;
  /** How long `mission.decide` waits for a work-producing decision before acknowledging it (default 2000ms). */
  ackMs?: number;
  /** Resolves `base_ref` and picks branch/worktree; injectable for tests. */
  resolveStart?: typeof resolveContainedMissionStart;
  /** Bridge shadow reconciler (OSSTACK_BRIDGE=shadow): started after recovery, stopped on close. Never on the tick path. */
  shadow?: import('./contained-mission-bridge-shadow.js').ShadowHandle;
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

export type BridgeMode = 'off' | 'shadow';
/** `OSSTACK_BRIDGE`: unset or `0` -> off; `shadow` -> read-only shadow; `1` (live) is not implemented in phase 4; anything else is invalid. */
export function parseBridgeMode(value: string | undefined): BridgeMode {
  if (value === undefined || value === '0') return 'off';
  if (value === 'shadow') return 'shadow';
  if (value === '1') throw new Error('BRIDGE_LIVE_NOT_IMPLEMENTED');
  throw new Error('BRIDGE_MODE_INVALID');
}

/** Owns the timer. RPC handlers never run a step inline: they write the ledger, and the tick advances it. */
export class ContainedMissionService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;
  private readonly background = new Set<Promise<void>>();
  constructor(private readonly options: ContainedMissionServiceOptions) {}
  get store(): ContainedMissionStore { return this.options.host.store; }

  async start(): Promise<void> {
    await this.options.host.recover();
    this.options.shadow?.start();
    this.timer = setInterval(() => { void this.tick(); }, this.options.tickMs ?? 1000);
    this.timer.unref();
  }
  /** One tick at a time; a slow step never overlaps the next scan. */
  tick(): Promise<void> {
    if (this.closed || this.options.draining()) return Promise.resolve();
    if (!this.ticking) this.ticking = this.options.host.tick().catch(() => undefined).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    await this.options.shadow?.stop();
    await this.ticking; await Promise.allSettled([...this.background]); await this.options.host.close();
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

/** Daemon wiring, kept here so daemon.ts only gates and routes. Configuration is environment-only. */
export async function createContainedMissionService(deps: {
  attention: ConstructorParameters<typeof import('@osstack/core').ContainedMissionStore>[0];
  owner: ConstructorParameters<typeof import('@osstack/core').ContainedMissionStore>[1];
  access: EngineeringAccess; home: string; draining: () => boolean; env?: NodeJS.ProcessEnv;
  /** Service log lines (default: stderr). */
  log?: (line: string) => void;
  /** Test seams for the shadow reconciler; production callers pass nothing. */
  shadow?: { transport?: import('./contained-mission-bridge-reader.js').GraphqlTransport; now?: () => number };
}): Promise<ContainedMissionService> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  // Fail before anything is built: live is not implemented in phase 4, and an unknown value never degrades to off.
  const bridgeMode = parseBridgeMode(env['OSSTACK_BRIDGE']);
  let registry: import('./contained-mission-bridge-registry.js').ProducerRegistryConfig | undefined;
  if (bridgeMode === 'shadow') {
    // Present but invalid -> BRIDGE_CONFIG_INVALID:producers.json:* stops the service; missing -> shadow stays off.
    registry = await (await import('./contained-mission-bridge-registry.js')).loadProducerRegistry(deps.home);
    if (!registry) log('osstack: bridge shadow: off (no bridge/producers.json)');
  }
  const need = (key: string) => { const v = env[key]; if (!v) throw new Error(`contained_config_required:${key}`); return v; };
  const [{ ContainedMissionStore }, { createContainedMissionPorts }, { ContainedMissionHost }] = await Promise.all([
    import('@osstack/core'), import('./contained-mission-ports.js'), import('./contained-mission-host.js'),
  ]);
  const { join } = await import('node:path');
  const store = new ContainedMissionStore(deps.attention, deps.owner);
  // A bridge config error must stop the service (fail closed), never fall back to host credentials.
  const { loadBridgeConfig } = await import('./contained-mission-github-app.js');
  const bridge = await loadBridgeConfig(deps.home);
  const ports = createContainedMissionPorts({
    store, ...(bridge ? { bridge: { config: bridge } } : {}),
    codex: { bin: need('OSSTACK_CONTAINED_CODEX_BIN'), sourceCodexHome: need('OSSTACK_CONTAINED_CODEX_HOME'),
      ...(env['OSSTACK_CONTAINED_CODEX_IDENTITY'] ? { identityBinary: env['OSSTACK_CONTAINED_CODEX_IDENTITY'] } : {}),
      ...(env['OSSTACK_CONTAINED_CODEX_MODEL'] ? { model: env['OSSTACK_CONTAINED_CODEX_MODEL'] } : {}) },
    verification: { socketPath: need('OSSTACK_CONTAINED_DOCKER_SOCKET'), daemonId: need('OSSTACK_CONTAINED_DOCKER_DAEMON_ID'),
      baseImageId: need('OSSTACK_CONTAINED_BASE_IMAGE_ID'), journalRoot: join(deps.home, 'contained-verification') },
    author: { name: env['OSSTACK_CONTAINED_AUTHOR_NAME'] ?? 'OSStack Mission', email: env['OSSTACK_CONTAINED_AUTHOR_EMAIL'] ?? 'mission@osstack.invalid' },
  });
  const host = new ContainedMissionHost({ ports });
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
  return new ContainedMissionService({ host, access: deps.access, draining: deps.draining, chainOf, ...(shadow ? { shadow } : {}) });
}
