import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readRepositoryGit } from "./repository-git.js";


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
  const stdout = await readRepositoryGit(canonicalWorkspace, "commonDir");
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
