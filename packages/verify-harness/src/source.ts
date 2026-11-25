import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { exportContainedCandidate, exportContainedCommit } from "@osstack/agents/contained-profile";
import { repository, sha } from "./config.js";
import { candidateLimit, type HarnessPorts } from "./run.js";

const exec = promisify(execFile);
const unavailable = () => Error("source_unavailable");

export function createGitSource(deps: {
  reposDir: string;
  remote?: (repository: string) => string;
  protocol?: "https" | "file";
  exportCommit?: typeof exportContainedCommit;
  timeoutMs?: number;
}): HarnessPorts["fetchSource"] {
  return async (name, headSha, signal) => {
    if (!isAbsolute(deps.reposDir) || !repository.safeParse(name).success || !sha.safeParse(headSha).success)
      throw unavailable();
    const dir = join(deps.reposDir, randomUUID() + ".git");
    const settings = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=",
      "-c", "protocol.allow=never", "-c", `protocol.${deps.protocol ?? "https"}.allow=always`,
      "-c", "http.followRedirects=false", "-c", "fetch.fsckObjects=true"];
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin", HOME: dir, GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "/bin/false",
      GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" };
    const options = { env, maxBuffer: 1048576 };
    await mkdir(dir, { mode: 0o700 }).catch(() => { throw unavailable(); });
    try {
      try {
        const remote = deps.remote ? deps.remote(name) : `https://github.com/${name}.git`;
        await exec("git", [...settings, "init", "--bare", "--quiet", dir], { ...options, timeout: 10000 });
        await exec("git", [...settings, "-C", dir, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", remote, headSha],
          { ...options, timeout: deps.timeoutMs ?? 120000, signal });
      } catch {
        throw unavailable();
      }
      try {
        return (deps.exportCommit ?? exportContainedCommit)(dir, headSha);
      } catch (error) {
        if (error instanceof Error && error.message === "CONTAINED_COMMIT_EXPORT_FAILED") {
          try { exportContainedCandidate(dir, headSha + "^{tree}"); }
          catch (cause) { if (candidateLimit(cause)) throw cause; }
        }
        throw unavailable();
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => { throw unavailable(); });
    }
  };
}
