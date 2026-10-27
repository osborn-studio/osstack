The behavior evaluator merged in #276 accepts unknown trust/policy fields and repeatedly reads or parses the same failing evidence. This follow-up rejects unknown fields, caches failed artifact reads and manifest parses, normalizes malformed context echoes, and retains bounded copy/hash accounting. Behavior V1 signing bytes remain unchanged.

This is the audit correction follow-up to #276. The original PR was merged at `5e86a778` before the audited correction commits reached that PR. Reviewed main is now `28d116f3` and includes #278 cleanup.

- Focused evaluator regressions: 55 passed on the correction candidate.
- Independent adversarial tests: 12 groups passed, including 120 random dependency graphs in both record orders and resource exhaustion.
- Earlier correction candidate on the previous main: full6,263 passed/5 skipped/0 failed and Sonnet5.5 PASS. These are historical, not a substitute for current-head validation.
- Current combined candidate: full validation and fresh Claude CLI Sonnet5.5 audit are in progress. Keep Draft until their evidence is bound and archived.

R05/V06 trust authentication, J02b source mapping and J12 recovery remain outside this patch. User gilberthello approves and merges.
