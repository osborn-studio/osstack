// Osstack role resolution: turn a RoleBinding (primary + fallback) plus the set
// of registered adapters into a concrete choice, probing isAvailable() so an
// agent that isn't installed on this machine is skipped in favour of the next.

import type {
  AgentAdapter,
  AgentRuntimeIdentity,
} from "@osstack/agents";
import type { RoutableAdapter } from "@osstack/core";
import { resolveRuntimeIdentity } from "./runtime-identity.js";
import {
  ALL_ROLES,
  ROLE_KINDS,
  type AgentRole,
  type AgentRuntimeIdentityOverride,
  type RoleBinding,
  type RoleMap,
} from "./types.js";

export interface RoleResolution {
  role: AgentRole;
  /** Chosen adapter id, or null if nothing usable is available. */
  chosen: string | null;
  reason: string;
  /** Every candidate we considered and why it was (not) picked. */
  tried: Array<{ id: string; ok: boolean; reason?: string }>;
  available: boolean;
}

function advertises(adapter: RoutableAdapter, role: AgentRole): boolean {
  const kinds = ROLE_KINDS[role];
  return adapter.capabilities().some((c) => kinds.includes(c.kind));
}

async function safeAvailable(
  adapter: RoutableAdapter,
): Promise<{ available: boolean; reason?: string }> {
  try {
    const a = await adapter.isAvailable();
    return a.reason !== undefined ? { available: a.available, reason: a.reason } : { available: a.available };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface ResolveOpts {
  /** If no configured agent is available, try any other adapter for the role. */
  autoFallback?: boolean;
  /** Adapter ids that cannot serve this resolution because another role owns them. */
  excludeAgentIds?: ReadonlySet<string>;
}

export async function resolveRole(
  role: AgentRole,
  binding: RoleBinding,
  adapters: ReadonlyArray<RoutableAdapter>,
  opts: ResolveOpts = {},
): Promise<RoleResolution> {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const tried: RoleResolution["tried"] = [];
  const order = [binding.primary, ...binding.fallback];

  for (const id of order) {
    if (opts.excludeAgentIds?.has(id) === true) {
      tried.push({
        id,
        ok: false,
        reason: "excluded by role-separation policy",
      });
      continue;
    }
    const adapter = byId.get(id);
    if (!adapter) {
      tried.push({ id, ok: false, reason: "not registered" });
      continue;
    }
    if (!advertises(adapter, role)) {
      tried.push({ id, ok: false, reason: `does not serve role "${role}"` });
      continue;
    }
    const av = await safeAvailable(adapter);
    if (av.available) {
      const isPrimary = id === binding.primary;
      return {
        role,
        chosen: id,
        reason: isPrimary
          ? `primary "${id}" available`
          : `fell back to "${id}" (primary "${binding.primary}" unavailable)`,
        tried,
        available: true,
      };
    }
    tried.push({ id, ok: false, reason: av.reason ?? "unavailable" });
  }

  if (opts.autoFallback) {
    for (const adapter of adapters) {
      if (order.includes(adapter.id)) continue;
      if (opts.excludeAgentIds?.has(adapter.id) === true) {
        tried.push({
          id: adapter.id,
          ok: false,
          reason: "excluded by role-separation policy",
        });
        continue;
      }
      if (!advertises(adapter, role)) continue;
      const av = await safeAvailable(adapter);
      if (av.available) {
        return {
          role,
          chosen: adapter.id,
          reason: `auto-fallback to "${adapter.id}" (no configured agent available)`,
          tried,
          available: true,
        };
      }
      tried.push({ id: adapter.id, ok: false, reason: av.reason ?? "unavailable" });
    }
  }

  return {
    role,
    chosen: null,
    reason: `no available agent for role "${role}" (tried ${order.join(", ") || "none"})`,
    tried,
    available: false,
  };
}

export async function resolveAll(
  roles: RoleMap,
  adapters: ReadonlyArray<RoutableAdapter>,
  opts: ResolveOpts = {},
): Promise<Record<AgentRole, RoleResolution>> {
  const out = {} as Record<AgentRole, RoleResolution>;
  for (const role of ALL_ROLES) {
    out[role] = await resolveRole(role, roles[role], adapters, opts);
  }
  return out;
}

export type RuntimeIndependenceLevel = "adapter" | "provider-or-model";

export interface ResolveDeliveryRolesOpts extends ResolveOpts {
  identityOverrides?: Readonly<
    Record<string, AgentRuntimeIdentityOverride>
  >;
  independenceLevel?: RuntimeIndependenceLevel;
}

export interface DeliveryRoleResolution {
  builder: RoleResolution;
  evaluator: RoleResolution;
  designer: RoleResolution;
  identities: {
    builder?: AgentRuntimeIdentity;
    evaluator?: AgentRuntimeIdentity;
    designer?: AgentRuntimeIdentity;
  };
  independent: boolean;
  independence_reason: string;
}

export function runtimeIdentitiesIndependent(
  builder: AgentRuntimeIdentity,
  evaluator: AgentRuntimeIdentity,
  level: RuntimeIndependenceLevel,
): { pass: boolean; reason: string } {
  if (builder.adapter_id === evaluator.adapter_id) {
    return {
      pass: false,
      reason: "builder and evaluator use the same adapter",
    };
  }
  if (level === "adapter") {
    return {
      pass: true,
      reason: "builder and evaluator use distinct adapters",
    };
  }
  if (
    builder.evidence_source !== "reported"
    || evaluator.evidence_source !== "reported"
  ) {
    return {
      pass: false,
      reason: "configured/inferred identity cannot prove provider independence",
    };
  }
  if (
    builder.provider_id === "unknown"
    || builder.model_id === "unknown"
    || evaluator.provider_id === "unknown"
    || evaluator.model_id === "unknown"
  ) {
    return {
      pass: false,
      reason: "reported identity has unknown provider or model",
    };
  }
  if (
    builder.provider_id !== evaluator.provider_id
    || builder.model_id !== evaluator.model_id
  ) {
    return {
      pass: true,
      reason: "reported provider or model differs",
    };
  }
  return {
    pass: false,
    reason: "builder and evaluator share provider and model",
  };
}

export async function resolveDeliveryRoles(
  roles: RoleMap,
  adapters: ReadonlyArray<AgentAdapter>,
  opts: ResolveDeliveryRolesOpts = {},
): Promise<DeliveryRoleResolution> {
  const builder = await resolveRole(
    "coding",
    roles.coding,
    adapters,
    opts,
  );
  const evaluatorExclusions = new Set(opts.excludeAgentIds);
  if (builder.chosen !== null) {
    evaluatorExclusions.add(builder.chosen);
  }
  const evaluator = await resolveRole(
    "test-verify",
    roles["test-verify"],
    adapters,
    {
      ...opts,
      excludeAgentIds: evaluatorExclusions,
    },
  );
  const designer = await resolveRole(
    "design",
    roles.design,
    adapters,
    opts,
  );
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const identities: DeliveryRoleResolution["identities"] = {};

  if (builder.chosen !== null) {
    const adapter = byId.get(builder.chosen);
    if (adapter !== undefined) {
      identities.builder = await resolveRuntimeIdentity(
        adapter,
        opts.identityOverrides?.[adapter.id],
      );
    }
  }
  if (evaluator.chosen !== null) {
    const adapter = byId.get(evaluator.chosen);
    if (adapter !== undefined) {
      identities.evaluator = await resolveRuntimeIdentity(
        adapter,
        opts.identityOverrides?.[adapter.id],
      );
    }
  }
  if (designer.chosen !== null) {
    const adapter = byId.get(designer.chosen);
    if (adapter !== undefined) {
      identities.designer = await resolveRuntimeIdentity(
        adapter,
        opts.identityOverrides?.[adapter.id],
      );
    }
  }

  const independence = identities.builder === undefined
    || identities.evaluator === undefined
    ? {
        pass: false,
        reason: "builder or evaluator unavailable",
      }
    : runtimeIdentitiesIndependent(
        identities.builder,
        identities.evaluator,
        opts.independenceLevel ?? "adapter",
      );

  return {
    builder,
    evaluator,
    designer,
    identities,
    independent: independence.pass,
    independence_reason: independence.reason,
  };
}
