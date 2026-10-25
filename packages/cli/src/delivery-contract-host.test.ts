import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createScratchDir, deliveryCheckReference, freezeDeliveryContract } from "@osstack/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deliveryGit, createDeliverySourceFence, createDeliveryVerificationFence, persistDeliveryHostRecord, readDeliveryHostRecord } from "./delivery-contract-host.js";

let root: string;
beforeEach(async () => { root = await createScratchDir("tests", "contract-host"); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
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

it("samples ignored source directories as roots and refuses intermediate symlink escapes", async () => {
  const workspace=join(root,"source");await mkdir(workspace);const git=(...args:string[])=>execFileSync("git",args,{cwd:workspace,encoding:"utf8"}).trim();
  git("init","-b","main");await mkdir(join(workspace,"src"));await writeFile(join(workspace,"src/a"),"original");await writeFile(join(workspace,".gitignore"),"node_modules/\nignored/\n");
  git("add",".");git("-c","user.name=test","-c","user.email=test@example.invalid","commit","-m","seed");const base=git("rev-parse","HEAD");
  await mkdir(join(workspace,"node_modules"));await writeFile(join(workspace,"node_modules/dependency"),"one");
  const fence=await createDeliverySourceFence(workspace,base);
  await writeFile(join(workspace,"node_modules/another"),"unqualified dependency contents");await expect(fence()).resolves.toBeUndefined();
  await mkdir(join(workspace,"ignored"));await writeFile(join(workspace,"ignored/new"),"new ignored root");await expect(fence()).rejects.toThrow("delivery_source_changed");
  await rm(join(workspace,"src"),{recursive:true});const outside=join(root,"outside");await mkdir(outside);await writeFile(join(outside,"a"),"secret");await symlink(outside,join(workspace,"src"));
  await expect(createDeliverySourceFence(workspace,base)).rejects.toThrow("parent_escape");
});
it('requires every receipt reviewer to be independent, including later artifacts',async()=>{
 const {buildDeliveryVerificationReceipt}=await import('./delivery-contract-host.js');
 const frozen=freezeDeliveryContract({schema_version:2,contract_id:'multi-review',task_id:'task',canonical_repo:root,mode:'implement',base_head:'a'.repeat(40),goal:'verify',required_checks:[{id:'test',registry_ref:deliveryCheckReference('pnpm test')}],review_policy_ref:'profile:test',requested_completion:'local_verified',allowed_paths:['src'],requested_actions:['build','verify'],budget_ref:'policy:test',policy_digest:'b'.repeat(64),publication_scope:{mode:'none'},merge_authority:{mode:'none'}});
 const review={schema_version:1 as const,reviewer_agent_id:'reviewer',verdict:'approved' as const,risk:'low' as const,markdown:'reviewed',judgments:[],findings:[],recommended_actions:[],evidence_refs:[],runtime_identity:{evidence_source:'reported',provider_id:'review-provider',model_id:'review-model'}};
 const input={frozen,runId:'run',runKind:'guarded-local' as const,candidate:{base_head:'a'.repeat(40),head:'a'.repeat(40),tree_id:'c'.repeat(40),diff_digest:'d'.repeat(64)},commands:[{command:'pnpm test',exit_code:0,duration_ms:1}],reviews:[review],builderAgentId:'builder',builderIdentity:{provider_id:'builder-provider',model_id:'builder-model',evidence_source:'reported'},workspaceStateDigest:'e'.repeat(64)};
 expect(buildDeliveryVerificationReceipt(input).review.reviewer_agent_id).toBe('reviewer');
 for(const bad of [{...review,reviewer_agent_id:'builder'},{...review,runtime_identity:{evidence_source:'reported',provider_id:'builder-provider',model_id:'builder-model'}},{...review,runtime_identity:{...review.runtime_identity,evidence_source:'unknown'}}])expect(()=>buildDeliveryVerificationReceipt({...input,reviews:[review,bad]})).toThrow('independent_review_required');
});

it("ignores inherited Git repository, index and configuration overrides", async () => {
  const workspace = join(root, "intended"); const other = join(root, "other");
  for (const [directory, value] of [[workspace, "intended"], [other, "other"]] as const) {
    await mkdir(directory); await writeFile(join(directory, "file"), value);
    execFileSync("git", ["init", "-q", directory]);
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", value], { cwd: directory });
  }
  const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const expectedTree = execFileSync("git", ["write-tree"], { cwd: workspace, encoding: "utf8" });
  vi.stubEnv("GIT_DIR", join(other, ".git"));
  vi.stubEnv("GIT_WORK_TREE", other);
  vi.stubEnv("GIT_INDEX_FILE", join(other, ".git/index"));
  vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.bare=true'");
  expect(await deliveryGit(workspace, ["rev-parse", "HEAD"])).toBe(expected);
  expect(await deliveryGit(workspace, ["write-tree"])).toBe(expectedTree);
  const fence = await createDeliverySourceFence(workspace, expected.trim());
  await writeFile(join(workspace, "file"), "changed");
  await expect(fence()).rejects.toThrow("delivery_source_changed");
});
