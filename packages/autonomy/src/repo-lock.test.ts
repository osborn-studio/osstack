import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectRepoWriteLock,
  releaseReconciledRepoWriteLock,
  acquireRepoLock,
  acquireRepoWriteLock,
  RepoLockBusyError,
  RepoLockOwnershipError,
  repoLockPath,
} from "./repo-lock.js";

let directory: string;
const children: ChildProcess[] = [];
let fixtureId = 0;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "osstack-repo-lock-"));
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }));
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
      stale_owner: stale.owner,
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

// Transpile the actual implementation, then execute it in independent Node processes.
// No in-memory mock can arbitrate these competing writers.
async function childWriter(repoId = "shared", options: {
  leaseMs?: number; workspacePath?: string; home?: string;
} = {}) {
  const source = await readFile(new URL("./repo-lock.ts", import.meta.url), "utf-8");
  const zod = pathToFileURL(createRequire(import.meta.url).resolve("zod")).href;
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  } }).outputText.replace('from "zod"', `from ${JSON.stringify(zod)}`);
  const id = fixtureId++;
  const modulePath = join(directory, `lock-impl-${id}.mjs`);
  await writeFile(modulePath, compiled);
  const scopeSource = await readFile(new URL("../../core/src/graph/repository-scope.ts", import.meta.url), "utf8");
  const scopePath = join(directory, `scope-${id}.mjs`);
  await writeFile(scopePath, ts.transpileModule(scopeSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
  } }).outputText);
  const driver = join(directory, `driver-${id}.mjs`);
  await writeFile(driver, `import { acquireRepoWriteLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    import { resolveRepositoryScope } from ${JSON.stringify(pathToFileURL(scopePath).href)};
    import { join } from "node:path";
    const scope = ${options.workspacePath === undefined ? "undefined" : `await resolveRepositoryScope(${JSON.stringify(options.workspacePath)})`};
    let lock;
    process.on("message", async (command) => {
      try {
        if (command === "acquire") { lock = await acquireRepoWriteLock({ root_dir: scope ? join(scope.commonDir, "osstack", "repo-locks") : ${JSON.stringify(directory)}, repo_id: scope?.repoId ?? ${JSON.stringify(repoId)}, autonomy_run_id: String(process.pid), lease_ms: ${options.leaseMs ?? 10000} }); process.send({ status: "acquired", owner: lock.owner }); }
        if (command === "renew") { await lock.renew(); process.send({ status: "renewed", owner: lock.owner }); }
        if (command === "release") { await lock.release(); process.send({ status: "released" }); }
      } catch (error) { process.send({ status: "error", name: error.name, message: error.message }); }
    }); process.send({ status: "ready" });`);
  const child = fork(driver, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, ...(options.home === undefined ? {} : { OSSTACK_HOME: options.home }) } });
  children.push(child);
  await reply(child);
  return child;
}
function reply(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("fixture IPC timed out")); }, 5_000);
    const onMessage = (value: Record<string, unknown>) => { cleanup(); resolve(value); };
    const onExit = () => { cleanup(); reject(new Error("fixture exited before reply")); };
    const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit); };
    child.once("message", onMessage); child.once("exit", onExit);
  });
}
function command(child: ChildProcess, value: string) {
  const result = reply(child); child.send(value); return result;
}

