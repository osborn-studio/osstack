import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createScratchDir, deliveryCheckReference, freezeDeliveryContract } from "@osstack/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { deliveryGit, createDeliveryVerificationFence, persistDeliveryHostRecord, readDeliveryHostRecord } from "./delivery-contract-host.js";

let root: string;
beforeEach(async () => { root = await createScratchDir("tests", "contract-host"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("reads only digest-bound local host files and rejects tampering, traversal and symlinks", async () => {
  const directory = join(root, "receipts");
  const ref = await persistDeliveryHostRecord(directory, { trusted: "host" });
  await expect(readDeliveryHostRecord(directory, ref)).resolves.toEqual({ trusted: "host" });
  const outside = join(root, `${ref.digest}.json`); await writeFile(outside, await readFile(ref.path));
  await expect(readDeliveryHostRecord(directory, { ...ref, path: outside })).rejects.toThrow("path_invalid");
  await rm(ref.path); await symlink(outside, ref.path);
  await expect(readDeliveryHostRecord(directory, ref)).rejects.toThrow("path_invalid");
  await expect(persistDeliveryHostRecord(directory, { trusted: "host" })).rejects.toThrow("path_invalid");
  await rm(ref.path); await writeFile(ref.path, '{"trusted":"forged"}\n');
  await expect(readDeliveryHostRecord(directory, ref)).rejects.toThrow("digest_mismatch");
});
it("fences tracked and new files without altering the candidate index", async () => {
  const workspace = join(root, "repo"); await mkdir(workspace);
  const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git(["init", "-b", "main"]); await mkdir(join(workspace, "src")); await writeFile(join(workspace, "src/a.txt"), "old");
  await writeFile(join(workspace, "private.txt"), "outside scope");
  git(["add", "."]); git(["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
  const base = git(["rev-parse", "HEAD"]);
  const frozen = freezeDeliveryContract({ schema_version: 2, contract_id: "contract", task_id: "task", canonical_repo: workspace,
    mode: "implement", base_head: base, goal: "change", required_checks: [{ id: "test", registry_ref: deliveryCheckReference("pnpm test") }],
    review_policy_ref: "profile:test", requested_completion: "local_verified", allowed_paths: ["src"], requested_actions: ["build", "verify"],
    budget_ref: "policy", policy_digest: "a".repeat(64), publication_scope: { mode: "none" }, merge_authority: { mode: "none" } });
  const marker = join(root, "external-executed"); const hook = join(root, "hook.sh");
  await writeFile(hook, `#!/bin/sh\nprintf hacked > '${marker}'\n`); await chmod(hook, 0o700);
  git(["config", "core.fsmonitor", hook]); git(["config", "diff.external", hook]);
  await writeFile(join(workspace, "src/a.txt"), "host-read");
  await deliveryGit(workspace, ["diff", "--binary", "HEAD"]);
  await deliveryGit(workspace, ["ls-files", "-v"]);
  await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  git(["config", "--unset", "core.fsmonitor"]); git(["config", "--unset", "diff.external"]);
  await writeFile(join(workspace, "src/a.txt"), "old");
  const verifier = createDeliveryVerificationFence(frozen); await verifier.prepare(workspace);
  await writeFile(join(workspace, "src/a.txt"), "candidate");
  const fence = await verifier(workspace);
  expect(git(["diff", "--cached", "--name-only"])).toBe("");
  await expect(fence()).resolves.toBeUndefined();
  git(["add", "-A"]);
  await expect(verifier.assertVerified(workspace)).resolves.toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(workspace, "src/a.txt"), "changed during check");
  await expect(fence()).rejects.toThrow("changed_during_verification");
  await expect(verifier.assertVerified(workspace)).rejects.toThrow("reviewed_candidate_changed");
  await writeFile(join(workspace, "src/new.txt"), "new candidate");
  const newFence = await verifier(workspace);
  await writeFile(join(workspace, "src/new.txt"), "changed new candidate");
  await expect(newFence()).rejects.toThrow("changed_during_verification");
  git(["mv", "private.txt", "src/private.txt"]);
  await expect(verifier(workspace)).rejects.toThrow("path_outside_scope");
});
