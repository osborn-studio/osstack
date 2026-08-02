# Kimi Autonomy Current-State Index

- Status date: 2026-08-02
- Repository baseline: `main` at `77865d13ab3f9084ed4c909e97fb33fb9c5d691c`
- Published CLI baseline: `@osstack/cli@0.14.0`

This index is the authority map for the Kimi autonomy documents dated
2026-07-27. Those documents preserve design history and implementation intent;
they do not override current source, current operator runbooks, or later
evidence. A historical prompt or plan never grants machine, production, merge,
or publication authority.

## Current authority order

1. Current source and schemas on `main`.
2. Current operator runbooks:
   - [`../runbooks/kimi-profile-routing.md`](../runbooks/kimi-profile-routing.md)
   - [`../runbooks/guarded-git-autonomy.md`](../runbooks/guarded-git-autonomy.md)
   - [`../runbooks/kimi-mac-mini-autonomy.md`](../runbooks/kimi-mac-mini-autonomy.md)
   - [`../operations/kimi-mac-mini-baseline.md`](../operations/kimi-mac-mini-baseline.md)
3. Current checked-in validation and promotion evidence.
4. The 2026-07-27 plans, audits, design, and handoff prompt listed below.

When a historical document conflicts with a current source contract or
runbook, the current source contract or runbook wins.

## Delivery status

| Phase | Status | Landed evidence | Current operational authority |
|---|---|---|---|
| A — Kimi adapter and verifier | Implemented | [PR #155](https://github.com/gilosbornhello/osstack/pull/155), `16ec9145` | `packages/agents`, `packages/governance`, `packages/loop`; Phase A scorecard |
| B — profile and delivery routing | Implemented | [PR #157](https://github.com/gilosbornhello/osstack/pull/157), `c7460192` | `docs/runbooks/kimi-profile-routing.md` |
| C — guarded Git autonomy | Implemented | [PR #158](https://github.com/gilosbornhello/osstack/pull/158), `b99bbfb1` | `docs/runbooks/guarded-git-autonomy.md` |
| D — guarded deploy and Mac Mini operations | Implemented in source; real-soak gate remains | [PR #159](https://github.com/gilosbornhello/osstack/pull/159), `4fb11c0b` | `docs/runbooks/kimi-mac-mini-autonomy.md` and the Phase D promotion report |
| E — productization qualification | Active, blocked | Seven-day real Mac Mini soak evidence is not checked in as passing | Phase D promotion report and `scripts/soak-kimi-autonomy.mjs --status --require-productization` |

The later release work in PRs #156 and #164–#167 published osstack packages,
but publication by itself does not satisfy the separate Phase E seven-day,
30-real-task productization gate.

## Document classification

| Document | Status | Use now |
|---|---|---|
| `reports/kimi-autonomy/final-audit-verdict.md` | Historical | Planning audit result only; it predates implementation PRs. |
| `runbooks/2026-07-27-kimi-autonomy-validation-deployment-release.md` | Superseded | Acceptance history; use the current runbooks listed above. |
| `audits/2026-07-27-kimi-autonomy-audit-appendix-full-reports.md` | Historical | Pinned-baseline audit evidence. |
| `audits/2026-07-27-kimi-autonomy-audit-closure-ledger.md` | Historical | Planning-defect closure evidence, not implementation status. |
| `audits/2026-07-27-kimi-autonomy-plan-audit-by-fable5.md` | Historical | Audit amendments retained for traceability. |
| `plans/2026-07-27-kimi-adapter-verifier-implementation.md` | Implemented | Historical Phase A implementation plan; code landed in PR #155. |
| `plans/2026-07-27-kimi-profile-deliver-routing-implementation.md` | Implemented | Historical Phase B implementation plan; code landed in PR #157. |
| `plans/2026-07-27-guarded-git-autonomy-implementation.md` | Implemented | Historical Phase C implementation plan; code landed in PR #158. |
| `plans/2026-07-27-deploy-mac-mini-operations-implementation.md` | Implemented | Historical Phase D source plan; code landed in PR #159, with real soak still outstanding. |
| `plans/2026-07-27-kimi-productization-release-implementation.md` | Active | Phase E gate specification; execution remains blocked on passing real-soak evidence. |
| `plans/2026-07-27-kimi-autonomy-execution-control-v3.md` | Historical | Execution controller for the completed A–D implementation sequence and the still-blocked E gate. |
| `plans/2026-07-27-kimi-code-mac-mini-autonomy.md` | Superseded | v1 audit baseline only. |
| `plans/2026-07-27-kimi-code-mac-mini-autonomy.v2.md` | Superseded | v2 audit baseline; v3 controlled execution and later code/runbooks replace it. |
| `prompts/2026-07-27-kimi-autonomy-codex-execution-prompt.md` | Historical | Handoff record only; its authority flags are not reusable. |
| `specs/2026-07-27-kimi-code-mac-mini-autonomous-development-design.md` | Historical | Approved design decisions and rationale; implementation-status statements are stale. |

## Open evidence gates

- Phase E remains denied until the checked-in, checksummed report covers at
  least seven real elapsed days, 30 real RISK-R1/R2 tasks across at least two
  repositories, and every threshold in the Phase D promotion report.
- Machine-wide installation, production activation, and public publication
  retain their explicit owner gates. Text copied from an old prompt cannot
  satisfy those gates.
- Any future status change must update this index and link the exact PR,
  commit, report, and verification command that justifies it.
