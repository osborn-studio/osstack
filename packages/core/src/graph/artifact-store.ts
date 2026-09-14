import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { GraphResult, GraphScope } from "@osstack/protocol";
import { resolveRepositoryScope } from "./repository-scope.js";
import { artifactGit, artifactPath, captureArtifactTree, gitText, initArtifactRepo, linkSourceObjects } from "./artifact-git.js";

export interface GraphFreezeInput {
  artifactId: string;
  scope: GraphScope;
  runId: string;
  generation: number;
  owner: string;
  workspaceLeaseRef: string;
  repoId: string;
  commonDir: string;
  worktreePath: string;
  baseRevision: string;
  implementationReceiptRef: string;
  producerStopEvidenceRef: string;
}
/** Trusted host capabilities, never worker-provided booleans/paths. Host retains
 * the already-held canonical G10 writer lease and blocks new producers throughout.
 * Each verifier must resolve undefined or throw; verifyLease authenticates the
 * actual lease object, generation/owner, canonical repo and current authority. */
export interface GraphFreezeAuthority {
  lease: object;
  verifyLease: (input: Readonly<GraphFreezeInput>, lease: object) => void | Promise<void>;
  verifyImplementationReceipt: (input: Readonly<GraphFreezeInput>) => void | Promise<void>;
  verifyProducersStopped: (input: Readonly<GraphFreezeInput>) => void | Promise<void>;
}
export interface GraphArtifactManifest {
  version: 1;
  input: GraphFreezeInput;
  tree: string;
  candidateRevision: string;
  bundleDigest: string;
}
type CandidateReady = Extract<GraphResult, { kind: "candidate_ready" }>;
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function snapshot<T>(value: T): T {
  const result = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(result); return result;
}
function validateInput(input: GraphFreezeInput): void {
  for (const key of ["artifactId", "runId", "owner", "workspaceLeaseRef", "repoId", "commonDir", "worktreePath", "baseRevision", "implementationReceiptRef", "producerStopEvidenceRef"] as const) {
    const value = input[key];
    if (typeof value !== "string" || !value || value.includes("\0")) throw new Error(`invalid freeze ${key}`);
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || input.scope?.schemaVersion !== 1 || !input.scope.tenantId || !input.scope.principalId || !input.scope.workspaceId) throw new Error("invalid freeze identity");
  if (![input.commonDir, input.worktreePath].every(isAbsolute) || !/^[a-f0-9]{40}$/.test(input.baseRevision)) throw new Error("invalid source path or revision (only SHA1 repositories supported)");
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } catch (error) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; } finally { await handle.close(); }
}
async function durableFile(path: string, value: Buffer | string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** On-disk immutable artifacts, no scheduler and no automatic GC. Store root and
 * Git executable must be host-owned, inaccessible to untrusted producers. */
export class GraphArtifactStore {
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error("artifact root must be absolute");
  }
  private async prepare(): Promise<string> {
    // Require an existing parent so all newly created directory entries are synced.
    await realpath(dirname(this.root));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    for (const child of ["artifacts", "ids", "scratch", "locks"]) await mkdir(join(root, child), { recursive: true, mode: 0o700 });
    await syncDirectory(root); await syncDirectory(dirname(root));
    return root;
  }
  async freeze(raw: GraphFreezeInput, rawAuthority: GraphFreezeAuthority): Promise<CandidateReady> {
    const input = snapshot(raw); validateInput(input);
    const authority = Object.freeze({ ...rawAuthority });
    if (!authority.lease || typeof authority.lease !== "object") throw new Error("missing canonical lease authority");
    const check = async (): Promise<void> => {
      for (const fn of [() => authority.verifyImplementationReceipt(input), () => authority.verifyProducersStopped(input), () => authority.verifyLease(input, authority.lease)]) {
        if (await fn() !== undefined) throw new Error("nonconforming freeze authority");
      }
    };
    await check();
    const root = await this.prepare();
    const id = sha(input.artifactId); const binding = join(root, "ids", `${id}.json`);
    const lock = join(root, "locks", id);
    await mkdir(lock); // Cross-process exclusion; stale locks fail closed, never guessed away.
    let scratch: string | undefined;
    try {
      const sourceIdentity = await this.source(input);
      await check();
      scratch = await mkdtemp(join(root, "scratch", "capture-"));
      const objectRepo = join(scratch, "objects.git");
      await initArtifactRepo(objectRepo); await linkSourceObjects(objectRepo, input.commonDir);
      if (await this.source(input) !== sourceIdentity) throw new Error("source identity changed before capture");
      await check();
      const tree = await captureArtifactTree(input.worktreePath, objectRepo);
      if (await exists(binding)) {
        const saved = JSON.parse(await readFile(binding, "utf8")) as { inputDigest: string; artifactDigest: string };
        if (saved.inputDigest !== sha(canonical(input))) throw new Error("artifact replay identity mismatch");
        const manifest = await this.verify(saved.artifactDigest);
        if (canonical(manifest.input) !== canonical(input) || manifest.tree !== tree) throw new Error("artifact replay content mismatch");
        await check();
        if (await this.source(input) !== sourceIdentity || await captureArtifactTree(input.worktreePath, objectRepo) !== tree) throw new Error("source content changed during replay");
        await check();
        return this.result(saved.artifactDigest, manifest);
      }
      const candidateRevision = await gitText(objectRepo, ["commit-tree", tree, "-p", input.baseRevision], Buffer.from(`OSStack frozen candidate ${sha(canonical(input))}\n`));
      await artifactGit(objectRepo, ["update-ref", "refs/heads/candidate", candidateRevision]);
      const staging = join(scratch, "artifact"); await mkdir(staging);
      const bundlePath = join(staging, "candidate.bundle");
      await artifactGit(objectRepo, ["bundle", "create", bundlePath, "refs/heads/candidate"]);
      const manifest: GraphArtifactManifest = { version: 1, input, tree, candidateRevision, bundleDigest: sha(await readFile(bundlePath)) };
      const manifestBytes = canonical(manifest); const digest = sha(manifestBytes);
      // Validate from a fresh object database with no alternates or prerequisites.
      await this.validateBundle(bundlePath, manifest, join(scratch, "verify.git"));
      await check();
      if (await this.source(input) !== sourceIdentity || await captureArtifactTree(input.worktreePath, objectRepo) !== tree) throw new Error("source content or identity changed during freeze");
      await check();
      const bundleHandle = await open(bundlePath, "r"); try { await bundleHandle.sync(); } finally { await bundleHandle.close(); }
      await durableFile(join(staging, "manifest.json"), manifestBytes); await syncDirectory(staging);
      const destination = join(root, "artifacts", digest);
      if (await exists(destination)) await this.verify(digest);
      else await rename(staging, destination);
      await syncDirectory(join(root, "artifacts"));
      const temporaryBinding = join(root, "ids", `.${id}-${randomUUID()}`);
      await durableFile(temporaryBinding, canonical({ inputDigest: sha(canonical(input)), artifactDigest: digest }));
      await rename(temporaryBinding, binding); await syncDirectory(join(root, "ids"));
      await check();
      return this.result(digest, manifest);
    } finally {
      // Only scratch files are disposable. Never source worktrees/artifacts.
      if (scratch) await rm(scratch, { recursive: true, force: true });
      await rm(lock, { recursive: true });
    }
  }
  private result(digest: string, manifest: GraphArtifactManifest): CandidateReady {
    return snapshot({ schemaVersion: 1, kind: "candidate_ready", candidateRevision: manifest.candidateRevision, artifactDigest: digest, artifactRefs: [`graph-artifact:${digest}`] });
  }
  private async source(input: GraphFreezeInput): Promise<string> {
    const scope = await resolveRepositoryScope(input.worktreePath, { repoId: input.repoId, commonDir: input.commonDir });
    if (scope.workspacePath !== input.worktreePath || scope.commonDir !== input.commonDir || await gitText(input.worktreePath, ["rev-parse", "--show-toplevel"]) !== input.worktreePath) throw new Error("exact source identity mismatch");
    if (await gitText(input.worktreePath, ["rev-parse", "HEAD"]) !== input.baseRevision) throw new Error("source HEAD revision mismatch");
    if (await gitText(input.worktreePath, ["rev-parse", "--is-shallow-repository"]) !== "false") throw new Error("unsupported shallow source");
    if ((await gitText(input.worktreePath, ["ls-tree", "-r", input.baseRevision])).split("\n").some(line => line.startsWith("160000 "))) throw new Error("unsupported submodule");
    const gitDir = await realpath(await gitText(input.worktreePath, ["rev-parse", "--absolute-git-dir"]));
    const identities = await Promise.all([input.worktreePath, input.commonDir, gitDir].map(async path => { const s = await lstat(path); return [path, s.dev, s.ino]; }));
    return canonical(identities);
  }
  async verify(digest: string): Promise<GraphArtifactManifest> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid artifact digest");
    const root = await this.prepare(); const directory = join(root, "artifacts", digest);
    const bytes = await readFile(join(directory, "manifest.json"));
    if (sha(bytes) !== digest) throw new Error("corrupt artifact manifest digest");
    const manifest = JSON.parse(bytes.toString("utf8")) as GraphArtifactManifest;
    if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.tree) || !/^[a-f0-9]{40}$/.test(manifest.candidateRevision)) throw new Error("invalid artifact manifest");
    validateInput(manifest.input);
    const bundle = join(directory, "candidate.bundle");
    if (sha(await readFile(bundle)) !== manifest.bundleDigest) throw new Error("corrupt artifact bundle digest");
    const scratch = await mkdtemp(join(root, "scratch", "verify-"));
    try { await this.validateBundle(bundle, manifest, join(scratch, "repo.git")); } finally { await rm(scratch, { recursive: true, force: true }); }
    return snapshot(manifest);
  }
  private async validateBundle(bundle: string, manifest: GraphArtifactManifest, repo: string): Promise<void> {
    await initArtifactRepo(repo);
    await artifactGit(repo, ["bundle", "verify", bundle]);
    await artifactGit(repo, ["bundle", "unbundle", bundle]);
    await artifactGit(repo, ["update-ref", "refs/heads/candidate", manifest.candidateRevision]);
    if (await gitText(repo, ["rev-parse", `${manifest.candidateRevision}^{tree}`]) !== manifest.tree || await gitText(repo, ["rev-parse", `${manifest.candidateRevision}^`]) !== manifest.input.baseRevision) throw new Error("artifact candidate tree/parent mismatch");
    await artifactGit(repo, ["fsck", "--full", "--strict"]);
  }
  async restore(digest: string, destination: { rootPath: string; directoryName: string }): Promise<{ worktreePath: string; candidateRevision: string; tree: string }> {
    const { rootPath, directoryName } = destination;
    if (!isAbsolute(rootPath) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(directoryName)) throw new Error("invalid exact restore destination");
    const parent = await realpath(rootPath); const target = join(parent, directoryName);
    if (await exists(target)) throw new Error("restore destination already exists");
    const manifest = await this.verify(digest);
    await mkdir(target); // exclusive allocation, never reuse or overwrite
    const root = await realpath(this.root);
    await initArtifactRepo(target, false);
    await artifactGit(target, ["bundle", "unbundle", join(root, "artifacts", digest, "candidate.bundle")]);
    await artifactGit(target, ["update-ref", "HEAD", manifest.candidateRevision]);
    await artifactGit(target, ["read-tree", manifest.candidateRevision]);
    const entries = (await artifactGit(target, ["ls-tree", "-rz", "--full-tree", manifest.candidateRevision])).toString("utf8").split("\0").filter(Boolean);
    for (const entry of entries) {
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("unsupported artifact tree entry");
      const path = artifactPath(target, match[3]!);
      await mkdir(dirname(path), { recursive: true });
      if (await realpath(dirname(path)) !== dirname(path) || await exists(path)) throw new Error("restore path collision or symlink ancestor");
      const bytes = await artifactGit(target, ["cat-file", "blob", match[2]!]);
      if (match[1] === "120000") await symlink(bytes, path);
      else { await durableFile(path, bytes); await chmod(path, match[1] === "100755" ? 0o755 : 0o644); }
    }
    const scratch = await mkdtemp(join(root, "scratch", "restore-"));
    try {
      await initArtifactRepo(scratch);
      if (await captureArtifactTree(target, scratch) !== manifest.tree) throw new Error("restored tree mismatch");
    } finally { await rm(scratch, { recursive: true, force: true }); }
    return { worktreePath: target, candidateRevision: manifest.candidateRevision, tree: manifest.tree };
  }
}
