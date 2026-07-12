---
"@osstack/loop": minor
"@osstack/cli": minor
---

R2.2 — kernel-level policy gate. Closes the R1.3 debt where observe-mode
enforcement was CLI-layer only: direct daemon RPC clients and the daemon's own
scheduler bypassed it.

- `@osstack/loop`: `LoopEngineOptions` gains an optional injectable
  `policyGate?: (ctx: { workspacePath }) => Promise<PolicyGateDecision>` (new
  loop-local `PolicyGateDecision`/`PolicyGate`/`LoopPolicyStatus` types — no
  `@osstack/core` import, ADR-001). The engine consults it once at
  `runOnce()`/`runCycles()` entry (refuse before ANY discovery/execution) and
  once per scheduled cycle tick inside `runCycles` (a mid-flight flip stops the
  loop cleanly with a `policy_denied` outcome — like a budget stop, never an
  exception). A denial surfaces `result.policy = { denied: true, reason }` and a
  `policy_denied` `loop.stopped` event. No gate injected ⇒ byte-identical prior
  behavior. A gate that throws is fail-closed (counts as deny with the error
  message), same discipline as the `assetize` self-improvement hook.
- `@osstack/cli`: new shared `makePolicyGate(workspacePath)` (`policy-gate.ts`)
  backed by core's `loadPolicyProfile` — absent file ⇒ allow, `mode: observe` ⇒
  deny with the established wording, invalid file ⇒ deny with the loader error
  (fail-closed). The R1.3 `enforceObservePolicyGate` in bin.ts now delegates to
  it (exit codes 2/1 and stderr unchanged). The gate is injected into every
  daemon `LoopEngine` via `withLoopAdapters` (the `loop.run` RPC — which now
  returns a `policy_denied` error under observe — and the persisted session
  scheduler — whose next tick stops with a persisted `policy_denied`
  stop_reason), and into the direct-CLI `deliver` / `loop run` engines for
  defense-in-depth. The gate re-reads policy on every consult (no caching), so a
  mid-session flip of `.osstack/policy.yaml` is honored on the next tick.

The only intentionally ungated daemon path remains the read-only `daily`
composition (observe mode permits observation); that lands in R2.3.
