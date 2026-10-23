import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { LoopEngine } from "./loop-engine.js";

const fixtures: string[] = [];

afterEach(async () => {
  for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("Loop cycle preserves worktrees with unproven ownership", () => {
  it("retains dirty worktrees and branches matching the current loop prefix", async () => {
    const fixture = createScratchDirSync("tests", "loop-retained-worktree");
    fixtures.push(fixture);
    const workspace = join(fixture, "repository");
    const worktreeRoot = join(fixture, "worktrees");
    const orphan = join(worktreeRoot, "interrupted-worker");
    mkdirSync(workspace);
    mkdirSync(worktreeRoot);
    const git = (...args: string[]): string => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("init", "-q");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "fixture");
    const branch = "osstack/loop/retention-loop/interrupted-worker";
    git("-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, orphan);
    writeFileSync(join(orphan, "uncommitted-result.txt"), "irreplaceable local worker output");

    const result = await new LoopEngine({
      loopId: "retention-loop",
      workspacePath: workspace,
      sources: [],
      inputTasks: [],
      useWorktree: true,
      worktreeRoot,
    }).runOnce();

    expect(result.executedTaskCount).toBe(0);
    expect(readFileSync(join(orphan, "uncommitted-result.txt"), "utf8")).toBe("irreplaceable local worker output");
    expect(git("branch", "--list", branch)).toContain(branch);
    expect(git("worktree", "list", "--porcelain")).toContain(realpathSync(orphan));
    expect(result.events.some((event) => event.type === "loop.worktree.orphans_cleaned")).toBe(false);
  });
});
