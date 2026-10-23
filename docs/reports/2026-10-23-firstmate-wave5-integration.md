# Firstmate wave 5: Graph delivery, remote observation and recovery

This slice is stacked on #241. It provides executable host wiring, not a claim that all 24 capability families are complete or deployed.

## Implemented

- G1/G2: frozen V2 contracts in the registered Graph host, for implement/local_verified/artifact_only with exactly one registered check. Explicit host policy and Graph budgets are read from private `graph-policy.json`; policy authority and pinned execution context are rechecked before durable transitions. Actual writer/reviewer prompts and two-phase content-addressed receipts are linked to effect identities. A completion file alone is not completion: `graph contract` only returns a receipt associated with the ready durable projection.
- The CLI checks both the original request digest and durable host input digest when a contract transforms the input envelope. Legacy acknowledgements keep their original exact digest check. This additive delegation projection does not change the worker v3 message protocol or v4 compiler identity. Old strict consumers need the updated client for this optional field.
- R1: actual `remote-export --stdio` runs before any CLI UI/deployment defaults, and `remote-home inspect` uses fixed SSH commands and explicit host, home, identity and registry pins. It exposes existing daemon identity and bounded worker snapshots only. It does not create/migrate a remote DB, execute arbitrary commands, retry unknown delivery or fall back to local state.
- Reliability: the real supervision scan yields between bounded observer steps; stop prevents later steps. `attention recovery` reads scoped receipt/cursor gaps and always reports `canAutoRetry:false` with unknown process liveness. It neither retries a worker nor treats a missing receipt as proof of termination.

## Evidence and limits

The [component evidence](2026-10-23-firstmate-wave5-evidence/) includes raw Haiku inputs/results, red/green regressions and manifests. CLI model metadata is not proof of provider weights. Audits are static, separate from tests.

Root wiring tests cover actual daemon policy loading, admission-disabled rejection without an adapter call, actual pinned-context invocation and receipt bytes, CLI dual digest rejection, scoped contract reads, remote compiled main entrypoint and recovery RPC/CLI. A real socket sample with one session and one run measured 100 recovery requests: p95 0.286 ms, max 0.830 ms. This is a small fixture, not a capacity or multi-backend soak.

The larger 100-run/12,000-event component benchmark converged in 501 passes; step p95 was 5.205 ms and max 18.338 ms against a soft 5 ms goal. The goal is therefore not fully met. Each admitted source gets bounded work; the 100-subject admission cap has no automatic overflow rotation. Ten-minute mixed Loop/session/Graph soak, Loop overhead below 1%, platform crash matrix, a real SSH target and provider-side live model qualification remain pending.

Full integrated qualification and independent root audit are in progress. No merge, deployment, public message, native multi-home upgrade or production SSH qualification is claimed by this report.
