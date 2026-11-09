import { z } from 'zod';
import { GITHUB_CI_SANDBOX, GITHUB_CI_SANDBOX_ID, SANDBOX_CI_POLICY, type GithubCiPolicy } from './contained-mission-ci-policy.js';

// Pure merge gates. The service chooses the authorized repository policy and supplies the ports.
export const APP_E_SANDBOX = Object.freeze({
  repository: GITHUB_CI_SANDBOX, repositoryId: GITHUB_CI_SANDBOX_ID,
  appId: 5620091, installationId: 178742757, actorId: 352681958, publisherId: 352680398, watcherId: 243772068,
});
export type CiMergerPolicy = {
  repository: GithubCiPolicy['repository']; repositoryId: number;
  appId: number; installationId: number; actorId: number; publisherId: number; watcherId: number;
  qualityRulesetId: number; updateRulesetId: number; ci: GithubCiPolicy;
  missionRulesets?: { writers: number; history: number };
};
export const SANDBOX_MERGER_POLICY: CiMergerPolicy = {
  ...APP_E_SANDBOX, qualityRulesetId: 26575831, updateRulesetId: 26577634, ci: SANDBOX_CI_POLICY,
};
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const bindingSchema = z.object({
  repository: z.enum(['osborn-studio/osstack-bridge-sandbox', 'osborn-studio/osstack']), repositoryId: z.number().int().positive().safe(),
  pr: z.number().int().positive(), branch: z.string().regex(/^osstack\/mission\/[A-Za-z0-9_.-]+$/u),
  head: sha, base: sha,
}).strict();
export type SandboxMergeBinding = z.infer<typeof bindingSchema>;
const handoffSchema = z.object({
  id: z.string().min(1).max(200), binding: bindingSchema, expiresAt: z.number().int().positive(),
}).strict();
export type SandboxMergerHandoff = z.infer<typeof handoffSchema>;

/** Normalized, fully paginated live GitHub evidence, never fields supplied by the handoff. */
export interface SandboxMergeObservation {
  binding: SandboxMergeBinding;
  complete: boolean;
  open: boolean;
  draft: boolean;
  publisherId: number;
  headRepositoryId: number;
  baseRef: string;
  baseTip: string;
  mergeable: boolean;
  reviewDecision: string;
  labels: readonly string[];
  blockers: readonly string[];
  unresolvedThreads: number;
  currentChangesRequested: boolean;
  watcher: { userId: number; type: string; state: string; head: string; counted: boolean };
  quality: { id: number; active: boolean; appliesToMain: boolean; bypassActors: readonly unknown[];
    requiredChecksEnforced: boolean; approvalEnforced: boolean; threadsEnforced: boolean; lastPushApprovalEnforced: boolean };
  update: { id: number; active: boolean; appliesToMain: boolean; restrictsUpdates: boolean;
    bypassActors: readonly { actorId: number; actorType: string; mode: string }[] };
}
export interface SandboxAppEPorts {
  now(): number;
  /** Authenticate an EXISTING Grok Merger handoff by trusted record ID, origin, exact binding,
   * expiry and revocation. PR text, chat text, caller JSON and a model verdict are not authority. */
  authenticateHandoff(handoff: SandboxMergerHandoff): Promise<boolean>;
  /** Fresh GitHub reads: GET repository + pulls/{pr}, git/ref/heads/main; GraphQL latestReviews,
   * reviewDecision, reviewThreads, labels; applicable rules and rulesets 26575831/26577634.
   * Refuse pagination truncation, unknown mergeability, dismissed/stale reviews and read failures.
   * counted means GitHub APPROVED plus a current User review, not merely REST APPROVED. */
  observe(binding: SandboxMergeBinding): Promise<SandboxMergeObservation>;
  /** Reconcile authoritative App A publication/repair push intent AND confirmed receipt with this
   * exact binding. Then run readSandboxCiJobs (newest run/attempt, all five registered jobs,
   * protected workflow blobs) now. Historical ci_repair_verified is insufficient. */
  verifyCurrentPublicationAndCi(binding: SandboxMergeBinding): Promise<boolean>;
  /** Durable atomic insert keyed by repository ID + PR (not handoff ID). Never release on failure,
   * restart, timeout or denial. Shared across every instance. Commit before returning true. */
  reserveOnce(key: string, handoff: SandboxMergerHandoff): Promise<boolean>;
  /** Dedicated sandbox App E installation capability. No publisher/host credential fallback.
   * The adapter must attest the installation identity before submitting this one PUT. */
  merge(request: { appId: number; installationId: number; repository: string; pr: number;
    sha: string; merge_method: 'squash' }, beforeWrite: () => Promise<void>): Promise<{ merged: boolean; sha: string }>;
  /** Fresh GET pulls/{pr} and git/commits/{mergeSha}; bind repos/PR/head and merged_by numeric
   * Bot ID to authenticated App E identity. Squash must have exactly one parent = binding.base. */
  readback(binding: SandboxMergeBinding): Promise<{
    binding: SandboxMergeBinding; merged: boolean; actorAppId: number; actorType: string;
    actorVerified: boolean; actorUserId: number; sha: string; parents: readonly string[];
  }>;
}
export type SandboxMergeResult = { kind: 'refused'; reason: string } | { kind: 'unknown' }
  | { kind: 'merged'; sha: string };
