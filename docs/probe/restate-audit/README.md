# Probe Restatement Human-Audit Pack

Status: **machine candidate prepared; human verdict pending**.

This directory turns the open `probe restate` acceptance checkpoint into a
reviewable evidence workflow. It does not claim that the human audit has
passed. The source is the real Probe production-acceptance intent, and the
restatement was written independently to preserve its obligations without
copying sentence structure.

## Candidate 1

- Source: `docs/probe/2026-08-02-production-acceptance-intent.md`
- Restatement: `production-acceptance-restatement.md`
- Agent hypotheses: `production-acceptance-findings.json`
- Human verdict: `production-acceptance-human-audit.md`
- Registered session: `probe_64a1f1af-583d-45a6-a2bf-76d29f7029cc`
- Portable artifacts:
  `sessions/probe_64a1f1af-583d-45a6-a2bf-76d29f7029cc/`

The candidate deliberately records one narrow ambiguity: whether defining a
false blocking incident as Probe preventing unrelated work in report mode
preserves or narrows the source requirement. The finding is a question for a
human, not an assertion that either text is wrong.

The registered session uses portable repository identity
`gilosbornhello/osstack` and was rendered by `osstack 0.14.0` at revision 1.
Its portable gate succeeds in report mode while retaining one open medium
advisory and zero disposed questions. Gate eligibility here means “does not
block unrelated work”; it is not a human restatement verdict or a completed
audit.

An earlier local-only attempt, session
`probe_648777d9-3fcf-49f6-b648-783a980392d9`, inherited the worktree basename
as its repository identity because `--repo-id` was omitted. It was not
rendered or cited as evidence. The CLI correctly refused an agent attempt to
abandon it because abandonment requires a human actor; the record remains in
the dedicated dogfood database for an owner decision.

## Evidence rules

1. Run `osstack probe restate`; never add findings by editing a ledger.
2. Keep source and restatement SHA-256 values bound in the finding JSON.
3. A human reviewer must select the verdict and provide rationale in the audit
   file. An agent must not check those boxes or fill the human identity.
4. Treat `wording-only false positive` as a false-positive observation, not as
   a reason to rewrite history or delete the registered finding.
5. One candidate cannot establish the absence of a systematic pattern. More
   real spec/restatement pairs and an owner-approved sampling threshold remain
   required before closing the production-acceptance checkpoint.

## Reproduce

Run from the repository root with an explicit development/test home. A fresh
home creates a new session id; the idempotency key only deduplicates retries in
the same state database.

```bash
export OSSTACK_HOME=/absolute/path/to/probe-dogfood-home

osstack probe restate \
  --repo-id gilosbornhello/osstack \
  --spec docs/probe/2026-08-02-production-acceptance-intent.md \
  --restatement docs/probe/restate-audit/production-acceptance-restatement.md \
  --findings docs/probe/restate-audit/production-acceptance-findings.json \
  --actor-kind agent --actor-id probe-skill \
  --idempotency-key probe-restate-production-acceptance-portable-v1 \
  --format json
```

The resulting standalone session must be rendered and gated before its machine
output is cited as portable evidence.

The checked-in candidate was rendered and verified with:

```bash
osstack probe gate \
  --ledger docs/probe/restate-audit/sessions/probe_64a1f1af-583d-45a6-a2bf-76d29f7029cc/ledger.json \
  --config .osstack/probe.yaml \
  --format json
```
