import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliverCommandDeps } from "./bin.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("binds V2 checks and budget to committed host policy without enabling auto-merge", async () => {
  const root = realpathSync(
    createScratchDirSync("tests", "delivery-host-policy"),
  );
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  vi.stubEnv("OSSTACK_HOME", home);
  mkdirSync(join(root, ".osstack"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const config = {
    schema_version: 2,
    product: "test-policy",
    role: "core_product",
    default_branch: "main",
    verify_command: "node --version",
    autonomy: {
      max_auto_risk: "R2",
      require_independent_evaluator: true,
      max_builder_iterations: 3,
      max_review_rounds: 2,
      max_wall_time_minutes: 15,
      max_no_progress_rounds: 1,
    },
    git: {
      remote: "origin",
      branch_prefix: "codex",
      merge_strategy: "squash",
      auto_merge: false,
      protected_branches: ["main"],
    },
    verification: {
      quick: ["node --version"],
      standard: ["node --version"],
      release: ["node --version"],
    },
  };
  writeFileSync(join(root, ".osstack/repo.yaml"), JSON.stringify(config));
  writeFileSync(
    join(root, ".osstack/policy.yaml"),
    JSON.stringify({
      schema_version: 1,
      mode: "execute",
      auto_apply: true,
      allowed_auto_changes: ["docs", "tests"],
      requires_approval: ["source"],
      forbidden: ["secrets"],
      budgets: { max_iterations: 5, max_runtime_minutes: 45, max_cost_usd: 20 },
    }),
  );
  git("add", ".osstack");
  git("commit", "-m", "policy");
  const deps = createDeliverCommandDeps();
  const base = git("rev-parse", "HEAD").toString().trim();
  const first = await deps.deliveryContractPolicy!(root);
  expect(first).toMatchObject({
    verifyCommands: ["node --version"],
    budgetRef: `policy:${first.policyDigest}`,
    budget: {
      max_builder_iterations: 3,
      max_review_rounds: 2,
      max_wall_time_ms: 900000,
      max_no_progress_rounds: 1,
    },
  });
  writeFileSync(
    join(root, ".osstack/repo.yaml"),
    JSON.stringify({
      ...config,
      verification: {
        ...config.verification,
        standard: ["uncommitted-untrusted-command"],
      },
    }),
  );
  expect(await deps.deliveryContractPolicy!(root)).toEqual(first);
  git("add", ".osstack/repo.yaml");
  git("commit", "-m", "updated policy");
  expect(await deps.deliveryContractPolicy!(root, base)).toEqual(first);
  await expect(deps.deliveryContractPolicy!(root, "HEAD:untrusted")).rejects.toThrow("invalid_policy_revision");
  expect((await deps.deliveryContractPolicy!(root)).policyDigest).not.toBe(
    first.policyDigest,
  );
});
