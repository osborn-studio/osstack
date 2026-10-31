// Host orchestration for one contained Mission (W11 §3, §4.3–§4.4, §6, §7). Each
// `step` advances at most one state through the ledger; every effect is behind a
// port so the daemon (M6b) supplies the real executor, workspace and verifier.
import { createHash } from 'node:crypto';
import { CODEX_PROXY_END_MARKER, type CodexProxyRun, type CodexQualification } from '@osstack/agents';
import type { ContainedMission, ContainedMissionStore } from '@osstack/core';
import { classifyMissionPatch, parseMissionPatch, redactSecrets, scanForSecrets, type MissionOutputChannel } from '@osstack/governance';
import { applyContainedPatchFile } from './contained-patch-apply.js';

export interface ContainedMissionSpec {
  goal: string; repo_path: string; base_ref: string; start_commit: string; branch: string; worktree_path: string;
  allowed_paths: string[]; caps?: Partial<{ maxFiles: number; maxChangedLines: number; maxFileBytes: number; maxTotalBytes: number }>;
  verify: { argv: string[] }; max_repair_cycles?: number; verification_paths?: string[];
}
export interface ContainedMissionPorts {
  store: ContainedMissionStore; now: () => number;
  createWorkspace: (spec: ContainedMissionSpec, signal: AbortSignal) => Promise<{ worktree: string; gitDir: string; head: string; configDigest: string }>;
  qualify: (worktree: string, gitDir: string) => Promise<CodexQualification>;
  execute: (input: { worktree: string; prompt: string; signal: AbortSignal; onLaunched: (launch: { pid: number; pgid: number; started_at: number }) => void }) => Promise<CodexProxyRun>;
  readFile: (worktree: string, path: string) => Promise<string | null>;
  commit: (input: { worktree: string; branch: string; expectedHead: string; files: Array<{ path: string; action: 'write'; content: string } | { path: string; action: 'delete' }>; message: string }) => Promise<{ head: string; tree: string }>;
  /** Unified diff from `startCommit` to the tree that `files` would produce on `expectedHead`, without touching the worktree. */
  cumulativeDiff: (input: { worktree: string; startCommit: string; expectedHead: string; files: ReadonlyArray<{ path: string; action: 'write'; content: string } | { path: string; action: 'delete' }> }) => Promise<string>;
  /** Re-materialize `expectedHead` into the worktree, drop untracked files and any unrecorded commit on the branch. */
  restoreWorkspace: (input: { worktree: string; branch: string; expectedHead: string }) => Promise<void>;
  /** Diff from `startCommit` to the worktree's current files, read safely and hashed without filters; unsafe entries are listed, not read. */
  worktreeDiff: (input: { worktree: string; startCommit: string }) => Promise<{ diff: string; tree: string; unsafe: string[] }>;
  /** Commit the worktree's current files onto the branch; the resulting tree must equal `tree`. */
  commitWorktree: (input: { worktree: string; branch: string; tree: string; message: string }) => Promise<{ head: string; tree: string }>;
  /** `stopped` only when the verification container was proven removed. */
  verify: (mission: ContainedMission, argv: readonly string[], signal: AbortSignal) => Promise<{ exit_code: number | null; output: string; cancelled: boolean; evidence: string; stopped: boolean }>;
}
export type ContainedDecision = { kind: 'abandon' } | { kind: 'extra_repair' } | { kind: 'approve_publication' } | { kind: 'discard_changes' } | { kind: 'adopt_worktree' };
const OUTPUT_EXCERPT = 4_000;
const MAX_RECORDED_HITS = 32;

