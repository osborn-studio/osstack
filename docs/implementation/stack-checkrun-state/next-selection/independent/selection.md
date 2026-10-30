# Independent next-slice assessment

Recommend a bounded, read-only current-stack observation/report loop first. Reuse inspectPrCandidate for explicit repo/PR identities, retain each head/base/time binding, and compare current observations with explicitly historical input. Preserve partial/unknown states and human merge authority. This closes a useful user loop without silently rewriting existing cards.

Existing-card ci_state staleness is an explicit create-only ingest limitation, documented in source/tests/design. It is not sufficient evidence of a regression. A later opt-in metadata refresh is the second candidate, contingent on repository identity, revision and manual-check preservation contracts.

Unknown CI produces no detectDrift issue, but current source search finds no non-test caller using it as readiness authority. This is a static completeness limitation; do not turn it into a confirmed merge-safety bug or silently change policy. The existing candidate snapshot already reports unknown separately and forbids merge authorization.

Both candidates are proposals only. No implementation, DB, model, full test, forge observation or central mutation was performed. Sources, exact commits, proposed acceptance and limits are in selection.json.
