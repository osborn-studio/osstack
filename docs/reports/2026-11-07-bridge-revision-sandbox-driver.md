# Phase 5-G sandbox driver

`scripts/smoke-bridge-revision-sandbox.mjs` defaults to preflight. It checks the ADR-006 sandbox name and numeric ID, real App A/B/test reviewer credentials and identities, active rulesets, Codex login and binary, a running Linux Docker daemon, a local immutable image, and the compiled production bridge factory. Preflight passed locally on 2026-11-07. No execution acceptance is claimed.

The guarded execution path uses `createProductionLiveBridge`, real contained Mission ports, the real Codex proxy and Docker verifier, and signed revision grants. It creates five root Missions for scenarios A, B, workflow T2, cancellation/recovery, and revoked write scope. It also probes host writer and App A force-push refusal, submits an unregistered review, and compares every remote commit and App B check to confirmed baseline/push intents. It fails on missing or duplicate checks, extra commits, truncated REST results, unexpected write acceptance, or any incomplete scenario.

Every control DB, authority file and runtime directory lives in a new 0700 directory below `/Volumes/AIMATE_WORK/tmp/osstack/smoke/`. Keys remain in their existing private App files; tokens remain in memory. The script closes only PRs that it recorded during the run. Protected Mission branches and a private JSON report remain for review. A failed run never claims qualification, and the normal daemon acceptance gate remains closed.

Build the integrated branch first, including the baseline receipt/invariant-6 implementation:

```sh
pnpm build
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/smoke-bridge-revision-sandbox.mjs --preflight --run revision-5g-20261107
```

The following command creates real sandbox PRs/reviews and spends real Codex execution. It requires the owner's final approval and has **not** been run:

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/smoke-bridge-revision-sandbox.mjs --execute --run revision-5g-20261107
```

Defaults use `/opt/homebrew/bin/codex`, `~/.codex` login, `~/.docker/run/docker.sock`, `~/.config/osstack-bridge/apps`, and the already-local `node:24-bookworm-slim` image (resolved to an immutable SHA before execution; no pull). Explicit absolute paths and an alternate local image can be supplied with the documented script flags. The execution model is `gpt-6.1-sol`.

Validation: `node --check scripts/smoke-bridge-revision-sandbox.mjs`; `node --test scripts/smoke-bridge-revision-sandbox.test.mjs` (four tests); CLI build and typecheck. The unit tests cover execution opt-in, run/path/repository restrictions, owned-effect egress and exact timeline assertions. They do not simulate or qualify the live scenarios.
