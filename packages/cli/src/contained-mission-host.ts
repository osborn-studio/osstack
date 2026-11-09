// Daemon-side host for contained Missions (W11 §4.4, §9, M6b): authorization,
// a bounded stepping loop and restart recovery over the runner. Daemon RPC and
// the `osstack mission` CLI are wired in M6c.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { classifyHostProcess, processGroupEmpty, runHardenedGit, type AgentHostProcessRecord, type HardenedGitContext } from '@osstack/agents';
import { scratchPath, type ContainedMission, type ContainedMissionStore, type EngineeringPrincipal, type HostProcessRecord } from '@osstack/core';
import { redactSecrets } from '@osstack/governance';
import { ContainedMissionRunner, parseContainedMissionSpec, type ContainedDecision, type ContainedMissionSpec } from './contained-mission-runner.js';
import { readMissionPublication, type MissionPublication } from './contained-mission-publication.js';
import { containedEvents, eventPayload, lastTransitionTo, type ContainedMissionHostPorts } from './contained-mission-ports.js';
import { PUBLICATION_RECOVERED, WORKSPACE_RECOVERED, HOST_PROCESS_UNPROVEN_PREFIX, hostOnlyObligation, hostProcessRouteOf, type HostProcessRoute } from './contained-mission-host-process.js';

export type { MissionPublication } from './contained-mission-publication.js';
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
  /**
   * Re-check host child processes that are not proven stopped every this many ms (design W13 section 10, decision 2a). Off by
   * default: that decision is still open, so recovery runs on host start and on `retry_stop_check` only.
   */
  hostProcessRecheckMs?: number;
  /** Longest wait for a host process that is still exiting during a proof (default: the classifier's 5 s). Tests shorten it. */
  hostProcessWaitMs?: number;
  /** Git context for the read-only `rev-parse` recovery runs to find a worktree's git dir. */
  git?: HardenedGitContext;
}
export interface ContainedStartInput { scope_id: string; spec: ContainedMissionSpec; supersedes?: string }
export type ContainedStartRequest = Omit<ContainedMissionSpec, 'start_commit' | 'branch' | 'worktree_path'>;

const TERMINAL = new Set<ContainedMission['state']>(['pr_opened', 'cancelled', 'abandoned', 'failed']);
// States whose next move is a runner step. Halts wait for a decision; executing/verifying only exist inside a step.
const STEPPABLE = new Set<ContainedMission['state']>(['authorized', 'workspace_ready', 'candidate_ready', 'verify_failed', 'verified', 'revalidating', 'delivering']);
const BRANCH = /^osstack\/mission\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_TAIL = 50; const EVENT_EXCERPT = 2_000;
const code = (error: unknown) => error instanceof Error ? (error.message.split(':')[0] ?? 'error').slice(0, 64) : 'error';

/** Resolve a start request into a full spec: `start_commit` from `base_ref` through the hardened runner, a fresh branch and worktree path. */
export async function resolveContainedMissionStart(request: ContainedStartRequest, options: { worktreesRoot?: string; git?: HardenedGitContext } = {}): Promise<ContainedMissionSpec> {
  const id = randomBytes(6).toString('hex');
  const resolved = await runHardenedGit(['rev-parse', '--verify', '--end-of-options', `${request.base_ref}^{commit}`], { ...options.git, cwd: request.repo_path });
  return { ...request, start_commit: resolved.stdout.toString('utf8').trim(), branch: `osstack/mission/${id}`, worktree_path: join(resolve(options.worktreesRoot ?? scratchPath('worktrees')), `mission-${id}`) };
}