/** Scan every channel before anything is persisted, displayed or published; return only redacted text. */
export function screenOutputs(outputs: Partial<Record<MissionOutputChannel, string>>) {
  const hits = Object.entries(outputs).flatMap(([channel, text]) => text ? scanForSecrets(text, { channel: channel as MissionOutputChannel }) : []);
  const redacted = Object.fromEntries(Object.entries(outputs).map(([channel, text]) => [channel, text ? redactSecrets(text).slice(0, OUTPUT_EXCERPT) : ''])) as Partial<Record<MissionOutputChannel, string>>;
  return { hits, redacted };
}
/** Every executor turn states the proxy protocol; the goal alone gives Codex no way to know it. */
export function containedExecutorPrompt(goal: string, feedback?: string): string {
  return [
    'You are working in a read-only checkout. Do not try to edit files or run commands that change it.',
    'Propose your change as one unified diff (git diff format, paths relative to the repository root, a/ and b/ prefixes).',
    'Output only the diff: no prose, no code fences. Text files only; no renames, mode changes, symlinks or binary content.',
    `End your reply with a final line containing exactly ${CODEX_PROXY_END_MARKER}.`,
    '', `Task: ${goal}`, ...(feedback ? ['', feedback] : []),
  ].join('\n');
}
export function parseContainedMissionSpec(json: string): ContainedMissionSpec {
  const v = JSON.parse(json) as ContainedMissionSpec;
  const str = (x: unknown) => typeof x === 'string' && x.length > 0;
  if (!v || ![v.goal, v.repo_path, v.base_ref, v.start_commit, v.branch, v.worktree_path].every(str) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v.start_commit)
    || !Array.isArray(v.allowed_paths) || !Array.isArray(v.verify?.argv) || v.verify.argv.length === 0 || !v.verify.argv.every(str)) throw Error('CONTAINED_SPEC_INVALID');
  return v;
}

export class ContainedMissionRunner {
  private readonly live = new Map<string, AbortController>();
  constructor(private readonly ports: ContainedMissionPorts) {}

  /** Advance one state. Returns the Mission after the step; no-op for halted or terminal Missions. */
  async step(missionId: string): Promise<ContainedMission> {
    const m = this.ports.store.get(missionId); const spec = parseContainedMissionSpec(m.spec_json);
    switch (m.state) {
      case 'authorized': return this.createWorkspace(m, spec);
      case 'workspace_ready': return this.qualifyAndExecute(m, spec, containedExecutorPrompt(spec.goal));
      case 'candidate_ready': return this.verify(m, spec);
      case 'verify_failed': return this.repair(m, spec);
      case 'verified': return this.halt(m, 'awaiting_decision', 'publication_pending');
      default: return m;
    }
  }

  async decide(missionId: string, decision: ContainedDecision): Promise<ContainedMission> {
    const m = this.ports.store.get(missionId); const reason = this.haltReason(m);
    const go = (to: ContainedMission['state'], kind: string) => this.ports.store.transition(m.mission_id, { if_revision: m.revision, to, event: { kind, payload: { reason } } }, this.ports.now());
    if (decision.kind === 'abandon' && (m.state === 'awaiting_decision' || m.state === 'needs_reconciliation' || m.state === 'stop_unknown')) return go('abandoned', 'decision_abandon');
    if (decision.kind === 'extra_repair' && m.state === 'awaiting_decision' && reason === 'repair_cycles_exhausted') {
      const next = go('executing', 'decision_extra_repair');
      return this.runExecutor(next, parseContainedMissionSpec(next.spec_json), this.lastFailurePrompt(next));
    }
    if (decision.kind === 'approve_publication' && m.state === 'awaiting_decision' && reason === 'publication_pending') return go('revalidating', 'decision_approve_publication');
    if (decision.kind === 'discard_changes' && m.state === 'needs_reconciliation') return this.discardChanges(m, reason);
    if (decision.kind === 'adopt_worktree' && m.state === 'needs_reconciliation') return this.adoptWorktree(m);
    throw Error('CONTAINED_DECISION_NOT_ALLOWED');
  }

