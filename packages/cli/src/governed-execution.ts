import { join } from "node:path";
import { acquireRepoWriteLock, FifoSemaphore, SemaphoreAcquireAbortedError, type SemaphoreLease, type RepoWriteLock } from '@osstack/autonomy';
import { resolveRepositoryScope } from '@osstack/core';

export interface ExecutionLease {
  /** Idempotent after physical release, including retries of a lost DB acknowledgement. */
  release(): Promise<void>;
  /** Keep ownership until a trusted caller has confirmed external exit. */
  retain(reason: string): void;
  /** Trusted host only; never accept a worker-provided proof callback.
   * Idempotent after release: recovery must never release semaphore permits twice. */
  releaseAfterReconciliation?(verify: () => Promise<void>): Promise<void>;
  /** Assert this exact canonical writer lease is still live. */
  assertActive?(): Promise<void>;
  /** Scoped synchronous file operations under the canonical writer lock. This
   * capability is absent on read leases. Failures retain admission until recovery. */
  withWriteGuard?<T>(workspacePath: string, operation: (assertActive: () => void) => T): Promise<T>;
}
export interface AdmissionInput {
  kind: 'read' | 'write';
  runId: string;
  /** Supplied by the daemon registration, never by an adapter context. */
  workspacePath?: string;
  repoId?: string;
  signal?: AbortSignal;
  authorize?: () => Promise<void>;
  /** Host-only synchronous proof: acquisition rejected with no lease or cleanup obligation. */
  onNotAcquired?: () => void;
}
export class GovernedExecution {
  private readonly activeRuns = new Set<string>();
  private readonly quarantinedRepositories = new Map<string, Set<string>>();
  private quarantine(repoId: string, runId: string): void {
    const owners = this.quarantinedRepositories.get(repoId) ?? new Set<string>();
    owners.add(runId); this.quarantinedRepositories.set(repoId, owners);
  }
  constructor(private readonly options: {
    reads: FifoSemaphore;
    writes: FifoSemaphore;
    repositories: Map<string, FifoSemaphore>;
    checkHealth: () => Promise<void>;
  }) {}

  get hasWriters(): boolean { return this.options.writes.in_use > 0; }

  async acquire(input: AdmissionInput): Promise<ExecutionLease> {
    const cleanup = { confirmed: true };
    try { return await this.acquireOwned(input, cleanup); }
    catch (error) {
      if (cleanup.confirmed && !this.activeRuns.has(input.runId)) input.onNotAcquired?.();
      throw error;
    }
  }

