---
"@osstack/core": patch
---

Stop attention delivery batches when their budget timer expires, even if the monotonic clock has not reached the nominal deadline. Keep the shorter per-send timeout distinct so longer batches can continue within their remaining budget.