/** The path, branch and repository checks every new Mission passes, and the identity of the workspace it will claim. Pure of the ledger. */
export function validateContainedStart(spec: ContainedMissionSpec, worktreesRoot?: string): { spec: ContainedMissionSpec; claim: { repo_identity: string; branch: string; worktree_identity: string } } {
  const root = resolve(worktreesRoot ?? scratchPath('worktrees'));
  if (!isAbsolute(spec.worktree_path) || resolve(spec.worktree_path) !== spec.worktree_path || existsSync(spec.worktree_path) || !BRANCH.test(spec.branch)
    || !isAbsolute(spec.repo_path) || !within(canonical(spec.worktree_path), canonical(root))) throw Error('CONTAINED_SPEC_INVALID');
  const repo = realpathSync(spec.repo_path); const stat = statSync(repo);
  return { spec, claim: { repo_identity: `${repo}#${stat.dev}:${stat.ino}`, branch: spec.branch, worktree_identity: spec.worktree_path } };
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
  private lastRecheck = 0;
  constructor(private readonly options: ContainedMissionHostOptions) {
    this.store = options.ports.store; this.runner = options.runner ?? new ContainedMissionRunner(options.ports);
    this.groupEmpty = options.processGroupEmpty ?? processGroupEmpty;
    this.max = Math.max(1, Math.floor(options.maxConcurrent ?? 1));
    this.processes = options.processesForWorktree ?? processesNaming;
    this.page = options.scan?.pageSize ?? 100; this.pages = options.scan?.maxPages ?? 10;
    this.recheckMs = options.hostProcessRecheckMs;
  }
  private readonly recheckMs: number | undefined;
  private get kit() { return this.options.ports.hostProcesses; }
  private get hp() { return this.kit.hp; }

  /** Used by live chain synchronization; includes the synchronous entry of a human decision. */
  isBusy(missionId: string): boolean { return this.inFlight.has(missionId); }

  start(principal: EngineeringPrincipal, input: ContainedStartInput): ContainedMission {
    const spec = parseContainedMissionSpec(JSON.stringify(input.spec));
    // Only the revision dispatcher builds these, and it does not come through here.
    if (spec.publish_target !== undefined || spec.revision_feedback !== undefined || spec.ci_repair !== undefined) throw Error('CONTAINED_SPEC_INVALID');
    if (spec.verification_mode && (!this.options.ports.assertStartMode || !principal.operator_scopes.includes(input.scope_id))) throw Error('permission_denied');
    this.options.ports.assertStartMode?.(input.scope_id, spec);
    const { claim } = validateContainedStart(spec, this.options.worktreesRoot);
    const authorize = () => this.store.authorize(principal, { scope_id: input.scope_id, spec: spec as unknown as Record<string, unknown>,
      ...(input.supersedes ? { supersedes: input.supersedes } : {}), claim }, this.options.ports.now());
    if (!spec.verification_mode) return authorize();
    return this.store.db.transaction(() => {
      this.store.attention.assertOwner(this.store.owner);
      const active = this.store.db.prepare(`SELECT 1 FROM engineering_contained_missions m WHERE scope_id=?
        AND json_extract(spec_json,'$.verification_mode')='github_actions' AND json_type(spec_json,'$.ci_repair') IS NULL
        AND state NOT IN ('cancelled','abandoned','failed')
        AND NOT EXISTS (SELECT 1 FROM engineering_contained_events e WHERE e.mission_id=m.mission_id
          AND e.kind IN ('ci_closed_unmerged','ci_pr_merged_observed')) LIMIT 1`).get(input.scope_id);
      if (active) throw Error('github_ci_scope_busy');
      return authorize();
    }).immediate();
  }

  status(principal: EngineeringPrincipal, missionId: string) {
    const mission = this.store.readable(principal, missionId);
    const tail = (this.store.db.prepare('SELECT seq,kind,created_at,payload_json FROM engineering_contained_events WHERE mission_id=? ORDER BY seq DESC LIMIT ?')
      .all(missionId, EVENT_TAIL) as Array<{ seq: number; kind: string; created_at: number; payload_json: string }>).reverse();
    return {
      mission: { ...mission, spec_json: redactSecrets(mission.spec_json) }, claim: this.store.claim(missionId), stepping: this.inFlight.has(missionId),
      events: tail.map(e => ({ seq: e.seq, kind: e.kind, created_at: e.created_at, payload: redactSecrets(e.payload_json).slice(0, EVENT_EXCERPT) })),
      publication: this.publication(missionId),
    };
  }

  /** The PR this Mission opened, read by event kind so it never depends on the bounded event tail. */
  publication(missionId: string): MissionPublication | null { return readMissionPublication(this.store, missionId); }

  async cancel(principal: EngineeringPrincipal, missionId: string): Promise<ContainedMission> {
    const mission = this.store.readable(principal, missionId);
    if (!principal.stop_scopes.includes(mission.scope_id) && !principal.write_scopes.includes(mission.scope_id)) throw Error('permission_denied');
    return this.runner.cancel(missionId);
  }

  /** Daemon fallback only when the grant principal has lost stop permission. */
  async cancelFromBridge(missionId: string): Promise<ContainedMission> {
    return this.runner.cancel(missionId);
  }

  /** Re-publish the `osstack/verify` check of a pr_opened Mission. Needs write scope; never touches the branch or PR. */
  async publishCheck(principal: EngineeringPrincipal, missionId: string): Promise<{ check_run_id: number; created: boolean }> {
    const mission = this.store.readable(principal, missionId);
    if (!principal.write_scopes.includes(mission.scope_id)) throw Error('permission_denied');
    if (mission.state !== 'pr_opened') throw Error('mission_not_pr_opened');
    if (!this.options.ports.publishVerifyCheck) throw Error('bridge_not_configured');
    return this.runner.retryVerifyCheck(missionId);
  }

  async decide(principal: EngineeringPrincipal, missionId: string, decision: ContainedHostDecision): Promise<ContainedMission> {
    const mission = this.store.readable(principal, missionId);
    if (!principal.write_scopes.includes(mission.scope_id)) throw Error('permission_denied');
    if (this.inFlight.has(missionId)) throw Error('CONTAINED_MISSION_BUSY');
    let result: ContainedMission | undefined;
    await this.track(missionId, async () => {
      if (decision.kind !== 'retry_stop_check') { result = await this.runner.decide(missionId, decision); return; }
      if (mission.state === 'stop_unknown' || mission.state === 'cancel_requested') {
        const settled = await this.settleStop(mission);
        if (!settled) throw Error('CONTAINED_STOP_UNPROVEN');
        result = settled;
      } else if (TERMINAL.has(mission.state) && this.hp.hasOpen(missionId)) {
        // A terminal Mission keeps its claim while a host process is unproven; this is the only way to settle it by hand.
        await this.recoverOne(missionId);
        if (this.hp.hasOpen(missionId)) throw Error('CONTAINED_STOP_UNPROVEN');
        result = this.store.get(missionId);
      } else throw Error('CONTAINED_DECISION_NOT_ALLOWED');
    }, true);
    return result!;
  }

  /** Step each outstanding Mission at most once, never two steps for one Mission, at most `maxConcurrent` at a time. */
  async tick(): Promise<void> {
    if (this.closed) return;
    const launched: Promise<void>[] = [];
    if (this.recheckMs !== undefined && Date.now() - this.lastRecheck >= this.recheckMs) {
      this.lastRecheck = Date.now();
      for (const missionId of await this.recheckCandidates()) launched.push(this.track(missionId, async () => { await this.recoverOne(missionId); }));
    }
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
    this.sweepOrphanMarkers();
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
    // Host child processes first (W13 section 5): nothing below may release a claim, clear an obligation or move on while one is unproven.
    const unproven = await this.proveHostProcesses(m);
    if (TERMINAL.has(m.state)) {
      if (unproven.length > 0) return;
      let current = m;
      if (current.stop_obligation === 1) {
        // An obligation only a host process caused (abandon from a host-only stop_unknown) needs no executor proof, only the host proofs above.
        const hostOnly = hostOnlyObligation(containedEvents(this.store, missionId));
        const proof = hostOnly ? { recovered_by: 'host_process_proofs' } : await this.stopProof(current);
        if (!proof) return;
        current = this.store.recordStopEvidence(missionId, current.revision, { ...proof, recovered: true, ...this.hostEvidence(missionId) }, this.options.ports.now());
      }
      if (this.store.claim(missionId).state === 'active') this.store.releaseClaim(missionId, 'terminal', this.options.ports.now());
      return;
    }
    if (unproven.length > 0) {
      if (m.state !== 'stop_unknown') this.haltHostUnproven(m, unproven[0]!.op_id);
      return;
    }
    if (m.state === 'executing' || m.state === 'verifying' || m.state === 'cancel_requested') {
      const settled = await this.settleStop(m, true);
      if (!settled) this.halt(m, 'stop_unknown', `${m.state}_stop_unproven_after_restart`);
      return;
    }
    // Includes `stop_unknown` with no obligation left: a crash between the two commits of the old exit leaves exactly that.
    if (m.state === 'stop_unknown') { await this.settleStop(m, true); return; }
    // An interrupted workspace creation (a journaled worktree add) is never retried blindly: a person checks what it left (`resume_workspace`).
    if (m.state === 'authorized' && this.hp.stoppedProofs(missionId).length > 0) {
      this.hp.settleStopped(missionId, m.revision, { recovered: true, ...this.hostEvidence(missionId) },
        { to: 'awaiting_decision', event: { kind: 'halted', payload: { reason: WORKSPACE_RECOVERED } } });
    }
  }

  /**
   * With stop proof: record it, then leave for reconciliation (or finish a cancel). Without: undefined, state unchanged.
   * Every host child process of the Mission must be proven stopped first; `proved` says recovery already did that.
   */
  private async settleStop(m: ContainedMission, proved = false): Promise<ContainedMission | undefined> {
    if (!proved && (await this.proveHostProcesses(m)).length > 0) return undefined;
    const halt = m.state === 'stop_unknown' ? this.lastHalt(m) : undefined;
    // An obligation that only a host process caused owes no executor or verification proof (also after a cancel moved the Mission on).
    const hostOnly = hostOnlyObligation(containedEvents(this.store, m.mission_id));
    let evidence: Record<string, unknown> = { recovered: true };
    if (m.stop_obligation === 1 && !hostOnly) {
      const proof = await this.stopProof(m);
      if (!proof) return undefined;
      evidence = { ...proof, recovered: true };
    }
    evidence = { ...evidence, ...this.hostEvidence(m.mission_id) };
    if (m.state === 'stop_unknown') return this.leaveStopUnknown(m, halt?.route ?? 'default', evidence);
    let current = m;
    if (current.stop_obligation === 1) current = this.store.recordStopEvidence(m.mission_id, current.revision, evidence, this.options.ports.now());
    if (current.state === 'cancel_requested') return this.store.transition(m.mission_id, { if_revision: current.revision, to: 'cancelled', event: { kind: 'cancelled', payload: { recovered: true } } }, this.options.ports.now());
    return this.halt(current, 'needs_reconciliation', `orphaned_${m.state}`);
  }

  /** Clear the obligation and leave `stop_unknown` in one owner transaction (W13 section 5.5), by the route recorded when it was entered. */
  private leaveStopUnknown(m: ContainedMission, route: HostProcessRoute, evidence: Record<string, unknown>): ContainedMission {
    const cancel = this.cancelPending(m);
    const reason = route === 'delivering' ? PUBLICATION_RECOVERED : route === 'authorized' ? WORKSPACE_RECOVERED : 'stop_evidence_recovered';
    const exit = cancel
      ? { to: 'cancel_requested' as const, event: { kind: 'cancel_requested', payload: { recovered: true } } }
      : { to: route === 'default' ? 'needs_reconciliation' as const : 'awaiting_decision' as const, event: { kind: 'halted', payload: { reason } } };
    const settled = this.hp.settleStopped(m.mission_id, m.revision, evidence, exit);
    // The cancel completes in its own commit; a crash in between leaves `cancel_requested` with nothing owed, which recovery finishes.
    if (cancel) return this.store.transition(m.mission_id, { if_revision: settled.revision, to: 'cancelled', event: { kind: 'cancelled', payload: { recovered: true } } }, this.options.ports.now());
    return settled;
  }

  /**
   * Prove, or fail to prove, that each open host child process of the Mission is gone (design W13 section 5.2). Observation only:
   * nothing here signals a process. Returns the records still unproven.
   */
  private async proveHostProcesses(m: ContainedMission): Promise<HostProcessRecord[]> {
    const unproven: HostProcessRecord[] = [];
    const waitMs = this.options.hostProcessWaitMs;
    for (const row of this.hp.open(m.mission_id)) {
      const verdict = await classifyHostProcess(classifiable(row), this.kit.probe, waitMs === undefined ? {} : { waitMs, pollMs: Math.max(1, Math.min(250, waitMs)) });
      if (verdict.kind !== 'stopped') {
        unproven.push(row);
        this.hp.recordUnproven(row.op_id, verdict.reason);
        continue;
      }
      // Cleanup first (against the moment of proof), so a crash or a failed removal leaves the row open and the next recovery cleans again.
      if (row.kind === 'git_index_write' && !(await this.clearStaleIndexLock(m, row, Date.now()))) {
        unproven.push(row);
        this.hp.recordUnproven(row.op_id, 'index_lock_remove_failed');
        continue;
      }
      this.hp.stopped(row.op_id, { proof: verdict.proof, detail: verdict.detail });
      try { rmSync(row.marker_path, { force: true }); } catch { /* the row is the record; a leftover marker is swept at the next start */ }
    }
    return unproven;
  }

  /** A killed index writer leaves `index.lock`; the worktree has no other legitimate holder (the claim is exclusive), so a lock older than the proof is removed and recorded. */
  private async clearStaleIndexLock(m: ContainedMission, row: HostProcessRecord, provenAt: number): Promise<boolean> {
    let lock: string;
    try {
      const worktree = parseContainedMissionSpec(m.spec_json).worktree_path;
      const gitDir = (await runHardenedGit(['rev-parse', '--absolute-git-dir'], { ...this.options.git, cwd: worktree })).stdout.toString('utf8').trim();
      lock = join(gitDir, 'index.lock');
    } catch { return true; /* no worktree or git dir: there is no lock to clean */ }
    try {
      const stat = lstatSync(lock, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.mtimeMs >= provenAt) return true;
      rmSync(lock, { force: true });
      this.store.record(m.mission_id, 'index_lock_removed', { op_id: row.op_id, lock, mtime_ms: Math.floor(stat.mtimeMs) }, this.options.ports.now());
      return true;
    } catch { return false; }
  }

  /** A host process the Mission cannot prove stopped: nothing may write its branch or worktree until it is (stop_unknown, never a decision that writes). */
  private haltHostUnproven(m: ContainedMission, opId: string): ContainedMission {
    return this.store.transition(m.mission_id, { if_revision: m.revision, to: 'stop_unknown', event: { kind: 'halted', payload: {
      reason: `${HOST_PROCESS_UNPROVEN_PREFIX}${opId}`, op_id: opId, route: hostProcessRouteOf(m.state, this.lastHalt(m)?.reason),
      prior_obligation: hostOnlyObligation(containedEvents(this.store, m.mission_id)) ? 0 : m.stop_obligation } } }, this.options.ports.now());
  }
  private lastHalt(m: ContainedMission): { reason?: string; route?: HostProcessRoute; prior_obligation?: number } | undefined {
    const halted = containedEvents(this.store, m.mission_id).filter(e => e.kind === 'halted').at(-1);
    return halted ? eventPayload(halted) as { reason?: string; route?: HostProcessRoute; prior_obligation?: number } : undefined;
  }
  /** Proofs already recorded for the Mission, attached to the settle event (bounded: the most recent ones). */
  private hostEvidence(missionId: string) {
    const proofs = this.hp.stoppedProofs(missionId);
    return { host_processes: proofs.slice(-50), host_process_count: proofs.length };
  }
  /** Markers no ledger row names (a crash between creating the file and journaling it) hold no process; remove them. */
  private sweepOrphanMarkers(): void {
    try {
      for (const name of readdirSync(this.kit.markerDir)) {
        if (!name.endsWith('.hold')) continue;
        const path = join(this.kit.markerDir, name);
        try { this.hp.get(name.slice(0, -'.hold'.length)); continue; } catch { /* no row */ }
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat?.isFile() && Date.now() - stat.mtimeMs > 60_000) rmSync(path, { force: true });
      }
    } catch { /* no marker directory yet */ }
  }
  /** Missions with an open host process whose process group is gone or unknown: a present group is cheap to rule out before any `lsof`. */
  private async recheckCandidates(): Promise<string[]> {
    const due: string[] = [];
    for (const missionId of this.hp.missionsWithOpen()) {
      if (this.inFlight.has(missionId)) continue;
      let gone = false;
      for (const row of this.hp.open(missionId)) {
        try { if (row.pgid === null || !(await this.kit.probe.groupPresent(row.pgid))) gone = true; } catch { gone = true; }
      }
      if (gone) due.push(missionId);
    }
    return due;
  }

  /** A cancel requested since the last executor turn or verification is still owed once the stop is proven. */
  private cancelPending(m: ContainedMission): boolean {
    const events = containedEvents(this.store, m.mission_id);
    return events.slice(lastTransitionTo(events, ['executing', 'verifying']) + 1).some(e => eventPayload(e).to === 'cancel_requested');
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
    // Defer the entry by one microtask so the host registers ownership before fn can call a port.
    const running = Promise.resolve().then(async () => {
      try { await fn(); }
      catch (error) { if (rethrow) throw error; this.recordError(missionId, 'step', error); }
      finally { this.inFlight.delete(missionId); }
    });
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

const within = (path: string, root: string) => path.startsWith(root + sep);
/** Canonical location of a possibly missing path: the nearest existing ancestor's realpath plus the rest. */
function canonical(path: string): string {
  const present = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  let ancestor = path;
  while (!present(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  try { return join(realpathSync(ancestor), relative(ancestor, path)); } catch { throw Error('CONTAINED_SPEC_INVALID'); }
}

function classifiable(r: HostProcessRecord): AgentHostProcessRecord {
  return { op_id: r.op_id, state: r.state, pid: r.pid, pgid: r.pgid, leader_start: r.leader_start, boot_id: r.boot_id, marker: { path: r.marker_path, dev: r.marker_dev, ino: r.marker_ino } };
}
