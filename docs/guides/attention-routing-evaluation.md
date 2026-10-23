# Deterministic routing regression evaluation

Run the production routing functions against an explicit, reviewable fixture matrix:

```sh
osstack attention routing-eval --mode router_golden --input packages/supervisor/src/fixtures/routing-golden-v1.json --json
```

When running a development checkout, set an explicit isolated `OSSTACK_HOME` as required by the repository guard. This command does not start a daemon, open the state DB, load the user's agent configuration, or create installed provider adapters. Availability, capabilities, cost tiers and runtime identities are fixture facts. A guarded fixture adapter records and rejects any attempt to invoke a provider.

The [version 1 matrix](../../packages/supervisor/src/fixtures/routing-golden-v1.json) contains 22 cases with label rationales. Each case fixes exactly one entrypoint:

- `capability` calls the actual `routeCapability` with capability/kind, optional explicit agent, fixture adapter availability and cost tiers. It compares the adapter, capability and reason, or the exact override rejection code/no candidate outcome.
- `profile` calls the actual `resolveLoopProfileRouting` with a complete fixture role configuration, a fixed profile and optional explicit builder/evaluator or role preferences. It compares builder/evaluator selection, adapter independence, recorded overrides or the exact rejection message.

The profile bridge is supplied by the CLI because supervisor cannot depend on CLI. Calling the supervisor evaluator directly without that bridge leaves profile cases `incomplete`; it does not substitute a fake profile prediction.

## Report and exit status

The report contains `mode: router_golden`, `qualification: deterministic_regression_only`, the canonical input SHA-256 `dataset_hash`, dataset ID, total case denominator, evaluated/passed/failed/incomplete counts, fixture `invoke()` attempt count (`provider_invocation_scope: fixture_invoke_attempts`) and every case's expected value, actual value, differences or incomplete reason. Object keys are canonicalized for hashing; case/adapter ordering and labels are retained in the hash. The hash identifies input data, not a signed qualification certificate or router build version.

Exit 0 requires all cases to produce valid matching results with zero provider invocations. Mismatches exit 1 and remain in the denominator. Missing results, invalid expectations, duplicate IDs/adapters, empty/invalid datasets and unexpected execution errors produce `incomplete` and exit 1. Dataset validation happens before any routing. For invalid datasets, no cases are executed; `total` is the supplied cases-array length, `incomplete` equals that length, and `errors` explains the rejection. A missing/non-array cases field has total 0 and an explicit incomplete status. Unreadable or invalid JSON inputs also produce an incomplete report.

Input is limited to 1 MiB; the schema caps datasets at 256 cases, 32 adapters per case and 64 capabilities per adapter. Unknown fields are rejected, including supplied predictions. Capability IDs must be unique across adapters within each case. Role override IDs containing `=` are rejected because the existing `--role` argv parser cannot round-trip them. Each profile case must explicitly provide all three role bindings, an `explicit_evaluators` array and a `role_overrides` object. The fixture is the versioned, fully worked format reference.

## What the current routers actually guarantee

Explicit capability `agent_id`, profile `explicit_builder` and profile `explicit_evaluators` are tested for failure-closed behavior. An unavailable pinned adapter must not silently pass by selecting a substitute.

The existing `--role` preference can fall back to configured alternatives; it is not the same contract as a hard evaluator pin. The matrix records that behavior rather than changing production policy. The capability router also has a legacy first-available fallback when no kind matches. Generic capability routing therefore does not establish review-role safety. The profile resolver enforces distinct builder/evaluator adapters at its current `adapter` independence level; it does not prove different providers/models, even when identities are configured.

This matrix is a deterministic regression suite, not a holdout study, model-intent classifier, production availability test, permission check, or token/cost savings experiment. It does not change the default router. A passing report means these reviewed expectations match this invocation of the routing code; it does not mean every existing routing behavior is desirable or safe for every caller. Real provider comparisons remain a separate qualification stage.

## Legacy supplied-prediction aggregation

Existing usage remains compatible:

```sh
osstack attention routing-eval --input routing-results.json --json
osstack attention routing-eval --mode supplied_predictions --input routing-results.json --json
```

Both aggregate the caller's existing prediction/label/usage rows. Reports retain those metrics and add `mode: supplied_predictions`, `qualification: supplied_predictions_only` and `router_executed: false`. They do not run the router or verify the caller's claimed predictions or token usage. Choose `router_golden` explicitly for actual deterministic router execution; unknown modes fail instead of falling back.
