/** W13-C1: every covered local write in plumbing goes through the gated launcher, and a refused fence leaves the ref and index alone. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDir } from "@osstack/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hardenedGitEnvironment } from "./hardened-git.js";
import { argvDigest, currentBootSession, runGatedProcess, type HostProcessJournal, type HostProcessLaunchInput, type HostProcessProbe as HostProbeForTest } from "./host-process.js";
import { commitPlumbing, createNoCheckoutWorktree, materializeCommit, type LocalWriteGate } from "./plumbing.js";

const env = { ...hardenedGitEnvironment(process.env), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const AUTHOR = { name: "Mission Host", email: "host@example.invalid", date: "1700000000 +0000" };

let dir: string;
beforeAll(async () => { dir = await createScratchDir("tests", "plumbing-gated"); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function repoWithCommit(name: string) {
  const repo = join(dir, name); mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "hi\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "initial");
  return { repo, head: sh(repo, "rev-parse", "HEAD") };
}

interface Journal extends HostProcessJournal { calls: Array<{ e: string; kind?: string; target?: string; proof?: string }>; stopped_ids: string[] }
function journal(): Journal {
  const j: Journal = {
    calls: [], stopped_ids: [],
    launching(i: HostProcessLaunchInput) { j.calls.push({ e: "launching", kind: i.kind, target: i.local_target }); },
    registered() { j.calls.push({ e: "registered" }); },
    release(_id, fence) { fence(); j.calls.push({ e: "released" }); },
    stopped(id, o) { j.stopped_ids.push(id); j.calls.push({ e: "stopped", proof: o.proof }); },
  };
  return j;
}
const gateOf = (j: Journal, fence: () => void = () => undefined): LocalWriteGate => ({ journal: j, markerDir: join(dir, "markers"), mission_id: "m1", boot_id: currentBootSession() ?? "unknown", fence });
const kinds = (j: Journal) => j.calls.filter(c => c.e === "launching").map(c => c.kind);

describe("gated local writes", () => {
  it("commitPlumbing journals exactly the ref update, and the fence runs in the release step", async () => {
    const { repo, head } = repoWithCommit("c1");
    const j = journal(); let fenced = 0;
    const wt = join(dir, "c1-wt");
    // A worktree on a mission branch, created ungated (the gate is exercised on the commit).
    sh(repo, "worktree", "add", "-q", "--no-checkout", "-b", "osstack/m/c1", wt, head);
    await materializeCommit(wt, head);
    const result = await commitPlumbing({ worktree: wt, branch: "osstack/m/c1", expectedHead: head, files: [{ path: "a.txt", action: "write", content: "hello\n" }], message: "m", author: AUTHOR,
      gate: gateOf(j, () => { fenced++; }) });
    expect(kinds(j)).toEqual(["git_update_ref"]);
    expect(j.calls.map(c => c.e)).toEqual(["launching", "registered", "released", "stopped"]);
    expect(j.calls.at(-1)?.proof).toBe("group_empty+marker_unheld");
    expect(fenced).toBe(1);
    expect(sh(repo, "rev-parse", "refs/heads/osstack/m/c1")).toBe(result.head);
  });

  it("a refusing fence leaves the branch where it was and records never_released", async () => {
    const { repo, head } = repoWithCommit("c2");
    const wt = join(dir, "c2-wt");
    sh(repo, "worktree", "add", "-q", "--no-checkout", "-b", "osstack/m/c2", wt, head);
    await materializeCommit(wt, head);
    const j = journal();
    await expect(commitPlumbing({ worktree: wt, branch: "osstack/m/c2", expectedHead: head, files: [{ path: "a.txt", action: "write", content: "hello\n" }], message: "m", author: AUTHOR,
      gate: gateOf(j, () => { throw new Error("FENCE_REFUSED"); }) })).rejects.toThrow("FENCE_REFUSED");
    expect(sh(repo, "rev-parse", "refs/heads/osstack/m/c2")).toBe(head);
    expect(j.calls.some(c => c.e === "released")).toBe(false);
    expect(j.calls.at(-1)).toMatchObject({ e: "stopped", proof: "never_released" });
  });

  it("createNoCheckoutWorktree journals the worktree add, then each real-index command", async () => {
    const { repo, head } = repoWithCommit("c3");
    const j = journal();
    await createNoCheckoutWorktree({ repoPath: repo, worktreePath: join(dir, "c3-wt"), branch: "osstack/m/c3", startCommit: head, gate: gateOf(j) });
    expect(kinds(j)).toEqual(["git_worktree_add", "git_index_write", "git_index_write"]);
    expect(j.calls.filter(c => c.e === "stopped")).toHaveLength(3);
    expect(sh(join(dir, "c3-wt"), "status", "--porcelain")).toBe("");
  });

  it("a fence refusing the worktree add creates no branch and no worktree", async () => {
    const { repo, head } = repoWithCommit("c4");
    const j = journal();
    await expect(createNoCheckoutWorktree({ repoPath: repo, worktreePath: join(dir, "c4-wt"), branch: "osstack/m/c4", startCommit: head,
      gate: gateOf(j, () => { throw new Error("FENCE_REFUSED"); }) })).rejects.toThrow("FENCE_REFUSED");
    expect(sh(repo, "branch", "--list", "osstack/m/c4")).toBe("");
    expect(() => readFileSync(join(dir, "c4-wt", ".git"))).toThrow();
  });

  it("materializeCommit alone journals read-tree and update-index --refresh as index writes", async () => {
    const { repo, head } = repoWithCommit("c5");
    const wt = join(dir, "c5-wt");
    sh(repo, "worktree", "add", "-q", "--no-checkout", "-b", "osstack/m/c5", wt, head);
    const j = journal();
    await materializeCommit(wt, head, { gate: gateOf(j) });
    expect(j.calls.filter(c => c.e === "launching").map(c => c.target)).toEqual([`${wt}#index`, `${wt}#index`]);
  });

  it("without a gate nothing is journaled and behaviour is unchanged", async () => {
    const { repo, head } = repoWithCommit("c6");
    const wt = join(dir, "c6-wt");
    sh(repo, "worktree", "add", "-q", "--no-checkout", "-b", "osstack/m/c6", wt, head);
    const res = await materializeCommit(wt, head);
    expect(res.files).toHaveLength(1);
  });
});

describe("T16: the online stop proof never signals after the leader is gone", () => {
  it("a recycled group id after exit yields no proof and no signal", async () => {
    const j = journal();
    const probe = { bootSession: () => null, groupPresent: () => true, leader: () => null, markerIdentity: () => "ok" as const, markerHeld: () => false } as unknown as HostProbeForTest;
    const kill = vi.spyOn(process, "kill");
    try {
      const args = ["-c", "exit 0"];
      const result = await runGatedProcess("/bin/sh", args, {
        cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 10_000, maxOutputBytes: 1024, journal: j, markerDir: join(dir, "markers"),
        launch: { mission_id: "m1", kind: "git_update_ref", local_target: "t", argv_digest: argvDigest("/bin/sh", args), boot_id: "unknown" },
        fence: () => undefined, probe, proofWaitMs: 150,
      });
      expect(result.proof).toBeNull();
      expect(j.calls.some(c => c.e === "stopped")).toBe(false);
      expect(kill.mock.calls.filter(([, signal]) => signal !== undefined && signal !== 0)).toEqual([]);
    } finally { kill.mockRestore(); }
  });
});
