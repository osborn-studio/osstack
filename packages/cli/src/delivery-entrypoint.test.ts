import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import {
  CapabilitySchema,
  createScratchDir,
  deliveryCheckReference,
} from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ adapters: [] as AgentAdapter[] }));
vi.mock("@osstack/agents", async (original) => ({
  ...(await original<typeof import("@osstack/agents")>()),
  defaultAdapters: () => ports.adapters,
}));
import { createDeliverCommandDeps, main } from "./bin.js";
let root: string | undefined;
let candidate: string | undefined;
let repo: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (candidate && repo)
    execFileSync("git", [
      "-C",
      repo,
      "worktree",
      "remove",
      "--force",
      candidate,
    ]);
  if (root) await rm(root, { recursive: true, force: true });
  candidate = undefined;
  repo = undefined;
  root = undefined;
});
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
it.each([false,true])("runs the real V2 delivery and rejects source mutation: %s", async (mutateSource) => {
  root = realpathSync(await createScratchDir("tests", "delivery-entrypoint"));
  repo = join(root, "repo");
  await cp(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../fixtures/guarded-local",
    ),
    repo,
    { recursive: true },
  );
  const home = join(root, "home");
  await mkdir(home);
  vi.stubEnv("OSSTACK_HOME", home);
  vi.stubEnv("OSSTACK_CONFIG", join(home, "absent.yaml"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo!, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "-b", "main");
  await mkdir(join(repo, ".osstack"), { recursive: true });
  await writeFile(
    join(repo, ".osstack/repo.yaml"),
    JSON.stringify({
      schema_version: 2,
      product: "entrypoint",
      role: "core_product",
      default_branch: "main",
      verify_command: "pnpm test",
      autonomy: {
        max_auto_risk: "R2",
        require_independent_evaluator: true,
        max_builder_iterations: 1,
        max_review_rounds: 1,
        max_wall_time_minutes: 2,
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
        quick: ["pnpm test"],
        standard: ["pnpm test"],
        release: ["pnpm test"],
      },
    }),
  );
  await writeFile(
    join(repo, ".osstack/policy.yaml"),
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
  const pack = JSON.stringify({
    id: "local/cache",
    version: "1",
    name: "Cache",
    license: "MIT",
    source_kind: "internal",
    quality_score: 90,
    scope: "project",
    chunks: [
      { chunk_id: "cache", title: "Cache", body: "Cache isolation reference" },
    ],
  });
  await writeFile(join(repo, "pack.json"), pack);
  const context = join(repo, "context.json");
  await writeFile(
    context,
    JSON.stringify({
      schema_version: 1,
      mode: "local",
      repo_path: repo,
      default_tenant: true,
      packs: [
        {
          path: "pack.json",
          pack_id: "local/cache",
          version: "1",
          sha256: hash(pack),
          scope: "project",
          verified_at_ms: Date.now() - 1000,
          expires_at_ms: Date.now() + 120000,
        },
      ],
    }),
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const base = git("rev-parse", "HEAD");
  const source = await readFile(join(repo, "src/greeting.ts"), "utf8");
  const policy = await createDeliverCommandDeps().deliveryContractPolicy!(repo);
  const contract = join(root, "contract.json");
  await writeFile(
    contract,
    JSON.stringify({
      schema_version: 2,
      contract_id: "entrypoint",
      task_id: "entrypoint-task",
      canonical_repo: repo,
      mode: "implement",
      base_head: base,
      goal: "Improve cache isolation",
      required_checks: [
        { id: "tests", registry_ref: deliveryCheckReference("pnpm test") },
      ],
      review_policy_ref: "profile:mac-mini",
      requested_completion: "local_verified",
      allowed_paths: ["src"],
      requested_actions: ["build", "verify"],
      budget_ref: policy.budgetRef,
      policy_digest: policy.policyDigest,
      publication_scope: { mode: "none" },
      merge_authority: { mode: "none" },
    }),
  );
  const prompts = new Map<string, string>();
  const identity = (id: string) => ({
    adapter_id: id,
    adapter_version: "1.0.0",
    auth_mode: "test",
    provider_id: id === "claude-code" ? "anthropic" : "kimi",
    model_id: id === "claude-code" ? "claude-current" : "kimi-code/k3",
    evidence_source: "reported" as const,
  });
  ports.adapters = ["claude-code", "kimi-code"].map((id) => ({
    id,
    display_name: id,
    cost_tier: "mid" as const,
    capabilities: () => [
      CapabilitySchema.parse({
        id: id + ".test",
        agent_id: id,
        kind: id === "claude-code" ? "code.write" : "code.review",
        description: id,
        cost_tier: "mid",
      }),
    ],
    isAvailable: async () => ({ available: true, last_checked_at: 1 }),
    runtimeIdentity: async () => identity(id),
    async *invoke(task: AgentTask): AsyncIterable<HermesEvent> {
      prompts.set(task.run_id, task.prompt);
      if (id === "claude-code") {
        candidate = String(task.context?.["repo_path"]);
        if (mutateSource) await writeFile(join(repo!, "src/greeting.ts"), "\n// escaped candidate\n", {flag:"a"});
        await writeFile(
          join(candidate, "src/greeting.ts"),
          "\nexport const isolated = true;\n",
          { flag: "a" },
        );
      }
      yield {
        event_id: task.run_id + ":1",
        seq: 1,
        run_id: task.run_id,
        session_id: task.session_id,
        created_at: Date.now() / 1000,
        terminal: true,
        type: "done",
        payload: {
          status: "completed",
          last_seq: 0,
          result_summary: "complete",
          ...(id === "kimi-code"
            ? {
                review: {
                  schema_version: 1,
                  verdict: "approved",
                  risk: "read_only",
                  markdown: "Approved",
                  judgments: [],
                  findings: [],
                  recommended_actions: [],
                  evidence_refs: [],
                  runtime_identity: identity(id),
                },
              }
            : {}),
        },
      };
    },
  }));
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
  const code = await main([
    "deliver",
    "--workspace",
    repo,
    "--profile",
    "mac-mini",
    "--autonomy",
    "guarded-local",
    "--contract",
    contract,
    "--execution-context",
    context,
    "--json",
  ]);
  if (mutateSource) {
    expect(code).not.toBe(0);
    expect(logs.join("\n") + errors.join("\n")).toContain("delivery_source_changed");
    expect(await readFile(join(repo, "src/greeting.ts"), "utf8")).not.toBe(source);
    return;
  }
  expect(code, logs.join("\n") + errors.join("\n")).toBe(0);
  const result = JSON.parse(logs.join("\n"));
  expect(result.delivery_contract.achieved_completion).toBe("local_verified");
  expect(git("rev-parse", "HEAD")).toBe(base);
  expect(await readFile(join(repo, "src/greeting.ts"), "utf8")).toBe(source);
  expect(git("status", "--porcelain")).toBe("");
  expect(result.json_path.startsWith(join(home, "delivery-contracts"))).toBe(true);
  expect(result.task_path.startsWith(join(home, "delivery-contracts"))).toBe(true);
  const receipt = JSON.parse(
    await readFile(result.delivery_contract.verification_receipt.path, "utf8"),
  );
  expect(receipt.context_receipt_refs.length).toBeGreaterThanOrEqual(4);
  for (const ref of receipt.context_receipt_refs) {
    const bytes = await readFile(ref.path);
    expect(hash(bytes)).toBe(ref.digest);
    expect(ref.path.startsWith(join(home, "execution-context-receipts"))).toBe(
      true,
    );
    const recorded = JSON.parse(bytes.toString());
    expect(recorded.prompt_sha256).toBe(hash(prompts.get(recorded.run_id)!));
    expect(recorded.contract_digest).toBe(result.delivery_contract.digest);
  }
  expect(
    [...prompts.values()].some((prompt) =>
      prompt.includes("Cache isolation reference"),
    ),
  ).toBe(true);
}, 60000);
