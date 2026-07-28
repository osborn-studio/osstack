import type {
  AgentAdapter,
  AgentRuntimeIdentity,
} from "@osstack/agents";
import { CapabilitySchema, type Capability, type CapabilityKind } from "@osstack/core";
import { describe, expect, it } from "vitest";
import {
  resolveAll,
  resolveDeliveryRoles,
  resolveRole,
  runtimeIdentitiesIndependent,
} from "./resolver.js";
import type { RoleMap } from "./types.js";

function makeAdapter(opts: {
  id: string;
  kinds: CapabilityKind[];
  available: boolean;
  reason?: string;
  identity?: AgentRuntimeIdentity;
}): AgentAdapter {
  const caps: Capability[] = opts.kinds.map((kind) =>
    CapabilitySchema.parse({
      id: `${opts.id}.${kind}`,
      kind,
      agent_id: opts.id,
      description: `${opts.id} ${kind}`,
      cost_tier: "mid",
    }),
  );
  return {
    id: opts.id,
    display_name: opts.id,
    cost_tier: "mid",
    capabilities: () => caps,
    isAvailable: async () =>
      opts.available
        ? { available: true, last_checked_at: 1 }
        : {
            available: false,
            reason: opts.reason ?? "unavailable",
            last_checked_at: 1,
          },
    ...(opts.identity !== undefined
      ? { runtimeIdentity: async () => opts.identity! }
      : {}),
    async *invoke() {
      yield* [];
    },
  };
}

const coding = { primary: "claude-code", fallback: ["codex-cli"] };

describe("resolveRole", () => {
  it("picks the primary when it is available", async () => {
    const adapters = [
      makeAdapter({ id: "claude-code", kinds: ["code.write"], available: true }),
      makeAdapter({ id: "codex-cli", kinds: ["code.write"], available: true }),
    ];
    const r = await resolveRole("coding", coding, adapters);
    expect(r.chosen).toBe("claude-code");
    expect(r.available).toBe(true);
    expect(r.reason).toContain("primary");
  });

  it("falls back when the primary is unavailable", async () => {
    const adapters = [
      makeAdapter({ id: "claude-code", kinds: ["code.write"], available: false, reason: "no key" }),
      makeAdapter({ id: "codex-cli", kinds: ["code.write"], available: true }),
    ];
    const r = await resolveRole("coding", coding, adapters);
    expect(r.chosen).toBe("codex-cli");
    expect(r.reason).toContain("fell back");
    expect(r.tried.find((t) => t.id === "claude-code")?.reason).toBe("no key");
  });

  it("skips an agent that does not serve the role", async () => {
    const adapters = [
      makeAdapter({ id: "claude-code", kinds: ["design.prd"], available: true }), // wrong role
      makeAdapter({ id: "codex-cli", kinds: ["code.write"], available: true }),
    ];
    const r = await resolveRole("coding", coding, adapters);
    expect(r.chosen).toBe("codex-cli");
    expect(r.tried.find((t) => t.id === "claude-code")?.reason).toContain("does not serve");
  });

  it("skips an unregistered primary", async () => {
    const adapters = [makeAdapter({ id: "codex-cli", kinds: ["code.write"], available: true })];
    const r = await resolveRole("coding", coding, adapters);
    expect(r.chosen).toBe("codex-cli");
    expect(r.tried.find((t) => t.id === "claude-code")?.reason).toBe("not registered");
  });

  it("returns unavailable when nothing usable exists", async () => {
    const adapters = [
      makeAdapter({ id: "claude-code", kinds: ["code.write"], available: false }),
      makeAdapter({ id: "codex-cli", kinds: ["code.write"], available: false }),
    ];
    const r = await resolveRole("coding", coding, adapters);
    expect(r.chosen).toBeNull();
    expect(r.available).toBe(false);
  });

  it("uses autoFallback to reach an unconfigured but capable agent", async () => {
    const adapters = [
      makeAdapter({ id: "claude-code", kinds: ["code.write"], available: false }),
      makeAdapter({ id: "codex-cli", kinds: ["code.write"], available: false }),
      makeAdapter({ id: "some-other", kinds: ["code.write"], available: true }),
    ];
    const r = await resolveRole("coding", coding, adapters, { autoFallback: true });
    expect(r.chosen).toBe("some-other");
    expect(r.reason).toContain("auto-fallback");
  });

  it("excludes a selected builder from evaluator candidates", async () => {
    const adapters = [
      makeAdapter({
        id: "claude-code",
        kinds: ["code.test"],
        available: true,
      }),
      makeAdapter({
        id: "kimi-code",
        kinds: ["code.review"],
        available: true,
      }),
    ];

    const r = await resolveRole(
      "test-verify",
      { primary: "claude-code", fallback: ["kimi-code"] },
      adapters,
      { excludeAgentIds: new Set(["claude-code"]) },
    );

    expect(r.chosen).toBe("kimi-code");
    expect(r.tried).toContainEqual({
      id: "claude-code",
      ok: false,
      reason: "excluded by role-separation policy",
    });
  });
});

