import { z } from 'zod';

// No environment, credential, DB or CLI access. Only the owner-approved sandbox exception.
export const APP_E_SANDBOX = Object.freeze({
  repository: 'osborn-studio/osstack-bridge-sandbox', repositoryId: 1446327922,
  appId: 5620091, installationId: 178742757, publisherId: 352680398, watcherId: 243772068,
});
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const bindingSchema = z.object({
  repository: z.literal(APP_E_SANDBOX.repository), repositoryId: z.literal(APP_E_SANDBOX.repositoryId),
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
  merge(request: { appId: 5620091; installationId: 178742757; repository: string; pr: number;
    sha: string; merge_method: 'squash' }): Promise<{ merged: boolean; sha: string }>;
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

function gated(s: SandboxMergeObservation, b: SandboxMergeBinding): boolean {
  const q = s.quality;
  const u = s.update;
  return same(s.binding, b) && s.complete && s.open && !s.draft
    && s.publisherId === APP_E_SANDBOX.publisherId && s.headRepositoryId === APP_E_SANDBOX.repositoryId
    && s.baseRef === 'main' && s.baseTip === b.base && s.mergeable && s.reviewDecision === 'APPROVED'
    && s.labels.includes('verified') && s.blockers.length === 0 && s.unresolvedThreads === 0 && !s.currentChangesRequested
    && s.watcher.userId === APP_E_SANDBOX.watcherId && s.watcher.type === 'User'
    && s.watcher.state === 'APPROVED' && s.watcher.head === b.head && s.watcher.counted
    && q.id === 26575831 && q.active && q.appliesToMain && q.bypassActors.length === 0
    && q.requiredChecksEnforced && q.approvalEnforced && q.threadsEnforced && q.lastPushApprovalEnforced
    && u.id === 26577634 && u.active && u.appliesToMain && u.restrictsUpdates && u.bypassActors.length === 1
    && u.bypassActors[0]?.actorId === APP_E_SANDBOX.appId
    && u.bypassActors[0]?.actorType === 'Integration' && u.bypassActors[0]?.mode === 'pull_request';
}

/** Executes at most one gated write. Unknown outcomes require read-only reconciliation by the
 * integrator; invoking this function again can never acquire the durable PR reservation again.
 * GitHub has no base-SHA precondition. Live non-bypassable quality rules must enforce the final
 * review/check race; the residual base race needs owner acceptance for this sandbox invocation. */
export async function executeSandboxAppEMerge(raw: unknown, ports: SandboxAppEPorts): Promise<SandboxMergeResult> {
  const parsed = handoffSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'refused', reason: 'handoff_invalid' };
  // Detach from caller mutation while asynchronous gates run.
  const h = parsed.data;
  const authorized = async () => h.expiresAt > ports.now() && await ports.authenticateHandoff(h);
  let reserved = false;
  try {
    if (!await authorized()) return { kind: 'refused', reason: 'handoff_unauthorized' };
    for (let pass = 0; pass < 2; pass++) {
      if (!gated(await ports.observe(h.binding), h.binding)
        || !await ports.verifyCurrentPublicationAndCi(h.binding)) return { kind: 'refused', reason: 'gate_failed' };
    }
    if (!await authorized()) return { kind: 'refused', reason: 'handoff_unauthorized' };
    if (!await ports.reserveOnce(`${APP_E_SANDBOX.repositoryId}:${h.binding.pr}`, h)) {
      return { kind: 'refused', reason: 'already_reserved' };
    }
    reserved = true;
    // Recheck after durable reservation, including revocation during storage latency.
    if (!await authorized() || !gated(await ports.observe(h.binding), h.binding)
      || !await ports.verifyCurrentPublicationAndCi(h.binding)) return { kind: 'refused', reason: 'gate_failed' };
    if (!await authorized()) return { kind: 'refused', reason: 'handoff_unauthorized' };
    const reply = await ports.merge({ appId: 5620091, installationId: 178742757,
      repository: APP_E_SANDBOX.repository, pr: h.binding.pr, sha: h.binding.head, merge_method: 'squash' });
    if (!reply.merged || !sha.safeParse(reply.sha).success) return { kind: 'unknown' };
    const back = await ports.readback(h.binding);
    if (!same(back.binding, h.binding) || !back.merged || !back.actorVerified || back.actorType !== 'Bot'
      || !Number.isSafeInteger(back.actorUserId) || back.actorUserId <= 0
      || back.actorAppId !== APP_E_SANDBOX.appId || back.sha !== reply.sha
      || back.parents.length !== 1 || back.parents[0] !== h.binding.base) return { kind: 'unknown' };
    return { kind: 'merged', sha: back.sha };
  } catch {
    return reserved ? { kind: 'unknown' } : { kind: 'refused', reason: 'evidence_unavailable' };
  }
}
