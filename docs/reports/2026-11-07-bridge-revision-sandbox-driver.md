# Phase 5-G sandbox driver

> Historical source-scoped report. For current acceptance, see [v2 status](bridge-phase5-verification/current-v2-status.md) and the [fourth-run evidence](bridge-phase5-verification/fourth-run-v2.md): fourth sandbox v2 `LIVE_5G_ONLY` PASSED 13/13; attempts 1–3 remain failed/unqualified. Old pending, checkout-selection and cold-helper findings below retain their original scope. The fourth cold scenario still cancels before first executor tick, not during an in-flight executor. Production remains CLOSED; no fifth run is authorized.

`scripts/smoke-bridge-revision-sandbox.mjs` defaults to preflight. It checks the ADR-006 sandbox name and numeric ID, real App A/B/test reviewer credentials and identities, active rulesets, Codex login and binary, a running Linux Docker daemon, a local immutable image, and the compiled production bridge factory. Preflight passed locally on 2026-11-07. No execution acceptance is claimed.

The guarded execution path uses `createProductionLiveBridge`, real contained Mission ports, the real Codex proxy and Docker verifier, and signed revision grants. It creates five root Missions for scenarios A, B, workflow T2, cancellation/recovery, and revoked write scope. It also probes host writer and App A force-push refusal, submits an unregistered review, and compares every remote commit and App B check to confirmed baseline/push intents. It fails on missing or duplicate checks, extra commits, truncated REST results, unexpected write acceptance, or any incomplete scenario.

Every control DB, authority file and runtime directory lives in a new 0700 directory below `/Volumes/AIMATE_WORK/tmp/osstack/smoke/`. Keys remain in their existing private App files; tokens remain in memory. The script closes only PRs that it recorded during the run. Protected Mission branches and a private JSON report remain for review. A failed run never claims qualification, and the normal daemon acceptance gate remains closed.

Build the integrated branch first, including the baseline receipt/invariant-6 implementation:

```sh
pnpm build
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/smoke-bridge-revision-sandbox.mjs --preflight --run revision-5g-20261107
```

The following historical checkout command creates real sandbox PRs/reviews and spends real Codex execution. It had not run at this report's original snapshot. It is not a current execution instruction; the four paid attempts are now used:

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/smoke-bridge-revision-sandbox.mjs --execute --run revision-5g-20261107
```

Defaults use `/opt/homebrew/bin/codex`, `~/.codex` login, `~/.docker/run/docker.sock`, `~/.config/osstack-bridge/apps`, and the already-local `node:24-bookworm-slim` image (resolved to an immutable SHA before execution; no pull). Explicit absolute paths and an alternate local image can be supplied with the documented script flags. The execution model is `gpt-6.1-sol`.

Validation: `node --check scripts/smoke-bridge-revision-sandbox.mjs`; `node --test scripts/smoke-bridge-revision-sandbox.test.mjs` (four tests); CLI build and typecheck. The unit tests cover execution opt-in, run/path/repository restrictions, owned-effect egress and exact timeline assertions. They do not simulate or qualify the live scenarios.


## Installed runtime selection and follow-up guard hardening

The driver accepts `--runtime-prefix /absolute/inactive-prefix` and `--expected-source-commit <full-lowercase-SHA>`. Selection uses `scripts/lib/bridge-installed-runtime.mjs`: it validates the canonical prefix, manifest source commit and three entry files before importing the runtime, core and App module. Preflight does not construct a DB or Mission host. Installed-mode import failures never fall back to checkout. Execution uses the selected core module, and reports the selected entry hashes and provenance; checkout mode leaves the runtime source commit unknown rather than attesting a build from the driver's HEAD. Entry hashes do not attest every transitive dependency or the whole installation supply chain.

The request helper disables redirects. A force-push refusal qualifies only with a valid SHA probe and canonical GitHub repository-rule evidence; generic validation/auth/transport failures do not qualify. A host push requires both a rejection for the exact ref and a GH013 diagnostic for that ref. The final PR and branch refs are read before and after timeline checks and must match the ledger tip. Resource cleanups are registered before setup, all attempted in reverse ownership order, and never replace the primary failure; DB close precedes final report persistence.

Permanent offline helper tests exercise cleanup failures, current-head mismatches, redirect handling, refusal classifiers and installed selection without source extraction or `vm` evaluation. `scripts/smoke-bridge-revision-sandbox.helpers.test.mjs` has 17 passing cases; together with the guard and installed-selection suites, 102 cases pass. These are local contracts, not real 5-G acceptance.

The report still declares three required acceptance gaps: normal App A push actor attribution from remote evidence, cancellation across a real process/new-owner restart after release, and write-scope revocation at the publication release fence. Current early-cancel/early-revoke scenarios are named to reflect their narrower scope. Until those gaps are independently closed, actual execution cannot set `qualified:true`. The source-extraction adversarial suite is retained only as historical evidence, not as a final maintained test interface.
