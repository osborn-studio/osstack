import { join } from "node:path";
import { acquireRepoWriteLock, FifoSemaphore, SemaphoreAcquireAbortedError, type SemaphoreLease, type RepoWriteLock } from '@osstack/autonomy';
import { resolveRepositoryScope } from '@osstack/core';

export interface ExecutionLease {
  release(): Promise<void>;
  /** Keep ownership until a trusted caller has confirmed external exit. */
  retain(reason: string): void;
}
export interface AdmissionInput {
  kind: 'read' | 'write';
  runId: string;
  /** Supplied by the daemon registration, never by an adapter context. */
  workspacePath?: string;
  repoId?: string;
  signal?: AbortSignal;
  authorize?: () => Promise<void>;
}
export class GovernedExecution {
  private readonly activeRuns = new Set<string>();
  private readonly quarantinedRepositories = new Set<string>();
  constructor(private readonly options: {
    reads: FifoSemaphore;
    writes: FifoSemaphore;
    repositories: Map<string, FifoSemaphore>;
    checkHealth: () => Promise<void>;
  }) {}

  get hasWriters(): boolean { return this.options.writes.in_use > 0; }

  async acquire(input: AdmissionInput): Promise<ExecutionLease> {
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
    if (this.activeRuns.has(input.runId)) throw new Error("run already admitted or queued");
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
    try {
      if (input.kind === 'write' && scope) {
        queue = this.options.repositories.get(scope.repoId) ?? new FifoSemaphore(1);
        this.options.repositories.set(scope.repoId, queue);
        local = await queue.acquire(input.signal);
      }
      global = await (input.kind === 'read' ? this.options.reads : this.options.writes).acquire(input.signal);
      if (input.kind === 'write' && scope) {
        lock = await acquireRepoWriteLock({ root_dir: join(scope.commonDir, "osstack", "writer-locks"), recover_stale: false, repo_id: scope.repoId, autonomy_run_id: input.runId });
      }
      if (input.kind === "write" && scope && this.quarantinedRepositories.has(scope.repoId)) throw new Error("repository external stop unconfirmed; reconciliation required");
      await check();
    } catch (error) {
      try { await lock?.release(); } finally { releasePermits(); }
      throw error;
    }
    let released = false;
    let retained = false;
    // A renewal failure quarantines this repository. Its unknown producer still
    // consumes write capacity, while unrelated reads remain available.
    let renewing: Promise<void> = Promise.resolve();
    const timer = lock === undefined ? undefined : setInterval(() => {
      renewing = renewing.then(async () => {
        if (!released) await lock!.renew();
      }).catch((error: unknown) => {
        retained = true;
        if (scope) this.quarantinedRepositories.add(scope.repoId);
        process.stderr.write(`repository lease renewal failed; retained ${input.runId}: ${String(error)}\n`);
        if (timer) clearInterval(timer);
      });
    }, 20_000);
    timer?.unref();
    return {
      retain: (reason) => { retained = true; if (timer) clearInterval(timer); if (scope) this.quarantinedRepositories.add(scope.repoId); process.stderr.write(`osstack: retaining write lease ${input.runId}: ${reason}\n`); },
      release: async () => {
        if (released) return;
        if (retained) throw new Error("external stop unconfirmed; reconciliation required before release");
        released = true;
        if (timer) clearInterval(timer);
        await renewing;
        if (retained) { released = false; throw new Error("external stop unconfirmed; reconciliation required before release"); }
        // Ownership failure must not free the in-process writer authority.
        try { await lock?.release(); }
        catch (error) {
          released = false; retained = true;
          if (scope) this.quarantinedRepositories.add(scope.repoId);
          process.stderr.write(`repository lock release failed; retained ${input.runId}: ${String(error)}\n`);
          throw error;
        }
        releasePermits();
      },
    };
  }
}
