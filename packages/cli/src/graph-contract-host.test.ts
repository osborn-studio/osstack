import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createScratchDirSync,
  deliveryCheckReference,
  freezeDeliveryContract,
} from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliverCommandDeps } from "./bin.js";
import { createGraphContractHostResolvers } from "./graph-contract-host.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "graph-host-policy"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  vi.stubEnv("OSSTACK_HOME", home);
  mkdirSync(join(root, ".osstack"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const config = {
    schema_version: 2,
    product: "graph-test",
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
  const base = git("rev-parse", "HEAD");
  const basePolicy = await createDeliverCommandDeps().deliveryContractPolicy!(
    root,
    base,
  );
  const scope = {
    schemaVersion: 1 as const,
    tenantId: "default",
    principalId: "operator",
    workspaceId: "workspace",
  };
  const limits = {
    maxEpochs: 1,
    maxBranchAttempts: 1,
    maxConcurrentReaders: 2,
    maxConcurrentWritersPerRepo: 1,
    maxActionStarts: 20,
    deadlineSeconds: 600,
    tokenReservationLimit: 500000,
  };
  const graphPolicy = {
    schema_version: 1,
    repo_path: root,
    scope,
    base_policy_digest: basePolicy.policyDigest,
    review_policy_ref: "graph:independent",
    limits,
  };
  const policyPath = join(home, "graph-policy.json");
  writeFileSync(policyPath, JSON.stringify(graphPolicy), { mode: 0o600 });
  const frozen = freezeDeliveryContract({
    schema_version: 2,
    contract_id: "contract",
    task_id: "task",
    canonical_repo: root,
    mode: "implement",
    base_head: base,
    goal: "change",
    required_checks: [
      { id: "check", registry_ref: deliveryCheckReference("node --version") },
    ],
    review_policy_ref: "graph:independent",
    requested_completion: "local_verified",
    allowed_paths: ["src"],
    requested_actions: ["build", "verify"],
    budget_ref: `policy:${basePolicy.policyDigest}`,
    policy_digest: basePolicy.policyDigest,
    publication_scope: { mode: "none" },
    merge_authority: { mode: "none" },
  });
  return {
    root,
    home,
    scope,
    limits,
    graphPolicy,
    policyPath,
    frozen,
    resolve: createGraphContractHostResolvers(home),
  };
}
it("uses explicit Graph budgets and detects private authority changes synchronously", async () => {
  const f = await fixture();
  const binding = await f.resolve.resolveDeliveryContractPolicy!({
    repositoryPath: f.root,
    scope: f.scope,
    contract: f.frozen.contract,
  });
  expect(binding.policy).toEqual({
    policyDigest: f.frozen.contract.policy_digest,
    reviewPolicyRef: "graph:independent",
    limits: f.limits,
  });
  expect(binding.assertCurrent()).toBeUndefined();
  writeFileSync(
    f.policyPath,
    JSON.stringify({
      ...f.graphPolicy,
      limits: { ...f.limits, maxActionStarts: 19 },
    }),
  );
  expect(() => binding.assertCurrent()).toThrow(
    "GRAPH_CONTRACT_POLICY_CHANGED",
  );
});
it("detects a newly introduced private overlay and rejects unregistered checks", async () => {
  const f = await fixture();
  const binding = await f.resolve.resolveDeliveryContractPolicy!({
    repositoryPath: f.root,
    scope: f.scope,
    contract: f.frozen.contract,
  });
  mkdirSync(join(f.home, "repos"));
  writeFileSync(join(f.home, "repos/graph-test.yaml"), "{}", { mode: 0o600 });
  expect(() => binding.assertCurrent()).toThrow(
    "GRAPH_CONTRACT_POLICY_CHANGED",
  );
  await expect(
    f.resolve.resolveDeliveryContractPolicy!({
      repositoryPath: f.root,
      scope: f.scope,
      contract: {
        ...f.frozen.contract,
        required_checks: [
          {
            id: "bad",
            registry_ref: deliveryCheckReference("arbitrary command"),
          },
        ],
      },
    }),
  ).rejects.toThrow();
});
it("rejects wrong scope, policy digest, unsafe permissions and implicit budgets", async () => {
  const f = await fixture();
  const input = {
    repositoryPath: f.root,
    scope: f.scope,
    contract: f.frozen.contract,
  };
  await expect(
    f.resolve.resolveDeliveryContractPolicy!({
      ...input,
      scope: { ...f.scope, tenantId: "other" },
    }),
  ).rejects.toThrow();
  await expect(
    f.resolve.resolveDeliveryContractPolicy!({
      ...input,
      contract: { ...f.frozen.contract, policy_digest: "a".repeat(64) },
    }),
  ).rejects.toThrow();
  chmodSync(f.policyPath, 0o644);
  await expect(
    f.resolve.resolveDeliveryContractPolicy!(input),
  ).rejects.toThrow();
  chmodSync(f.policyPath, 0o600);
  const { maxActionStarts: _omitted, ...partial } = f.limits;
  writeFileSync(
    f.policyPath,
    JSON.stringify({ ...f.graphPolicy, limits: partial }),
  );
  await expect(
    f.resolve.resolveDeliveryContractPolicy!(input),
  ).rejects.toThrow();
});
it("rejects cross-tenant context before attempting to read its path", async () => {
  const f = await fixture();
  await expect(
    f.resolve.resolveExecutionContext!({
      configPath: "missing.json",
      repositoryPath: f.root,
      scope: { ...f.scope, tenantId: "other" },
      frozen: f.frozen,
    }),
  ).rejects.toThrow("GRAPH_CONTEXT_SCOPE_UNSUPPORTED");
});

it("passes pinned context into actual invocation and persists both digest-bound receipts", async () => {
  const f = await fixture();
  const { executionContextDigest } = await import("@osstack/knowledge");
  const { readFileSync, statSync } = await import("node:fs");
  const pack = {
    id: "test/pin",
    version: "1",
    name: "Pinned",
    license: "MIT",
    source_kind: "internal",
    quality_score: 90,
    scope: "project",
    chunks: [
      { chunk_id: "one", title: "Guidance", body: "pinned test instruction" },
    ],
  };
  const raw = JSON.stringify(pack);
  writeFileSync(join(f.root, "pack.json"), raw);
  const path = join(f.root, "context.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 1,
      mode: "local",
      repo_path: f.root,
      default_tenant: true,
      packs: [
        {
          path: "pack.json",
          pack_id: "test/pin",
          version: "1",
          sha256: executionContextDigest(raw),
          scope: "project",
          verified_at_ms: Date.now() - 1000,
          expires_at_ms: Date.now() + 60000,
        },
      ],
    }),
  );
  const binding = await f.resolve.resolveExecutionContext!({
    configPath: path,
    repositoryPath: f.root,
    scope: f.scope,
    frozen: f.frozen,
  });
  const seen: string[] = [];
  const adapter: import("@osstack/agents").AgentAdapter = {
    id: "fake",
    display_name: "Fake",
    cost_tier: "low",
    capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    async *invoke(task) {
      seen.push(task.prompt);
      yield {
        type: "run.started",
      } as import("@osstack/hermes-adapter").HermesEvent;
    },
  };
  const wrapped = await binding.create({
    adapter,
    workspacePath: f.root,
    frozen: f.frozen,
  });
  for await (const _event of wrapped.adapter.invoke(
    {
      run_id: "run",
      task_id: "task",
      session_id: "session",
      capability_id: "code",
      prompt: "Implement pinned test instruction",
      context: { repo_path: f.root },
    },
    new AbortController().signal,
  )) {
    /* drain */
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("pinned test instruction");
  expect(seen[0]).toContain(f.frozen.brief);
  const refs = wrapped.receiptRefs();
  expect(refs).toHaveLength(2);
  const receipts = refs.map((ref) => {
    const bytes = readFileSync(ref.path);
    expect(executionContextDigest(bytes)).toBe(ref.digest);
    expect(statSync(ref.path).mode & 0o077).toBe(0);
    return JSON.parse(bytes.toString());
  });
  expect(receipts.map((row) => row.phase)).toEqual([
    "prepared",
    "adapter_observed",
  ]);
  expect(
    receipts.every(
      (row) =>
        row.prompt_sha256 === executionContextDigest(seen[0]!) &&
        row.contract_digest === f.frozen.digest,
    ),
  ).toBe(true);
  writeFileSync(path, "{}");
  expect(() => binding.assertCurrent()).toThrow("GRAPH_CONTEXT_CONFIG_CHANGED");
  await expect(
    binding.create({ adapter, workspacePath: f.root, frozen: f.frozen }),
  ).rejects.toThrow();
});

it("loads contract authority through the default real daemon and keeps admission disabled", async () => {
  const f = await fixture();
  const { startDaemon } = await import("./daemon.js");
  const { healthyAutonomyHealth } = await import("./test-healthy-autonomy.js");
  const { connect } = await import("node:net");
  const { FrameDecoder, encodeFrame } = await import("@osstack/hermes-adapter");
  const socket = join(
    (await import("node:os")).tmpdir(),
    `g-${(await import("node:crypto")).randomUUID().slice(0, 8)}.sock`,
  );
  const adapters = ["writer", "reviewer"].map((id) => ({
    id,
    display_name: id,
    cost_tier: "low" as const,
    capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    invoke: vi.fn(() => {
      throw Error("MUST_NOT_INVOKE");
    }),
  }));
  writeFileSync(
    join(f.home, "graph-host.json"),
    JSON.stringify({
      schemaVersion: 1,
      admissionEnabled: false,
      registration: {
        id: "local",
        scope: f.scope,
        repositoryRef: "repo",
        repositoryPath: f.root,
        taskRef: "task",
        task: "change",
        inputArtifactRef: "input",
        deliveryContract: f.frozen.contract,
        writer: { agentId: "writer", capabilityId: "write" },
        reviewer: { agentId: "reviewer", capabilityId: "review" },
        acceptanceRegistry: [
          {
            ref: "test",
            command: "node --version",
            passExitCodes: [0],
            failExitCodes: [1],
          },
        ],
        grant: {
          scope: f.scope,
          expiresAt: Date.now() + 60000,
          operations: ["read", "execute"],
        },
      },
    }),
    { mode: 0o600 },
  );
  await (await import("./graph-rpc.js")).loadLocalGraphRegistration(
    join(f.home, "graph-host.json"),
    new Map(adapters.map((adapter) => [adapter.id, adapter])),
    createGraphContractHostResolvers(f.home),
  );
  const daemon = await startDaemon({
    socketPath: socket,
    adapters,
    autonomyHealth: async () => healthyAutonomyHealth(),
  });
  expect((await import("node:fs")).statSync(socket).mode & 0o077).toBe(0);
  const rpc = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = connect(socket);
      const decoder = new FrameDecoder();
      const timer = setTimeout(() => {
        client.destroy();
        reject(Error("timeout"));
      }, 5000);
      client.on("connect", () =>
        client.write(encodeFrame({ id: 1, method, params })),
      );
      client.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      client.on("data", (chunk) => {
        const values = decoder.push(chunk);
        if (values.length) {
          clearTimeout(timer);
          client.end();
          resolve(values[0] as Record<string, unknown>);
        }
      });
    });
  try {
    const request = {
      schemaVersion: 1,
      kind: "start",
      scope: f.scope,
      idempotencyKey: "one",
      inputArtifactRef: "input",
      source: { product: "osstack", requestId: "request" },
      spec: {
        schemaVersion: 1,
        template: "code-delivery-v1",
        publication: "artifact_only",
        input: {
          taskRef: "task",
          repositoryRef: "repo",
          baseRevision: f.frozen.contract.base_head,
          acceptanceRef: "test",
        },
        limits: f.limits,
      },
    };
    expect(await rpc("graph.start", request)).toMatchObject({
      ok: false,
      error: { code: "GRAPH_ADMISSION_DISABLED" },
    });
    expect(
      await rpc("graph.contract", {
        schemaVersion: 1,
        scope: f.scope,
        graphRunId: "missing",
      }),
    ).toMatchObject({ ok: false, error: { code: "RUN_MISMATCH" } });
    expect(
      adapters.every((adapter) => adapter.invoke.mock.calls.length === 0),
    ).toBe(true);
  } finally {
    await daemon.close();
  }
});
