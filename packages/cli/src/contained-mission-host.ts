// Daemon-side host for contained Missions (W11 §4.4, §9, M6b): authorization,
// a bounded stepping loop and restart recovery over the runner. Daemon RPC and
// the `osstack mission` CLI are wired in M6c.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { processGroupEmpty, runHardenedGit, type HardenedGitContext } from '@osstack/agents';
import { scratchPath, type ContainedMission, type ContainedMissionStore, type EngineeringPrincipal } from '@osstack/core';
import { redactSecrets } from '@osstack/governance';
import { ContainedMissionRunner, parseContainedMissionSpec, type ContainedDecision, type ContainedMissionSpec } from './contained-mission-runner.js';
import { containedEvents, eventPayload, lastTransitionTo, type ContainedMissionHostPorts } from './contained-mission-ports.js';

export type ContainedHostDecision = ContainedDecision | { kind: 'retry_stop_check' };
export interface ContainedMissionHostOptions {
  ports: ContainedMissionHostPorts;
  runner?: ContainedMissionRunner;
  /** Injectable for tests; defaults to the M4 process-group probe. */
  processGroupEmpty?: (pgid: number) => boolean;
  /** Pids whose command line names this worktree; default reads `ps`. A launch the ledger never journaled is excluded only when this is empty. */
  processesForWorktree?: (worktree: string) => number[];
  /** Concurrent Mission steps across the host (default 1). */
  maxConcurrent?: number;
  /** Root every Mission worktree must live under (default: the scratch root's worktrees/). */
  worktreesRoot?: string;
  /** Page size and pages per tick; the scan resumes where the previous tick stopped. */
  scan?: { pageSize: number; maxPages: number };
}
export interface ContainedStartInput { scope_id: string; spec: ContainedMissionSpec; supersedes?: string }
export type ContainedStartRequest = Omit<ContainedMissionSpec, 'start_commit' | 'branch' | 'worktree_path'>;

const TERMINAL = new Set<ContainedMission['state']>(['pr_opened', 'cancelled', 'abandoned', 'failed']);
// States whose next move is a runner step. Halts wait for a decision; executing/verifying only exist inside a step.
const STEPPABLE = new Set<ContainedMission['state']>(['authorized', 'workspace_ready', 'candidate_ready', 'verify_failed', 'verified']);
const BRANCH = /^osstack\/mission\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_TAIL = 50; const EVENT_EXCERPT = 2_000;
const code = (error: unknown) => error instanceof Error ? (error.message.split(':')[0] ?? 'error').slice(0, 64) : 'error';

/** Resolve a start request into a full spec: `start_commit` from `base_ref` through the hardened runner, a fresh branch and worktree path. */
export async function resolveContainedMissionStart(request: ContainedStartRequest, options: { worktreesRoot?: string; git?: HardenedGitContext } = {}): Promise<ContainedMissionSpec> {
  const id = randomBytes(6).toString('hex');
  const resolved = await runHardenedGit(['rev-parse', '--verify', '--end-of-options', `${request.base_ref}^{commit}`], { ...options.git, cwd: request.repo_path });
  return { ...request, start_commit: resolved.stdout.toString('utf8').trim(), branch: `osstack/mission/${id}`, worktree_path: join(resolve(options.worktreesRoot ?? scratchPath('worktrees')), `mission-${id}`) };
}

export class ContainedMissionHost {
  readonly store: ContainedMissionStore;
  readonly runner: ContainedMissionRunner;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly groupEmpty: (pgid: number) => boolean;
  private readonly max: number;
  private readonly processes: (worktree: string) => number[];
  private readonly page: number; private readonly pages: number;
  private cursor: { created_at: number; mission_id: string } | undefined;
  private closed = false;
  constructor(private readonly options: ContainedMissionHostOptions) {
    this.store = options.ports.store; this.runner = options.runner ?? new ContainedMissionRunner(options.ports);
    this.groupEmpty = options.processGroupEmpty ?? processGroupEmpty;
    this.max = Math.max(1, Math.floor(options.maxConcurrent ?? 1));
    this.processes = options.processesForWorktree ?? processesNaming;
    this.page = options.scan?.pageSize ?? 100; this.pages = options.scan?.maxPages ?? 10;
  }

