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
});
