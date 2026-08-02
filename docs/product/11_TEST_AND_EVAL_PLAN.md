# Test And Eval Plan

## Required Gates

- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm -r build`
- `pnpm -r test`
- `pnpm smoke:npm-install`

## Feature-Level Tests

- CLI tests for commands.
- Package tests for reusable contracts.
- Smoke tests for install, loop, daemon, and proof flows.
- Retrieval evals for official Knowledge Cloud packs.
- Offline Kimi review corpus: `pnpm eval:kimi-review`.
- Live Mac Mini Kimi corpus before Phase B:
  `node scripts/eval-kimi-review.mjs --live --json`.

## Evidence Quality Checks

- Proof pack checksum validation.
- Redaction tests for common secrets.
- Compliance pack self-validation.
- Run spec schema/vector parseability tests.

## Kimi Review Qualification

The Kimi seeded-defect gate has two distinct layers:

1. The offline deterministic oracle runs in CI. It validates corpus shape,
   independent score calculation, parser/fail-closed plumbing, and proves that
   a label unsupported by the oracle fails the gate. It is not semantic
   provider evidence.
2. The live layer invokes the authenticated Kimi provider on at least ten
   frozen diffs. It records false passes, false alarms, missing expected rule
   IDs, provider failures, adapter/provider/model identity, prompt and result
   digests, and explicit usage unavailability.

Phase B is blocked unless the committed live scorecard reports zero false
passes, zero missing expected rules, zero provider failures, and zero identity
mismatches. Reviewer mutation, forbidden/secret inputs, or a non-approved
structured verdict remain independent delivery blockers.
