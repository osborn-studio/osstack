# U2a multi-home upgrade plan/journal audit — 2026-10-23

## Delivered boundary

This slice implements exact-version deployment-group plans, private journals, cross-plan installation/home claims and an injectable coordinator tested exclusively with fake native ports. Root integration owns the plan/status CLI. Production apply is not registered and no native updater implementation is supplied. Ordinary plans always say qualification_pending and authority:none. A registry cannot prove complete shared-binary consumer membership.

Existing `DeploymentIdentitySchema` is reused. No migration, public package export, daemon implementation, existing upgrader modification, production installation, restart or database rollback was performed. The future native adapter must not simply wrap `handleUpgradeCommand`, whose legacy rollback branches restore database files. U2b requires explicit native reconciliation and completeness/manager qualification before enabling apply.

## Tests and build

- New plan/journal/coordinator suites: 67 tests passed (14 plan, 12 journal, 41 coordinator).
- Existing home-inventory and updater mock/deployed-home suites: 31 tests passed.
- CLI typecheck passed after rebuilding the changed-baseline dependencies; initial stale-dist errors were not source failures.
- Three new runtime entrypoints bundled successfully into isolated scratch output. No generated package output is included in the commit.
- Seven-file Biome and diff checks passed.

Tests cover exact semver and build binding, duplicates, missing/stale/unknown consumers, schema downgrade refusal, bounded plan serialization, minimum per-group port budget, cross-plan shared-installation/home concurrency, exact drain and target identities, Graph holds and unknown actions, fence loss, abort and timeout with late receipts, receipt substitution, every saved process-loss phase prefix, corruption, private temporary hard-link crash state, direct replay after manual claim deletion, hidden partial claims, and verification surviving cleanup failure or late cancellation. Interrupted-prefix tests reconstruct saved process-loss state; they are not real power-cut tests. Native effects are fake throughout.

Evidence root: `/Volumes/AIMATE_WORK/tmp/osstack/smoke/pr237-integration/upgrade-next/`. `tests.log`, `legacy-tests.log`, `typecheck.log`, `build.log`, and `biome.log` retain validation output.

## Independent static challenge and disposition

Claude Code was invoked with requested model `claude-haiku-5-5`, empty tools/MCP, disabled hooks/plugins/slash commands, no setting sources and no session persistence. Raw input, JSON result and stderr are retained. The CLI warns `unrecognized_model` while successful result metadata names the requested alias; that is not independent provider identity attestation. No audit invoked an updater or tool.

Round 1 reported 4 P1 and 10 P2. Fixed the concrete slice issues:

- Added individual home claims alongside installation claims, keeping physical installation completeness a separate future host proof.
- Minimum step budget is checked before draining (5 × homes + 2 calls); cancellation/expiry after drain preserves stopped/unknown facts and requires reconciliation rather than restarting without authority.
- Crash-after-link files with two links are readable only when the matching second link is the private temporary in the same directory. Other hard links, noncanonical bytes and oversized files fail closed. Read/status never deletes temporary files.
- Re-read journal state after obtaining claims; immediate logical cancellation; strict locale-independent canonical JSON; confirmed status required for verification; verified facts survive claim-release failure.

The retained-claim availability issue is an explicit U2b blocker: failure claims are never stale-stolen, automatically erased or treated as proof of no native effect. U2a supplies read-only recovery state, not authorized native reconciliation. Native apply remains disabled. macOS power-loss cache flushing, hung filesystem calls, automatic temporary GC, same-UID identity forgery and cross-host authentication remain unqualified; port deadlines do not claim a hard filesystem/physical-stop SLA.

Round 2 separated disabled native qualifications from slice defects and found two P1 issues. Both were corrected: partial claim sets are visible even without phase records, and `UpgradeJournal.claim` itself refuses prior attempted journals even if files were manually removed. The coordinator also classifies ambiguous claim acquisition as recovery_required. Additional P2 corrections: no post-persistence cancellation can overwrite confirmed verification, and reads verify exact canonical bytes. The review's invalid build-evidence example is rejected by the existing DeploymentIdentitySchema enum; deployment-kind mismatches were already flagged by the planner and are independently checked by the coordinator. Missing failure-marker writes leave the prior started record and claims for reconciliation; they cannot turn an attempt into success. Historical confirmed drain IDs and all started records remain distinct from assertions about current physical stop.

Round 3 found that a failed acquisition before any writer/native action was returned should remove its own fresh token claims instead of stranding them. That local metadata rollback is now implemented with token matching and directory sync; foreign claims and attempted native-effect claims remain untouched. Status still reports process-loss/uncertain-cleanup partial claims. The mutating port boundary also synchronously checks every claim immediately before invocation, and ambiguous restart errors use recovery_required. The host authorization proof digest/reference is recorded at preflight. Frozen group order is tested before any port calls. Round 4 caught that the fresh-token cleanup must also cover the post-publication journal re-read and state comparison, not just the publish loop. Those operations now share one try/catch before any writer is returned; an injected second-read failure verifies complete own-token cleanup, and missing claims map to a stable claim-changed error. Round 5 confirmed the post-publication cleanup gap is closed and found no new P0/P1 in that delta. All demonstrated slice P1 findings above were addressed; crash/SIGKILL retained-claim reconciliation remains an explicit disabled-native follow-up, not automatic permission to clear unknown effects. These static reviews do not qualify root CLI wiring, the full PR, native installation, multi-home real upgrades or physical power-loss recovery.

## Raw review integrity

| Round | Raw result | SHA-256 |
| --- | --- | --- |
| 1 | `audit-1-result.json` | `51fbe531926be08a18157ae897435aba5b8f0c7b7ccba790294ffa1bd2f6a293` |
| 2 | `audit-2-result.json` | `6961c442673fbca00a462135d499309b24191ad919ed317c174523e86cca08ae` |
| 3 | `audit-3-result.json` | `01a93347d515ac68e13aff48fc515c40fcb6eb576bef531b2066c966cd714b69` |
| 4 | `audit-4-result.json` | `28f196f77149810d6c6c735f568608474966f02b8f937201c765960c9df8f2ed` |
| 5 | `audit-5-result.json` | `2965f6c69b4638a5c6315622bcab9f8a00a5ff4b7332b3af02c9edd1d9370a25` |
