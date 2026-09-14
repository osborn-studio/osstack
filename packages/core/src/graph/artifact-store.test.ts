import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
