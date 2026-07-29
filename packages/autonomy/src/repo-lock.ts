import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const RepoLockOwner = z
  .object({
    pid: z.number().int().positive(),
    autonomy_run_id: z.string().min(1),
    repo_id: z.string().min(1),
    acquired_at: z.string().datetime(),
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
    super(`repository lock ownership changed before release: ${path}`);
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

async function createExclusiveLock(
  path: string,
  owner: RepoLockOwner,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

function sameOwner(left: RepoLockOwner, right: RepoLockOwner): boolean {
  return left.pid === right.pid
    && left.autonomy_run_id === right.autonomy_run_id
    && left.repo_id === right.repo_id
    && left.acquired_at === right.acquired_at;
}

function lockHandle(
  path: string,
  owner: RepoLockOwner,
): RepoWriteLock {
  let released = false;
  return {
    path,
    owner,
    async release() {
      if (released) return;
      let current: RepoLockOwner;
      try {
        current = await readOwner(path);
      } catch (error) {
        if (
          errorCode(error) === "ENOENT"
          || error instanceof RepoLockCorruptError
        ) {
          throw new RepoLockOwnershipError(path);
        }
        throw error;
      }
      if (!sameOwner(current, owner)) {
        throw new RepoLockOwnershipError(path);
      }
      await rm(path);
      released = true;
    },
  };
}

export async function acquireRepoWriteLock(
  options: Omit<RepoLockOptions, "mode">,
): Promise<RepoWriteLock> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date().toISOString());
  const isProcessAlive =
    options.is_process_alive ?? defaultIsProcessAlive;
  const owner = RepoLockOwner.parse({
    pid,
    autonomy_run_id: options.autonomy_run_id,
    repo_id: options.repo_id,
    acquired_at: now(),
  });
  await mkdir(options.root_dir, { recursive: true, mode: 0o700 });
  await chmod(options.root_dir, 0o700);
  const path = repoLockPath(options.root_dir, options.repo_id);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await createExclusiveLock(path, owner)) {
      return lockHandle(path, owner);
    }
    let current: RepoLockOwner;
    try {
      current = await readOwner(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (isProcessAlive(current.pid)) {
      throw new RepoLockBusyError(path, current);
    }

    const stalePath = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, stalePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const movedOwner = await readOwner(stalePath);
    if (!sameOwner(movedOwner, current)) {
      try {
        await link(stalePath, path);
        await rm(stalePath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      throw new RepoLockOwnershipError(path);
    }
    try {
      await options.on_audit?.({
        kind: "repo_lock_stale_recovered",
        repo_id: options.repo_id,
        recovered_by_run_id: options.autonomy_run_id,
        recovered_by_pid: pid,
        stale_owner: current,
        recovered_at: owner.acquired_at,
      });
    } finally {
      await rm(stalePath, { force: true });
    }
  }
  throw new Error(
    `repository lock changed repeatedly while acquiring ${path}`,
  );
}

export async function acquireRepoLock(
  options: RepoLockOptions,
): Promise<RepoWriteLock | undefined> {
  if (options.mode === "read") return undefined;
  const { mode: _mode, ...writeOptions } = options;
  return await acquireRepoWriteLock(writeOptions);
}
