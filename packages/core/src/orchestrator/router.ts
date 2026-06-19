// Capability router (S2 basic version).
//
// Given a task's requested capability_id (or capability kind) and a set of
// available adapters, pick which adapter should run it. S3 will replace
// this with the data-driven policy engine; for now we keep it transparent
// and rule-based so users can reason about routing.
//
// Selection rules (in order, first match wins):
//   1. Exact capability_id match if the requested adapter is available.
//   2. Same kind, lowest cost_tier (low > mid > high preference).
//   3. Same kind, any available adapter.
//   4. None — return null and let the caller decide.

// @osstack/agents depends on @osstack/core for the Capability schema, so to
// avoid a cycle we re-declare the minimum routable-adapter surface here
// (just the fields the router actually reads).
import type { Capability, CapabilityKind, CostTier } from "../capability.js";

export interface RouterAvailability {
  available: boolean;
  reason?: string;
}

export interface RoutableAdapter {
  readonly id: string;
  readonly cost_tier: CostTier;
  capabilities(): readonly Capability[];
  isAvailable(): Promise<RouterAvailability>;
}

export interface RoutingRequest {
  capability_id?: string;
  kind?: CapabilityKind;
  /** Optional override: force this agent if it can serve the requested kind. */
  agent_id?: string;
}

export interface RoutingDecision {
  adapter: RoutableAdapter;
  capability: Capability;
  reason: string;
}

const TIER_ORDER: Record<CostTier, number> = { low: 0, mid: 1, high: 2 };

export async function routeCapability(
  request: RoutingRequest,
  adapters: ReadonlyArray<RoutableAdapter>,
): Promise<RoutingDecision | null> {
  if (adapters.length === 0) return null;

  // 1. Exact agent + capability override.
  if (request.agent_id) {
    const adapter = adapters.find((a) => a.id === request.agent_id);
    if (adapter && await isAvailable(adapter)) {
      const cap = pickCapability(adapter, request);
      if (cap) return { adapter, capability: cap, reason: "agent_id override" };
    }
  }

  // 2. Exact capability_id match.
  if (request.capability_id) {
    for (const adapter of adapters) {
      const cap = adapter.capabilities().find((c) => c.id === request.capability_id);
      if (cap && await isAvailable(adapter)) {
        return { adapter, capability: cap, reason: "exact capability_id match" };
      }
    }
  }

  // 3. Kind-based: prefer lowest cost tier.
  const kind = request.kind ?? capabilityKindFromId(request.capability_id);
  if (kind) {
    const candidates: Array<{ adapter: RoutableAdapter; cap: Capability }> = [];
    for (const adapter of adapters) {
      const cap = adapter.capabilities().find((c) => c.kind === kind);
      if (cap && await isAvailable(adapter)) candidates.push({ adapter, cap });
    }
    candidates.sort((a, b) => TIER_ORDER[a.adapter.cost_tier] - TIER_ORDER[b.adapter.cost_tier]);
    if (candidates.length > 0) {
      const winner = candidates[0]!;
      return {
        adapter: winner.adapter,
        capability: winner.cap,
        reason: `kind=${kind} lowest-cost (${winner.adapter.cost_tier})`,
      };
    }
  }

  // 4. Fall back to the first available adapter's first capability.
  for (const adapter of adapters) {
    if (await isAvailable(adapter)) {
      const cap = adapter.capabilities()[0];
      if (cap) return { adapter, capability: cap, reason: "fallback first-available" };
    }
  }

  return null;
}

async function isAvailable(adapter: RoutableAdapter): Promise<boolean> {
  try {
    const a = await adapter.isAvailable();
    return a.available;
  } catch {
    return false;
  }
}

function pickCapability(adapter: RoutableAdapter, request: RoutingRequest): Capability | undefined {
  if (request.capability_id) {
    const exact = adapter.capabilities().find((c) => c.id === request.capability_id);
    if (exact) return exact;
  }
  if (request.kind) {
    return adapter.capabilities().find((c) => c.kind === request.kind);
  }
  return adapter.capabilities()[0];
}

// Known CapabilityKind values, hand-mirrored from capability.ts. Kept here
// (rather than re-extracted from the Zod enum) so this module stays a leaf
// import — no circular dance with the Zod schema. If you add a kind there,
// add it here too. The router test exercises the round-trip.
const KIND_SET = new Set<string>([
  // Software lifecycle
  "code.write", "code.review", "review.code", "code.refactor", "code.test", "code.debug",
  "design.prd", "design.architecture", "design.review",
  "doc.write", "doc.summarize",
  "plan.decompose", "plan.estimate",
  "research.web", "research.code",
  "release.check", "release.verify",
  "ops.deploy", "ops.rollback",
  // Professional services (PartnerOS)
  "intent.draft", "intent.clarify", "intent.assign",
  "client.followup", "client.summarize",
  "matter.summarize", "matter.checklist",
  "risk.check", "verify.acceptance", "verify.alignment",
  "artifact.create", "artifact.revise", "approval.request",
  "memory.write", "memory.read",
  // Autonomous ML research (karpathy/autoresearch)
  "research.ml", "research.experiment",
]);

function capabilityKindFromId(id: string | undefined): CapabilityKind | undefined {
  if (!id) return undefined;
  // 1. If the whole id is a known kind ("code.write"), use it directly.
  if (KIND_SET.has(id)) return id as CapabilityKind;
  // 2. If it looks like "<agent_id>.<kind>" and the suffix is a known kind,
  //    extract that. Greedy: try the longest dotted suffix first so we don't
  //    confuse "ops.deploy" with "code.deploy".
  const parts = id.split(".");
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join(".");
    if (KIND_SET.has(candidate)) return candidate as CapabilityKind;
  }
  return undefined;
}
