import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { loadPolicyProfile, resolveRepositoryScope } from "@osstack/core";
import type { PolicyGate } from "@osstack/loop";
import { OBSERVE_POLICY_DENIED_REASON } from "./policy-gate.js";


/** Local socket/host supplied workspace; worker fields never select this path.
 * Every worktree inherits the primary checkout policy. Subdirectory policies
 * can restrict it further, but cannot hide a parent observe/invalid policy.
 */
export function makeRepositoryPolicyGate(workspacePath: string, requirePolicy = false): PolicyGate {
  return async () => {
    try {
      const scope = await resolveRepositoryScope(workspacePath);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
      const options = { cwd: scope.workspacePath, env, encoding: "utf8" as const, timeout: 5_000, killSignal: "SIGKILL" as const, maxBuffer: 64 * 1024, shell: false };
      const top = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], options);
      const listing = await promisify(execFile)("git", ["worktree", "list", "--porcelain", "-z"], options);
      const first = listing.stdout.split("\0")[0];
      if (!first?.startsWith("worktree ")) throw new Error("primary repository policy root unavailable");
      const primary = await realpath(first.slice("worktree ".length));
      await resolveRepositoryScope(primary, { repoId: scope.repoId });
      const root = await realpath(top.stdout.replace(/\r?\n$/, ""));
      let present = false;
      for (const path of new Set([primary, root, scope.workspacePath])) {
        const profile = await loadPolicyProfile(path);
        present ||= profile !== undefined;
        if (profile?.mode === "observe") return { allow: false, reason: OBSERVE_POLICY_DENIED_REASON };
      }
      if (requirePolicy && !present) return { allow: false, reason: "graph policy authorization required" };
      return { allow: true };
    } catch (error) {
      return { allow: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}
