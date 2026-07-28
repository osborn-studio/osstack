import type {
  AgentAdapter,
  AgentRuntimeIdentity,
} from "@osstack/agents";
import {
  CapabilitySchema,
  type Capability,
  type CapabilityKind,
} from "@osstack/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  defaultConfig,
  selectProfile,
} from "@osstack/config";
import {
  resolveLoopProfileRouting,
  shouldResolveExecutionProfile,
} from "./loop-profile-routing.js";

const profileEnvNames = [
  "OSSTACK_AGENT_PROFILE",
  "OSSTACK_PROFILE",
] as const;
let oldProfileEnv: Record<string, string | undefined>;
const selectTestProfile: typeof selectProfile = (
  config,
  opts = {},
) => selectProfile(config, {
  ...opts,
  hostname: "test-host.local",
  model: "",
});

beforeEach(() => {
  oldProfileEnv = Object.fromEntries(
    profileEnvNames.map((name) => [name, process.env[name]]),
  );
  for (const name of profileEnvNames) delete process.env[name];
});

afterEach(() => {
  for (const name of profileEnvNames) {
    const value = oldProfileEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe("shouldResolveExecutionProfile", () => {
  it.each([
    {
      label: "bare legacy",
      input: {
        explicitProfile: false,
        roleOverrides: false,
        guardedAutonomy: false,
        autoAgent: false,
        executeCommand: false,
      },
      expected: false,
    },
    {
      label: "explicit profile",
      input: {
        explicitProfile: true,
        roleOverrides: false,
        guardedAutonomy: false,
        autoAgent: false,
        executeCommand: true,
      },
      expected: true,
    },
    {
      label: "role override",
      input: {
        explicitProfile: false,
        roleOverrides: true,
        guardedAutonomy: false,
        autoAgent: false,
        executeCommand: true,
      },
      expected: true,
    },
    {
      label: "guarded autonomy",
      input: {
        explicitProfile: false,
        roleOverrides: false,
        guardedAutonomy: true,
        autoAgent: false,
        executeCommand: true,
      },
      expected: true,
    },
    {
      label: "agent-backed auto routing",
      input: {
        explicitProfile: false,
        roleOverrides: false,
        guardedAutonomy: false,
        autoAgent: true,
        executeCommand: false,
      },
      expected: true,
    },
    {
      label: "local execute with auto-agent",
      input: {
        explicitProfile: false,
        roleOverrides: false,
        guardedAutonomy: false,
        autoAgent: true,
        executeCommand: true,
      },
      expected: false,
    },
  ])("$label -> $expected", ({ input, expected }) => {
    expect(shouldResolveExecutionProfile(input)).toBe(expected);
  });
});

describe("resolveLoopProfileRouting", () => {
  it("resolves active_profile:auto for agent-backed execution", async () => {
    const adapters = profileAdapters();

    await expect(resolveLoopProfileRouting(
      ["--auto-agent"],
      undefined,
      [],
      {
        loadConfig: defaultConfig,
        selectProfile: selectTestProfile,
        adapters: () => adapters,
      },
    )).resolves.toMatchObject({
      agentId: "claude-code",
      verifierAgentIds: ["kimi-code"],
      summary: {
        profile_name: "defaults",
        builder_agent_id: "claude-code",
        evaluator_agent_id: "kimi-code",
        builder_identity: {
          adapter_id: "claude-code",
          evidence_source: "reported",
        },
        evaluator_identity: {
          adapter_id: "kimi-code",
          evidence_source: "reported",
        },
        independent: true,
      },
    });
  });

  it("does not resolve or probe for local --execute paths", async () => {
    const adapters = vi.fn(() => profileAdapters());

    await expect(resolveLoopProfileRouting(
      [
        "--auto-agent",
        "--execute",
        "node -e \"process.exit(0)\"",
      ],
      undefined,
      [],
      {
        loadConfig: defaultConfig,
        selectProfile: selectTestProfile,
        adapters,
      },
    )).resolves.toBeUndefined();
    expect(adapters).not.toHaveBeenCalled();
  });

  it("always resolves an explicit profile", async () => {
    await expect(resolveLoopProfileRouting(
      [
        "--profile",
        "mac-mini",
        "--execute",
        "node -e \"process.exit(0)\"",
      ],
      undefined,
      [],
      {
        loadConfig: defaultConfig,
        selectProfile: selectTestProfile,
        adapters: profileAdapters,
      },
    )).resolves.toMatchObject({
      summary: {
        profile_name: "mac-mini",
        independent: true,
      },
    });
  });

  it("rejects an explicit same Builder and Evaluator pair", async () => {
    await expect(resolveLoopProfileRouting(
      ["--profile", "mac-mini"],
      "claude-code",
      ["claude-code"],
      {
        loadConfig: defaultConfig,
        selectProfile: selectTestProfile,
        adapters: profileAdapters,
      },
    )).resolves.toEqual(
      new Error(
        "explicit Builder and Evaluator must use different adapters",
      ),
    );
  });

  it("falls back to Codex when Kimi is unavailable", async () => {
    const adapters = profileAdapters({
      kimiAvailable: false,
      codexTestCapability: true,
    });

    await expect(resolveLoopProfileRouting(
      ["--profile", "mac-mini"],
      undefined,
      [],
      {
        loadConfig: defaultConfig,
        selectProfile: selectTestProfile,
        adapters: () => adapters,
      },
    )).resolves.toMatchObject({
      agentId: "claude-code",
      verifierAgentIds: ["codex-cli"],
      summary: {
        evaluator_agent_id: "codex-cli",
        independent: true,
      },
    });
  });

  it("fails closed when no independent Evaluator exists", async () => {
    const adapters = [
      fakeAdapter({
        id: "claude-code",
        kinds: ["code.write", "code.test"],
      }),
    ];

    const result = await resolveLoopProfileRouting(
      ["--profile", "mac-mini"],
      undefined,
      [],
      {
        loadConfig: defaultConfig,
        selectProfile: selectTestProfile,
        adapters: () => adapters,
      },
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe(
      "no independent Evaluator is available",
    );
  });
});

function profileAdapters(options: {
  kimiAvailable?: boolean;
  codexTestCapability?: boolean;
} = {}): AgentAdapter[] {
  return [
    fakeAdapter({
      id: "claude-code",
      kinds: ["code.write"],
      identity: runtimeIdentity(
        "claude-code",
        "anthropic",
        "claude-current",
      ),
    }),
    fakeAdapter({
      id: "kimi-code",
      kinds: ["code.review"],
      available: options.kimiAvailable ?? true,
      identity: runtimeIdentity(
        "kimi-code",
        "kimi",
        "kimi-code/k3",
      ),
    }),
    fakeAdapter({
      id: "codex-cli",
      kinds: options.codexTestCapability === true
        ? ["code.write", "code.test"]
        : ["code.write"],
      identity: runtimeIdentity(
        "codex-cli",
        "openai",
        "gpt-current",
      ),
    }),
  ];
}

function fakeAdapter(options: {
  id: string;
  kinds: CapabilityKind[];
  available?: boolean;
  identity?: AgentRuntimeIdentity;
}): AgentAdapter {
  const capabilities: Capability[] = options.kinds.map((kind) =>
    CapabilitySchema.parse({
      id: `${options.id}.${kind}`,
      kind,
      agent_id: options.id,
      description: `${options.id} ${kind}`,
      cost_tier: "mid",
    }),
  );
  return {
    id: options.id,
    display_name: options.id,
    cost_tier: "mid",
    capabilities: () => capabilities,
    isAvailable: async () => ({
      available: options.available ?? true,
      last_checked_at: 1,
    }),
    ...(options.identity !== undefined
      ? { runtimeIdentity: async () => options.identity! }
      : {}),
    async *invoke() {
      yield* [];
    },
  };
}

function runtimeIdentity(
  adapterId: string,
  providerId: string,
  modelId: string,
): AgentRuntimeIdentity {
  return {
    adapter_id: adapterId,
    adapter_version: "1.0.0",
    auth_mode: "test",
    provider_id: providerId,
    model_id: modelId,
    evidence_source: "reported",
  };
}
