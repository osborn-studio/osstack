import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { improvementPrTransport, type ImprovementPrTransport } from "./improvement-pr-delivery.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();
}

/** Real local Git, simulated GitHub only. Never contacts a remote service. */
export async function simulatedImprovementGithub(root: string, repoPath: string, drop?: "push" | "pr") {
  const runGit = improvementPrTransport.run.bind(improvementPrTransport);
  const remote = join(root, "remote.git");
  await git(root, ["clone", "--bare", repoPath, remote]);
  await git(repoPath, ["remote", "add", "origin", "https://github.com/studio/project.git"]);
  const base = await git(repoPath, ["rev-parse", "HEAD"]);
  const writes: string[] = [];
  const pulls: unknown[] = [];
  const transport: ImprovementPrTransport = {
    async run(binary, args, cwd, timeout) {
      if (binary === "git") {
        const result = await runGit(binary, args.map((arg) => arg === "https://github.com/studio/project.git" ? remote : arg), cwd, timeout);
        if (args.includes("push")) { writes.push("push"); if (drop === "push") throw new Error("push response lost"); }
        return result;
      }
      const endpoint = args[3]!;
      let value: unknown;
      if (endpoint === "repos/studio/project") value = { id: 123, full_name: "studio/project", default_branch: "main", archived: false, permissions: { push: true } };
      else if (endpoint.includes("/git/ref/heads/")) value = { object: { sha: await git(remote, ["rev-parse", `refs/heads/${endpoint.split("/git/ref/heads/")[1]}`]) } };
      else if (args.includes("POST")) {
        writes.push("pr");
        const payload = JSON.parse(await readFile(args[args.indexOf("--input") + 1]!, "utf8"));
        expect(payload.draft).toBe(true);
        pulls.push({ number: 17, html_url: "https://github.com/studio/project/pull/17", state: "open", draft: true,
          head: { sha: await git(remote, ["rev-parse", `refs/heads/${payload.head}`]), ref: payload.head, repo: { id: 123 } },
          base: { sha: base, ref: "main", repo: { id: 123 } },
        });
        if (drop === "pr") throw new Error("PR response lost");
        value = pulls[0];
      } else if (endpoint.startsWith("repos/studio/project/pulls?")) value = pulls;
      else throw new Error(`Unexpected fixture API ${endpoint}`);
      return Buffer.from(JSON.stringify(value));
    },
  };
  return { remote, base, writes, pulls, transport };
}
