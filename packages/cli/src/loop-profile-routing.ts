import {
  defaultAdapters,
  type AgentAdapter,
  type AgentRuntimeIdentity,
} from "@osstack/agents";
import {
  loadConfig,
  resolveDeliveryRoles,
  selectProfile,
  type AgentRole,
  type OsstackConfig,
  type ResolvedProfile,
} from "@osstack/config";

export interface LoopProfileSummary {
  profile_name: string;
  reason: string;
  builder_agent_id: string;
  evaluator_agent_id: string;
  designer_agent_id?: string;
  builder_identity: AgentRuntimeIdentity;
  evaluator_identity: AgentRuntimeIdentity;
  designer_identity?: AgentRuntimeIdentity;
  independent: boolean;
  independence_reason: string;
  overrides: Record<string, string>;
  resolutions: Record<string, {
    chosen: string | null;
    reason: string;
    tried: Array<{ id: string; ok: boolean; reason?: string }>;
  }>;
}

export interface LoopProfileRoutingResult {
  agentId: string;
  verifierAgentIds: string[];
  summary: LoopProfileSummary;
}

export interface LoopProfileRoutingDeps {
  loadConfig?: () => OsstackConfig;
  selectProfile?: (
    config: OsstackConfig,
    opts?: { override?: string | undefined },
  ) => ResolvedProfile;
  adapters?: () => AgentAdapter[];
}

export function shouldResolveExecutionProfile(input: {
  explicitProfile: boolean;
  roleOverrides: boolean;
  guardedAutonomy: boolean;
  autoAgent: boolean;
  executeCommand: boolean;
}): boolean {
  return input.explicitProfile
    || input.roleOverrides
    || input.guardedAutonomy
    || (input.autoAgent && !input.executeCommand);
}

