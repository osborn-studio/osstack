A retained successful verification could hide a later failed attempt, while source manifests discarded the subtree and package version needed to adopt a fixed pstack release. This adds a bounded, read-only maintenance health report and strict source registration fields for subdir and package_version.

The health report separates the latest attempt from the last success, reports configured ownership and relevant file drift, and preserves the first and subsequent failure diagnostics. The fixed-five maintenance wrapper records its own source digest, and the existing evidence projector exposes a read-only retained-journey inspection. Source registration preserves legacy defaults but rejects unknown fields and invalid subtree paths; it does not activate or install the candidate.

The plan pins pstack 0.15.36 at cursor/plugins commit c742dd61706fbacc1b95f1a20b7b988cf096ce6c, subtree pstack. It prioritizes a project method bundle and a real task through existing Loop Engineering and kanban, includes the 24-capability adoption matrix, and keeps formal/statechart separate. Firstmate deep runtime remains excluded. The source lock and plan do not claim completed adoption or qualification.

Validation:
- Combined code at e82adca9: 22 packages, 7304 passed / 5 skipped / 0 failed; 8981 tracked files unchanged during the run. Four fresh knowledge/dist outputs were already dirty at test start, retained by bytes/hash/patch, then restored after all validation; this was not a clean committed-tree run.
- 199 focused script tests passed: health 45, maintenance 25, projection 89, feature-map 40. Source registration: author 52 and independent frozen 47 vectors passed; old/new failures retained.
- Fresh build, typecheck, TypeScript lint and generated inventory passed. MJS files are not covered by Biome. The initial integrated typecheck failure in CLI test fixtures and its correction are preserved.
- Actual bounded injected tool-path failure, one-line repair and fresh re-drive are retained. Static Sonnet audits remain PASS_WITH_CONCERNS; raw evidence and original failures are archived and independently checked.
- Final documentation validation: 241 passed. Documentation-only publication follows the tested code; final GitHub CI is still required.

Details: docs/implementation/pstack-maintenance-health/README.md and docs/implementation/pstack-fixed-release/{PLAN,CAPABILITY-ADOPTION,LOOP-AND-BOARD-FIRST}.md. Root owns this PR and the central ledger; merge remains a human action.