  private async acquireOwned(input: AdmissionInput, cleanup: { confirmed: boolean }): Promise<ExecutionLease> {
    const check = async (): Promise<void> => {
      if (input.signal?.aborted) throw new SemaphoreAcquireAbortedError();
      if (input.kind === 'write') await this.options.checkHealth();
      await input.authorize?.();
    };
    await check();
    const scope = input.workspacePath === undefined ? undefined
      : await resolveRepositoryScope(input.workspacePath, input.repoId === undefined ? {} : { repoId: input.repoId });
    if (input.kind === 'write' && !scope) throw new Error('trusted repository scope required for writes');
    if (input.kind === "write" && scope && this.quarantinedRepositories.has(scope.repoId)) throw new Error("repository external stop unconfirmed; reconciliation required");
    if (this.activeRuns.has(input.runId)) {
      cleanup.confirmed = false;
      throw new Error("run already admitted or queued");
    }
    this.activeRuns.add(input.runId);
    let local: SemaphoreLease | undefined;
    let global: SemaphoreLease | undefined;
    let lock: RepoWriteLock | undefined;
    let queue: FifoSemaphore | undefined;
    const releasePermits = (): void => {
      global?.release(); local?.release();
      this.activeRuns.delete(input.runId);
      if (scope && queue?.in_use === 0 && queue.pending === 0) this.options.repositories.delete(scope.repoId);
    };
    let released = false;
    let retained = false;
    let writeGuardActive = false;
    // Start as soon as the filesystem lock exists, including the final policy
    // wait. Once admitted, a renewal failure retains the unknown producer.
    let renewing: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setInterval> | undefined;
    const startRenewal = () => {
      timer = setInterval(() => {
        if (writeGuardActive) return;
        renewing = renewing.then(async () => {
          if (!released && !writeGuardActive) await lock!.renew();
        }).catch((error: unknown) => {
          retained = true;
          if (scope) this.quarantine(scope.repoId, input.runId);
          process.stderr.write(`repository lease renewal failed; retained ${input.runId}: ${String(error)}\n`);
          if (timer) clearInterval(timer);
        });
      }, 20_000);
      timer.unref();
    };
    try {
      if (input.kind === 'write' && scope) {
        queue = this.options.repositories.get(scope.repoId) ?? new FifoSemaphore(1);
        this.options.repositories.set(scope.repoId, queue);
        local = await queue.acquire(input.signal);
      }
      global = await (input.kind === 'read' ? this.options.reads : this.options.writes).acquire(input.signal);
      if (input.kind === 'write' && scope) {
        // A failed filesystem acquisition may have left an ownership obligation.
        cleanup.confirmed = false;
        lock = await acquireRepoWriteLock({ root_dir: join(scope.commonDir, "osstack", "writer-locks"), recover_stale: false, repo_id: scope.repoId, autonomy_run_id: input.runId });
        // Authorization may wait behind another branch's synchronous work.
        // Start ownership renewal before that wait, not after publishing admission.
        startRenewal();
      }
      if (input.kind === "write" && scope && this.quarantinedRepositories.has(scope.repoId)) throw new Error("repository external stop unconfirmed; reconciliation required");
      await check();
      await renewing;
      if (retained) throw new Error("repository lease renewal failed during admission");
      await lock?.assertActive();
      if (retained) throw new Error("repository lease renewal failed during admission");
      if (input.signal?.aborted) throw new SemaphoreAcquireAbortedError();
    } catch (error) {
      if (timer) clearInterval(timer);
      await renewing;
      try {
        await lock?.release();
        if (lock) cleanup.confirmed = true;
        // No executor was admitted. Remove only this rejected acquisition's quarantine.
        if (scope) {
          const owners = this.quarantinedRepositories.get(scope.repoId);
          owners?.delete(input.runId);
          if (owners?.size === 0) this.quarantinedRepositories.delete(scope.repoId);
        }
      } catch (releaseError) {
        if (scope) this.quarantine(scope.repoId, input.runId);
        throw new AggregateError([error, releaseError], 'admission rejected and ownership cleanup failed');
      } finally { releasePermits(); }
      throw error;
    }
    let reconciled: Promise<void> | undefined;
    let releasing: Promise<void> | undefined;
    return {
      ...(lock && scope ? { withWriteGuard: async <T>(workspacePath: string, operation: (assertActive: () => void) => T): Promise<T> => {
        if (workspacePath !== scope.workspacePath) throw new Error('write guard workspace mismatch');
        if (released || retained || writeGuardActive || reconciled || releasing) throw new Error('execution lease unavailable');
        writeGuardActive = true;
        try {
          await renewing;
          if (released || retained || releasing) throw new Error('execution lease unavailable');
          // Do not let the timer contend with our metadata guard. Renew on both
          // sides while still excluding release; renewal never revives expiry.
          await lock!.renew();
          const value = await lock!.withActiveGuard(check => {
            const assertActive = () => {
              if (released || retained || releasing) throw new Error('execution lease unavailable');
              check();
            };
            assertActive(); const result = operation(assertActive);
            if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
              void Promise.resolve(result).catch(() => {});
              throw new Error('write guard operation must be synchronous');
            }
            assertActive(); return result;
          });
          await lock!.renew();
          return value;
        } catch (error) {
          retained = true; if (timer) clearInterval(timer);
          this.quarantine(scope.repoId, input.runId);
          throw error;
        } finally { writeGuardActive = false; }
      } } : {}),
      assertActive: async () => {
        if (released || retained || releasing) throw new Error("execution lease unavailable");
        await lock?.assertActive();
        if (released || retained || releasing) throw new Error("execution lease unavailable");
      },
      releaseAfterReconciliation: (verify) => {
        if (releasing) return releasing;
        if (writeGuardActive) return Promise.reject(new Error('write guard in progress'));
        if (released) return Promise.resolve();
        if (reconciled) return reconciled;
        if (typeof verify !== 'function') return Promise.reject(new Error('trusted reconciliation verifier required'));
        reconciled = (async () => {
          // Stop renewal first. No authority is freed until the verifier succeeds
          // and the canonical token is released under its filesystem guard.
          if (timer) clearInterval(timer);
          await renewing;
          const result: unknown = await verify();
          if (result !== undefined) throw new Error('invalid reconciliation authority');
          await lock?.release();
          released = true; retained = false;
          if (scope) {
            const owners = this.quarantinedRepositories.get(scope.repoId);
            owners?.delete(input.runId);
            if (owners?.size === 0) this.quarantinedRepositories.delete(scope.repoId);
          }
          releasePermits();
        })().catch((error: unknown) => {
          retained = true;
          if (scope) this.quarantine(scope.repoId, input.runId);
          throw error;
        }).finally(() => { reconciled = undefined; });
        return reconciled;
      },
      retain: (reason) => { retained = true; if (timer) clearInterval(timer); if (scope) this.quarantine(scope.repoId, input.runId); process.stderr.write(`osstack: retaining write lease ${input.runId}: ${reason}\n`); },
      release: () => {
        if (releasing) return releasing;
        if (reconciled) return reconciled;
        if (writeGuardActive) return Promise.reject(new Error('write guard in progress'));
        if (released) return Promise.resolve();
        if (retained) return Promise.reject(new Error("external stop unconfirmed; reconciliation required before release"));
        releasing = (async () => {
          if (timer) clearInterval(timer);
          await renewing;
          if (retained) throw new Error("external stop unconfirmed; reconciliation required before release");
          // Physical completion, not starting its asynchronous release, is the
          // final state. Concurrent release/reconciliation callers share this wait.
          try { await lock?.release(); }
          catch (error) {
            retained = true;
            if (scope) this.quarantine(scope.repoId, input.runId);
            process.stderr.write(`repository lock release failed; retained ${input.runId}: ${String(error)}\n`);
            throw error;
          }
          released = true;
          releasePermits();
        })().finally(() => { releasing = undefined; });
        return releasing;
      },
    };
  }
}
