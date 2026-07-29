import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRepoLock,
  acquireRepoWriteLock,
  RepoLockBusyError,
  RepoLockOwnershipError,
  repoLockPath,
} from "./repo-lock.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-repo-lock-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("repository write lock", () => {
  it("allows only one live writer per repository", async () => {
    const first = await acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-1",
      pid: 101,
      now: () => "2026-07-28T18:00:00.000Z",
      is_process_alive: () => true,
    });

    await expect(acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-2",
      pid: 202,
      is_process_alive: () => true,
    })).rejects.toBeInstanceOf(RepoLockBusyError);

    await first.release();
    const second = await acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-2",
      pid: 202,
      is_process_alive: () => true,
    });
    await second.release();
  });

  it("does not create a writer lock for read-only access", async () => {
    const lock = await acquireRepoLock({
      mode: "read",
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "read-1",
      pid: 101,
    });

    expect(lock).toBeUndefined();
    await expect(readFile(
      repoLockPath(directory, "example-web"),
      "utf-8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a dead process lock and emits an audit event", async () => {
    const stale = await acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-dead",
      pid: 101,
      now: () => "2026-07-28T17:00:00.000Z",
      is_process_alive: () => true,
    });
    const audit: unknown[] = [];

    const recovered = await acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-new",
      pid: 202,
      now: () => "2026-07-28T18:00:00.000Z",
      is_process_alive: (pid) => pid !== 101,
      on_audit: (event) => {
        audit.push(event);
      },
    });

    expect(audit).toEqual([{
      kind: "repo_lock_stale_recovered",
      repo_id: "example-web",
      recovered_by_run_id: "run-new",
      recovered_by_pid: 202,
      stale_owner: {
        pid: 101,
        autonomy_run_id: "run-dead",
        repo_id: "example-web",
        acquired_at: "2026-07-28T17:00:00.000Z",
      },
      recovered_at: "2026-07-28T18:00:00.000Z",
    }]);
    await expect(stale.release()).rejects.toBeInstanceOf(
      RepoLockOwnershipError,
    );
    await recovered.release();
  });

  it("refuses to unlink a lock after ownership changes", async () => {
    const lock = await acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-1",
      pid: 101,
      is_process_alive: () => true,
    });
    await writeFile(lock.path, JSON.stringify({
      pid: 202,
      autonomy_run_id: "run-2",
      repo_id: "example-web",
      acquired_at: "2026-07-28T18:00:00.000Z",
    }));

    await expect(lock.release()).rejects.toBeInstanceOf(
      RepoLockOwnershipError,
    );
    expect(JSON.parse(await readFile(lock.path, "utf-8"))).toMatchObject({
      pid: 202,
      autonomy_run_id: "run-2",
    });
  });

  it("fails closed if ownership changes during stale recovery", async () => {
    const stale = await acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-dead",
      pid: 101,
      now: () => "2026-07-28T17:00:00.000Z",
      is_process_alive: () => true,
    });
    const replacement = {
      pid: 303,
      autonomy_run_id: "run-raced",
      repo_id: "example-web",
      acquired_at: "2026-07-28T17:30:00.000Z",
    };

    await expect(acquireRepoWriteLock({
      root_dir: directory,
      repo_id: "example-web",
      autonomy_run_id: "run-new",
      pid: 202,
      now: () => "2026-07-28T18:00:00.000Z",
      is_process_alive: () => {
        writeFileSync(stale.path, `${JSON.stringify(replacement)}\n`);
        return false;
      },
    })).rejects.toBeInstanceOf(RepoLockOwnershipError);

    expect(JSON.parse(await readFile(stale.path, "utf-8"))).toEqual(
      replacement,
    );
    expect(await readdir(directory)).toEqual(["example-web.lock"]);
  });

  it("maps path-traversal repository ids inside the lock root", () => {
    const path = repoLockPath(directory, "../../outside/../repo");
    expect(relative(directory, path)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(dirname(path)).toBe(directory);
    expect(basename(path)).toMatch(/^repo-[a-f0-9]{24}\.lock$/);
  });
});
