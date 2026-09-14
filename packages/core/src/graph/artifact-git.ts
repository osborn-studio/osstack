import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Plumbing only. Never inherit Git redirection, templates, hooks, filters or fsmonitor. */
export async function artifactGit(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C",
    GIT_AUTHOR_NAME: "OSStack freeze", GIT_AUTHOR_EMAIL: "freeze@osstack.invalid", GIT_COMMITTER_NAME: "OSStack freeze", GIT_COMMITTER_EMAIL: "freeze@osstack.invalid", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" });
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "init.templateDir=", "-c", "commit.gpgSign=false", "-c", "gc.auto=0", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("artifact git timed out")); }, 60_000);
    child.stdout.on("data", (part: Buffer) => { bytes += part.length; if (bytes > 256 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("artifact git output limit")); } else stdout.push(part); });
    child.stderr.on("data", (part: Buffer) => { if (stderr.length < 256) stderr.push(part); });
    child.stdin.on("error", () => { /* exit status reports failed plumbing */ });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolvePromise(Buffer.concat(stdout)); else reject(new Error(`artifact git ${args[0]} failed: ${Buffer.concat(stderr).toString().slice(0, 4096)}`)); });
    child.stdin.end(input);
  });
}
export async function gitText(cwd: string, args: string[], input?: Buffer): Promise<string> {
  return (await artifactGit(cwd, args, input)).toString("utf8").trim();
}
export function artifactPath(root: string, name: string): string {
  if (!name || name.includes("\0") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("unsupported artifact path");
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) throw new Error("escaping artifact path");
  return path;
}
export async function initArtifactRepo(path: string, bare = true): Promise<void> {
  await mkdir(path, { recursive: true });
  await artifactGit(path, ["init", ...(bare ? ["--bare"] : []), "--object-format=sha1"]);
}
/** Raw bytes, no add/checkout/clean/smudge or global attributes transformations. */
export async function captureArtifactTree(source: string, objectRepo: string): Promise<string> {
  // Sparse checkout omissions are not deletions. Require a fully materialized
  // source instead of silently deleting skipped tracked files from the candidate.
  const flags = (await artifactGit(source, ["ls-files", "-t", "-z"])).toString("utf8").split("\0");
  if (flags.some(entry => entry.startsWith("S "))) throw new Error("unsupported skip-worktree source");
  const stages = (await artifactGit(source, ["ls-files", "--stage", "-z"])).toString("utf8").split("\0");
  if (stages.some(line => line.startsWith("160000 "))) throw new Error("unsupported submodule");
  if (stages.some(line => line && !/^\d+ [a-f0-9]+ 0\t/.test(line))) throw new Error("unmerged source index");
  const namesRaw = await artifactGit(source, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!Buffer.from(namesRaw.toString("utf8"), "utf8").equals(namesRaw)) throw new Error("unsupported non-UTF8 path");
  const names = [...new Set(namesRaw.toString("utf8").split("\0").filter(Boolean))].sort();
  await artifactGit(objectRepo, ["read-tree", "--empty"]);
  const entries: string[] = [];
  for (const name of names) {
    const path = artifactPath(source, name);
    let info;
    try { info = await lstat(path); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    if (await realpath(dirname(path)) !== dirname(path)) throw new Error("source path has symlink ancestor");
    if (info.isDirectory()) {
      try { await lstat(join(path, ".git")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new Error("unsupported nested repository or submodule");
    }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error("unsupported nested repository, submodule or special file");
    const data = info.isSymbolicLink() ? await readlink(path, { encoding: "buffer" }) : await readFile(path);
    const oid = await gitText(objectRepo, ["hash-object", "-w", "--stdin", "--no-filters"], data);
    const mode = info.isSymbolicLink() ? "120000" : (info.mode & 0o111) !== 0 ? "100755" : "100644";
    entries.push(`${mode} ${oid}\t${name}\0`);
  }
  await artifactGit(objectRepo, ["update-index", "-z", "--index-info"], Buffer.from(entries.join("")));
  return await gitText(objectRepo, ["write-tree"]);
}
export async function linkSourceObjects(repo: string, commonDir: string): Promise<void> {
  if (commonDir.includes("\n")) throw new Error("unsupported object directory path");
  await mkdir(join(repo, "objects", "info"), { recursive: true });
  await writeFile(join(repo, "objects", "info", "alternates"), `${join(commonDir, "objects")}\n`);
}