describe("renewable repository lease", () => {
  it("has unique ownership even with identical pid, run and timestamp", async () => {
    const options = { root_dir: directory, repo_id: "same", autonomy_run_id: "same", now: () => "2026-09-13T00:00:00.000Z" };
    const old = await acquireRepoWriteLock(options);
    await rm(old.path); // Simulates a prior administrative replacement.
    const replacement = await acquireRepoWriteLock(options);
    expect(old.owner.token).not.toBe(replacement.owner.token);
    await expect(old.release()).rejects.toBeInstanceOf(RepoLockOwnershipError);
    await expect(old.renew()).rejects.toBeInstanceOf(RepoLockOwnershipError);
    await replacement.assertActive();
    await replacement.release();
  });

  it("renews expiry, observes expiry and cannot renew an already expired lease", async () => {
    let time = Date.parse("2026-09-13T00:00:00.000Z");
    const lock = await acquireRepoWriteLock({ root_dir: directory, repo_id: "lease", autonomy_run_id: "run", lease_ms: 100, now: () => new Date(time).toISOString() });
    const token = lock.owner.token;
    expect(lock.owner.expires_at).toBe(new Date(time + 100).toISOString());
    time += 60;
    await lock.renew();
    expect(lock.owner.token).toBe(token);
    expect(lock.owner.expires_at).toBe(new Date(time + 100).toISOString());
    expect(JSON.parse(await readFile(lock.path, "utf8"))).toEqual(lock.owner);
    time += 100;
    await lock.assertOwnership();
    await expect(lock.assertActive()).rejects.toThrow(/expir/i);
    await expect(lock.renew()).rejects.toThrow(/expir/i);
    await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: "lease", autonomy_run_id: "other" })).rejects.toBeInstanceOf(RepoLockBusyError);
    await lock.release();
    await lock.release();
    await expect(lock.assertOwnership()).rejects.toBeInstanceOf(RepoLockOwnershipError);
  });

  it("rejects omitted lock identity and invalid lease durations", async () => {
    for (const lease_ms of [0, -1, NaN, Infinity]) {
      await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: "repo", autonomy_run_id: "run", lease_ms })).rejects.toThrow();
    }
    await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: "", autonomy_run_id: "run" })).rejects.toThrow();
  });

  it("treats unknown process liveness as live and leaves legacy owner files intact", async () => {
    const path = repoLockPath(directory, "legacy");
    const legacy = { pid: process.pid, repo_id: "legacy", autonomy_run_id: "old", acquired_at: "2026-07-28T17:00:00.000Z" };
    await writeFile(path, JSON.stringify(legacy));
    await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: "legacy", autonomy_run_id: "new", is_process_alive: () => { throw new Error("unknown"); } })).rejects.toBeInstanceOf(RepoLockBusyError);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(legacy);
  });

  it("fails closed on an abandoned mutation guard instead of age-stealing it", async () => {
    await mkdir(`${repoLockPath(directory, "guarded")}.guard`);
    await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: "guarded", autonomy_run_id: "run" })).rejects.toThrow(/guard|mutation/i);
    await expect(readFile(repoLockPath(directory, "guarded"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("arbitrates real competing processes, renews and transfers only after release", async () => {
    const writers = await Promise.all(Array.from({ length: 4 }, () => childWriter()));
    const results = await Promise.all(writers.map((child) => command(child, "acquire")));
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.name === "RepoLockBusyError")).toHaveLength(3);
    const winner = writers[results.findIndex((result) => result.status === "acquired")]!;
    expect(await command(winner, "renew")).toMatchObject({ status: "renewed" });
    expect(await command(winner, "release")).toEqual({ status: "released" });
    const other = writers.find((child) => child !== winner)!;
    expect(await command(other, "acquire")).toMatchObject({ status: "acquired" });
    expect(await command(other, "release")).toEqual({ status: "released" });
  });

  it("concurrent stale recovery never removes a newly acquired live process lock", async () => {
    const dead = await childWriter();
    expect(await command(dead, "acquire")).toMatchObject({ status: "acquired" });
    const exited = new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    dead.kill("SIGKILL"); await exited;
    const contenders = await Promise.all(Array.from({ length: 6 }, () => childWriter()));
    const results = await Promise.all(contenders.map((child) => command(child, "acquire")));
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.name === "RepoLockBusyError")).toHaveLength(5);
    const winner = contenders[results.findIndex((result) => result.status === "acquired")]!;
    const owner = JSON.parse(await readFile(repoLockPath(directory, "shared"), "utf8"));
    expect(owner.pid).toBe(winner.pid);
    expect(await command(winner, "renew")).toMatchObject({ status: "renewed" });
    expect(await command(winner, "release")).toEqual({ status: "released" });
  });
});


describe("managed repository process quarantine", () => {
  it("retains a dead owner when managed acquisition forbids unproven descendant recovery", async () => {
    const child = await childWriter();
    expect(await command(child, "acquire")).toMatchObject({ status: "acquired" });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
    const path = repoLockPath(directory, "shared");
    const before = await readFile(path, "utf8");
    for (let restart = 0; restart < 2; restart++) {
      await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: "shared", autonomy_run_id: `restart-${restart}`, recover_stale: false })).rejects.toBeInstanceOf(RepoLockBusyError);
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });

  it("does not steal from a real live child after its lease expires", async () => {
    const child = await childWriter("short", { leaseMs: 50 });
    const acquired = await command(child, "acquire");
    expect(acquired.status).toBe("acquired");
    const owner = acquired.owner as { expires_at: string };
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(owner.expires_at) - Date.now()) + 20));
    expect(await command(child, "renew")).toMatchObject({ name: "RepoLockOwnershipError" });
    await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: "short", autonomy_run_id: "contender" })).rejects.toBeInstanceOf(RepoLockBusyError);
    expect(await command(child, "release")).toEqual({ status: "released" });
  });

  it("shares one lock across real worktrees and independent OSSTACK_HOMEs", async () => {
    const repo = join(directory, "repo");
    const worktree = join(directory, "worktree");
    await mkdir(repo);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, timeout: 5_000, stdio: "pipe" });
    git("init");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
    git("worktree", "add", "--detach", worktree);
    const firstHome = join(directory, "home-a");
    const secondHome = join(directory, "home-b");
    await Promise.all([mkdir(firstHome), mkdir(secondHome)]);
    const first = await childWriter("ignored-label-a", { workspacePath: repo, home: firstHome });
    const second = await childWriter("ignored-label-b", { workspacePath: worktree, home: secondHome });
    expect(await command(first, "acquire")).toMatchObject({ status: "acquired" });
    expect(await command(second, "acquire")).toMatchObject({ name: "RepoLockBusyError" });
    expect(await command(first, "release")).toEqual({ status: "released" });
    expect(await command(second, "acquire")).toMatchObject({ status: "acquired" });
    expect(await command(second, "release")).toEqual({ status: "released" });
  });
});


