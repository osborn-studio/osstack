# Open the live bridge for the sandbox repository only

Date: 2026-11-25. Status: owner decision recorded; implementation in this PR.

## Decision

On 2026-11-25 the owner chose "Sandbox repo only". `OSSTACK_BRIDGE=1` stops failing with `BRIDGE_LIVE_NOT_IMPLEMENTED:acceptance_required:5-F:5-G`. A live start is allowed only when the bridge repository is `osborn-studio/osstack-bridge-sandbox` (`GITHUB_CI_SANDBOX` in `packages/cli/src/contained-mission-ci-policy.ts`). For any other repository, `serve` refuses to start with `BRIDGE_LIVE_SANDBOX_ONLY`. A later reviewed change removes this limit after the sandbox drill passes on current main.

## Why only the sandbox

- **5-F is current.** The evidence was refreshed on 2026-11-25 (#560, #562 and #567, which carries #561 and #565):
  - all 19 source mutants killed on current main
  - 10,000 property runs per invariant
  - F1 to F9 closed or rerun
  - the TLA model covers the local-failure writer and version 2 renewal; TLC found no counterexample, and the model mutants all fail
- **5-G is not current.** The sandbox end-to-end run passed 13/13 on 2026-11-08. The local-failure route was wired in on 2026-11-20 (`2026-11-20-local-failure-route-wiring.md`), so 5-G never exercised it.
- **The design already sets this limit.** Same-PR revision design §5.6 ("阶段 5 完成的门槛") says `OSSTACK_BRIDGE=1` must not be used outside the sandbox while any Phase 5 item is missing.
- **The drill is the missing 5-G.** It needs the live bridge, and it runs only against the sandbox (`docs/plans/2026-11-25-sandbox-drill-checklist.md`).

## Contract

1. `parseBridgeMode('1')` returns `'live'`. `0`, unset, `shadow` and invalid values behave as before.
2. `loadLiveBridgeConfiguration(home)` keeps all of its current checks in the same order:
   - all four files present and valid
   - `apps.json` and `producers.json` name the same repository
   - the publisher app matches

   Only then does it check the repository. If `bridge.repository.toLowerCase()` is not `GITHUB_CI_SANDBOX`, it throws `BRIDGE_LIVE_SANDBOX_ONLY:repository`. The repository name is not printed. It already appears in host-private config, and the error goes to the service log.
3. The check runs before any port is installed and before any network read. `createProductionLiveBridge` already calls `loadLiveBridgeConfiguration` first, so a refused start leaves nothing half built.
4. Nothing else changes:
   - `OSSTACK_LOCAL_FAILURE_REPAIR=1` still requires the live bridge.
   - Candidate approval is still host-only.
   - Grants are still signed on the host.
   - App E still does not merge local-failure PRs.
   - `OSSTACK_MERGER=1` still fails with `MERGER_LIVE_NOT_IMPLEMENTED`.

## Tests

- `parseBridgeMode('1')` returns `'live'`. The old "not implemented" assertions change: a service start with `OSSTACK_BRIDGE=1` and no live configuration now fails with `BRIDGE_CONFIG_INVALID:live:*`.
- A valid live configuration whose repository is not the sandbox fails with `BRIDGE_LIVE_SANDBOX_ONLY:repository` before any port is used.
- The same configuration with the sandbox repository, in any letter case, passes `loadLiveBridgeConfiguration`.
- The publisher-mismatch error still comes first when both problems are present.

## Not in scope

- Running anything live. The drill steps keep their own owner approvals.
- Letting a Bot merge local-failure PRs. The owner raised this on 2026-11-25. It goes against bridge runbook §6.1 and needs its own design.
