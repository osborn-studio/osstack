import { describe, expect, it } from "vitest";
import { routeCapability, type RoutableAdapter } from "./router.js";
import { CapabilitySchema, type Capability } from "../capability.js";

function makeAdapter(opts: {
  id: string;
  cost_tier: "low" | "mid" | "high";
  caps: ReadonlyArray<{ kind: Capability["kind"]; suffix: string }>;
  available?: boolean;
}): RoutableAdapter {
  const caps = opts.caps.map((c) =>
    CapabilitySchema.parse({
      id: `${opts.id}.${c.suffix}`,
      kind: c.kind,
      agent_id: opts.id,
      description: `${opts.id} ${c.kind}`,
      cost_tier: opts.cost_tier,
    }),
  );
  return {
    id: opts.id,
    cost_tier: opts.cost_tier,
    capabilities: () => caps,
    isAvailable: async () => ({ available: opts.available !== false }),
  };
}

const claude = makeAdapter({
  id: "claude-code", cost_tier: "high",
  caps: [
    { kind: "code.write", suffix: "code.write" },
    { kind: "code.refactor", suffix: "code.refactor" },
    { kind: "code.test", suffix: "code.test" },
  ],
});
const codex = makeAdapter({
  id: "codex-cli", cost_tier: "mid",
  caps: [
    { kind: "code.write", suffix: "code.write" },
    { kind: "code.refactor", suffix: "code.refactor" },
  ],
});

describe("routeCapability", () => {
  it("returns null when no adapters are registered", async () => {
    expect(await routeCapability({ kind: "code.write" }, [])).toBeNull();
  });

  it("honors an agent_id override when that adapter has the capability", async () => {
    const d = await routeCapability({ agent_id: "claude-code", kind: "code.write" }, [claude, codex]);
    expect(d?.adapter.id).toBe("claude-code");
    expect(d?.reason).toMatch(/override/);
  });

  it("prefers lower-cost adapter when both serve the kind", async () => {
    const d = await routeCapability({ kind: "code.write" }, [claude, codex]);
    expect(d?.adapter.id).toBe("codex-cli");
    expect(d?.adapter.cost_tier).toBe("mid");
    expect(d?.reason).toMatch(/lowest-cost/);
  });

  it("matches an exact capability_id", async () => {
    const d = await routeCapability({ capability_id: "claude-code.code.test" }, [claude, codex]);
    expect(d?.adapter.id).toBe("claude-code");
    expect(d?.capability.id).toBe("claude-code.code.test");
    expect(d?.reason).toMatch(/exact capability_id/);
  });

  it("falls through to first-available when nothing else matches", async () => {
    const d = await routeCapability({ kind: "design.architecture" }, [claude, codex]);
    expect(d?.reason).toMatch(/fallback/);
  });

  it("skips unavailable adapters in cost-tier comparison", async () => {
    const unavailable = makeAdapter({
      id: "codex-cli", cost_tier: "low",
      caps: [{ kind: "code.write", suffix: "code.write" }], available: false,
    });
    const d = await routeCapability({ kind: "code.write" }, [claude, unavailable]);
    expect(d?.adapter.id).toBe("claude-code");
  });

  it("infers kind from a dotted capability_id when no kind is given", async () => {
    const d = await routeCapability({ capability_id: "missing.code.refactor" }, [claude, codex]);
    // No exact id match, but kind inference picks lowest-cost
    expect(d?.adapter.id).toBe("codex-cli");
  });

  it("recognizes review and verifier loop capability ids", async () => {
    const dsReview = makeAdapter({
      id: "ds-review",
      cost_tier: "low",
      caps: [{ kind: "review.code", suffix: "review.code" }],
    });
    const dsVerify = makeAdapter({
      id: "ds-verify",
      cost_tier: "low",
      caps: [{ kind: "verify.alignment", suffix: "verify.alignment" }],
    });

    await expect(routeCapability({ capability_id: "missing.review.code" }, [dsReview]))
      .resolves.toMatchObject({ adapter: { id: "ds-review" } });
    await expect(routeCapability({ capability_id: "missing.verify.alignment" }, [dsVerify]))
      .resolves.toMatchObject({ adapter: { id: "ds-verify" } });
  });
});

describe("agent_id override fail-closed (Phase 2 closure G1.1)", () => {
  const reviewCaps = [{ kind: "code.review" as const, suffix: "code.review" }];
  const mk = (id: string, avail: () => Promise<{ available: boolean; reason?: string }>): RoutableAdapter => ({
    ...makeAdapter({ id, cost_tier: "mid", caps: reviewCaps }),
    isAvailable: avail,
  });
  const ok = mk("codex-cli", async () => ({ available: true }));
  const cheap = makeAdapter({ id: "ds-review", cost_tier: "low", caps: reviewCaps });

  it("routes to the requested agent when available (no fallback consulted)", async () => {
    const d = await routeCapability({ agent_id: "codex-cli", kind: "code.review" }, [cheap, ok]);
    expect(d?.adapter.id).toBe("codex-cli");
    expect(d?.reason).toBe("agent_id override");
  });

  it("FAILS CLOSED when the requested agent does not exist — never lowest-cost fallback", async () => {
    await expect(routeCapability({ agent_id: "nope", kind: "code.review" }, [cheap, ok]))
      .rejects.toMatchObject({ name: "AgentOverrideError", code: "agent_not_found", agent_id: "nope" });
  });

  it("FAILS CLOSED when the requested agent reports unavailable", async () => {
    const down = mk("codex-cli", async () => ({ available: false, reason: "probe failed" }));
    await expect(routeCapability({ agent_id: "codex-cli", kind: "code.review" }, [cheap, down]))
      .rejects.toMatchObject({ name: "AgentOverrideError", code: "agent_unavailable" });
  });

  it("FAILS CLOSED when the availability probe throws", async () => {
    const boom = mk("codex-cli", async () => { throw new Error("probe crashed"); });
    await expect(routeCapability({ agent_id: "codex-cli", kind: "code.review" }, [cheap, boom]))
      .rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("FAILS CLOSED when the availability probe hangs past the timeout", async () => {
    const hang = mk("codex-cli", () => new Promise(() => {}));
    await expect(routeCapability({ agent_id: "codex-cli", kind: "code.review" }, [cheap, hang], { probeTimeoutMs: 50 }))
      .rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("FAILS CLOSED when the agent exists but lacks the requested kind", async () => {
    const wrongCap = makeAdapter({ id: "codex-cli", cost_tier: "mid", caps: [{ kind: "code.write", suffix: "code.write" }] });
    await expect(routeCapability({ agent_id: "codex-cli", kind: "code.review" }, [cheap, wrongCap]))
      .rejects.toMatchObject({ code: "agent_capability_mismatch" });
  });

  it("non-override requests keep the existing kind-based lowest-cost behavior", async () => {
    const d = await routeCapability({ kind: "code.review" }, [cheap, ok]);
    expect(d?.adapter.id).toBe("ds-review");
  });
});
