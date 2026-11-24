---
"@osstack/cli": patch
---

`osstack stats` now shows, for CI chains, the first-pass rate with both counts, the wait between consecutive recorded stages of closed chains (count, median, p95), and the current wait of open chains. Each line states what it counts and its `n`, and prints "no data" when there is none. The 7-day reverted-or-hot-fixed rate is reported as not measured: only its calculation exists, the read of later commits is not wired.
