import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ImprovementCandidateArtifact {
  base_sha: string;
  head_sha: string;
  changed_paths: string[];
  patch: string;
  patch_sha256: string;
  files: Array<{ path: string; sha256: string | null }>;
  /** The semantic index contents, independent of Git's mutable stat cache. */
  staged_sha256: string;
}

interface GitEntry {
  mode: string;
  oid: string;
}
interface WorkingEntry extends GitEntry {
  bytes: Buffer;
}
interface Snapshot {
  head: string;
  base: Map<string, GitEntry>;
  working: Map<string, WorkingEntry | null>;
  changedPaths: string[];
  stagedHash: string;
  fingerprint: string;
}

const MAX_BYTES = 64 * 1024 * 1024;
const PROTECTED_COMPONENTS = new Set([
  ".git", ".github", ".gitlab", ".osstack", ".codex", ".claude", ".agents",
  ".circleci", ".githooks", ".husky",
]);
const PROTECTED_FILES = new Set([
  "agents.md", "claude.md", ".gitignore", ".gitattributes", ".gitmodules", ".gitconfig",
  ".npmrc", ".yarnrc", ".yarnrc.yml", "package.json", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
  "bun.lock", "bun.lockb", "makefile", "dockerfile", "justfile",
]);
// Only ignored, untracked entries in these conventional caches are excluded.
// An ignored source directory such as generated/ is still part of the candidate.
const IGNORED_CACHE_COMPONENTS = new Set([
  "node_modules", ".pnpm", ".cache", ".pytest_cache", ".mypy_cache", "__pycache__",
]);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateRelativePath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") ||
      path.includes("\\") || [":", "*", "?", "[", "]"].some((character) => path.includes(character)) ||
      [...path].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      }) || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid exact relative improvement path: ${JSON.stringify(path)}`);
  }
}

/** Exact file names only. Returned names are sorted; directory prefixes grant nothing. */
export function validateImprovementPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("At least one exact allowed improvement path is required");
  }
  for (const path of paths) {
    validateRelativePath(path);
    if (path.split("/").some((part) => {
      const lower = part.toLowerCase();
      return PROTECTED_COMPONENTS.has(lower) || PROTECTED_FILES.has(lower) ||
        lower === ".env" || lower.startsWith(".env.");
    })) {
      throw new Error(`Protected improvement path: ${path}`);
    }
  }
  return [...new Set(paths)].sort();
}

/** No shell, inherited Git overrides, user hooks, fsmonitor, or global attributes. */
function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = execFile("git", [
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null",
      "-c", "core.quotePath=false", ...args,
    ], {
      cwd,
      encoding: "buffer",
      maxBuffer: MAX_BYTES,
      timeout: 30_000,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
      },
    }, (error, stdout) => {
      if (error) reject(error);
      else accept(stdout);
    });
    child.stdin?.on("error", () => { /* The process callback reports command failure. */ });
    child.stdin?.end(input);
  });
}

function decode(value: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function names(value: Buffer): string[] {
  return decode(value).split("\0").filter(Boolean);
}

function parseEntries(value: Buffer, kind: "tree" | "index"): Map<string, GitEntry> {
  const entries = new Map<string, GitEntry>();
  for (const record of names(value)) {
    const separator = record.indexOf("\t");
    const metadata = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    const mode = metadata[0];
    const oid = metadata[kind === "tree" ? 2 : 1];
    if (separator < 0 || !mode || !oid || (kind === "index" && metadata[2] !== "0")) {
      throw new Error("Candidate contains an invalid or unmerged Git index entry");
    }
    validateRelativePath(path);
    if (mode === "160000") throw new Error(`Gitlink/submodule candidates are unsupported: ${path}`);
    if (!["100644", "100755", "120000"].includes(mode)) {
      throw new Error(`Unsupported Git mode ${mode}: ${path}`);
    }
    entries.set(path, { mode, oid });
  }
  return entries;
}

function equalEntry(left: GitEntry | null | undefined, right: GitEntry | null | undefined): boolean {
  return !left && !right ? true : left?.mode === right?.mode && left?.oid === right?.oid;
}

async function workingEntry(workspace: string, path: string, objectFormat: string): Promise<WorkingEntry | null> {
  const parts = path.split("/");
  let current = workspace;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const last = index === parts.length - 1;
    if (!last) {
      if (stat.isSymbolicLink()) throw new Error(`Symlink ancestor in candidate: ${path}`);
      if (!stat.isDirectory()) throw new Error(`Non-directory ancestor in candidate: ${path}`);
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Non-regular candidate file: ${path}`);
    if (stat.size > MAX_BYTES) throw new Error(`Candidate file exceeds capture limit: ${path}`);
    const bytes = stat.isSymbolicLink() ? Buffer.from(await readlink(current)) : await readFile(current);
    const mode = stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    const oid = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return { mode, oid, bytes };
  }
  throw new Error(`Invalid candidate path: ${path}`);
}

