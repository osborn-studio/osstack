import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilitySchema } from "@osstack/core";
import type {
  AgentAdapter,
  AgentAvailability,
  AgentRuntimeIdentity,
  AgentTask,
} from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { handleConfigCommand } from "./config.js";

let tmp: string;
let oldConfigPath: string | undefined;
let oldTestSecret: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-config-cli-"));
  oldConfigPath = process.env["OSSTACK_CONFIG"];
  oldTestSecret = process.env["OSSTACK_TEST_SECRET"];
  process.env["OSSTACK_CONFIG"] = join(tmp, "config.yaml");
});

afterEach(async () => {
  if (oldConfigPath === undefined) {
    delete process.env["OSSTACK_CONFIG"];
  } else {
    process.env["OSSTACK_CONFIG"] = oldConfigPath;
  }
  if (oldTestSecret === undefined) {
    delete process.env["OSSTACK_TEST_SECRET"];
  } else {
    process.env["OSSTACK_TEST_SECRET"] = oldTestSecret;
  }
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
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
    expect(output).toContain(
      "adapter=kimi-code provider=kimi model=kimi-code/k3",
    );
    expect(output).toContain("evidence=configured");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows selected role identities without credentials or arbitrary environment values", async () => {
    process.env["OSSTACK_TEST_SECRET"] = "sk-test-do-not-print";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    const adapters = [
      fakeBuilderAdapter(),
      fakeKimiAdapter(
        { available: true, last_checked_at: 1 },
        vi.fn(),
      ),
    ];

    const exitCode = await handleConfigCommand(
      ["doctor", "--profile", "mac-mini"],
      { adapters: () => adapters },
    );

    const output = logs.join("\n");
    expect(exitCode).toBe(0);
    expect(output).toContain(
      "adapter=claude-code provider=anthropic model=claude-current profile=mac-mini evidence=reported",
    );
    expect(output).toContain(
      "adapter=kimi-code provider=kimi model=kimi-code/k3 profile=mac-mini evidence=configured",
    );
    expect(output).not.toContain("auth_mode");
    expect(output).not.toContain("OSSTACK_TEST_SECRET");
    expect(output).not.toContain("sk-test-do-not-print");
  });

  it("shows runtime identity for each resolved role in config show", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });

    const exitCode = await handleConfigCommand(
      ["show", "--profile", "mac-mini"],
      {
        adapters: () => [
          fakeBuilderAdapter(),
          fakeKimiAdapter(
            { available: true, last_checked_at: 1 },
            vi.fn(),
          ),
        ],
      },
    );

    const output = logs.join("\n");
    expect(exitCode).toBe(0);
    expect(output).toContain(
      "adapter=claude-code provider=anthropic model=claude-current profile=mac-mini evidence=reported",
    );
    expect(output).toContain(
      "adapter=kimi-code provider=kimi model=kimi-code/k3 profile=mac-mini evidence=configured",
    );
  });

  it("does not echo runtime identity exception details", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    const adapter = {
      ...fakeBuilderAdapter(),
      runtimeIdentity: async () => {
        throw new Error("credential sk-test-runtime-leak");
      },
    };

    const exitCode = await handleConfigCommand(
      ["doctor", "--profile", "mac-mini"],
      { adapters: () => [adapter] },
    );

    const output = logs.join("\n");
    expect(exitCode).toBe(0);
    expect(output).toContain("runtime identity unavailable");
    expect(output).not.toContain("sk-test-runtime-leak");
  });
});

function fakeBuilderAdapter(): AgentAdapter {
  return {
    id: "claude-code",
    display_name: "Claude Code",
    cost_tier: "high",
    capabilities: () => [
      CapabilitySchema.parse({
        id: "claude-code.code.write",
        kind: "code.write",
        agent_id: "claude-code",
        description: "Write code",
        cost_tier: "high",
      }),
    ],
    isAvailable: async () => ({
      available: true,
      last_checked_at: 1,
    }),
    runtimeIdentity: async (): Promise<AgentRuntimeIdentity> => ({
      adapter_id: "claude-code",
      adapter_version: "1.0.0",
      auth_mode: "login-reuse",
      provider_id: "anthropic",
      model_id: "claude-current",
      evidence_source: "reported",
    }),
    async *invoke() {
      yield* [];
    },
  };
}

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
