import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const RepoLockOwner = z
  .object({
    pid: z.number().int().positive(),
    autonomy_run_id: z.string().min(1),
    repo_id: z.string().min(1),
    acquired_at: z.string().datetime(),
    token: z.string().uuid().optional(),
    expires_at: z.string().datetime().optional(),
    recovery_policy: z.literal("reconcile").optional(),
  })
  .strict();
export type RepoLockOwner = z.infer<typeof RepoLockOwner>;

export interface RepoLockAuditEvent {
  kind: "repo_lock_stale_recovered";
  repo_id: string;
  recovered_by_run_id: string;
  recovered_by_pid: number;
  stale_owner: RepoLockOwner;
  recovered_at: string;
}

export interface RepoLockOptions {
  mode: "read" | "write";
  root_dir: string;
  repo_id: string;
  autonomy_run_id: string;
  /** Admission lease only: expiry does not stop a process or allow stealing. */
  lease_ms?: number;
  /** Legacy default true only proves recorded PID death, not descendant exit.
   * Managed admission MUST use false until the host reconciles external writers.
   */
  recover_stale?: boolean;
  pid?: number;
  now?: () => string;
  is_process_alive?: (pid: number) => boolean;
  on_audit?: (
    event: RepoLockAuditEvent,
  ) => void | Promise<void>;
}

export interface RepoWriteLock {
  readonly path: string;
  readonly owner: Readonly<RepoLockOwner>;
  renew(): Promise<void>;
  assertOwnership(): Promise<void>;
  assertActive(): Promise<void>;
  /** Trusted synchronous host work only. Holds the metadata mutation guard and
   * supplies a time-bounded proof that cannot escape the callback. Expiry never
   * authorizes lock stealing. The caller must retain physical admission on failure. */
  withActiveGuard<T>(operation: (assertActive: () => void) => T): Promise<T>;
  release(): Promise<void>;
}

export class RepoLockBusyError extends Error {
  constructor(
    readonly path: string,
    readonly owner: RepoLockOwner,
  ) {
    super(
      `repository ${owner.repo_id} is locked by pid=${owner.pid} `
      + `run=${owner.autonomy_run_id}`,
    );
    this.name = "RepoLockBusyError";
  }
}

export class RepoLockOwnershipError extends Error {
  constructor(readonly path: string) {
    super(`repository lock ownership changed: ${path}`);
    this.name = "RepoLockOwnershipError";
  }
}

export class RepoLockCorruptError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`invalid repository lock ${path}: ${detail}`);
    this.name = "RepoLockCorruptError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
    ? error.code
    : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function lockFileName(repoId: string): string {
  if (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repoId)
    && repoId !== "."
    && repoId !== ".."
  ) {
    return `${repoId}.lock`;
  }
  return `repo-${createHash("sha256")
    .update(repoId)
    .digest("hex")
    .slice(0, 24)}.lock`;
}

export function repoLockPath(rootDir: string, repoId: string): string {
  return join(rootDir, lockFileName(repoId));
}

