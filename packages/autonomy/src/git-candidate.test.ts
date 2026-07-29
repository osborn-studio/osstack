import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitGuardedCandidate,
  stageGuardedCandidate,
} from "./git-candidate.js";

let directory: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "osstack-candidate-"));
  execFileSync("git", ["init", "-b", "osstack/test"], {
    cwd: directory,
  });
  await writeFile(join(directory, "README.md"), "# before\n");
  execFileSync("git", ["add", "README.md"], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "seed",
    ],
    { cwd: directory },
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("guarded staged candidate", () => {
  it("commits exactly the classified staged bytes and reuses the commit idempotently", async () => {
    await writeFile(join(directory, "README.md"), "# after\n");
    const staged = await stageGuardedCandidate({
      workspace_path: directory,
      commands: ["pnpm test"],
    });
    const diffSha256 = sha256(staged.staged_diff_binary);
    const input = {
      workspace_path: directory,
      expected_base_commit_sha: staged.base_commit_sha,
      expected_diff_sha256: diffSha256,
      idempotency_key: `run-1:commit:${diffSha256}`,
      message: "docs: guarded candidate",
    };

    const first = await commitGuardedCandidate(input);
    const second = await commitGuardedCandidate(input);

    expect(second).toEqual(first);
    const body = execFileSync(
      "git",
      ["show", "-s", "--format=%B", first.commit],
      { cwd: directory, encoding: "utf8" },
    );
    expect(body).toContain(`OSSTACK-DIFF-SHA256: ${diffSha256}`);
  });

  it("rejects TOCTOU worktree changes and never runs repository hooks", async () => {
    const marker = join(directory, "hook-ran");
    const hook = join(directory, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf pwned > '${marker}'\n`,
    );
    chmodSync(hook, 0o755);
    await writeFile(join(directory, "README.md"), "# classified\n");
    const staged = await stageGuardedCandidate({
      workspace_path: directory,
      commands: ["pnpm test"],
    });
    const diffSha256 = sha256(staged.staged_diff_binary);
    await writeFile(join(directory, "README.md"), "# mutated\n");

    await expect(
      commitGuardedCandidate({
        workspace_path: directory,
        expected_base_commit_sha: staged.base_commit_sha,
        expected_diff_sha256: diffSha256,
        idempotency_key: `run-2:commit:${diffSha256}`,
        message: "docs: should not commit",
      }),
    ).rejects.toThrow(/fully staged|porcelain|changed/i);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
