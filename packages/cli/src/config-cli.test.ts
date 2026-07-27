import { CapabilitySchema } from "@osstack/core";
import type {
  AgentAdapter,
  AgentAvailability,
  AgentRuntimeIdentity,
  AgentTask,
} from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConfigCommand } from "./config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("config doctor Kimi readiness", () => {
  it.each([
    {
      label: "available",
      availability: { available: true, last_checked_at: 1 },
      state: "kimi_available",
    },
    {
      label: "missing",
      availability: {
        available: false,
        reason: "kimi unavailable (not installed): version probe exited 127",
        last_checked_at: 1,
      },
      state: "kimi_not_installed",
    },
    {
      label: "unauthenticated",
      availability: {
        available: false,
        reason: "kimi unavailable (not authenticated): provider probe exited 17",
        last_checked_at: 1,
      },
      state: "kimi_not_authenticated",
    },
  ] satisfies Array<{
    label: string;
    availability: AgentAvailability;
    state: string;
  }>)("reports $label without invoking a model", async ({ availability, state }) => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    const invoke = vi.fn();
    const adapter = fakeKimiAdapter(availability, invoke);

    const exitCode = await handleConfigCommand(
      ["doctor"],
      { adapters: () => [adapter] },
    );

    const output = logs.join("\n");
    expect(exitCode).toBe(0);
    expect(output).toContain(state);
    expect(output).toContain("roles: test-verify, reviewer, release/proof");
    expect(output).not.toContain("roles: coding");
    expect(output).toContain("provider: kimi  model: kimi-code/k3");
    expect(invoke).not.toHaveBeenCalled();
  });
});

function fakeKimiAdapter(
  availability: AgentAvailability,
  invoke: ReturnType<typeof vi.fn>,
): AgentAdapter {
  return {
    id: "kimi-code",
    display_name: "Kimi Code CLI",
    cost_tier: "mid",
    capabilities: () => [
      CapabilitySchema.parse({
        id: "kimi-code.code.review",
        kind: "code.review",
        agent_id: "kimi-code",
        description: "Review code",
        cost_tier: "mid",
      }),
      CapabilitySchema.parse({
        id: "kimi-code.release.verify",
        kind: "release.verify",
        agent_id: "kimi-code",
        description: "Verify release",
        cost_tier: "mid",
      }),
    ],
    isAvailable: async () => availability,
    runtimeIdentity: async (): Promise<AgentRuntimeIdentity> => ({
      adapter_id: "kimi-code",
      adapter_version: "0.29.1",
      auth_mode: "subprocess/login-reuse",
      provider_id: "kimi",
      model_id: "kimi-code/k3",
      agent_profile: "osstack-reviewer",
      evidence_source: "configured",
    }),
    invoke: async function* (
      task: AgentTask,
      signal: AbortSignal,
    ): AsyncIterable<HermesEvent> {
      invoke(task, signal);
      for (const event of [] as HermesEvent[]) yield event;
    },
  };
}