  start(principal: EngineeringPrincipal, input: ContainedStartInput): ContainedMission {
    const spec = parseContainedMissionSpec(JSON.stringify(input.spec));
    const root = resolve(this.options.worktreesRoot ?? scratchPath('worktrees'));
    const roots = [root, ...(existsSync(root) ? [realpathSync(root)] : [])];
    if (!isAbsolute(spec.worktree_path) || resolve(spec.worktree_path) !== spec.worktree_path || !roots.some(r => spec.worktree_path.startsWith(r + sep))
      || existsSync(spec.worktree_path) || !BRANCH.test(spec.branch) || !isAbsolute(spec.repo_path)) throw Error('CONTAINED_SPEC_INVALID');
    const repo = realpathSync(spec.repo_path); const stat = statSync(repo);
    return this.store.authorize(principal, { scope_id: input.scope_id, spec: spec as unknown as Record<string, unknown>, ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      claim: { repo_identity: `${repo}#${stat.dev}:${stat.ino}`, branch: spec.branch, worktree_identity: spec.worktree_path } }, this.options.ports.now());
  }

  status(principal: EngineeringPrincipal, missionId: string) {
    const mission = this.store.readable(principal, missionId);
    const tail = (this.store.db.prepare('SELECT seq,kind,created_at,payload_json FROM engineering_contained_events WHERE mission_id=? ORDER BY seq DESC LIMIT ?')
      .all(missionId, EVENT_TAIL) as Array<{ seq: number; kind: string; created_at: number; payload_json: string }>).reverse();
    return {
      mission: { ...mission, spec_json: redactSecrets(mission.spec_json) }, claim: this.store.claim(missionId), stepping: this.inFlight.has(missionId),
      events: tail.map(e => ({ seq: e.seq, kind: e.kind, created_at: e.created_at, payload: redactSecrets(e.payload_json).slice(0, EVENT_EXCERPT) })),
    };
  }

  async cancel(principal: EngineeringPrincipal, missionId: string): Promise<ContainedMission> {
    const mission = this.store.readable(principal, missionId);
    if (!principal.stop_scopes.includes(mission.scope_id) && !principal.write_scopes.includes(mission.scope_id)) throw Error('permission_denied');
    return this.runner.cancel(missionId);
  }

  async decide(principal: EngineeringPrincipal, missionId: string, decision: ContainedHostDecision): Promise<ContainedMission> {
    const mission = this.store.readable(principal, missionId);
    if (!principal.write_scopes.includes(mission.scope_id)) throw Error('permission_denied');
    if (this.inFlight.has(missionId)) throw Error('CONTAINED_MISSION_BUSY');
    let result: ContainedMission | undefined;
    await this.track(missionId, async () => {
      if (decision.kind !== 'retry_stop_check') { result = await this.runner.decide(missionId, decision); return; }
      if (mission.state !== 'stop_unknown') throw Error('CONTAINED_DECISION_NOT_ALLOWED');
      const settled = await this.settleStop(mission);
      if (!settled) throw Error('CONTAINED_STOP_UNPROVEN');
      result = settled;
    }, true);
    return result!;
  }

  /** Step each outstanding Mission at most once, never two steps for one Mission, at most `maxConcurrent` at a time. */
  async tick(): Promise<void> {
    if (this.closed) return;
    const launched: Promise<void>[] = [];
    // Resume after the last row scanned, so long-halted Missions cannot starve later ones.
    pages: for (let page = 0; page < this.pages; page++) {
      const rows = this.store.listOutstanding(this.page, this.cursor);
      for (const row of rows) {
        if (this.inFlight.size >= this.max) break pages;
        this.cursor = row;
        if (this.inFlight.has(row.mission_id)) continue;
        let state: ContainedMission['state'];
        try { state = this.store.get(row.mission_id).state; } catch { continue; }
        if (STEPPABLE.has(state)) launched.push(this.track(row.mission_id, async () => { await this.runner.step(row.mission_id); }));
      }
      if (rows.length < this.page) { this.cursor = undefined; break; }
    }
    await Promise.all(launched);
  }

  /** Restart recovery (§9) over every outstanding Mission: settle orphans from the ledger and stop proofs only. It never resumes execution. */
  async recover(): Promise<void> {
    let after: { created_at: number; mission_id: string } | undefined;
    for (;;) {
      const rows = this.store.listOutstanding(this.page, after);
      for (const row of rows) {
        if (this.inFlight.has(row.mission_id)) continue;
        try { await this.recoverOne(row.mission_id); } catch (error) { this.recordError(row.mission_id, 'recover', error); }
      }
      if (rows.length < this.page) return;
      after = rows.at(-1);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.inFlight.values());
  }

