import { execFileSync, fork, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphResult } from "@osstack/protocol";
import { GraphArtifactStore, type GraphFreezeAuthority, type GraphFreezeInput } from "./artifact-store.js";
import { resolveRepositoryScope } from "./repository-scope.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.length = 0; });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "g16-artifact-"))); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  git(repo, "init", "-b", "main");
  await writeFile(join(repo, "deleted.txt"), "old"); await writeFile(join(repo, "base.txt"), "base");
  git(repo, "add", "."); git(repo, "-c", "user.name=test", "-c", "user.email=test@invalid", "commit", "-m", "base");
  const worktree = join(root, "source"); git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", worktree);
  const scope = await resolveRepositoryScope(worktree);
  const input: GraphFreezeInput = { artifactId: "artifact-1", scope: { schemaVersion: 1, tenantId: "t", principalId: "p", workspaceId: "w" }, runId: "run", generation: 1, owner: "owner", workspaceLeaseRef: "lease", repoId: scope.repoId, commonDir: scope.commonDir, worktreePath: scope.workspacePath, baseRevision: git(worktree, "rev-parse", "HEAD"), implementationReceiptRef: "implementation-1", producerStopEvidenceRef: "all-producers-1" };
  const lease = {};
  const authority: GraphFreezeAuthority = { lease, verifyLease: (_input, value) => { if (value !== lease) throw new Error("lease"); }, verifyImplementationReceipt: () => undefined, verifyProducersStopped: () => undefined };
  const store = new GraphArtifactStore(join(root, "artifacts"));
  return { root, repo, worktree, input, authority, store };
}
describe("trusted graph artifact freeze", () => {
  it("restores full reachable history and exact raw tree after deleting original repo and worktree", async () => {
    const f = await fixture();
    await rm(join(f.worktree, "deleted.txt"));
    await writeFile(join(f.worktree, "binary"), Buffer.from([0, 255, 1, 0, 128]));
    await writeFile(join(f.worktree, "exec"), "#!/bin/sh\nexit 0\n"); await chmod(join(f.worktree, "exec"), 0o755);
    await symlink("base.txt", join(f.worktree, "link"));
    const result = await f.store.freeze(f.input, f.authority);
    expect(GraphResult.parse(result).kind).toBe("candidate_ready");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.input.baseRevision);
    expect(git(f.repo, "show-ref")).not.toContain(result.candidateRevision);
    expect(() => git(f.repo, "cat-file", "-e", result.candidateRevision)).toThrow();
    const manifest = await f.store.verify(result.artifactDigest);
    expect(await f.store.freeze(f.input, f.authority)).toEqual(result);
    await rm(f.worktree, { recursive: true }); await rm(f.repo, { recursive: true });
    const restored = await new GraphArtifactStore(join(f.root, "artifacts")).restore(result.artifactDigest, { rootPath: f.root, directoryName: "restored" });
    expect(git(restored.worktreePath, "rev-parse", "HEAD^{tree}")).toBe(manifest.tree);
    expect(git(restored.worktreePath, "rev-parse", "HEAD^")).toBe(f.input.baseRevision);
    git(restored.worktreePath, "fsck", "--full", "--strict");
    await expect(readFile(join(restored.worktreePath, "binary"))).resolves.toEqual(Buffer.from([0, 255, 1, 0, 128]));
    expect((await lstat(join(restored.worktreePath, "exec"))).mode & 0o111).not.toBe(0);
    expect(await readlink(join(restored.worktreePath, "link"))).toBe("base.txt");
    await expect(lstat(join(restored.worktreePath, "deleted.txt"))).rejects.toThrow();
  }, 30_000);
  it("rechecks authority after durable publication before returning ready", async () => {
    const f = await fixture(); let checks = 0;
    f.authority.verifyLease = () => { if (++checks === 6) throw new Error("lease revoked during publication"); };
    await expect(f.store.freeze(f.input, f.authority)).rejects.toThrow("lease revoked during publication");
    expect(await readdir(join(f.root, "artifacts", "ids"))).toHaveLength(1);
  });
  it("returns immutable candidate identity and artifact refs", async () => {
    const f = await fixture(); const result = await f.store.freeze(f.input, f.authority);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifactRefs)).toBe(true);
  });
  it("captures tracked-file to directory replacement with unusual filenames", async () => {
    const f = await fixture();
    await rm(join(f.worktree, "base.txt")); await mkdir(join(f.worktree, "base.txt"));
    await writeFile(join(f.worktree, "base.txt", "space and\nnewline"), "replacement");
    const result = await f.store.freeze(f.input, f.authority);
    const restored = await f.store.restore(result.artifactDigest, { rootPath: f.root, directoryName: "replacement" });
    expect(await readFile(join(restored.worktreePath, "base.txt", "space and\nnewline"), "utf8")).toBe("replacement");
  }, 15_000);
  it("rejects missing required receipt fields at runtime", async () => {
    const f = await fixture(); const raw = { ...f.input } as Partial<GraphFreezeInput>;
    delete raw.implementationReceiptRef;
    await expect(f.store.freeze(raw as GraphFreezeInput, f.authority)).rejects.toThrow(/receipt/i);
  });
  it("does not return ready if durable ID publication fails; exported bytes remain recoverable", async () => {
    const f = await fixture(); let checks = 0;
    f.authority.verifyLease = async () => {
      if (++checks === 5) {
        await rm(join(f.root, "artifacts", "ids"), { recursive: true });
        await writeFile(join(f.root, "artifacts", "ids"), "disk publication unavailable");
      }
    };
    await expect(f.store.freeze(f.input, f.authority)).rejects.toThrow();
    const artifacts = await readdir(join(f.root, "artifacts", "artifacts"));
    expect(artifacts).toHaveLength(1);
    await rm(join(f.root, "artifacts", "ids")); await mkdir(join(f.root, "artifacts", "ids"));
    expect((await f.store.verify(artifacts[0]!)).input).toEqual(f.input);
  }, 15_000);
  it("rejects manifest corruption under a pinned artifact digest", async () => {
    const f = await fixture(); const result = await f.store.freeze(f.input, f.authority);
    await writeFile(join(f.root, "artifacts", "artifacts", result.artifactDigest, "manifest.json"), "{}");
    await expect(f.store.verify(result.artifactDigest)).rejects.toThrow(/manifest digest/);
  });
  it("rejects same ID with changed receipt or content", async () => {
    const f = await fixture(); await f.store.freeze(f.input, f.authority);
    await expect(f.store.freeze({ ...f.input, implementationReceiptRef: "other" }, f.authority)).rejects.toThrow(/replay|identity/i);
    await writeFile(join(f.worktree, "base.txt"), "changed");
    await expect(f.store.freeze(f.input, f.authority)).rejects.toThrow(/replay|content/i);
  });
  it.each(["verifyLease", "verifyImplementationReceipt", "verifyProducersStopped"] as const)("rejects nonconforming async authority %s", async (key) => {
    const f = await fixture();
    const bad = { ...f.authority, [key]: async () => true } as unknown as GraphFreezeAuthority;
    await expect(f.store.freeze(f.input, bad)).rejects.toThrow(/authority/i);
  });
  it("rechecks resolved producer evidence before capture and rejects revocation", async () => {
    const f = await fixture(); let calls = 0;
    f.authority.verifyProducersStopped = async () => { if (++calls > 1) throw new Error("producer unknown"); };
    await expect(f.store.freeze(f.input, f.authority)).rejects.toThrow("producer unknown");
    await expect(lstat(join(f.root, "artifacts", "ids"))).resolves.toBeDefined();
  });
  it("rejects mismatched exact source identity and HEAD", async () => {
    const f = await fixture();
    await expect(f.store.freeze({ ...f.input, repoId: "wrong" }, f.authority)).rejects.toThrow(/identity|repoId/i);
    await expect(f.store.freeze({ ...f.input, baseRevision: "0".repeat(40) }, f.authority)).rejects.toThrow(/HEAD|revision/i);
  });
  it("does not invoke local hooks or filters during capture or restore", async () => {
    const f = await fixture(); const marker = join(f.root, "executed");
    await writeFile(join(f.repo, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch '${marker}'\n`); await chmod(join(f.repo, ".git", "hooks", "pre-commit"), 0o755);
    git(f.repo, "config", "filter.evil.clean", `touch '${marker}'; cat`); git(f.repo, "config", "filter.evil.smudge", `touch '${marker}'; cat`);
    await writeFile(join(f.worktree, ".gitattributes"), "*.txt filter=evil text eol=crlf\n");
    await writeFile(join(f.worktree, "base.txt"), "raw\r\n");
    const result = await f.store.freeze(f.input, f.authority);
    const restored = await f.store.restore(result.artifactDigest, { rootPath: f.root, directoryName: "restored" });
    expect(await readFile(join(restored.worktreePath, "base.txt"), "utf8")).toBe("raw\r\n");
    await expect(lstat(marker)).rejects.toThrow();
  }, 20_000);
  it("rejects submodules instead of exporting an incomplete tree", async () => {
    const f = await fixture(); git(f.worktree, "update-index", "--add", "--cacheinfo", `160000,${f.input.baseRevision},sub`);
    await expect(f.store.freeze(f.input, f.authority)).rejects.toThrow(/submodule/i);
  });
  it("rejects corrupted bundles and manifests, including replay", async () => {
    const f = await fixture(); const result = await f.store.freeze(f.input, f.authority);
    const bundle = join(f.root, "artifacts", "artifacts", result.artifactDigest, "candidate.bundle");
    await writeFile(bundle, "broken");
    await expect(f.store.verify(result.artifactDigest)).rejects.toThrow(/digest|corrupt/i);
    await expect(f.store.freeze(f.input, f.authority)).rejects.toThrow(/digest|corrupt/i);
  });
  it("refuses existing and escaping restore destinations", async () => {
    const f = await fixture(); const result = await f.store.freeze(f.input, f.authority);
    await expect(f.store.restore(result.artifactDigest, { rootPath: f.root, directoryName: "repo" })).rejects.toThrow();
    await expect(f.store.restore(result.artifactDigest, { rootPath: f.root, directoryName: "../escape" })).rejects.toThrow();
    await symlink(f.repo, join(f.root, "alias"));
    await expect(f.store.restore(result.artifactDigest, { rootPath: f.root, directoryName: "alias" })).rejects.toThrow();
  }, 20_000);
});
it('rejects skip-worktree entries instead of silently freezing sparse omissions as deletions', async () => {
  const f = await fixture();
  git(f.worktree, 'update-index', '--skip-worktree', 'base.txt'); await rm(join(f.worktree, 'base.txt'));
  await expect(f.store.freeze(f.input, f.authority)).rejects.toThrow('skip-worktree');
});

it('F07/F12: SIGKILL during freeze leaves a lock that a fresh store cannot guess away', async () => {
  const f = await fixture();
  const inputFile = join(f.root, 'crash-input.json');
  const storeRoot = join(f.root, 'artifacts');
  await writeFile(inputFile, JSON.stringify({ storeRoot, input: f.input }));
  const child = fork(fileURLToPath(new URL('../../../../scripts/fixtures/graph-artifact-crash.mjs', import.meta.url)), [inputFile], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, OSSTACK_HOME: join(f.root, 'home') },
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('LOCK_BARRIER_TIMEOUT')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('EARLY_PRODUCER_EXIT')); });
      child.once('message', value => {
        clearTimeout(timer);
        if ((value as { kind?: string }).kind === 'lock-acquired') resolve(); else reject(Error('WRONG_BARRIER'));
      });
    });
    child.kill('SIGKILL'); await exited;
    const locks = await readdir(join(storeRoot, 'locks')); expect(locks).toHaveLength(1);
    expect(await readdir(join(storeRoot, 'ids'))).toEqual([]);
    await expect(new GraphArtifactStore(storeRoot).freeze(f.input, f.authority)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readdir(join(storeRoot, 'locks'))).toEqual(locks);
    expect(await readFile(join(f.worktree, 'base.txt'), 'utf8')).toBe('base');
    expect(await readdir(join(storeRoot, 'ids'))).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}, 10000);

it('F07: a late real process writing the old directory cannot mutate the exported candidate or its new restore', async () => {
  const f = await fixture(); const candidate = await f.store.freeze(f.input, f.authority);
  const child = spawn(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1],"late old-generation write");process.send({written:true});setInterval(()=>{},1000)',
    join(f.worktree, 'base.txt')], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) }); expect(message).toEqual({ written: true });
    const restored = await f.store.restore(candidate.artifactDigest, { rootPath: f.root, directoryName: 'next-generation' });
    expect(restored.worktreePath).not.toBe(f.worktree);
    expect(await readFile(join(f.worktree, 'base.txt'), 'utf8')).toBe('late old-generation write');
    expect(await readFile(join(restored.worktreePath, 'base.txt'), 'utf8')).toBe('base');
    expect((await f.store.verify(candidate.artifactDigest)).candidateRevision).toBe(candidate.candidateRevision);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}, 10000);

it('rejects an oversized full-history bundle before reading it into memory', async () => {
  const f = await fixture(); const result = await f.store.freeze(f.input, f.authority);
  const bundle = join(f.root, 'artifacts', 'artifacts', result.artifactDigest, 'candidate.bundle');
  await truncate(bundle, 256 * 1024 * 1024 + 1);
  await expect(f.store.verify(result.artifactDigest)).rejects.toThrow('maximum 256 MiB');
});


it('binds freeze and replay to the applied tree and invocation base tree', async () => {
  const f = await fixture(); const base = git(f.worktree, 'rev-parse', 'HEAD^{tree}');
  await writeFile(join(f.worktree, 'base.txt'), 'applied');
  git(f.worktree, 'add', '.'); const candidate = git(f.worktree, 'write-tree');
  const authority = { ...f.authority, expectedTrees: { base, candidate } };
  const result = await f.store.freeze(f.input, authority);
  expect((await f.store.verify(result.artifactDigest)).tree).toBe(candidate);
  expect(await f.store.freeze(f.input, authority)).toEqual(result);
  await expect(f.store.freeze(f.input, { ...authority, expectedTrees: { base, candidate: base } })).rejects.toThrow('applied tree mismatch');
});
it.each(['base', 'candidate'] as const)('rejects a mismatched %s tree before artifact publication', async field => {
  const f = await fixture(); const tree = git(f.worktree, 'rev-parse', 'HEAD^{tree}');
  const authority = { ...f.authority, expectedTrees: { base: tree, candidate: tree, [field]: '0'.repeat(40) } };
  await expect(f.store.freeze(f.input, authority)).rejects.toThrow(/tree mismatch/);
  expect(await readdir(join(f.root, 'artifacts', 'ids'))).toEqual([]);
  expect(await readdir(join(f.root, 'artifacts', 'artifacts'))).toEqual([]);
});
it('pins tree constraints before calling asynchronous authority', async () => {
  const f = await fixture(); const tree = git(f.worktree, 'rev-parse', 'HEAD^{tree}');
  const expectedTrees = { base: tree, candidate: '0'.repeat(40) };
  f.authority.verifyLease = () => { expectedTrees.candidate = tree; };
  await expect(f.store.freeze(f.input, { ...f.authority, expectedTrees })).rejects.toThrow('applied tree mismatch');
});
it('rejects malformed tree constraints before invoking authority', async () => {
  const f = await fixture(); let checked = false;
  f.authority.verifyLease = () => { checked = true; };
  await expect(f.store.freeze(f.input, { ...f.authority, expectedTrees: { base: 'HEAD', candidate: 'bad' } })).rejects.toThrow('invalid freeze tree constraint');
  expect(checked).toBe(false);
});

it('constrained capture uses the same owner execute bit as the changeset applier', async () => {
  const f = await fixture(); const tree = git(f.worktree, 'rev-parse', 'HEAD^{tree}');
  await chmod(join(f.worktree, 'base.txt'), 0o645);
  const candidate = await f.store.freeze(f.input, { ...f.authority, expectedTrees: { base: tree, candidate: tree } });
  expect((await f.store.verify(candidate.artifactDigest)).tree).toBe(tree);
});
it('preserves historical ignored-file capture while constrained freeze detects the file', async () => {
  const f = await fixture(); const tree = git(f.worktree, 'rev-parse', 'HEAD^{tree}');
  await writeFile(join(f.root, 'ignore'), 'hidden.txt\n'); git(f.worktree, 'config', 'core.excludesFile', join(f.root, 'ignore'));
  await writeFile(join(f.worktree, 'hidden.txt'), 'ignored');
  const candidate = await f.store.freeze(f.input, f.authority);
  expect((await f.store.verify(candidate.artifactDigest)).tree).toBe(tree);
  await expect(f.store.freeze(f.input, { ...f.authority, expectedTrees: { base: tree, candidate: tree } })).rejects.toThrow('applied tree mismatch');
});
