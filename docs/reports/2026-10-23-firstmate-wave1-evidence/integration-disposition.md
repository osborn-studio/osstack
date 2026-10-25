# Integrated challenge disposition

Three static challenges were run against frozen inputs, with raw responses retained. Final round confirms no concrete P0/P1 in the corrected delivery startup/recovery and per-scope isolation paths. Prior components each had their own final static review.

1. Confirmed: sender success followed by failed receipt persistence could strand `sending` until restart. Service now retains a recovery-needed flag and reconciles before its next serial local batch. SQL-trigger fault injection proves recovery; failed recovery retains the flag. An actual hung sender is aborted and joined before DB close; late settlement does not touch SQLite.
2. Conditional reader-field injection was not reachable through the production reader: `readAttentionLoop` parses LoopState and returns a whitelist. A file-injection regression confirms raw reason/owner_released/admitted/state_path cannot enter facts. Trusted test reader injection is not an RPC configuration.
3. Conditional cursor and canonical path concerns are resolved by `registerScope` using realpath and SHA-256 IDs. Existing dashboard unit/HTTP tests cover scoped pagination and validation.
4. Conditional synchronous drain throws cannot escape the production async method, and enqueue does not parse decisions. Nonetheless startup now normalizes through a promise and scope enqueue failures are isolated, with a regression for unaffected delivery.
5. Intentional limits: 30s fallback recovery, retained physical-reader capacity, local idempotent duplicate-send tolerance, explicit release remaining degraded, historical delivery not proof of current item state. Repeated receipt-write failure can consume the five-attempt budget and produce an interrupted-delivery dead letter; it does not prove the artifact was never written.
6. Full-suite CLI regressions exposed stale section assertions and a real short-terminal layout problem: adding Attention pushed action rows below the clipped frame. Layout now reserves actions/keys/footer and has a 20-row regression, while section expectations include Attention. This final UI adjustment is tested separately from the static delivery challenge.

Scope of model evidence: static review only; no model response is treated as having run tests. Unsupported hypotheses remain visible in raw output and are not counted as confirmed blockers.
