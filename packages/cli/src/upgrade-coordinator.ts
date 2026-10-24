import { z } from 'zod';
import { DeploymentIdentitySchema, type DeploymentIdentity } from './home-inventory.js';
import { UpgradeDigest, UpgradeId, freezeUpgradePlan, upgradeCanonical, upgradeDigest, type FrozenUpgradePlan, type UpgradePlanGroup, type UpgradePlanHome } from './upgrade-plan.js';
import type { UpgradeJournal, UpgradeJournalWriter, UpgradePhase } from './upgrade-journal.js';

const ref = z.string().min(1).max(512);
const AuthoritySchema = z.object({ plan_digest: UpgradeDigest, group_id: UpgradeId, installation_id: UpgradeId,
  consumer_home_ids: z.array(z.string()).min(1).max(32), expires_at_ms: z.number().int().nonnegative().safe(),
  completeness_evidence_ref: ref, qualification_ref: ref, authorization_ref: ref }).strict();
export type UpgradeAuthority = z.infer<typeof AuthoritySchema> & { assertCurrent: () => void };
const StoppedSchema = z.object({ home_id: z.string(), generation: z.string(), stopped: z.literal(true),
  graph_holds: z.literal(0), unknown_actions: z.literal(0), receipt_ref: ref }).strict();
export type UpgradeStopLease = { receipt: z.infer<typeof StoppedSchema>; assertHeld: () => void };
const ReceiptSchema = z.object({ home_id: z.string(), source_generation: z.string(), receipt_ref: ref }).strict();
const InstallSchema = z.object({ plan_digest: UpgradeDigest, installation_id: UpgradeId, version: z.string(), build_digest: UpgradeDigest, receipt_ref: ref }).strict();

/** Trusted host boundary. ManagedNativeUpgradePort implements the opt-in pinned launchd backend.
 * Implementations must prove the complete controlled consumer set independently of inventory. */
export interface NativeUpgradePort {
  resolveAuthority(plan: FrozenUpgradePlan, group: UpgradePlanGroup, signal: AbortSignal): Promise<UpgradeAuthority | null>;
  observe(home: UpgradePlanHome, signal: AbortSignal): Promise<{ identity: DeploymentIdentity; healthy: boolean; receipt_ref: string }>;
  drain(home: UpgradePlanHome, signal: AbortSignal): Promise<UpgradeStopLease>;
  snapshot(home: UpgradePlanHome, signal: AbortSignal): Promise<z.infer<typeof ReceiptSchema>>;
  install(plan: FrozenUpgradePlan, group: UpgradePlanGroup, signal: AbortSignal): Promise<z.infer<typeof InstallSchema>>;
  restart(home: UpgradePlanHome, signal: AbortSignal): Promise<z.infer<typeof ReceiptSchema>>;
}
export interface UpgradeExecutionResult { state: UpgradePhase; plan_digest: string; group_id: string; reason: string | null }
function synchronous(call: () => void): void {
  const value: unknown = call(); if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('upgrade_async_authority'); }
}

/** Runs only with an explicit trusted port. A persisted plan never grants permission.
 * Every side effect has a durable started record; incomplete prior attempts are never replayed. */
