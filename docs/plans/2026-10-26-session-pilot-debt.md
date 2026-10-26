# Session adoption: remaining delivery work

Date: 2026-10-26. Scope: the opt-in `adopt_session` pilot. This work does not enable goal dispatch, automatic Loop/Graph selection, runtime qualification or production isolation.

## Baseline and delivery boundary

The complete reviewed pilot is pinned at `2212325e5e7a9c692a02d06d0e59eb18957b573b`. Main is `a74296c0f6fe5f0b3c3b5c1849b27e1b1ef07ace`. PR #252 reached main. PRs #253–#258 were merged into their predecessor feature branches, so their merged labels do not prove main delivery. Restore the six remaining layers as small promotion PRs. Keep downstream PRs Draft until their predecessor reaches main, then retarget them to main before merging. Check ancestry, not only PR state.

Use the installed OSStack 0.22.1 daemon in a dedicated task home. Board: `session-pilot-debt`. The exported card IDs and receipts belong to the delivery report. The design's original `work-items.json` and `pilot-scenarios.json` stay planning contracts; do not rewrite them to imply execution or qualification.

## Work and acceptance

| ID | Owner / files | Dependencies | Acceptance |
|---|---|---|---|
| INT01 | Root; Git history and promotion PRs | Existing reviewed layers | Six bounded diffs preserve the reviewed source; first targets main, successors stay Draft; no claim that feature-base merges reached main. |
| CORE01 | Core agent; `engineering-store.ts`, completion tests | Baseline build | Reproduce source identity reconciliation after an applied original turn and later manual turn. Identity mismatch must remain fenced after apparent source restoration. Preserve ADR-14: historical proof alone does not force current Mission completion. |
| RUN01 | Runtime agent; daemon, host and tests | Baseline build | Deterministic barriers hold asynchronous lease cleanup after receipt persistence. Failed release must not make drain report safe. Settle callbacks cannot dispatch while draining. Add regression tests before fixes. |
| SMOKE01 | Smoke agent; engineering smoke script, fixture and tests | Baseline build | Run compiled CLI against a separate fixture daemon: adopt, observe, defer, decide, exact completion, replay, reconcile. Exactly one invocation. Bound startup, RPC and cleanup; use dedicated scratch/home and 0600 authority. Report `provider_qualified: false`. |
| EVID01 | Root; plan, bilingual guides and delivery report | Agent results | Link task cards, exact tests, audit result and external blockers. Keep historical records clearly dated. Distinguish implemented, locally tested, main-integrated and live-qualified. |
| VERIFY01 | Root; full validation and independent review | CORE01, RUN01, SMOKE01 | Build, full tests, typecheck, lint, inventory, smoke and applicable repository gates pass. Run actual Claude Code `claude-sonnet-5-5` review; fix actionable findings and repeat affected checks. Submit bounded PRs. |
| LIVE01 | Environment qualification | Supported live harness and containment | Track six unqualified pilot scenarios separately: WD-19, WD-28, WD-32, WD-33, WD-41, WD-43. No fixture, CLI login or static review can satisfy them. |

## Safety and verification method

Three subagents own disjoint files in one isolated worktree. Only root commits or performs integrated builds. Use Node 22 and the repository's scratch API. Never open the default OSStack home from development code. Preserve the primary checkout's unrelated modifications.

Start with failing regression tests for behavior changes. Keep completed-turn proof, active process cleanup and writer lease release as separate facts. An applied receipt does not prove a clean drain. Never erase an unknown receipt or release an upgrade fence to make tests pass.

Sonnet receives the candidate diff and relevant source through stdin with no tools, slash commands or MCP servers. Record the actual returned model and findings. Its review is independent static evidence, not executed tests or a production certificate.

## Deferred qualifications

Real provider resume/intervention, surviving child processes and containment, physical power-loss durability, same-UID adversarial isolation, hard token/cost budgets and user-intervention baseline measurements remain separate. Report any preflight actually run and its concrete outcome. Full controller/routing/registry stages retain their original work-item IDs; this pilot does not silently complete them.