describe("resolveAll", () => {
  it("resolves all three roles independently", async () => {
    const roles: RoleMap = {
      coding: { primary: "claude-code", fallback: ["codex-cli"] },
      "test-verify": { primary: "codex-cli", fallback: ["claude-code"] },
      design: { primary: "claude-design", fallback: ["google-stitch"] },
    };
    const adapters = [
      makeAdapter({ id: "claude-code", kinds: ["code.write", "code.test"], available: true }),
      makeAdapter({ id: "codex-cli", kinds: ["code.write", "code.test"], available: true }),
      makeAdapter({ id: "claude-design", kinds: ["design.prd"], available: true }),
      makeAdapter({ id: "google-stitch", kinds: ["design.prd"], available: false }),
    ];
    const out = await resolveAll(roles, adapters);
    expect(out.coding.chosen).toBe("claude-code");
    expect(out["test-verify"].chosen).toBe("codex-cli");
    expect(out.design.chosen).toBe("claude-design");
  });
});

describe("runtimeIdentitiesIndependent", () => {
  const reportedBuilder = identity({
    adapter_id: "claude-code",
    provider_id: "anthropic",
    model_id: "claude-current",
    evidence_source: "reported",
  });
  const reportedEvaluator = identity({
    adapter_id: "kimi-code",
    provider_id: "kimi",
    model_id: "kimi-code/k3",
    evidence_source: "reported",
  });

  it("accepts distinct adapters at the adapter separation level", () => {
    expect(runtimeIdentitiesIndependent(
      identity({
        adapter_id: "claude-code",
        provider_id: "unknown",
        model_id: "unknown",
        evidence_source: "inferred",
      }),
      identity({
        adapter_id: "kimi-code",
        provider_id: "kimi",
        model_id: "kimi-code/k3",
        evidence_source: "configured",
      }),
      "adapter",
    )).toMatchObject({ pass: true });
  });

  it("rejects configured or inferred evidence for R2 provider independence", () => {
    expect(runtimeIdentitiesIndependent(
      { ...reportedBuilder, evidence_source: "configured" },
      reportedEvaluator,
      "provider-or-model",
    )).toEqual({
      pass: false,
      reason: "configured/inferred identity cannot prove provider independence",
    });
    expect(runtimeIdentitiesIndependent(
      reportedBuilder,
      { ...reportedEvaluator, evidence_source: "inferred" },
      "provider-or-model",
    )).toEqual({
      pass: false,
      reason: "configured/inferred identity cannot prove provider independence",
    });
  });

  it("accepts only reported distinct providers or models for R2", () => {
    expect(runtimeIdentitiesIndependent(
      reportedBuilder,
      reportedEvaluator,
      "provider-or-model",
    )).toMatchObject({ pass: true });
    expect(runtimeIdentitiesIndependent(
      reportedBuilder,
      { ...reportedEvaluator, provider_id: "anthropic" },
      "provider-or-model",
    )).toMatchObject({ pass: true });
    expect(runtimeIdentitiesIndependent(
      reportedBuilder,
      { ...reportedEvaluator, model_id: "claude-current" },
      "provider-or-model",
    )).toMatchObject({ pass: true });
    expect(runtimeIdentitiesIndependent(
      reportedBuilder,
      {
        ...reportedEvaluator,
        provider_id: "anthropic",
        model_id: "claude-current",
      },
      "provider-or-model",
    )).toMatchObject({ pass: false });
    expect(runtimeIdentitiesIndependent(
      reportedBuilder,
      { ...reportedEvaluator, provider_id: "unknown" },
      "provider-or-model",
    )).toEqual({
      pass: false,
      reason: "reported identity has unknown provider or model",
    });
  });
});

