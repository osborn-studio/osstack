---
"@osstack/core": minor
---

Add a bounded behavior registry evaluator for caller-supplied build pins, clock, policy and trust context. It checks source membership, qualification signatures, evidence and dependencies relative to those inputs. It does not authenticate the trust context, verify the operations-root signature, persist a revocation epoch or grant execution authority. It is not wired into daemon routing.
