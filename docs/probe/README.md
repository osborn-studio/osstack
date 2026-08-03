# Probe Dogfood Evidence

This directory contains portable evidence from real osstack Probe sessions.
The repository is intentionally operating Probe in report-only mode during
the initial dogfood period; `.osstack/probe.yaml` is the machine-readable
authority for that policy.

## Evidence rules

- `sessions/<session-id>/` is produced only by `osstack probe render`.
- Do not hand-edit `ledger.json`, `ledger.md`, or `render-manifest.json`.
- A local SQLite session is not portable evidence until it is rendered and
  the rendered ledger passes `osstack probe gate --ledger`.
- Open findings and report-mode violations are evidence, not failures to hide.
- Human answers, waivers, invalidations, and verified destination attestations
  must retain a human actor in the ledger.
- No report may claim the two-week baseline, five-spec E2E, restatement audit,
  or frozen outcome target before its checked-in evidence satisfies the exact
  checkpoint.

## Initial acceptance task

The first real dogfood session uses
`2026-08-02-production-acceptance-intent.md`. It tracks the gap between Probe
being published and Probe being accepted through sustained real use. Its
owner-approved obligation-to-evidence mapping is executable in
`2026-08-02-production-acceptance-test-plan.md`.

## Verification

For each rendered session:

```bash
osstack probe gate \
  --ledger docs/probe/sessions/<session-id>/ledger.json \
  --config .osstack/probe.yaml \
  --json
```

In report mode, readiness violations are reported but do not block unrelated
repository work. Invalid config or invalid portable evidence still fails
closed.
