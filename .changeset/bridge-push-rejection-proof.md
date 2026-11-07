---
"@osstack/cli": patch
---

Require explicit target-ref rejection before marking a stopped revision push failed. Transport and authentication failures with the old remote head remain uncertain so late server updates cannot lose their receipt.
