import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { makeRepositoryPolicyGate } from "./repository-policy.js";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "policy-roots-")); roots.push(root);
  const repo = join(root, "main");
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  const sibling = join(root, "sibling");
  execFileSync("git", ["-C", repo, "worktree", "add", sibling], { stdio: "ignore" });
  return { repo, sibling };
}
async function policy(path: string, mode: string) {
  await mkdir(join(path, ".osstack"), { recursive: true });
  await writeFile(join(path, ".osstack", "policy.yaml"), `schema_version: 1\nmode: ${mode}\n`);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it("inherits the main policy in a policy-free subdirectory and sibling checkout", async () => {
  const { repo, sibling } = await fixture();
  const sub = join(repo, "nested"); await mkdir(sub);
  await policy(repo, "observe"); await policy(sibling, "execute");
  for (const path of [sub, sibling]) expect(await makeRepositoryPolicyGate(path)({ workspacePath: path })).toMatchObject({ allow: false, reason: expect.stringContaining("observe") });
});
it("binds to the registered path and re-reads revocations", async () => {
  const { repo, sibling } = await fixture();
  await policy(repo, "execute"); const gate = makeRepositoryPolicyGate(sibling, true);
  expect(await gate({ workspacePath: "/forged" })).toEqual({ allow: true });
  await policy(repo, "observe");
  expect(await gate({ workspacePath: sibling })).toMatchObject({ allow: false });
});
it("fails closed on malformed main policy and requires an explicit graph policy", async () => {
  const { repo, sibling } = await fixture();
  expect(await makeRepositoryPolicyGate(repo, true)({ workspacePath: repo })).toMatchObject({ allow: false });
  await policy(sibling, "execute"); await policy(repo, "invalid-mode");
  expect(await makeRepositoryPolicyGate(sibling, true)({ workspacePath: sibling })).toMatchObject({ allow: false });
});