  /** §4.4: restore `expected_head` exactly, then start a fresh executor turn. */
  private async discardChanges(m: ContainedMission, reason: string | undefined): Promise<ContainedMission> {
    if (m.stop_obligation === 1) throw Error('stop_evidence_required');
    const spec = parseContainedMissionSpec(m.spec_json); const head = m.expected_head ?? spec.start_commit;
    const controller = new AbortController(); this.live.set(m.mission_id, controller);
    try { await this.ports.restoreWorkspace({ worktree: spec.worktree_path, branch: spec.branch, expectedHead: head }); }
    finally { this.live.delete(m.mission_id); }
    const current = this.ports.store.get(m.mission_id);
    if (current.revision !== m.revision) return this.settleCancel(current) ?? current;
    let next: ContainedMission;
    try { next = this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'executing', expected_head: head, event: { kind: 'decision_discard_changes', payload: { reason, head } } }, this.ports.now()); }
    catch (error) { if (code(error) === 'repair_cycles_exhausted') return this.halt(m, 'awaiting_decision', 'repair_cycles_exhausted'); throw error; }
    return this.runExecutor(next, spec, containedExecutorPrompt(spec.goal));
  }

  /** §4.4: the worktree as a new proposal. The whole diff from start_commit is classified and scanned again, then re-verified. */
  private async adoptWorktree(m: ContainedMission): Promise<ContainedMission> {
    if (m.stop_obligation === 1) throw Error('stop_evidence_required');
    const spec = parseContainedMissionSpec(m.spec_json);
    const operationId = `op_${createHash('sha256').update(`${m.mission_id}:${m.revision}:adopt`).digest('hex').slice(0, 16)}`;
    const controller = new AbortController(); this.live.set(m.mission_id, controller);
    const fenced = () => { const now = this.ports.store.get(m.mission_id); return controller.signal.aborted || now.revision !== m.revision ? this.settleCancel(now) ?? now : undefined; };
    try {
      const snapshot = await this.ports.worktreeDiff({ worktree: spec.worktree_path, startCommit: spec.start_commit });
      const moved = fenced(); if (moved) return moved;
      if (snapshot.unsafe.length > 0) return this.halt(m, 'awaiting_decision', 'tier_escalated', { operation_id: operationId, adopted: true, reasons: snapshot.unsafe.slice(0, 32) });
      if (!snapshot.diff) throw Error('CONTAINED_ADOPT_EMPTY');
      const overall = this.classify(spec, snapshot.diff);
      const totals = overall.tier === 'rejected' ? undefined : overall.totals;
      const parsed = parseMissionPatch(snapshot.diff);
      this.ports.store.record(m.mission_id, 't0_intent', { operation_id: operationId, worktree: spec.worktree_path, head_before: m.expected_head, tier: overall.tier, reasons: overall.reasons, adopted: true,
        files: parsed.ok ? parsed.files.slice(0, 256).map(f => ({ path: f.path, kind: f.kind })) : [], cumulative_totals: totals }, this.ports.now());
      if (overall.tier === 'rejected' || overall.tier === 'T2') return this.halt(m, 'awaiting_decision', 'tier_escalated', { operation_id: operationId, reasons: overall.reasons, cumulative: true, adopted: true });
      if (screenOutputs({ patch: snapshot.diff }).hits.length > 0) return this.halt(m, 'awaiting_decision', 'tier_escalated', { operation_id: operationId, reasons: ['SECRET_DETECTED'], cumulative: true, adopted: true });
      const before = fenced(); if (before) return before;
      const commit = await this.ports.commitWorktree({ worktree: spec.worktree_path, branch: spec.branch, tree: snapshot.tree, message: `contained mission ${m.mission_id} ${operationId} (adopted worktree)` });
      const after = fenced(); if (after) { this.ports.store.record(m.mission_id, 'commit_after_cancel', { operation_id: operationId, head: commit.head }, this.ports.now()); return after; }
      return this.commitCandidate(m, operationId, snapshot.diff, commit, overall.tier, totals);
    } finally { this.live.delete(m.mission_id); }
  }

  /** Abort a live executor or verifier; the step that owns it records stop evidence and settles state. */
  async cancel(missionId: string): Promise<ContainedMission> {
    const m = this.ports.store.get(missionId);
    const live = this.live.get(missionId);
    const requested = this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'cancel_requested', event: { kind: 'cancel_requested', payload: {} } }, this.ports.now());
    if (live) { live.abort(); return requested; }
    if (requested.stop_obligation === 0) return this.ports.store.transition(requested.mission_id, { if_revision: requested.revision, to: 'cancelled', event: { kind: 'cancelled', payload: {} } }, this.ports.now());
    return requested;
  }

  private async createWorkspace(m: ContainedMission, spec: ContainedMissionSpec) {
    this.ports.store.record(m.mission_id, 'workspace_intent', { worktree_path: spec.worktree_path, branch: spec.branch, start_commit: spec.start_commit }, this.ports.now());
    // Tracked like any other effect: a cancel waits for creation to settle before the claim can be released.
    const controller = new AbortController(); this.live.set(m.mission_id, controller);
    let ws: Awaited<ReturnType<ContainedMissionPorts['createWorkspace']>>;
    try { ws = await this.ports.createWorkspace(spec, controller.signal); }
    catch (error) { return this.settleCancel(this.ports.store.get(m.mission_id)) ?? this.halt(this.ports.store.get(m.mission_id), 'awaiting_decision', `workspace_failed:${code(error)}`); }
    finally { this.live.delete(m.mission_id); }
    const cancelled = this.settleCancel(this.ports.store.get(m.mission_id)); if (cancelled) return cancelled;
    if (ws.head !== spec.start_commit) return this.halt(m, 'awaiting_decision', 'workspace_head_mismatch');
    return this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'workspace_ready', event: { kind: 'workspace_created', payload: { worktree: ws.worktree, git_dir: ws.gitDir, config_digest: ws.configDigest } } }, this.ports.now());
  }

  private async qualifyAndExecute(m: ContainedMission, spec: ContainedMissionSpec, prompt: string) {
    const created = this.ports.store.events(m.mission_id, 0, 500).filter(e => e.kind === 'workspace_created').at(-1);
    const gitDir = created ? (JSON.parse(created.payload_json) as { git_dir?: string }).git_dir : undefined;
    if (!gitDir) return this.halt(m, 'awaiting_decision', 'workspace_unrecorded');
    // The probe runs processes too: a cancel waits for it, and an unstopped probe group is stop_unknown.
    const probe = new AbortController(); this.live.set(m.mission_id, probe);
    let q: CodexQualification;
    try { q = await this.ports.qualify(spec.worktree_path, gitDir); } finally { this.live.delete(m.mission_id); }
    this.ports.store.record(m.mission_id, 'qualification_probe', { ...q, reasons: q.reasons.slice(0, 32) }, this.ports.now());
    const current = this.ports.store.get(m.mission_id);
    if (q.reasons.includes('PROBE_GROUP_NOT_STOPPED')) return this.halt(current, 'stop_unknown', 'qualification_probe_not_stopped');
    const cancelled = this.settleCancel(current); if (cancelled) return cancelled;
    if (current.revision !== m.revision) return current;
    if (!q.qualified) return this.halt(m, 'awaiting_decision', 'qualification_failed');
    const next = this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'executing', expected_head: spec.start_commit, event: { kind: 'executor_launch_intent', payload: { version: q.version, identity_sha256: q.identity_sha256 } } }, this.ports.now());
    return this.runExecutor(next, spec, prompt);
  }

  private async runExecutor(m: ContainedMission, spec: ContainedMissionSpec, prompt: string): Promise<ContainedMission> {
    const controller = new AbortController(); this.live.set(m.mission_id, controller);
    let run: CodexProxyRun; let launched = false;
    try {
      run = await this.ports.execute({ worktree: spec.worktree_path, prompt, signal: controller.signal,
        onLaunched: launch => { launched = true; this.ports.store.record(m.mission_id, 'executor_started', launch, this.ports.now()); } });
    } catch (error) {
      this.live.delete(m.mission_id);
      const current = this.ports.store.get(m.mission_id);
      if (launched) return this.halt(current, 'stop_unknown', `executor_failed:${code(error)}`);
      // Nothing was spawned, so there is no executor to prove stopped.
      const settled = this.ports.store.recordStopEvidence(current.mission_id, current.revision, { stop_proof: 'never_launched' }, this.ports.now());
      return this.halt(settled, 'awaiting_decision', `executor_spawn_failed:${code(error)}`);
    }
    this.live.delete(m.mission_id);
    let current = this.ports.store.get(m.mission_id);
    // Secrets in any channel are found before the patch, message or logs are recorded anywhere.
    const patchText = run.patch.ok ? run.patch.text : '';
    const screen = screenOutputs({ patch: patchText, stdout: run.stdout, stderr: run.stderr });
    // Stop evidence first: nothing about the output may keep a stopped executor's obligation open.
    if (run.stop) current = this.ports.store.recordStopEvidence(current.mission_id, current.revision, run.stop, this.ports.now());
    this.ports.store.record(m.mission_id, 'executor_output', { exit_code: run.exit_code, timed_out: run.timed_out, cancelled: run.cancelled,
      patch: run.patch.ok ? { bytes: run.patch.bytes } : { reason: run.patch.reason }, stdout: screen.redacted.stdout, stderr: screen.redacted.stderr,
      secret_hits: screen.hits.slice(0, MAX_RECORDED_HITS), secret_hit_count: screen.hits.length }, this.ports.now());
    if (!run.stop) return this.halt(current, 'stop_unknown', 'executor_stop_unproven');
    if (current.state === 'cancel_requested') return this.ports.store.transition(current.mission_id, { if_revision: current.revision, to: 'cancelled', event: { kind: 'cancelled', payload: {} } }, this.ports.now());
    if (!run.patch.ok) return this.halt(current, 'awaiting_decision', `patch_invalid:${run.patch.reason}`);
    if (screen.hits.length > 0) return this.halt(current, 'awaiting_decision', 'secret_detected');
    return this.applyPatch(current, spec, patchText);
  }

  private async applyPatch(m: ContainedMission, spec: ContainedMissionSpec, patch: string): Promise<ContainedMission> {
    const classify = (text: string) => this.classify(spec, text);
    const operationId = `op_${createHash('sha256').update(`${m.mission_id}:${m.revision}:${patch}`).digest('hex').slice(0, 16)}`;
    // The turn's own patch decides what may be applied; the cumulative diff (below) decides the tier.
    const incremental = classify(patch);
    if (incremental.tier === 'rejected') return this.halt(m, 'awaiting_decision', 'write_rejected', { operation_id: operationId, reasons: incremental.reasons });
    if (incremental.tier === 'T2') return this.halt(m, 'awaiting_decision', 'tier_escalated', { operation_id: operationId, reasons: incremental.reasons });
    // Apply exactly the files the classifier parsed; the patch text is never parsed a second way.
    const parsed = parseMissionPatch(patch);
    if (!parsed.ok) return this.halt(m, 'awaiting_decision', 'write_rejected', { operation_id: operationId });
    // Host-write phase: cancel() aborts this controller, and every await is followed by a fence check.
    const controller = new AbortController(); this.live.set(m.mission_id, controller);
    const fenced = () => { const now = this.ports.store.get(m.mission_id); return controller.signal.aborted || now.revision !== m.revision ? now : undefined; };
    const settle = (now: ContainedMission) => now.state === 'cancel_requested'
      ? this.ports.store.transition(now.mission_id, { if_revision: now.revision, to: 'cancelled', event: { kind: 'cancelled', payload: { operation_id: operationId } } }, this.ports.now())
      : now;
    try {
      const files: Array<{ path: string; action: 'write'; content: string } | { path: string; action: 'delete' }> = [];
      for (const change of parsed.files) {
        const current = await this.ports.readFile(spec.worktree_path, change.path);
        const moved = fenced(); if (moved) return settle(moved);
        const next = applyContainedPatchFile(change, current);
        files.push(next === null ? { path: change.path, action: 'delete' } : { path: change.path, action: 'write', content: next });
      }
      let cumulative: string;
      try { cumulative = await this.ports.cumulativeDiff({ worktree: spec.worktree_path, startCommit: spec.start_commit, expectedHead: m.expected_head!, files }); }
      catch (error) { return this.halt(this.ports.store.get(m.mission_id), 'awaiting_decision', `cumulative_diff_failed:${code(error)}`, { operation_id: operationId }); }
      const moved = fenced(); if (moved) return settle(moved);
      // Caps and the protected set apply to everything changed since start_commit, not to one repair turn.
      const overall = classify(cumulative);
      const totals = overall.tier === 'rejected' ? undefined : overall.totals;
      this.ports.store.record(m.mission_id, 't0_intent', { operation_id: operationId, worktree: spec.worktree_path, head_before: m.expected_head, tier: overall.tier, reasons: overall.reasons,
        files: parsed.files.map(f => ({ path: f.path, kind: f.kind })), cumulative_totals: totals }, this.ports.now());
      if (overall.tier === 'rejected' || overall.tier === 'T2') return this.halt(m, 'awaiting_decision', 'tier_escalated', { operation_id: operationId, reasons: overall.reasons, cumulative: true });
      if (screenOutputs({ patch: cumulative }).hits.length > 0) return this.halt(m, 'awaiting_decision', 'secret_detected', { operation_id: operationId, cumulative: true });
      const tier = overall.tier;
      const before = fenced(); if (before) return settle(before);
      let commit: { head: string; tree: string };
      try {
        commit = await this.ports.commit({ worktree: spec.worktree_path, branch: spec.branch, expectedHead: m.expected_head!, files, message: `contained mission ${m.mission_id} ${operationId}` });
      } catch (error) { return this.halt(this.ports.store.get(m.mission_id), 'needs_reconciliation', `commit_failed:${code(error)}`, { operation_id: operationId }); }
      // A cancel that arrived during the commit leaves the commit on the preserved branch, never delivered.
      const after = fenced(); if (after) { this.ports.store.record(m.mission_id, 'commit_after_cancel', { operation_id: operationId, head: commit.head }, this.ports.now()); return settle(after); }
      return this.commitCandidate(m, operationId, patch, commit, tier, totals);
    } catch (error) {
      return this.halt(this.ports.store.get(m.mission_id), 'awaiting_decision', `patch_apply_failed:${code(error)}`, { operation_id: operationId });
    } finally { this.live.delete(m.mission_id); }
  }

  private commitCandidate(m: ContainedMission, operationId: string, patch: string, commit: { head: string; tree: string }, tier: string, totals: unknown) {
    const diffDigest = createHash('sha256').update(patch).digest('hex');
    return this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'candidate_ready', expected_head: commit.head, candidate: { head: commit.head, tree: commit.tree, diff_digest: diffDigest },
      event: { kind: 'candidate_committed', payload: { operation_id: operationId, head_commit: commit.head, tree_id: commit.tree, diff_digest: diffDigest, tier, totals } } }, this.ports.now());
  }

  private async verify(m: ContainedMission, spec: ContainedMissionSpec): Promise<ContainedMission> {
    const verifying = this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'verifying', event: { kind: 'verify_intent', payload: { candidate: m.candidate_head, argv: spec.verify.argv } } }, this.ports.now());
    const controller = new AbortController(); this.live.set(m.mission_id, controller);
    let result: Awaited<ReturnType<ContainedMissionPorts['verify']>>;
    // Entering verifying opened a stop obligation; it closes only on proof the container is gone.
    try { result = await this.ports.verify(verifying, spec.verify.argv, controller.signal); }
    catch (error) { this.live.delete(m.mission_id); return this.halt(this.ports.store.get(m.mission_id), 'stop_unknown', `verify_failed_to_settle:${code(error)}`); }
    this.live.delete(m.mission_id);
    let current = this.ports.store.get(m.mission_id);
    if (!result.stopped) return this.halt(current, 'stop_unknown', 'verify_stop_unproven');
    current = this.ports.store.recordStopEvidence(current.mission_id, current.revision, { stop_proof: 'container_removed', evidence: result.evidence }, this.ports.now());
    const screen = screenOutputs({ stdout: result.output });
    const passed = result.exit_code === 0 && !result.cancelled;
    this.ports.store.record(m.mission_id, 'verify_receipt', { exit_code: result.exit_code, cancelled: result.cancelled, evidence: result.evidence, output: screen.redacted.stdout,
      secret_hits: screen.hits.slice(0, MAX_RECORDED_HITS), secret_hit_count: screen.hits.length }, this.ports.now());
    // T0 receipts close only once the candidate holding their write has been verified (§4.5).
    for (const intent of this.openIntents(current)) this.ports.store.record(m.mission_id, 't0_receipt', { ...intent, head_after: current.candidate_head, diff_digest: current.candidate_diff_digest, verify_command: spec.verify.argv, verify_exit: result.exit_code }, this.ports.now());
    if (current.state === 'cancel_requested') return this.ports.store.transition(current.mission_id, { if_revision: current.revision, to: 'cancelled', event: { kind: 'cancelled', payload: {} } }, this.ports.now());
    return this.ports.store.transition(current.mission_id, { if_revision: current.revision, to: passed ? 'verified' : 'verify_failed', event: { kind: passed ? 'verified' : 'verify_failed', payload: { exit_code: result.exit_code } } }, this.ports.now());
  }

  private async repair(m: ContainedMission, spec: ContainedMissionSpec): Promise<ContainedMission> {
    let next: ContainedMission;
    try { next = this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'executing', event: { kind: 'repair_started', payload: {} } }, this.ports.now()); }
    catch (error) { if (code(error) === 'repair_cycles_exhausted') return this.halt(m, 'awaiting_decision', 'repair_cycles_exhausted'); throw error; }
    return this.runExecutor(next, spec, this.lastFailurePrompt(next));
  }

  private classify(spec: ContainedMissionSpec, text: string) {
    return classifyMissionPatch({ allowedPaths: spec.allowed_paths, ...(spec.caps ? { caps: spec.caps } : {}), ...(spec.verification_paths ? { verificationPaths: spec.verification_paths } : {}) }, text);
  }
  private halt(m: ContainedMission, to: 'awaiting_decision' | 'needs_reconciliation' | 'stop_unknown', reason: string, extra: Record<string, unknown> = {}) {
    return this.ports.store.transition(m.mission_id, { if_revision: m.revision, to, event: { kind: 'halted', payload: { reason, ...extra } } }, this.ports.now());
  }
  private haltReason(m: ContainedMission): string | undefined {
    const halted = this.ports.store.events(m.mission_id, 0, 500).filter(e => e.kind === 'halted').at(-1);
    return halted ? (JSON.parse(halted.payload_json) as { reason?: string }).reason : undefined;
  }
  private lastFailurePrompt(m: ContainedMission): string {
    const spec = parseContainedMissionSpec(m.spec_json);
    const receipt = this.ports.store.events(m.mission_id, 0, 500).filter(e => e.kind === 'verify_receipt').at(-1);
    const r = receipt ? JSON.parse(receipt.payload_json) as { exit_code: number | null; output: string } : undefined;
    // Only the exit code and redacted, truncated output; never anything the host would execute.
    return containedExecutorPrompt(spec.goal, `The previous change failed verification (exit ${r?.exit_code ?? 'unknown'}). Output excerpt:\n${r?.output ?? ''}`);
  }
  private settleCancel(m: ContainedMission): ContainedMission | undefined {
    if (m.state !== 'cancel_requested' || m.stop_obligation === 1) return undefined;
    return this.ports.store.transition(m.mission_id, { if_revision: m.revision, to: 'cancelled', event: { kind: 'cancelled', payload: {} } }, this.ports.now());
  }
  private openIntents(m: ContainedMission) {
    const events = this.ports.store.events(m.mission_id, 0, 500);
    const closed = new Set(events.filter(e => e.kind === 't0_receipt').map(e => (JSON.parse(e.payload_json) as { operation_id: string }).operation_id));
    const committed = new Set(events.filter(e => e.kind === 'candidate_committed').map(e => (JSON.parse(e.payload_json) as { operation_id: string }).operation_id));
    return events.filter(e => e.kind === 't0_intent').map(e => JSON.parse(e.payload_json) as { operation_id: string; worktree: string; head_before: string; files: unknown })
      .filter(i => committed.has(i.operation_id) && !closed.has(i.operation_id));
  }
}

function code(error: unknown): string { return error instanceof Error ? (error.message.split(':')[0] ?? 'error').slice(0, 64) : 'error'; }
