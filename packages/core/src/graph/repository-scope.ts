import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";


export interface RepositoryScope {
  repoId: string;
  commonDir: string;
  workspacePath: string;
}

/** Proves filesystem identity, not caller authorization. Resolve a trusted registered
 * path at the admission boundary; caller-provided expected values are only hints.
 * Git and the private local filesystem must be trusted and stable during admission.
 */
export async function resolveRepositoryScope(
  workspacePath: string,
  expected?: { repoId?: string; commonDir?: string },
): Promise<RepositoryScope> {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
    throw new Error("repository workspace path is required");
  }
  const canonicalWorkspace = await realpath(workspacePath);
  if (!(await stat(canonicalWorkspace)).isDirectory()) {
    throw new Error("repository workspace path must be a directory");
  }
  // Inherited GIT_DIR/COMMON_DIR/WORK_TREE and config injection must not redirect
  // the identity lookup away from the registered filesystem path.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.LC_ALL = "C";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "--git-common-dir"], {
    cwd: canonicalWorkspace,
    env,
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    shell: false,
  });
  // Remove Git's one line terminator, not legal leading/trailing path spaces.
  const gitCommonDir = stdout.replace(/\r?\n$/, "");
  if (!gitCommonDir || gitCommonDir.includes("\n") || gitCommonDir.includes("\0")) {
    throw new Error("invalid git common directory identity");
  }
  const commonDir = await realpath(resolve(canonicalWorkspace, gitCommonDir));
  if (!(await stat(commonDir)).isDirectory()) {
    throw new Error("git common directory must be a directory");
  }
  const repoId = `repo-${createHash("sha256").update(commonDir).digest("hex")}`;
  if (expected?.repoId !== undefined && expected.repoId !== repoId) {
    throw new Error("repository identity does not match expected repoId");
  }
  if (expected?.commonDir !== undefined) {
    if (!expected.commonDir || await realpath(expected.commonDir) !== commonDir) {
      throw new Error("repository identity does not match expected commonDir");
    }
  }
  return { repoId, commonDir, workspacePath: canonicalWorkspace };
}