  private async recoverOne(missionId: string): Promise<void> {
    const m = this.store.get(missionId);
    if (TERMINAL.has(m.state)) {
      let current = m;
      if (current.stop_obligation === 1) {
        const proof = await this.stopProof(current);
        if (!proof) return;
        current = this.store.recordStopEvidence(missionId, current.revision, { ...proof, recovered: true }, this.options.ports.now());
      }
      if (this.store.claim(missionId).state === 'active') this.store.releaseClaim(missionId, 'terminal', this.options.ports.now());
      return;
    }
    if (m.state === 'executing' || m.state === 'verifying' || m.state === 'cancel_requested') {
      const settled = await this.settleStop(m);
      if (!settled) this.halt(m, 'stop_unknown', `${m.state}_stop_unproven_after_restart`);
      return;
    }
    if (m.state === 'stop_unknown' && m.stop_obligation === 1) await this.settleStop(m);
  }

  /** With stop proof: record it, then leave for reconciliation (or finish a cancel). Without: undefined, state unchanged. */
  private async settleStop(m: ContainedMission): Promise<ContainedMission | undefined> {
    let current = m;
    if (current.stop_obligation === 1) {
      const proof = await this.stopProof(current);
      if (!proof) return undefined;
      current = this.store.recordStopEvidence(m.mission_id, current.revision, { ...proof, recovered: true }, this.options.ports.now());
    }
    if (current.state === 'cancel_requested') return this.store.transition(m.mission_id, { if_revision: current.revision, to: 'cancelled', event: { kind: 'cancelled', payload: { recovered: true } } }, this.options.ports.now());
    return this.halt(current, 'needs_reconciliation', m.state === 'stop_unknown' ? 'stop_evidence_recovered' : `orphaned_${m.state}`);
  }

  /** Proof that the effect the Mission last opened (an executor turn or a verification) is gone. */
  private async stopProof(m: ContainedMission): Promise<Record<string, unknown> | undefined> {
    const events = containedEvents(this.store, m.mission_id);
    const opened = lastTransitionTo(events, ['executing', 'verifying']);
    if (opened < 0) return undefined;
    if (eventPayload(events[opened]!).to === 'verifying') {
      const result = await this.options.ports.verificationStopped(m);
      return result.stopped ? { stop_proof: result.proof, evidence: result.evidence } : undefined;
    }
    const started = events.slice(opened + 1).filter(e => e.kind === 'executor_started').at(-1);
    // The intent precedes the spawn, but a crash can fall between spawn and journaling: require that no process names the worktree.
    if (!started) {
      try { return this.processes(parseContainedMissionSpec(m.spec_json).worktree_path).length === 0 ? { stop_proof: 'never_launched', evidence: 'no_process_names_worktree' } : undefined; }
      catch { return undefined; }
    }
    const pgid = eventPayload(started).pgid;
    if (typeof pgid !== 'number') return undefined;
    try { return this.groupEmpty(pgid) ? { stop_proof: 'group_empty_after_restart', pgid } : undefined; } catch { return undefined; }
  }

  private halt(m: ContainedMission, to: 'needs_reconciliation' | 'stop_unknown', reason: string): ContainedMission {
    return this.store.transition(m.mission_id, { if_revision: m.revision, to, event: { kind: 'halted', payload: { reason } } }, this.options.ports.now());
  }
  private track(missionId: string, fn: () => Promise<void>, rethrow = false): Promise<void> {
    const running = (async () => {
      try { await fn(); }
      catch (error) { if (rethrow) throw error; this.recordError(missionId, 'step', error); }
      finally { this.inFlight.delete(missionId); }
    })();
    this.inFlight.set(missionId, running.catch(() => {}));
    return running;
  }
  private recordError(missionId: string, stage: string, error: unknown): void {
    try { this.store.record(missionId, 'host_step_failed', { stage, error: code(error) }, this.options.ports.now()); } catch { /* a stale owner cannot write diagnostics */ }
  }
}

/** Pids of processes whose argv mentions `worktree` (Codex is always started with `-C <worktree>`). Throws when `ps` cannot be read. */
export function processesNaming(worktree: string): number[] {
  const listing = execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  return listing.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[1]) !== process.pid && match[2]!.includes(worktree) ? [Number(match[1])] : [];
  });
}