export async function resolveLoopProfileRouting(
  args: string[],
  explicitAgentId: string | undefined,
  explicitVerifierAgentIds: readonly string[],
  deps: LoopProfileRoutingDeps = {},
): Promise<LoopProfileRoutingResult | undefined | Error> {
  const profileOverride = flagValue(args, "--profile")
    ?? process.env["OSSTACK_AGENT_PROFILE"]
    ?? process.env["OSSTACK_PROFILE"];
  const overrides = parseRoleOverrides(args);
  if (overrides instanceof Error) return overrides;
  const autonomy = flagValue(args, "--autonomy");
  const shouldResolve = shouldResolveExecutionProfile({
    explicitProfile: profileOverride !== undefined,
    roleOverrides: Object.keys(overrides).length > 0,
    guardedAutonomy: autonomy !== undefined && autonomy !== "legacy",
    autoAgent: args.includes("--auto-agent"),
    executeCommand: flagValue(args, "--execute") !== undefined,
  });
  if (!shouldResolve) {
    return undefined;
  }

  const requestedBuilder = explicitAgentId ?? overrides.coding;
  const requestedEvaluator = explicitVerifierAgentIds[0]
    ?? overrides["test-verify"];
  if (
    requestedBuilder !== undefined
    && requestedBuilder === requestedEvaluator
  ) {
    return new Error(
      "explicit Builder and Evaluator must use different adapters",
    );
  }

  const config = deps.loadConfig?.() ?? loadConfig();
  const profile = (deps.selectProfile ?? selectProfile)(
    config,
    profileOverride !== undefined ? { override: profileOverride } : {},
  );
  const roles = {
    coding: {
      ...profile.roles.coding,
      fallback: [...profile.roles.coding.fallback],
    },
    "test-verify": {
      ...profile.roles["test-verify"],
      fallback: [...profile.roles["test-verify"].fallback],
    },
    design: {
      ...profile.roles.design,
      fallback: [...profile.roles.design.fallback],
    },
  };
  for (
    const [role, agentId]
    of Object.entries(overrides) as Array<[AgentRole, string]>
  ) {
    roles[role] = {
      primary: agentId,
      fallback: roles[role].fallback.filter(
        (candidate) => candidate !== agentId,
      ),
    };
  }
  if (explicitAgentId !== undefined) {
    roles.coding = {
      primary: explicitAgentId,
      fallback: roles.coding.fallback.filter(
        (candidate) => candidate !== explicitAgentId,
      ),
    };
  }
  const explicitEvaluatorId = explicitVerifierAgentIds[0];
  if (explicitEvaluatorId !== undefined) {
    roles["test-verify"] = {
      primary: explicitEvaluatorId,
      fallback: roles["test-verify"].fallback.filter(
        (candidate) => candidate !== explicitEvaluatorId,
      ),
    };
  }

  const adapters = deps.adapters?.() ?? defaultAdapters();
  const resolution = await resolveDeliveryRoles(
    roles,
    adapters,
    {
      autoFallback: true,
      identityOverrides: config.agent_runtime,
      independenceLevel: "adapter",
    },
  );
  const builder = resolution.builder.chosen;
  const evaluator = resolution.evaluator.chosen;
  if (builder === null) {
    return new Error("no Builder is available");
  }
  if (evaluator === null) {
    return new Error("no independent Evaluator is available");
  }
  if (
    explicitAgentId !== undefined
    && builder !== explicitAgentId
  ) {
    return new Error(
      `explicit Builder "${explicitAgentId}" is unavailable`,
    );
  }
  if (
    explicitEvaluatorId !== undefined
    && evaluator !== explicitEvaluatorId
  ) {
    return new Error(
      `explicit Evaluator "${explicitEvaluatorId}" is unavailable or conflicts with the Builder`,
    );
  }
  if (!resolution.independent) {
    return new Error(
      `Builder/Evaluator separation failed: ${resolution.independence_reason}`,
    );
  }
  const builderIdentity = resolution.identities.builder;
  const evaluatorIdentity = resolution.identities.evaluator;
  if (
    builderIdentity === undefined
    || evaluatorIdentity === undefined
  ) {
    return new Error("Builder or Evaluator runtime identity is unavailable");
  }
  const summaryOverrides = {
    ...Object.fromEntries(Object.entries(overrides)),
    ...(explicitAgentId !== undefined
      ? { coding: explicitAgentId }
      : {}),
    ...(explicitEvaluatorId !== undefined
      ? { "test-verify": explicitEvaluatorId }
      : {}),
  };
  return {
    agentId: builder,
    verifierAgentIds: [evaluator],
    summary: {
      profile_name: profile.name,
      reason: profile.reason,
      builder_agent_id: builder,
      evaluator_agent_id: evaluator,
      ...(resolution.designer.chosen !== null
        ? { designer_agent_id: resolution.designer.chosen }
        : {}),
      builder_identity: builderIdentity,
      evaluator_identity: evaluatorIdentity,
      ...(resolution.identities.designer !== undefined
        ? { designer_identity: resolution.identities.designer }
        : {}),
      independent: resolution.independent,
      independence_reason: resolution.independence_reason,
      overrides: summaryOverrides,
      resolutions: Object.fromEntries(
        Object.entries({
          coding: resolution.builder,
          "test-verify": resolution.evaluator,
          design: resolution.designer,
        }).map(([role, roleResolution]) => [
          role,
          {
            chosen: roleResolution.chosen,
            reason: roleResolution.reason,
            tried: roleResolution.tried,
          },
        ]),
      ),
    },
  };
}

export function parseRoleOverrides(
  args: string[],
): Partial<Record<AgentRole, string>> | Error {
  const overrides: Partial<Record<AgentRole, string>> = {};
  for (const raw of flagValues(args, "--role")) {
    const [roleRaw, agentId] = raw.split("=", 2);
    if (
      roleRaw === undefined
      || agentId === undefined
      || agentId.trim() === ""
    ) {
      return new Error(`--role must use role=agent-id, got "${raw}"`);
    }
    const role = normalizeLoopRole(roleRaw);
    if (role === undefined) {
      return new Error(
        `unknown --role "${roleRaw}"; use coder, evaluator, or designer`,
      );
    }
    overrides[role] = agentId.trim();
  }
  return overrides;
}

export function normalizeLoopRole(
  value: string,
): AgentRole | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "coder"
    || normalized === "builder"
    || normalized === "coding"
  ) {
    return "coding";
  }
  if (
    normalized === "evaluator"
    || normalized === "judge"
    || normalized === "verifier"
    || normalized === "test-verify"
  ) {
    return "test-verify";
  }
  if (
    normalized === "designer"
    || normalized === "design"
  ) {
    return "design";
  }
  return undefined;
}

function flagValue(
  args: readonly string[],
  name: string,
): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length
    ? args[index + 1]
    : undefined;
}

function flagValues(
  args: readonly string[],
  name: string,
): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) {
      values.push(args[index + 1]!);
      index += 1;
    }
  }
  return values;
}
