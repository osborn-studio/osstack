// Daemon surface for contained Missions (W11 M6c): `mission.*` RPC over the M6b host,
// authenticated by the engineering authority file, with recovery at start and a tick timer.
import { z } from 'zod';
import type { ContainedMissionStore } from '@osstack/core';
import type { EngineeringAccess } from './engineering-access.js';
import { resolveContainedMissionStart, type ContainedMissionHost } from './contained-mission-host.js';
import { parseContainedMissionSpec } from './contained-mission-runner.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: request text must not carry control characters into the ledger.
const Text = (max: number) => z.string().min(1).max(max).refine(v => !/[\u0000-\u001f\u007f]/.test(v), 'control');
const Credential = z.string().min(32).max(4096);
const MissionId = z.string().regex(/^cm_[0-9a-f-]{36}$/);
export const ContainedMissionRpcRequests = {
  'mission.start': z.object({
    credential: Credential, scope_id: Text(256), supersedes: MissionId.optional(),
    request: z.object({
      goal: z.string().min(1).max(8000), repo_path: Text(4096), base_ref: Text(256),
      allowed_paths: z.array(Text(512)).min(1).max(64), verification_paths: z.array(Text(512)).max(64).optional(),
      verify: z.object({ argv: z.array(Text(4096)).min(1).max(64) }).strict(),
      max_repair_cycles: z.number().int().min(0).max(8).optional(),
      caps: z.object({ maxFiles: z.number().int().positive(), maxChangedLines: z.number().int().positive(), maxFileBytes: z.number().int().positive(), maxTotalBytes: z.number().int().positive() }).partial().strict().optional(),
    }).strict(),
  }).strict(),
  'mission.status': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.cancel': z.object({ credential: Credential, mission_id: MissionId }).strict(),
  'mission.decide': z.object({ credential: Credential, mission_id: MissionId,
    decision: z.enum(['abandon', 'extra_repair', 'approve_publication', 'discard_changes', 'adopt_worktree', 'retry_stop_check']) }).strict(),
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
          ...(r.max_repair_cycles !== undefined ? { max_repair_cycles: r.max_repair_cycles } : {}), ...(caps ? { caps } : {}) });
        parseContainedMissionSpec(JSON.stringify(spec));
        return view(host.start(actor, { scope_id: p.scope_id, spec, ...(p.supersedes ? { supersedes: p.supersedes } : {}) }));
      }
      case 'mission.status': {
        const p = ContainedMissionRpcRequests['mission.status'].parse(params);
        return host.status(actor, p.mission_id);
      }
      case 'mission.cancel': {
        const p = ContainedMissionRpcRequests['mission.cancel'].parse(params);
        return view(await host.cancel(actor, p.mission_id));
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
}): Promise<ContainedMissionService> {
  const env = deps.env ?? process.env;
  const need = (key: string) => { const v = env[key]; if (!v) throw new Error(`contained_config_required:${key}`); return v; };
  const [{ ContainedMissionStore }, { createContainedMissionPorts }, { ContainedMissionHost }] = await Promise.all([
    import('@osstack/core'), import('./contained-mission-ports.js'), import('./contained-mission-host.js'),
  ]);
  const { join } = await import('node:path');
  const store = new ContainedMissionStore(deps.attention, deps.owner);
  const ports = createContainedMissionPorts({
    store,
    codex: { bin: need('OSSTACK_CONTAINED_CODEX_BIN'), sourceCodexHome: need('OSSTACK_CONTAINED_CODEX_HOME'),
      ...(env['OSSTACK_CONTAINED_CODEX_IDENTITY'] ? { identityBinary: env['OSSTACK_CONTAINED_CODEX_IDENTITY'] } : {}),
      ...(env['OSSTACK_CONTAINED_CODEX_MODEL'] ? { model: env['OSSTACK_CONTAINED_CODEX_MODEL'] } : {}) },
    verification: { socketPath: need('OSSTACK_CONTAINED_DOCKER_SOCKET'), daemonId: need('OSSTACK_CONTAINED_DOCKER_DAEMON_ID'),
      baseImageId: need('OSSTACK_CONTAINED_BASE_IMAGE_ID'), journalRoot: join(deps.home, 'contained-verification') },
    author: { name: env['OSSTACK_CONTAINED_AUTHOR_NAME'] ?? 'OSStack Mission', email: env['OSSTACK_CONTAINED_AUTHOR_EMAIL'] ?? 'mission@osstack.invalid' },
  });
  const host = new ContainedMissionHost({ ports });
  return new ContainedMissionService({ host, access: deps.access, draining: deps.draining });
}