it("starts the lease at publication after waiting for a metadata transaction", async () => {
  const path = repoLockPath(directory, "waiting");
  const guard = `${path}.guard`;
  await mkdir(guard);
  let time = Date.parse("2026-09-13T00:00:00.000Z");
  let clockRead!: () => void;
  const read = new Promise<void>((resolve) => { clockRead = resolve; });
  const pending = acquireRepoWriteLock({ root_dir: directory, repo_id: "waiting", autonomy_run_id: "run", lease_ms: 100, now: () => { clockRead(); return new Date(time).toISOString(); } });
  await read;
  time += 500;
  await rmdir(guard);
  const lock = await pending;
  await lock.assertActive();
  expect(lock.owner.expires_at).toBe(new Date(time + 100).toISOString());
  await lock.release();
});

it('requires exact dead-owner identity and verified external quiescence before post-restart release', async () => {
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  const lock = await acquireRepoWriteLock({ root_dir: directory, repo_id: 'recovered', autonomy_run_id: 'graph-action:effect', pid, recover_stale: false });
  const owner = await inspectRepoWriteLock(directory, 'recovered');
  expect(owner).toEqual(lock.owner);
  const options = { root_dir: directory, repo_id: 'recovered', expectedOwner: owner!, verifyQuiescent: async () => {} };
  await expect(releaseReconciledRepoWriteLock({ ...options, expectedOwner: { ...owner!, token: '00000000-0000-4000-8000-000000000000' } })).rejects.toThrow('ownership');
  await expect(releaseReconciledRepoWriteLock({ ...options, verifyQuiescent: async () => { throw new Error('independent producer remains'); } })).rejects.toThrow('independent producer');
  expect(await inspectRepoWriteLock(directory, 'recovered')).toEqual(owner);
  await expect(releaseReconciledRepoWriteLock({ ...options, verifyQuiescent: async () => false as unknown as undefined })).rejects.toThrow('quiescence');
  await releaseReconciledRepoWriteLock(options);
  expect(await inspectRepoWriteLock(directory, 'recovered')).toBeNull();
  const replacement = await acquireRepoWriteLock({ root_dir: directory, repo_id: 'recovered', autonomy_run_id: 'new-owner' });
  await expect(releaseReconciledRepoWriteLock(options)).rejects.toThrow('ownership');
  await replacement.release();
});
it('never treats a live daemon PID as a post-restart recovery target', async () => {
  const lock = await acquireRepoWriteLock({ root_dir: directory, repo_id: 'live', autonomy_run_id: 'live' });
  await expect(releaseReconciledRepoWriteLock({ root_dir: directory, repo_id: 'live', expectedOwner: lock.owner, verifyQuiescent: async () => {} })).rejects.toThrow('alive');
  await lock.release();
});

// A persisted policy protects against unrelated callers using the legacy default.
it('never stale-reaps a managed graph lock through legacy or explicit recovery, even after expiry', async () => {
  const lock = await acquireRepoWriteLock({ root_dir: directory, repo_id: 'retained', autonomy_run_id: 'graph:unknown',
    recover_stale: false, pid: 123, now: () => '2000-01-01T00:00:00.000Z' });
  const before = await readFile(lock.path, 'utf8');
  expect(JSON.parse(before).recovery_policy).toBe('reconcile');
  for (const recover_stale of [undefined, true, false]) {
    await expect(acquireRepoWriteLock({ root_dir: directory, repo_id: 'retained', autonomy_run_id: 'legacy-loop',
      ...(recover_stale === undefined ? {} : { recover_stale }), is_process_alive: () => false })).rejects.toBeInstanceOf(RepoLockBusyError);
    expect(await readFile(lock.path, 'utf8')).toBe(before);
  }
  await lock.release();
});
