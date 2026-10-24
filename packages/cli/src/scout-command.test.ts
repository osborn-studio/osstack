import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createScratchDir } from "@osstack/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createScoutHost, handleScoutCommand } from "./scout-command.js";
let root: string;
let repo: string;
const policyDigest = "a".repeat(64);
const policy = async () => ({
  policyDigest,
  verifyCommands: ["node check.cjs"],
  budgetRef: `policy:${policyDigest}`,
  budget: {
    max_builder_iterations: 2,
    max_review_rounds: 2,
    max_wall_time_ms: 60000,
    max_no_progress_rounds: 2,
  },
});
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
beforeEach(async () => {
  root = await createScratchDir("tests", "scout");
  repo = join(root, "repo");
  await mkdir(repo);
  git("init", "-b", "main");
  await writeFile(join(repo, "source.txt"), "committed source\n");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-m",
    "seed",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("uses only bounded committed blobs, leaves dirty working copy unchanged, and records create-only evidence", async () => {
  const host = createScoutHost({ home: join(root, "home"), policy });
  await writeFile(join(repo, "source.txt"), "dirty private edit");
  const request = {
    repo,
    goal: "Investigate source",
    paths: ["source.txt"],
    profile: "mac-mini",
    requestId: "request-1",
  };
  const result = await host.inspect(request);
  expect(result.kind).toBe("scout");
  expect(result.facts[0]?.text).toBe("committed source\n");
  expect(result.tools).toEqual(["git_committed_blob_read"]);
  expect(await readFile(join(repo, "source.txt"), "utf8")).toBe(
    "dirty private edit",
  );
  expect((await host.inspect(request)).digest).toBe(result.digest);
  await expect(
    host.inspect({ ...request, goal: "Different request" }),
  ).rejects.toThrow("request_conflict");
});
it("promotion reloads latest base and policy, emits no authority and claims once", async () => {
  let calls = 0;
  let args: string[] = [];
  const host = createScoutHost({
    home: join(root, "home"),
    policy,
    deliver: async (a) => {
      calls++;
      args = a;
      return 2;
    },
  });
  const scout = await host.inspect({
    repo,
    goal: "Repair source",
    paths: ["source.txt"],
    profile: "mac-mini",
    requestId: "scout",
  });
  await writeFile(join(repo, "source.txt"), "new base\n");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-m",
    "new base",
  );
  const result = await host.promote({
    digest: scout.digest,
    requestId: "promotion",
  });
  expect(result.exitCode).toBe(2);
  expect(calls).toBe(1);
  const contract = JSON.parse(
    await readFile(args[args.indexOf("--contract") + 1]!, "utf8"),
  );
  expect(contract.parent_contract_id).toBe(scout.contract.contract.contract_id);
  expect(contract.base_head).toBe(git("rev-parse", "HEAD"));
  expect(contract.requested_actions).toEqual(["build", "verify"]);
  expect(args).toContain("guarded-local");
  await expect(
    host.promote({ digest: scout.digest, requestId: "promotion" }),
  ).rejects.toThrow("already_claimed");
  expect(calls).toBe(1);
});
it.each([
  "../outside",
  "source.txt\n",
  "-bad",
  "",
])("rejects unsafe source path %j", async (path) => {
  const host = createScoutHost({ home: join(root, "home"), policy });
  await expect(
    host.inspect({
      repo,
      goal: "read",
      paths: [path],
      profile: "mac-mini",
      requestId: "id",
    }),
  ).rejects.toThrow();
});
it("rejects a symlink blob and an oversized committed blob", async () => {
  const { symlink } = await import("node:fs/promises");
  await symlink("/etc/passwd", join(repo, "link"));
  await writeFile(join(repo, "large"), "x".repeat(65537));
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-m",
    "unsafe blobs",
  );
  const host = createScoutHost({ home: join(root, "home"), policy });
  await expect(
    host.inspect({
      repo,
      goal: "read",
      paths: ["link"],
      profile: "mac-mini",
      requestId: "link",
    }),
  ).rejects.toThrow("regular_committed_file");
  await expect(
    host.inspect({
      repo,
      goal: "read",
      paths: ["large"],
      profile: "mac-mini",
      requestId: "large",
    }),
  ).rejects.toThrow("budget_exceeded");
});
it("rejects malformed/binary/invalid UTF-8 and directory reads", async () => {
  await writeFile(join(repo, "binary"), Buffer.from([0, 1]));
  await writeFile(join(repo, "invalid"), Buffer.from([255, 255]));
  await mkdir(join(repo, "dir"));
  await writeFile(join(repo, "dir/file"), "hello");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-m",
    "files",
  );
  const host = createScoutHost({ home: join(root, "home"), policy });
  for (const path of ["binary", "invalid", "dir"])
    await expect(
      host.inspect({
        repo,
        goal: "read",
        paths: [path],
        profile: "mac-mini",
        requestId: path,
      }),
    ).rejects.toThrow();
});
it("blocks state under repository and refuses a symlink state root", async () => {
  const { symlink } = await import("node:fs/promises");
  await mkdir(join(root, "target"), { mode: 0o700 });
  await symlink(join(root, "target"), join(root, "alias"));
  for (const home of [join(repo, "private-home"), join(root, "alias")])
    await expect(
      createScoutHost({ home, policy }).inspect({
        repo,
        goal: "read",
        paths: ["source.txt"],
        profile: "mac-mini",
        requestId: "id",
      }),
    ).rejects.toThrow();
});
it("rejects live policy changes before creating an investigation receipt", async () => {
  let reads = 0;
  const host = createScoutHost({
    home: join(root, "home"),
    policy: async () => ({
      ...(await policy()),
      policyDigest: (reads++ ? "b" : "a").repeat(64),
    }),
  });
  await expect(
    host.inspect({
      repo,
      goal: "read",
      paths: ["source.txt"],
      profile: "mac-mini",
      requestId: "id",
    }),
  ).rejects.toThrow("policy_changed");
});
it("does not replay a started promotion whose delivery outcome is unknown", async () => {
  let calls = 0;
  const host = createScoutHost({
    home: join(root, "home"),
    policy,
    deliver: async () => {
      calls++;
      throw Error("connection lost");
    },
  });
  const scout = await host.inspect({
    repo,
    goal: "read",
    paths: ["source.txt"],
    profile: "mac-mini",
    requestId: "id",
  });
  await expect(
    host.promote({ digest: scout.digest, requestId: "promote" }),
  ).rejects.toThrow("connection lost");
  await expect(
    host.promote({ digest: scout.digest, requestId: "promote" }),
  ).rejects.toThrow("already_claimed");
  await expect(
    host.promote({ digest: scout.digest, requestId: "different-id" }),
  ).rejects.toThrow("already_claimed");
  expect(calls).toBe(1);
});
it("rejects tampered scout evidence before promotion can dispatch", async () => {
  let calls = 0;
  const host = createScoutHost({
    home: join(root, "home"),
    policy,
    deliver: async () => {
      calls++;
      return 0;
    },
  });
  const scout = await host.inspect({
    repo,
    goal: "read",
    paths: ["source.txt"],
    profile: "mac-mini",
    requestId: "id",
  });
  await writeFile(scout.path, "{}");
  await expect(
    host.promote({ digest: scout.digest, requestId: "promote" }),
  ).rejects.toThrow("digest_mismatch");
  expect(calls).toBe(0);
});
it("never executes repository Git hooks, filters, or externally configured diff commands", async () => {
  const marker = join(root, "executed");
  const command = `touch '${marker}'`;
  git("config", "core.fsmonitor", command);
  git("config", "diff.external", command);
  git("config", "filter.evil.smudge", command);
  git("config", "filter.evil.clean", command);
  const host = createScoutHost({ home: join(root, "home"), policy });
  const scout = await host.inspect({
    repo,
    goal: "read",
    paths: ["source.txt"],
    profile: "mac-mini",
    requestId: "id",
  });
  expect(scout.facts).toHaveLength(1);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses a repository subdirectory before writing scout state", async () => {
  await mkdir(join(repo, "subdir"));
  const host = createScoutHost({ home: join(root, "new-home"), policy });
  await expect(
    host.inspect({
      repo: join(repo, "subdir"),
      goal: "read",
      paths: ["source.txt"],
      profile: "mac-mini",
      requestId: "id",
    }),
  ).rejects.toThrow("repository_root_required");
  await expect(
    readFile(join(root, "new-home", "scout", "anything")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("prints one JSON investigation response and escapes terminal C1 controls", async () => {
  await writeFile(join(repo, "source.txt"), "\u009b2J untrusted source");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-m",
    "control text",
  );
  const output: string[] = [];
  expect(
    await handleScoutCommand(
      [
        "inspect",
        "--repo",
        repo,
        "--goal",
        "read",
        "--path",
        "source.txt",
        "--profile",
        "mac-mini",
        "--request-id",
        "output",
        "--json",
      ],
      { home: join(root, "home"), policy },
      (line) => output.push(line),
    ),
  ).toBe(0);
  expect(output).toHaveLength(1);
  expect(output[0]).not.toContain("\u009b");
  expect(JSON.parse(output[0]!).facts[0].text).toContain("\u009b");
});
it("does not treat a zero exit without matching verified delivery output as completion", async () => {
  const host = createScoutHost({
    home: join(root, "home"),
    policy,
    deliver: async () => 0,
  });
  const scout = await host.inspect({
    repo,
    goal: "read",
    paths: ["source.txt"],
    profile: "mac-mini",
    requestId: "id",
  });
  await expect(
    host.promote({ digest: scout.digest, requestId: "promote" }),
  ).rejects.toThrow();
});