describe("resolveDeliveryRoles", () => {
  const roles: RoleMap = {
    coding: { primary: "claude-code", fallback: ["codex-cli"] },
    "test-verify": { primary: "kimi-code", fallback: ["codex-cli", "claude-code"] },
    design: { primary: "claude-design", fallback: ["google-stitch"] },
  };

  it("resolves separated Builder, Evaluator, and Designer identities", async () => {
    const adapters = [
      makeAdapter({
        id: "claude-code",
        kinds: ["code.write"],
        available: true,
        identity: identity({
          adapter_id: "claude-code",
          provider_id: "anthropic",
          model_id: "claude-current",
          evidence_source: "reported",
        }),
      }),
      makeAdapter({
        id: "kimi-code",
        kinds: ["code.review"],
        available: true,
        identity: identity({
          adapter_id: "kimi-code",
          provider_id: "kimi",
          model_id: "kimi-code/k3",
          evidence_source: "reported",
        }),
      }),
      makeAdapter({
        id: "claude-design",
        kinds: ["design.prd"],
        available: true,
      }),
    ];

    await expect(resolveDeliveryRoles(
      roles,
      adapters,
      { independenceLevel: "provider-or-model" },
    )).resolves.toMatchObject({
      builder: { chosen: "claude-code" },
      evaluator: { chosen: "kimi-code" },
      designer: { chosen: "claude-design" },
      identities: {
        builder: { adapter_id: "claude-code" },
        evaluator: { adapter_id: "kimi-code" },
        designer: { adapter_id: "claude-design" },
      },
      independent: true,
    });
  });

  it("falls back when the configured evaluator is also the Builder", async () => {
    const sameAgentRoles: RoleMap = {
      ...roles,
      "test-verify": {
        primary: "claude-code",
        fallback: ["kimi-code"],
      },
    };
    const adapters = [
      makeAdapter({
        id: "claude-code",
        kinds: ["code.write", "code.test"],
        available: true,
      }),
      makeAdapter({
        id: "kimi-code",
        kinds: ["code.review"],
        available: true,
      }),
    ];

    const out = await resolveDeliveryRoles(sameAgentRoles, adapters);
    expect(out.builder.chosen).toBe("claude-code");
    expect(out.evaluator.chosen).toBe("kimi-code");
    expect(out.independent).toBe(true);
  });

  it("falls back to Codex when Kimi is unavailable", async () => {
    const adapters = [
      makeAdapter({
        id: "claude-code",
        kinds: ["code.write"],
        available: true,
      }),
      makeAdapter({
        id: "kimi-code",
        kinds: ["code.review"],
        available: false,
        reason: "not authenticated",
      }),
      makeAdapter({
        id: "codex-cli",
        kinds: ["code.write", "code.test"],
        available: true,
      }),
    ];

    const out = await resolveDeliveryRoles(roles, adapters);
    expect(out.builder.chosen).toBe("claude-code");
    expect(out.evaluator.chosen).toBe("codex-cli");
    expect(out.evaluator.tried).toContainEqual({
      id: "kimi-code",
      ok: false,
      reason: "not authenticated",
    });
    expect(out.independent).toBe(true);
  });

  it("does not let configured identities self-prove R2 independence", async () => {
    const adapters = [
      makeAdapter({
        id: "claude-code",
        kinds: ["code.write"],
        available: true,
      }),
      makeAdapter({
        id: "kimi-code",
        kinds: ["code.review"],
        available: true,
      }),
    ];

    const out = await resolveDeliveryRoles(roles, adapters, {
      independenceLevel: "provider-or-model",
      identityOverrides: {
        "claude-code": {
          provider_id: "anthropic",
          model_id: "claude-current",
        },
        "kimi-code": {
          provider_id: "kimi",
          model_id: "kimi-code/k3",
        },
      },
    });

    expect(out.identities).toMatchObject({
      builder: { evidence_source: "configured" },
      evaluator: { evidence_source: "configured" },
    });
    expect(out).toMatchObject({
      independent: false,
      independence_reason:
        "configured/inferred identity cannot prove provider independence",
    });
  });

  it("fails closed when no independent evaluator is available", async () => {
    const adapters = [
      makeAdapter({
        id: "claude-code",
        kinds: ["code.write", "code.test"],
        available: true,
      }),
    ];

    await expect(resolveDeliveryRoles(roles, adapters)).resolves.toMatchObject({
      builder: { chosen: "claude-code" },
      evaluator: { chosen: null },
      independent: false,
      independence_reason: "builder or evaluator unavailable",
    });
  });
});

function identity(
  input: Pick<
    AgentRuntimeIdentity,
    "adapter_id" | "provider_id" | "model_id" | "evidence_source"
  >,
): AgentRuntimeIdentity {
  return {
    adapter_version: "1.0.0",
    auth_mode: "test",
    ...input,
  };
}
