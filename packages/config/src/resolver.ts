// Osstack role resolution: turn a RoleBinding (primary + fallback) plus the set
// of registered adapters into a concrete choice, probing isAvailable() so an
// agent that isn't installed on this machine is skipped in favour of the next.

import type { RoutableAdapter } from "@osstack/core";
import { ALL_ROLES, ROLE_KINDS, type AgentRole, type RoleBinding, type RoleMap } from "./types.js";

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
