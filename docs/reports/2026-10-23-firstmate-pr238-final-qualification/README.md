# PR #238 final local qualification

Qualified source: `6703ceb7bf2dda3c0f229bcd0504ff88a147c041` on `codex/firstmate-next-wave`, based on PR #237 `2d33db37cebb2e37036625c555c602c6e305cffe`.

The native Loop task `firstmate-wave1-qualification-retry` completed with `success`, zero verification issues. The earlier `firstmate-wave1-qualification` remains `escalated`; its failed CLI assertions and the subsequent footer layout repair are preserved in the preceding wave evidence. No historical failure was rewritten.

All eight final stages exited zero: build, generated inventory, typecheck, full workspace tests, lint, protocol schema freshness, inventory freshness, startup budget. The final test log contains 22 package summaries: **4727 passed, 3 skipped**. Local execution used Node 22, workspace concurrency 1, two test workers and a 20-second test timeout; this does not change application timeouts or CI commands. The recorded root lint command ran Biome; existing warnings are retained in its log.

GitHub exact-head CI run: https://github.com/osborn-studio/osstack/actions/runs/40007668124. Its final status is **completed/success**; `ci-final.json` records the exact head and job results. This archive is in the next dependent PR so recording results does not replace the already-tested head.

`outbox-audit-stderr.txt` preserves the previously omitted first outbox review warning: requested `claude-haiku-5-5` and the returned modelUsage agree, while CLI emitted an unrecognized-model warning. Static review is not independent model-weight certification or test execution.
