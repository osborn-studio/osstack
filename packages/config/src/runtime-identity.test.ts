import type {
  AgentAdapter,
  AgentRuntimeIdentity,
} from "@osstack/agents";
import { describe, expect, it } from "vitest";
import { resolveRuntimeIdentity } from "./runtime-identity.js";
import { AgentRuntimeIdentityOverride } from "./types.js";

describe("AgentRuntimeIdentityOverride", () => {
  it("normalizes identity labels and rejects credential-bearing fields", () => {
    expect(AgentRuntimeIdentityOverride.parse({
      provider_id: " kimi ",
      model_id: " kimi-code/k3 ",
      agent_profile: " osstack-kimi-review ",
    })).toEqual({
      provider_id: "kimi",
      model_id: "kimi-code/k3",
      agent_profile: "osstack-kimi-review",
    });

    for (const forbidden of ["api_key", "base_url", "headers", "env"]) {
      expect(() => AgentRuntimeIdentityOverride.parse({
        provider_id: "kimi",
        model_id: "kimi-code/k3",
        [forbidden]: "forbidden",
      })).toThrow();
    }
  });
});

describe("resolveRuntimeIdentity", () => {
  it("prefers adapter-reported evidence over configured identity", async () => {
    const reported: AgentRuntimeIdentity = {
      adapter_id: "kimi-code",
      adapter_version: "0.29.1",
      auth_mode: "subprocess/login-reuse",
      provider_id: "kimi",
      model_id: "kimi-code/k3",
      evidence_source: "reported",
    };

    await expect(resolveRuntimeIdentity(
      fakeAdapter("kimi-code", reported),
      {
        provider_id: "configured-provider",
        model_id: "configured-model",
      },
    )).resolves.toEqual(reported);
  });

  it("uses configured evidence instead of inferred labels", async () => {
    const inferred: AgentRuntimeIdentity = {
      adapter_id: "claude-code",
      adapter_version: "1.2.3",
      auth_mode: "sdk/api-key",
      provider_id: "unknown",
      model_id: "unknown",
      binary_path_sha256: "abc123",
      evidence_source: "inferred",
    };

    await expect(resolveRuntimeIdentity(
      fakeAdapter("claude-code", inferred),
      {
        provider_id: "anthropic",
        model_id: "claude-current",
        reasoning_effort: "high",
        agent_profile: "claude-native",
      },
    )).resolves.toEqual({
      adapter_id: "claude-code",
      adapter_version: "1.2.3",
      auth_mode: "sdk/api-key",
      provider_id: "anthropic",
      model_id: "claude-current",
      reasoning_effort: "high",
      agent_profile: "claude-native",
      binary_path_sha256: "abc123",
      evidence_source: "configured",
    });
  });

  it("rejects runtime evidence for a different adapter", async () => {
    const mismatched: AgentRuntimeIdentity = {
      adapter_id: "codex-cli",
      adapter_version: "1.0.0",
      auth_mode: "subprocess/login-reuse",
      provider_id: "openai",
      model_id: "gpt",
      evidence_source: "reported",
    };

    await expect(resolveRuntimeIdentity(
      fakeAdapter("kimi-code", mismatched),
    )).rejects.toThrow(
      "runtime identity adapter mismatch: expected kimi-code, got codex-cli",
    );
  });

  it("falls back to explicit inferred unknowns when no evidence exists", async () => {
    await expect(resolveRuntimeIdentity(
      fakeAdapter("unreported"),
    )).resolves.toEqual({
      adapter_id: "unreported",
      adapter_version: "unknown",
      auth_mode: "local",
      provider_id: "unknown",
      model_id: "unknown",
      evidence_source: "inferred",
    });
  });
});

function fakeAdapter(
  id: string,
  identity?: AgentRuntimeIdentity,
): AgentAdapter {
  return {
    id,
    display_name: id,
    cost_tier: "low",
    capabilities: () => [],
    isAvailable: async () => ({
      available: true,
      last_checked_at: 1,
    }),
    ...(identity !== undefined
      ? { runtimeIdentity: async () => identity }
      : {}),
    async *invoke() {
      yield* [];
    },
  };
}
