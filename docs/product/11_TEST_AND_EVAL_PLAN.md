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

## Evidence Quality Checks

- Proof pack checksum validation.
- Redaction tests for common secrets.
- Compliance pack self-validation.
- Run spec schema/vector parseability tests.

