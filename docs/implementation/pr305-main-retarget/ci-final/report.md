# PR305 final CI read-only verification

Run **40912894527**, attempt1, completed **success**: five jobs success and the paid DeepSeek job skipped. Head `b0ea4e7836dd4be640b4f7c140befba73977837d`, base `main` at `5248195bd2611cc21a98a0ef3e39d229cdf9b681`.

CI actually checked out synthetic merge **84046a712d524800d0f4e764523a9a6df049255f**, not bare head. Checkout log lines3697/3700 identify both parents.

- Exact `check / Test`: **22 unique packages, 7142 passed / 7 skipped / 0 failed**. Matrix and standalone tests excluded from this total.
- Exporter: **94 total =93 passed +1 skipped**; global Codex home absent (line8434). Projection **88**, journey **43**, reader **14** each passed without skips.
- Fresh default journey: healthy/missing-ref product exits **0/1**, drivers **0/0**. Full journey: healthy/missing-ref/drift/mixed/empty product exits **0/1/2/1/0**, all driver exits0. Both receipts passed and report fixture removal; descendants remain **not_attested**.
- Default projection/check succeeded with matching logged packet SHA `740d2231b0456141ed1655e218129d4066acceb195e9eaf13306f81fd2405b1e` (lines10710/10712).
- Explicit full projection/check succeeded with matching logged packet SHA `7a0af0dd55b43ca5a8d43a768f181bba4f157f8c64143ffe1e4b3855204c005a` (lines10748/10750). Check states original_evidence_revalidated=false; no artifact was downloaded or independently rehashed.

Command success is supported by successful bash-e steps and emitted result records, not separate numeric shell-exit footer. This review only reads CI records; it does not rerun product tests, make model calls, grant runtime qualification, attest complete descendant cleanup, or change PR readiness.

Full run/jobs JSON and original `gh run view --log` output are retained. `complete-log.log.gz` decompresses byte-for-byte to `complete-log.stdout` (2,132,038 bytes; SHA256 `62482e0b7d89fbef58f149ff82f696c2930d44675f10f701a0ba57a7422b1810`). ANSI stripping occurred only in parser memory. No parser failure occurred. Polls0–19 span approximately20minutes; no rerun/cancel was requested.
