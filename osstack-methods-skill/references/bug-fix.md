# Bug fix

Use when the user authorized a product correction. If the request is explanation only, use [investigation](investigation.md).

1. State the concrete trigger, expected observable result and actual result. Find the real entry point and existing verification driver. Record the candidate/build and environment before changing anything.
2. Attempt the original trigger on the matching surface in isolation. Preserve the failure and exact conditions. If it cannot be reproduced, narrow inputs, inspect timing or add scoped diagnostic instrumentation within authorization. Label hypotheses; do not present an unobserved failure as reproduced. If access or a safe driver is missing, report the blocker and the evidence collected so far.
3. List plausible mechanisms and one observation that would distinguish each. Prefer a discriminating experiment over broad speculative hardening. Rejected explanations stay in the record; revert speculative changes that no longer have a purpose.
4. Make the smallest correction supported by the mechanism. Use a cheap local regression test when it captures the bug; preserve the failing-before/passing-after result. An expensive or unavailable unit reproduction does not justify substituting an unrelated green test for the real trigger.
5. Repeat the original action sequence on the candidate using the same surface and controlled inputs. Recheck nearby affected behavior according to actual impact. Record any changed prerequisites; wrong-surface or inconclusive results remain explicitly limited.
6. Run cleanup for every attempt, including failures, and verify evidence survives. Review the diff and report the defect, mechanism, change, verification and unresolved limits. Commit or open a PR only within the task's existing publication scope.

Example: when an engineering decision is allegedly applied twice, inspect and reproduce the original action identity and reconcile path. The [engineering decision example](engineering-decision.md) checks a same-key replay and one deterministic adapter invocation. Passing it is evidence for that sequence only; it does not establish every race, crash or provider combination.