async function snapshot(workspace: string, baseSha: string, allowed: Set<string>, objectFormat: string): Promise<Snapshot> {
  const head = decode(await git(workspace, ["rev-parse", "--verify", "HEAD"])).trim();
  if (head !== baseSha) throw new Error(`Candidate HEAD changed: expected ${baseSha}, received ${head}`);
  // None of these commands asks Git to read/filter working-tree file contents.
  const base = parseEntries(await git(workspace, ["ls-tree", "-r", "--full-tree", "-z", baseSha]), "tree");
  const index = parseEntries(await git(workspace, ["ls-files", "--stage", "-z"]), "index");
  const untracked = names(await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const ignored = names(await git(workspace, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]));
  const paths = [...new Set([
    ...base.keys(), ...index.keys(), ...untracked,
    ...ignored.filter((path) => !path.split("/").some((part) => IGNORED_CACHE_COMPONENTS.has(part))),
  ])].sort();
  const working = new Map<string, WorkingEntry | null>();
  const changedPaths: string[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    validateRelativePath(path);
    const entry = await workingEntry(workspace, path, objectFormat);
    totalBytes += entry?.bytes.length ?? 0;
    if (totalBytes > MAX_BYTES * 4) throw new Error("Candidate workspace exceeds capture size limit");
    working.set(path, entry);
    if (!equalEntry(base.get(path), index.get(path)) || !equalEntry(base.get(path), entry)) {
      if ([base.get(path), index.get(path), entry].some((item) => item?.mode === "120000")) {
        throw new Error(`Symbolic link candidate is unsupported: ${path}`);
      }
      validateImprovementPaths([path]);
      if (!allowed.has(path)) throw new Error(`Changed path is outside the exact allowed paths: ${path}`);
      changedPaths.push(path);
    }
  }
  const stagedHash = sha256(JSON.stringify([...index.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
  const fingerprint = sha256(JSON.stringify({
    head, stagedHash,
    working: [...working].map(([path, entry]) => [path, entry?.mode ?? null, entry?.oid ?? null]),
  }));
  return { head, base, working, changedPaths, stagedHash, fingerprint };
}

/** Build a standard binary-capable patch with raw blobs in an isolated repository. */
async function createPatch(workspace: string, captured: Snapshot, objectFormat: string): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "osstack-improvement-patch-"));
  try {
    await git(temporary, ["init", "--bare", `--object-format=${objectFormat}`, "."]);
    const binaryPaths = new Set<string>();
    async function put(path: string, mode: string, bytes: Buffer): Promise<void> {
      try { decode(bytes); } catch { binaryPaths.add(path); }
      const oid = decode(await git(temporary, ["hash-object", "-w", "--stdin"], bytes)).trim();
      await git(temporary, ["update-index", "--add", "--cacheinfo", mode, oid, path]);
    }
    for (const path of captured.changedPaths) {
      const entry = captured.base.get(path);
      if (entry) await put(path, entry.mode, await git(workspace, ["cat-file", "blob", entry.oid]));
    }
    const baseTree = decode(await git(temporary, ["write-tree"])).trim();
    for (const path of captured.changedPaths) {
      const entry = captured.working.get(path);
      if (entry) await put(path, entry.mode, entry.bytes);
      else await git(temporary, ["update-index", "-z", "--index-info"],
        Buffer.from(`0 ${"0".repeat(objectFormat === "sha256" ? 64 : 40)}\t${path}\0`));
    }
    const finalTree = decode(await git(temporary, ["write-tree"])).trim();
    // Git's NUL-byte heuristic otherwise emits invalid UTF-8 bytes in a textual
    // patch. Attributes here are generated only in this private temporary repo.
    await writeFile(join(temporary, "info", "attributes"), [...binaryPaths].sort()
      .map((path) => `${JSON.stringify(path)} -diff\n`).join(""));
    return decode(await git(temporary, [
      "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--src-prefix=a/", "--dst-prefix=b/", baseTree, finalTree, "--",
    ]));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/**
 * Capture the final raw working tree plus all staged path changes. Does not write
 * the source index/object store or execute repository filters. The caller must
 * keep the candidate exclusive to its executor; the repeated snapshot detects
 * observable concurrent changes, not a hostile process racing under the same UID.
 */
export async function captureImprovementCandidate(
  workspacePath: string,
  baseSha: string,
  allowedPaths: string[],
): Promise<ImprovementCandidateArtifact> {
  const allowed = new Set(validateImprovementPaths(allowedPaths));
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha)) throw new Error("A full canonical base SHA is required");
  const workspace = await realpath(resolve(workspacePath));
  const top = decode(await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
  if (await realpath(top) !== workspace) throw new Error("Candidate workspace must be the Git worktree root");
  const objectFormat = decode(await git(workspace, ["rev-parse", "--show-object-format"])).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported Git object format");
  const captured = await snapshot(workspace, baseSha, allowed, objectFormat);
  if (captured.changedPaths.length === 0) throw new Error("Empty improvement candidate");
  const patch = await createPatch(workspace, captured, objectFormat);
  if (patch.length === 0) throw new Error("Empty improvement candidate patch");
  const after = await snapshot(workspace, baseSha, allowed, objectFormat);
  if (after.fingerprint !== captured.fingerprint) throw new Error("Candidate changed during artifact capture");
  return {
    base_sha: baseSha,
    head_sha: captured.head,
    changed_paths: captured.changedPaths,
    patch,
    patch_sha256: sha256(patch),
    files: captured.changedPaths.map((path) => {
      const entry = captured.working.get(path);
      return { path, sha256: entry ? sha256(entry.bytes) : null };
    }),
    staged_sha256: captured.stagedHash,
  };
}

/** Detect verifier/reviewer edits, including index-only changes. */
export function assertCandidateUnchanged(before: ImprovementCandidateArtifact, after: ImprovementCandidateArtifact): void {
  if (before.base_sha !== after.base_sha || before.head_sha !== after.head_sha ||
      before.patch_sha256 !== after.patch_sha256 || before.patch !== after.patch ||
      before.staged_sha256 !== after.staged_sha256 ||
      JSON.stringify(before.changed_paths) !== JSON.stringify(after.changed_paths) ||
      JSON.stringify(before.files) !== JSON.stringify(after.files)) {
    throw new Error("Improvement candidate changed during verification or review");
  }
}

/** Verify a reconstructed commit stayed unchanged while clean verification ran. */
export async function assertImprovementTreeUnchanged(workspace: string, commitSha: string): Promise<void> {
  const format = decode(await git(workspace, ["rev-parse", "--show-object-format"])).trim();
  if (format !== "sha1" && format !== "sha256") throw new Error("Unsupported Git object format");
  await snapshot(workspace, commitSha, new Set(), format);
}