const same = (a: SandboxMergeBinding, b: SandboxMergeBinding): boolean =>
  bindingSchema.safeParse(a).success && bindingSchema.safeParse(b).success
  && (Object.keys(a) as (keyof SandboxMergeBinding)[]).every(k => a[k] === b[k]);

function gated(s: SandboxMergeObservation, b: SandboxMergeBinding, policy: CiMergerPolicy): boolean {
  const q = s.quality;
  const u = s.update;
  return same(s.binding, b) && s.complete && s.open && !s.draft
    && s.publisherId === policy.publisherId && s.headRepositoryId === policy.repositoryId
    && s.baseRef === 'main' && s.baseTip === b.base && s.mergeable && s.reviewDecision === 'APPROVED'
    && s.labels.includes('verified') && s.blockers.length === 0 && s.unresolvedThreads === 0 && !s.currentChangesRequested
    && s.watcher.userId === policy.watcherId && s.watcher.type === 'User'
    && s.watcher.state === 'APPROVED' && s.watcher.head === b.head && s.watcher.counted
    && q.id === policy.qualityRulesetId && q.active && q.appliesToMain && q.bypassActors.length === 0
    && q.requiredChecksEnforced && q.approvalEnforced && q.threadsEnforced && q.lastPushApprovalEnforced
    && u.id === policy.updateRulesetId && u.active && u.appliesToMain && u.restrictsUpdates && u.bypassActors.length === 1
    && u.bypassActors[0]?.actorId === policy.appId
    && u.bypassActors[0]?.actorType === 'Integration' && u.bypassActors[0]?.mode === 'pull_request';
}

/** Executes at most one gated write. Unknown outcomes require read-only reconciliation by the
 * integrator; invoking this function again can never acquire the durable PR reservation again.
 * GitHub has no base-SHA precondition. Live non-bypassable quality rules must enforce the final
 * review/check race; the residual base race needs owner acceptance for this sandbox invocation. */
export async function executeSandboxAppEMerge(raw: unknown, ports: SandboxAppEPorts, policy = SANDBOX_MERGER_POLICY): Promise<SandboxMergeResult> {
  const parsed = handoffSchema.safeParse(raw);
  if (!parsed.success || parsed.data.binding.repository !== policy.repository || parsed.data.binding.repositoryId !== policy.repositoryId) return { kind: 'refused', reason: 'handoff_invalid' };
  // Detach from caller mutation while asynchronous gates run.
  const h = parsed.data;
  const authorized = async () => h.expiresAt > ports.now() && await ports.authenticateHandoff(h);
  let reserved = false;
  try {
    if (!await authorized()) return { kind: 'refused', reason: 'handoff_unauthorized' };
    for (let pass = 0; pass < 2; pass++) {
      if (!gated(await ports.observe(h.binding), h.binding, policy)
        || !await ports.verifyCurrentPublicationAndCi(h.binding)) return { kind: 'refused', reason: 'gate_failed' };
    }
    if (!await authorized()) return { kind: 'refused', reason: 'handoff_unauthorized' };
    if (!await ports.reserveOnce(`${policy.repositoryId}:${h.binding.pr}`, h)) {
      return { kind: 'refused', reason: 'already_reserved' };
    }
    reserved = true;
    // Recheck after durable reservation, including revocation during storage latency.
    if (!await authorized() || !gated(await ports.observe(h.binding), h.binding, policy)
      || !await ports.verifyCurrentPublicationAndCi(h.binding)) return { kind: 'refused', reason: 'gate_failed' };
    if (!await authorized()) return { kind: 'refused', reason: 'handoff_unauthorized' };
    const reply = await ports.merge({ appId: policy.appId, installationId: policy.installationId,
      repository: policy.repository, pr: h.binding.pr, sha: h.binding.head, merge_method: 'squash' }, async () => {
      if (policy.missionRulesets && (!gated(await ports.observe(h.binding), h.binding, policy)
        || !await ports.verifyCurrentPublicationAndCi(h.binding))) throw Error('CI_PILOT_MERGE_GATE_CHANGED');
      if (!await authorized()) throw Error('SANDBOX_APP_E_HANDOFF_REVOKED');
    });
    if (!reply.merged || !sha.safeParse(reply.sha).success) return { kind: 'unknown' };
    const back = await ports.readback(h.binding);
    if (!same(back.binding, h.binding) || !back.merged || !back.actorVerified || back.actorType !== 'Bot'
      || back.actorUserId !== policy.actorId
      || back.actorAppId !== policy.appId || back.sha !== reply.sha
      || back.parents.length !== 1 || back.parents[0] !== h.binding.base) return { kind: 'unknown' };
    return { kind: 'merged', sha: back.sha };
  } catch {
    return reserved ? { kind: 'unknown' } : { kind: 'refused', reason: 'evidence_unavailable' };
  }
}
