import type { RoutableAdapter } from "@osstack/core";
import { CapabilitySchema, type Capability, type CapabilityKind } from "@osstack/core";
import { describe, expect, it } from "vitest";
import { resolveAll, resolveRole } from "./resolver.js";
import type { RoleMap } from "./types.js";

function makeAdapter(opts: {
  id: string;
  kinds: CapabilityKind[];
  available: boolean;
  reason?: string;
}): RoutableAdapter {
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
    cost_tier: "mid",
    capabilities: () => caps,
    isAvailable: async () =>
      opts.available ? { available: true } : { available: false, reason: opts.reason ?? "unavailable" },
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
