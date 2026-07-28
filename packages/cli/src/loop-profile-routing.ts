import { defaultAdapters } from "@osstack/agents";
import {
  loadConfig,
  resolveAll,
  selectProfile,
  type AgentRole,
} from "@osstack/config";
import type { RoutableAdapter } from "@osstack/core";

export interface LoopProfileSummary {
  profile_name: string;
  reason: string;
  builder_agent_id?: string;
  evaluator_agent_id?: string;
  designer_agent_id?: string;
  overrides: Record<string, string>;
  resolutions: Record<string, {
    chosen: string | null;
    reason: string;
    tried: Array<{ id: string; ok: boolean; reason?: string }>;
  }>;
}

export interface LoopProfileRoutingResult {
  agentId?: string;
  verifierAgentIds: string[];
  summary: LoopProfileSummary;
}

export async function resolveLoopProfileRouting(
  args: string[],
  explicitAgentId: string | undefined,
  explicitVerifierAgentIds: readonly string[],
): Promise<LoopProfileRoutingResult | undefined | Error> {
  const profileOverride = flagValue(args, "--profile")
    ?? process.env["OSSTACK_AGENT_PROFILE"]
    ?? process.env["OSSTACK_PROFILE"];
  const overrides = parseRoleOverrides(args);
  if (overrides instanceof Error) return overrides;
  if (
    profileOverride === undefined
    && Object.keys(overrides).length === 0
  ) {
    return undefined;
  }

  const config = loadConfig();
  const profile = selectProfile(
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

  const adapters = defaultAdapters() as unknown as RoutableAdapter[];
  const resolutions = await resolveAll(
    roles,
    adapters,
    { autoFallback: true },
  );
  const builder = explicitAgentId
    ?? resolutions.coding.chosen
    ?? undefined;
  const evaluator = explicitVerifierAgentIds[0]
    ?? resolutions["test-verify"].chosen
    ?? undefined;
  return {
    ...(builder !== undefined ? { agentId: builder } : {}),
    verifierAgentIds: evaluator !== undefined ? [evaluator] : [],
    summary: {
      profile_name: profile.name,
      reason: profile.reason,
      ...(builder !== undefined ? { builder_agent_id: builder } : {}),
      ...(evaluator !== undefined
        ? { evaluator_agent_id: evaluator }
        : {}),
      ...(resolutions.design.chosen !== null
        ? { designer_agent_id: resolutions.design.chosen }
        : {}),
      overrides: Object.fromEntries(Object.entries(overrides)),
      resolutions: Object.fromEntries(
        Object.entries(resolutions).map(([role, resolution]) => [
          role,
          {
            chosen: resolution.chosen,
            reason: resolution.reason,
            tried: resolution.tried,
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