async function readOwner(path: string): Promise<RepoLockOwner> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw error;
    throw new RepoLockCorruptError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new RepoLockCorruptError(
      path,
      "lock must be a regular non-symlink file",
    );
  }
  try {
    return RepoLockOwner.parse(
      JSON.parse(await readFile(path, "utf-8")) as unknown,
    );
  } catch (error) {
    throw new RepoLockCorruptError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** A metadata transaction guard, not a separate writer authority. Never recover
 * it by age/PID: removing a guard by pathname races a new guard owner. A crash in
 * this short section fails closed until quiescent administrative recovery. All
 * participating binaries must use this protocol on a trusted local lock root.
 */
async function withMutationGuard<T>(path: string, action: () => Promise<T>): Promise<T> {
  const guard = `${path}.guard`;
  const deadline = performance.now() + 2_000;
  for (;;) {
    try {
      await mkdir(guard, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (performance.now() >= deadline) {
        throw new RepoLockCorruptError(path, "mutation guard busy or abandoned; quiescent recovery required");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    return await action();
  } finally {
    // No recursive deletion: a modified guard is ambiguous and must fail closed.
    await rmdir(guard);
  }
}

async function publishOwner(path: string, owner: RepoLockOwner): Promise<void> {
  const staged = `${path}.publish-${randomUUID()}`;
  const handle = await open(staged, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Readers never see an empty/partial owner. Replacement is serialized by guard.
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

function sameOwner(left: RepoLockOwner, right: RepoLockOwner): boolean {
  return left.token === right.token
    && left.pid === right.pid
    && left.autonomy_run_id === right.autonomy_run_id
    && left.repo_id === right.repo_id
    && left.acquired_at === right.acquired_at
    && left.recovery_policy === right.recovery_policy;
}

function lockHandle(
  path: string,
  initialOwner: RepoLockOwner,
  now: () => string,
  leaseMs: number,
): RepoWriteLock {
  let owner = Object.freeze(initialOwner);
  let released = false;
  async function owned(): Promise<RepoLockOwner> {
    if (released) throw new RepoLockOwnershipError(path);
    let current: RepoLockOwner;
    try {
      current = await readOwner(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || error instanceof RepoLockCorruptError) {
        throw new RepoLockOwnershipError(path);
      }
      throw error;
    }
    if (!sameOwner(current, owner)) throw new RepoLockOwnershipError(path);
    return current;
  }
  function active(current: RepoLockOwner): void {
    const time = Date.parse(now());
    if (!Number.isFinite(time) || !current.expires_at || time >= Date.parse(current.expires_at)) {
      throw new RepoLockOwnershipError(`${path} (lease expired)`);
    }
  }
  return {
    path,
    get owner() { return owner; },
    async assertOwnership() {
      await withMutationGuard(path, async () => { await owned(); });
    },
    async assertActive() {
      await withMutationGuard(path, async () => { active(await owned()); });
    },
    async withActiveGuard<T>(operation: (assertActive: () => void) => T): Promise<T> {
      return withMutationGuard(path, async () => {
        const current = await owned(); active(current);
        let open = true;
        const check = () => {
          if (!open || released) throw new RepoLockOwnershipError(`${path} (guard closed)`);
          active(current);
        };
        try {
          const result = operation(check);
          // Trusted code, not a sandbox: rejecting a Promise does not cancel
          // code already scheduled by a mistaken asynchronous callback.
          if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
            void Promise.resolve(result).catch(() => {});
            throw new Error('repository guarded operation must be synchronous');
          }
          check(); return result;
        } finally { open = false; }
      });
    },
    async renew() {
      await withMutationGuard(path, async () => {
        const current = await owned();
        active(current);
        const renewed = RepoLockOwner.parse({ ...current, expires_at: new Date(Date.parse(now()) + leaseMs).toISOString() });
        await publishOwner(path, renewed);
        owner = Object.freeze(renewed);
      });
    },
    async release() {
      if (released) return;
      await withMutationGuard(path, async () => {
        if (released) return;
        await owned();
        await rm(path);
        released = true;
      });
    },
  };
}

export async function acquireRepoWriteLock(
  options: Omit<RepoLockOptions, "mode">,
): Promise<RepoWriteLock> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date().toISOString());
  const leaseMs = options.lease_ms ?? 60_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("repository lease_ms must be a positive safe integer");
  }
  const isProcessAlive = options.is_process_alive ?? defaultIsProcessAlive;
  const acquiredAt = now();
  let owner = RepoLockOwner.parse({
    pid,
    autonomy_run_id: options.autonomy_run_id,
    repo_id: options.repo_id,
    acquired_at: acquiredAt,
    token: randomUUID(),
    ...(options.recover_stale === false ? { recovery_policy: "reconcile" } : {}),
    expires_at: new Date(Date.parse(acquiredAt) + leaseMs).toISOString(),
  });
  await mkdir(options.root_dir, { recursive: true, mode: 0o700 });
  await chmod(options.root_dir, 0o700);
  const path = repoLockPath(options.root_dir, options.repo_id);
  let staleOwner: RepoLockOwner | undefined;
  const handle = await withMutationGuard(path, async () => {
    let current: RepoLockOwner | undefined;
    try {
      current = await readOwner(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (current) {
      if (current.repo_id !== options.repo_id) throw new RepoLockOwnershipError(path);
      let alive = true;
      try { alive = isProcessAlive(current.pid) !== false; } catch { /* unknown is live */ }
      if (alive || options.recover_stale === false || current.recovery_policy === "reconcile") throw new RepoLockBusyError(path, current);
      // Detect out-of-protocol replacement (including legacy/malicious writers).
      // Cooperating writers cannot replace anything while we hold the guard.
      if (!sameOwner(await readOwner(path), current)) throw new RepoLockOwnershipError(path);
      staleOwner = current;
    }
    // The lease begins after contention, not before waiting for the guard.
    const publishedAt = now();
    owner = RepoLockOwner.parse({
      ...owner,
      acquired_at: publishedAt,
      expires_at: new Date(Date.parse(publishedAt) + leaseMs).toISOString(),
    });
    // Replace the dead owner's file atomically, without a missing-lock window or
    // stale rename that can accidentally move a newly acquired live lock.
    await publishOwner(path, owner);
    return lockHandle(path, owner, now, leaseMs);
  });
  try {
    if (staleOwner) {
      await options.on_audit?.({
        kind: "repo_lock_stale_recovered",
        repo_id: options.repo_id,
        recovered_by_run_id: options.autonomy_run_id,
        recovered_by_pid: pid,
        stale_owner: staleOwner,
        recovered_at: owner.acquired_at,
      });
    }
  } catch (error) {
    await handle.release();
    throw error;
  }
  return handle;
}

export async function acquireRepoLock(
  options: RepoLockOptions,
): Promise<RepoWriteLock | undefined> {
  if (options.mode === "read") return undefined;
  const { mode: _mode, ...writeOptions } = options;
  return await acquireRepoWriteLock(writeOptions);
}

/** Trusted administrative inspection. Expiry/PID are not external-stop evidence. */
export async function inspectRepoWriteLock(rootDir: string, repoId: string): Promise<Readonly<RepoLockOwner> | null> {
  try {
    const owner = await readOwner(repoLockPath(rootDir, repoId));
    if (owner.repo_id !== repoId) throw new RepoLockOwnershipError(rootDir);
    return Object.freeze(owner);
  } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
}

/** Post-daemon-restart administration only. The registered verifier must validate
 * a committed graph decision, every external producer and workspace quarantine.
 * No automatic stale recovery: exact token/run/repository and real daemon PID
 * death are checked under the existing mutation guard before unlinking one file. */
export async function releaseReconciledRepoWriteLock(options: {
  root_dir: string; repo_id: string; expectedOwner: Readonly<RepoLockOwner>;
  verifyQuiescent: (owner: Readonly<RepoLockOwner>) => Promise<void>;
}): Promise<void> {
  const { root_dir: root, repo_id: repoId, verifyQuiescent } = options;
  const expected = Object.freeze(RepoLockOwner.parse(options.expectedOwner));
  const path = repoLockPath(root, repoId);
  if (expected.repo_id !== repoId || typeof verifyQuiescent !== 'function') throw new RepoLockOwnershipError(path);
  await withMutationGuard(path, async () => {
    const current = await readOwner(path);
    if (!sameOwner(current, expected)) throw new RepoLockOwnershipError(path);
    if (defaultIsProcessAlive(current.pid)) throw new Error('recorded daemon still alive; use its retained lease');
    const result: unknown = await verifyQuiescent(Object.freeze({ ...current }));
    if (result !== undefined) throw new Error('invalid quiescence authority');
    if (!sameOwner(await readOwner(path), expected)) throw new RepoLockOwnershipError(path);
    if (defaultIsProcessAlive(current.pid)) throw new Error('recorded daemon PID is alive or reused');
    await rm(path);
  });
}
