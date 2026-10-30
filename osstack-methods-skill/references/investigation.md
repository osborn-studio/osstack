# Investigation

Investigation is read-only with respect to product code and live application state. Produce an answer, not an implicit implementation or PR. If an experiment needs state changes or credentials beyond the request, first identify that dependency; continue the independent source analysis without pretending the experiment ran.

1. Restate the question as a small set of testable claims. Identify original sources: current source code and history, actual CLI/RPC entry points, documented contracts, raw logs or reports tied to their candidate.
2. Trace the user-visible path through boundaries. Cite files and symbols at a known revision. Distinguish what the source promises, what the tests exercise and what an actual observation shows.
3. Consider at least the plausible competing explanation that would change the conclusion. Seek the observation that could disprove the favored answer. Use read-only inspection or already-authorized isolated observations; do not mutate production to answer a question.
4. Write findings as facts, inferences and unknowns. Each material conclusion has a source or an explicit inference chain. Missing evidence is a gap, not proof that behavior is absent.
5. Return the answer, relevant tradeoffs, confidence limits and a bounded next step if needed. If fixing is appropriate, describe the scope for the separate implementation task; do not quietly switch to bug-fix mode.

Example: “Does a completed engineering mission prove code was delivered?” Trace its observation proof and completion level. The deterministic smoke asserts `observed_turn`; that does not attest task `local_verified`, a real provider, or a published change. Quote the actual observed level instead of upgrading its meaning.

## Explain the path and its history

For a behavior question, explain the entry point, key types, data flow, ownership boundaries and non-obvious failure paths. Include a compact file/symbol map. Use only the sections that help answer the question; a narrow question does not need a full architecture report.

For a motivation question, distinguish an author's recorded explanation from today's plausible rationale. Anchor the claim in source history and any relevant, authorized issue or discussion record. Mark direct statements, supported inference, speculation and unknowns separately. Show contradictory sources rather than selecting the tidiest story. Name unavailable or unread sources; do not claim all external systems were searched. Do not configure connectors, search unrelated personal history or launch a model panel just to fill a source category.

On an existing card, return a cited explanation and a bounded next step under that card's task ID. If the user requested investigation only, stop before product changes. If the task already authorizes investigation followed by repair, continue with [bug fix](bug-fix.md) without asking for the same permission again. This is shared guidance derived from selected pstack 0.15.36 sources; it adds no investigator service or automatic card transition.
