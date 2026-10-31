import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  deliverToGitHub,
  observeCurrentGreenCandidate,
  type DeliveryCommandResult,
  type DeliveryCommandRunner,
  type GitHubDeliveryInput,
} from "./delivery.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real Git for local checks; GitHub calls succeed only for auth so nothing remote runs. */
class RealGitRunner implements DeliveryCommandRunner {
  readonly calls: string[] = [];
  async run(command: string, args: readonly string[], options: { cwd: string }): Promise<DeliveryCommandResult> {
    this.calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh" && args[0] === "auth") return { stdout: "", stderr: "", exitCode: 0 };
    if (command !== "git") throw new Error(`unexpected remote command after clean check: ${command} ${args.join(" ")}`);
    try {
      const { stdout, stderr } = await execFileAsync("git", [...args], { cwd: options.cwd });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", exitCode: typeof failed.code === "number" ? failed.code : 1 };
    }
  }
}

async function hiddenUntrackedCandidate(): Promise<GitHubDeliveryInput> {
  const dir = mkdtempSync(join(tmpdir(), "osstack-delivery-clean-"));
  roots.push(dir);
  const repo = join(dir, "repo");
  const git = async (...args: string[]) => await execFileAsync("git", args, { cwd: repo });
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "README.md"), "# test\n");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "init");
  await git("checkout", "-q", "-b", "feature/candidate");
  await git("config", "status.showUntrackedFiles", "no");
  writeFileSync(join(repo, "forgotten.ts"), "export const unpublished = true;\n");
  const bodyFile = join(dir, "body.md");
  writeFileSync(bodyFile, "proof\n");
  return {
    workspacePath: repo,
    remote: "origin",
    base: "main",
    branch: "feature/candidate",
    title: "candidate",
    bodyFile,
    mergeStrategy: "squash",
    ciTimeoutMs: 60_000,
  };
}

describe("GitHub delivery clean-worktree gate", () => {
  it("refuses delivery when repository config hides untracked work", async () => {
    const input = await hiddenUntrackedCandidate();
    const runner = new RealGitRunner();

    await expect(deliverToGitHub(input, runner)).rejects.toThrow("GitHub delivery requires a clean committed worktree");
    expect(runner.calls).not.toContain("git remote get-url origin");
  });

  it("does not observe a green candidate while repository config hides untracked work", async () => {
    const input = await hiddenUntrackedCandidate();
    const runner = new RealGitRunner();
    const fingerprint = "f".repeat(64);

    await expect(observeCurrentGreenCandidate(input, {
      environmentFingerprint: fingerprint,
      policyFingerprint: fingerprint,
      testsFingerprint: fingerprint,
    }, runner)).resolves.toBeUndefined();
    expect(runner.calls).not.toContain("git rev-parse HEAD");
  });
});
