import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertGuardedCandidateBase,
  assertGuardedMergedCandidate,
  commitGuardedCandidate,
  stageGuardedCandidate,
} from "./git-candidate.js";

let directory: string;
let remoteDirectory: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "osstack-candidate-"));
  remoteDirectory = mkdtempSync(join(tmpdir(), "osstack-remote-"));
  execFileSync("git", ["init", "--bare", remoteDirectory]);
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
  await rm(remoteDirectory, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("guarded staged candidate", () => {
  it("requires a clean candidate at the exact fetched base commit", async () => {
    execFileSync("git", ["remote", "add", "origin", remoteDirectory], {
      cwd: directory,
    });
    execFileSync(
      "git",
      ["push", "origin", "HEAD:refs/heads/main"],
      { cwd: directory },
    );
    execFileSync("git", ["checkout", "-b", "osstack/feature"], {
      cwd: directory,
    });

    const verifiedBase = await assertGuardedCandidateBase({
      workspace_path: directory,
      remote: "origin",
      base: "main",
    });
    expect(verifiedBase).toMatchObject({
      base_commit_sha: expect.stringMatching(/^[a-f0-9]{40}$/),
    });

    await writeFile(join(directory, "README.md"), "# dirty\n");
    await expect(assertGuardedCandidateBase({
      workspace_path: directory,
      remote: "origin",
      base: "main",
    })).rejects.toThrow(/clean|dirty|worktree/i);

    await writeFile(join(directory, "README.md"), "# before\n");
    await writeFile(join(directory, "preexisting.md"), "hidden candidate\n");
    execFileSync("git", ["add", "preexisting.md"], { cwd: directory });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "preexisting candidate",
      ],
      { cwd: directory },
    );
    await expect(assertGuardedCandidateBase({
      workspace_path: directory,
      remote: "origin",
      base: "main",
    })).rejects.toThrow(/exact.*base|HEAD.*base/i);
    await expect(stageGuardedCandidate({
      workspace_path: directory,
      expected_base_commit_sha: verifiedBase.base_commit_sha,
      commands: ["pnpm test"],
    })).rejects.toThrow(/expected.*base|base.*changed/i);
  });

  it("binds post-merge deployment to the exact fetched merge tree", async () => {
    execFileSync("git", ["remote", "add", "origin", remoteDirectory], {
      cwd: directory,
    });
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
      cwd: directory,
    });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "-b", "osstack/feature"], {
      cwd: directory,
    });
    await writeFile(join(directory, "README.md"), "# merged tree\n");
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
        "candidate",
      ],
      { cwd: directory },
    );
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    const mergeCommit = execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "squash merge",
      ],
      { cwd: directory, encoding: "utf8" },
    ).trim();
    execFileSync(
      "git",
      ["push", "--force", "origin", `${mergeCommit}:refs/heads/main`],
      { cwd: directory },
    );

    await expect(
      assertGuardedMergedCandidate({
        workspace_path: directory,
        remote: "origin",
        base: "main",
        expected_merge_commit_sha: mergeCommit,
      }),
    ).resolves.toBeUndefined();

    execFileSync(
      "git",
      ["push", "--force", "origin", `${base}:refs/heads/main`],
      { cwd: directory },
    );
    await expect(
      assertGuardedMergedCandidate({
        workspace_path: directory,
        remote: "origin",
        base: "main",
        expected_merge_commit_sha: base,
      }),
    ).rejects.toThrow(/tree.*match|match.*tree/i);
  });

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

  it("derives major dependency evidence from the exact staged manifests", async () => {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({
        dependencies: {
          alpha: "^1.2.0",
          stable: "^4.1.0",
        },
      }, null, 2)}\n`,
    );
    execFileSync("git", ["add", "package.json"], { cwd: directory });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "seed dependencies",
      ],
      { cwd: directory },
    );
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({
        dependencies: {
          alpha: "^2.0.0",
          stable: "^4.2.0",
        },
      }, null, 2)}\n`,
    );

    const staged = await stageGuardedCandidate({
      workspace_path: directory,
      commands: ["pnpm test"],
    });

    expect(staged.dependency_changes).toEqual([
      {
        name: "alpha",
        from: "^1.2.0",
        to: "^2.0.0",
        major: true,
      },
      {
        name: "stable",
        from: "^4.1.0",
        to: "^4.2.0",
        major: false,
      },
    ]);
  });

  it("fails closed when Git cannot inspect a changed dependency manifest", async () => {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ dependencies: { alpha: "^1.0.0" } }, null, 2)}\n`,
    );
    execFileSync("git", ["add", "package.json"], { cwd: directory });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "seed dependencies",
      ],
      { cwd: directory },
    );
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ dependencies: { alpha: "^2.0.0" } }, null, 2)}\n`,
    );

    const realGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const fakeBin = join(directory, "fake-bin");
    await writeFile(
      join(directory, "fake-git"),
      [
        "#!/bin/sh",
        "for arg in \"$@\"; do",
        "  case \"$arg\" in",
        "    cat-file|ls-tree)",
        "      printf '%s\\n' 'simulated object database failure' >&2",
        "      exit 2",
        "      ;;",
        "  esac",
        "done",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(directory, "fake-git"), 0o755);
    await mkdir(fakeBin);
    await symlink(join(directory, "fake-git"), join(fakeBin, "git"));
    const priorPath = process.env["PATH"];
    process.env["PATH"] = `${fakeBin}:${priorPath ?? ""}`;
    try {
      await expect(
        stageGuardedCandidate({
          workspace_path: directory,
          commands: ["pnpm test"],
        }),
      ).rejects.toThrow(/object database failure|git .* failed/i);
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
    }
  });
});