export async function coordinateUpgrade(input: {
  journal: UpgradeJournal; plan: FrozenUpgradePlan; groupId: string; port?: NativeUpgradePort;
  nowMs?: () => number; monotonicMs?: () => number; signal?: AbortSignal;
}): Promise<UpgradeExecutionResult> {
  const plan = freezeUpgradePlan(input.plan.plan); if (plan.digest !== input.plan.digest) throw Error('upgrade_plan_digest_mismatch');
  const group = plan.plan.groups.find(g => g.group_id === input.groupId); if (!group) throw Error('upgrade_group_missing');
  const result = (state: UpgradePhase, reason: string | null = null): UpgradeExecutionResult => ({ state, plan_digest: plan.digest, group_id: group.group_id, reason });
  await input.journal.create(plan); const prior = await input.journal.status(plan.digest, group.group_id);
  if (prior.completed) return result('verified');
  if (prior.phase === 'recovery_required' || prior.records.some(r => r.phase !== 'qualification_pending')) return result('recovery_required', 'prior_attempt_requires_reconciliation');
  if (!input.port) return result('qualification_pending', 'native_updater_not_qualified');
  for (const previous of plan.plan.groups.slice(0, plan.plan.groups.indexOf(group))) {
    if (!(await input.journal.status(plan.digest, previous.group_id)).completed) return result('qualification_pending', 'preceding_group_not_verified');
  }
  const unqualifiedIdentity = group.homes.some(home => !home.identity || home.identity.home_id !== home.home_id
    || home.identity.deployment_kind !== 'npm' || home.identity.build_digest === null || home.identity.build_evidence !== 'host_manifest'
    || home.identity.database_schema > plan.plan.target.database_schema
    || home.identity.database_schema < plan.plan.target.readable_schema_min || home.identity.database_schema > plan.plan.target.readable_schema_max
    || home.observed_at_ms > plan.plan.created_at_ms || plan.plan.created_at_ms - home.observed_at_ms > 30000);
  if (plan.plan.budget.max_steps < 5 * group.homes.length + 2 || group.deployment_kind !== 'npm' || unqualifiedIdentity || group.reasons.some(reason => !['shared_consumers_not_attested', 'native_updater_not_qualified'].includes(reason)))
    return result('qualification_pending', 'plan_has_unqualified_consumers');
  const port = input.port; const now = input.nowMs ?? Date.now; const mono = input.monotonicMs ?? (() => performance.now());
  const startedAt = mono(); let steps = 0; let authority: UpgradeAuthority | undefined; let writer: UpgradeJournalWriter | undefined;
  let phase: UpgradePhase = 'preflight'; let installStarted = false; let sideEffectStarted = false; let closed = false;
  const stops: UpgradeStopLease[] = [];
  const clockCheck = () => {
    if (closed || input.signal?.aborted) throw Error('upgrade_cancelled');
    if (now() < plan.plan.created_at_ms || now() >= plan.plan.expires_at_ms) throw Error('upgrade_plan_expired');
    if (mono() - startedAt >= plan.plan.budget.max_total_ms) throw Error('upgrade_budget_exhausted');
    if (authority) {
      if (now() >= authority.expires_at_ms) throw Error('upgrade_authority_expired'); synchronous(authority.assertCurrent);
    }
  };
  const append = async (status: 'started' | 'confirmed' | 'failed', home: UpgradePlanHome | null, evidence?: unknown, evidenceRef?: string, reason?: string) => {
    if (!writer) return;
    await writer.append({ phase, status, at_ms: now(), home_id: home?.home_id ?? null, evidence_digest: evidence === undefined ? null : upgradeDigest(evidence),
      evidence_ref: evidenceRef ?? null, reason: reason ?? null });
  };
  const call = async <T>(operation: (signal: AbortSignal) => Promise<T>, mutating = false): Promise<T> => {
    clockCheck(); if (steps >= plan.plan.budget.max_steps) throw Error('upgrade_budget_exhausted'); steps += 1;
    const controller = new AbortController(); let rejectAbort!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => { controller.abort(); rejectAbort(Error('upgrade_cancelled')); };
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
    const remaining = plan.plan.budget.max_total_ms - (mono() - startedAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('upgrade_operation_unknown')); }, Math.max(1, Math.min(remaining, plan.plan.budget.max_step_ms))); });
      // After timeout, the late operation cannot append or advance phases. Its physical effects remain unknown.
      const value = await Promise.race([Promise.resolve().then(() => { clockCheck(); if (mutating) synchronous(writer!.assertCurrent); return operation(controller.signal); }), deadline, cancelled]);
      clockCheck(); return value;
    } finally { if (timer) clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
  };
  try {
    const resolved = await call(signal => port.resolveAuthority(plan, group, signal));
    if (!resolved) return result('qualification_pending', 'shared_consumers_not_attested');
    const { assertCurrent, ...raw } = resolved; const parsed = AuthoritySchema.parse(raw);
    if (typeof assertCurrent !== 'function' || parsed.plan_digest !== plan.digest || parsed.group_id !== group.group_id || parsed.installation_id !== group.installation_id
      || upgradeCanonical([...parsed.consumer_home_ids].sort()) !== upgradeCanonical(group.homes.map(h => h.home_id).sort())) throw Error('upgrade_authority_binding');
    authority = { ...parsed, assertCurrent: assertCurrent.bind(resolved) }; clockCheck();
    writer = await input.journal.claim(plan.digest, group.group_id); clockCheck(); await append('started', null, parsed, parsed.authorization_ref);
    for (const home of group.homes) {
      const observation = await call(signal => port.observe(home, signal));
      const identity = DeploymentIdentitySchema.parse(observation.identity);
      if (observation.healthy !== true || upgradeCanonical(identity) !== upgradeCanonical(home.identity)) throw Error('upgrade_identity_changed');
      ref.parse(observation.receipt_ref); await append('confirmed', home, identity, observation.receipt_ref); clockCheck();
    }
    phase = 'draining';
    for (const home of group.homes) {
      await append('started', home); clockCheck(); sideEffectStarted = true;
      const lease = await call(signal => port.drain(home, signal), true); const receipt = StoppedSchema.parse(lease.receipt);
      if (receipt.home_id !== home.home_id || receipt.generation !== home.identity?.generation || typeof lease.assertHeld !== 'function') throw Error('upgrade_stop_binding');
      const frozenLease = { receipt, assertHeld: lease.assertHeld.bind(lease) }; synchronous(frozenLease.assertHeld); stops.push(frozenLease);
      await append('confirmed', home, receipt, receipt.receipt_ref); clockCheck();
    }
    const quiescent = () => { clockCheck(); for (const stop of stops) synchronous(stop.assertHeld); if (stops.length !== group.homes.length) throw Error('upgrade_all_consumers_required'); };
    quiescent(); phase = 'quiescent'; await append('confirmed', null, stops.map(s => s.receipt)); quiescent(); phase = 'snapshotting';
    for (const home of group.homes) {
      await append('started', home); quiescent(); const receipt = ReceiptSchema.parse(await call(signal => { quiescent(); return port.snapshot(home, signal); }, true));
      quiescent(); if (receipt.home_id !== home.home_id || receipt.source_generation !== home.identity?.generation) throw Error('upgrade_snapshot_binding');
      await append('confirmed', home, receipt, receipt.receipt_ref); quiescent();
    }
    phase = 'installing'; await append('started', null); quiescent(); installStarted = true;
    const installed = InstallSchema.parse(await call(signal => { quiescent(); return port.install(plan, group, signal); }, true)); quiescent();
    if (installed.plan_digest !== plan.digest || installed.installation_id !== group.installation_id || installed.version !== plan.plan.target.version || installed.build_digest !== plan.plan.target.build_digest) throw Error('upgrade_install_mismatch');
    phase = 'installed'; await append('confirmed', null, installed, installed.receipt_ref); clockCheck(); phase = 'restarting';
    for (const home of group.homes) {
      await append('started', home); clockCheck(); synchronous(stops[group.homes.indexOf(home)]!.assertHeld);
      const receipt = ReceiptSchema.parse(await call(signal => { synchronous(stops[group.homes.indexOf(home)]!.assertHeld); return port.restart(home, signal); }, true));
      if (receipt.home_id !== home.home_id || receipt.source_generation !== home.identity?.generation) throw Error('upgrade_restart_binding');
      await append('confirmed', home, receipt, receipt.receipt_ref); clockCheck();
    }
    phase = 'verifying';
    for (const home of group.homes) {
      await append('started', home); clockCheck(); const observed = await call(signal => port.observe(home, signal)); const identity = DeploymentIdentitySchema.parse(observed.identity);
      if (observed.healthy !== true || identity.home_id !== home.home_id || identity.generation === home.identity?.generation || identity.deployment_kind !== 'npm'
        || identity.version !== plan.plan.target.version || identity.build_digest !== plan.plan.target.build_digest || identity.build_evidence !== 'host_manifest'
        || identity.protocol_version !== plan.plan.target.protocol_version || identity.database_schema !== plan.plan.target.database_schema) throw Error('upgrade_version_mismatch');
      ref.parse(observed.receipt_ref); await append('confirmed', home, identity, observed.receipt_ref); clockCheck();
    }
    phase = 'verified'; clockCheck(); await append('confirmed', null);
    try { await writer.releaseVerified(); } catch { closed = true; return result('verified', 'claim_release_requires_reconciliation'); }
    closed = true; return result('verified');
  } catch (error) {
    if (error instanceof Error && error.message === 'upgrade_already_verified') return result('verified');
    const message = error instanceof Error && /^upgrade_[a-z_]+$/.test(error.message) ? error.message : 'upgrade_port_failure';
    if (!writer && message !== 'upgrade_recovery_required') {
      const status = await input.journal.status(plan.digest, group.group_id).catch(() => null);
      if (status?.completed) return result('verified', status.recovery.claim_cleanup_pending ? 'claim_release_requires_reconciliation' : null);
      return result(!status || status.phase === 'recovery_required' ? 'recovery_required' : 'qualification_pending', message);
    }
    const state: UpgradePhase = message === 'upgrade_recovery_required' || sideEffectStarted && !installStarted ? 'recovery_required'
      : !installStarted ? 'aborted_before_install' : message === 'upgrade_version_mismatch' ? 'version_mismatch' : 'recovery_required';
    phase = state; closed = true;
    // A failed journal write leaves its previous started record. Never undo an external fact or steal the claim.
    try { await append('failed', null, undefined, undefined, message); } catch { /* Caller must inspect the retained claim and previous record. */ }
    return result(state, message);
  }
}
