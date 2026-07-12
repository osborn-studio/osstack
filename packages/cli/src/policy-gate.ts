// Shared policy gate (R2.2 — kernel-level policy enforcement).
//
// One implementation of the loop's injectable `PolicyGate`, backed by core's
// `loadPolicyProfile`. It is the single enforcement point wired into BOTH the
// bin.ts direct-command gate (fast exit-2 UX before any daemon RPC) and every
// daemon-side `LoopEngine` construction (loop.run RPC + the session scheduler),
// so no execution path bypasses the observe-mode refusal.
//
// Decision semantics (matches POLICY_PROFILE_V1 fail-closed discipline):
//   absent policy.yaml   => allow (legacy repos, `loadPolicyProfile` => undefined)
//   mode: observe        => deny, reason carries the established `policy_denied:`
//                           wording so callers can print/persist it verbatim
//   mode: propose|execute => allow
//   invalid / unreadable => deny with the loader's error message (fail-closed)
//
// The returned gate is a closure that re-reads the policy file on EVERY consult
// (no caching), so a human flipping `mode: observe` on disk mid-session is
// honored on the very next tick.

import { loadPolicyProfile } from "@osstack/core";
import type { PolicyGate, PolicyGateDecision } from "@osstack/loop";

/** Established observe-mode refusal wording (R1.3). Kept byte-identical. */
export const OBSERVE_POLICY_DENIED_REASON =
  "policy_denied: policy mode is observe — execution refused; see .osstack/policy.yaml";

/**
 * Resolve a policy decision for `workspacePath` by loading `.osstack/policy.yaml`.
 * Pure/stateless — reads the file fresh on each call (never caches).
 */
export async function evaluatePolicyGate(workspacePath: string): Promise<PolicyGateDecision> {
  let profile: Awaited<ReturnType<typeof loadPolicyProfile>>;
  try {
    profile = await loadPolicyProfile(workspacePath);
  } catch (err) {
    // Fail-closed: a present-but-invalid/unreadable policy file denies.
    return { allow: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (profile?.mode === "observe") {
    return { allow: false, reason: OBSERVE_POLICY_DENIED_REASON };
  }
  return { allow: true };
}

/**
 * Build a {@link PolicyGate} bound to `workspacePath`. Injected into every
 * daemon-side `LoopEngine`; the loop consults it at run entry and per cycle
 * tick. The `ctx.workspacePath` the loop passes is authoritative when present
 * (it equals the bound path in practice), so a single gate correctly covers the
 * run it was created for.
 */
export function makePolicyGate(workspacePath: string): PolicyGate {
  return (ctx) => evaluatePolicyGate(ctx.workspacePath ?? workspacePath);
}
