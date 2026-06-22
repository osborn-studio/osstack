# OSSTACK_RUN_SPEC_V1 Conformance Matrix

Status: Draft  
Spec: `OSSTACK_RUN_SPEC_V1.md`  
Date: 2026-06-22

This matrix maps every stable clause in `OSSTACK_RUN_SPEC_V1` to the current evidence that can prove, partially prove, or still needs to prove conformance. It is intentionally implementation-facing: future schema changes, verifier changes, or CLI changes should update this file in the same PR.

## Status Legend

| Status | Meaning |
|---|---|
| Covered | The clause has a schema, test vector, deterministic code path, and/or CLI test that directly exercises it. |
| Partial | The clause has some evidence, but one or more required behaviors need stronger verifier or end-to-end coverage. |
| Planned | The clause is specified but does not yet have enough executable evidence. |

## Matrix

| Clause | Requirement Summary | Current Evidence | Status | Next Coverage Step |
|---|---|---|---:|---|
| R-001 Lifecycle | Runs/loops must follow durable discover-plan-execute-verify-iterate-persist lifecycle with stable `run_id` / `loop_id`. | `packages/loop/src/loop-engine.test.ts`; `packages/loop/src/state-file.test.ts`; `packages/cli/src/loop-cli.test.ts`; `docs/specs/test-vectors/OS-EVID-001.json`; `scripts/smoke-deliver-proof.mjs`. | Covered | Add this smoke to remote CI after workflow-scope push is available. |
| R-002 Task Schema | Discovered work must conform to `schemas/task.schema.json` with `task_id`, `capability`, `prompt`, `source`. | `docs/specs/schemas/task.schema.json`; `docs/specs/test-vectors/OS-GOV-001.json`; `packages/cli/src/deliver-cli.test.ts`; `packages/loop/src/task-queue.test.ts`. | Covered | Add JSON Schema validation in task enqueue path when accepting external queue files. |
| R-003 Capability and Adapter Contract | Adapters must declare capabilities; invocations must emit events or explicit failure; router decisions must record fallback reasons. | `packages/agents/src/adapters/subprocess-cli.test.ts`; `packages/agents/src/adapters/deepseek.test.ts`; `packages/cli/src/agent-list-cli.test.ts`; `packages/core/src/orchestrator/router.test.ts`. | Partial | Add a conformance fixture that asserts adapter capability metadata and failure event shape together. |
| R-004 Policy Decision | Agent selection must be recorded as policy decision conforming to `schemas/policy-decision.schema.json`; missing evidence must use `unknown`. | `docs/specs/schemas/policy-decision.schema.json`; `docs/specs/test-vectors/OS-GOV-001.json`; `packages/cli/src/proof-cli.test.ts`; `packages/cli/src/pr-cli.test.ts`. | Covered | Add proof-pack schema validation for `policy-decision.json`. |
| R-005 Event Schema | Events must be replayable in sequence and conform to `schemas/event.schema.json`. | `docs/specs/schemas/event.schema.json`; `docs/specs/test-vectors/OS-EVID-001.json`; `packages/loop/src/loop-engine.test.ts`; `packages/cli/src/daemon-loop.test.ts`. | Covered | Add monotonic sequence validation to proof creation for external event files. |
| R-006 Loop State | Loop state must conform to `schemas/loop-state.schema.json`; renderers must not crash on missing optional fields. | `docs/specs/schemas/loop-state.schema.json`; `docs/specs/test-vectors/OS-EVID-001.json`; `packages/loop/src/state-file.test.ts`; `packages/cli/src/report-cli.test.ts`; `packages/cli/src/scorecard-cli.test.ts`. | Covered | Add explicit malformed-state negative fixture in CLI report tests. |
| R-007 Verify Gates | Verification evidence must record task id, pass/fail, verifier id, summary, and event pointer when available; missing verifier event must be marked `unknown` or clearly state-only. | `docs/specs/schemas/verify-results.schema.json`; `packages/loop/src/verifier.test.ts`; `packages/cli/src/proof-cli.test.ts`; `packages/cli/src/report-cli.test.ts`; `docs/specs/test-vectors/OS-EVID-001.json`. | Covered | Add runtime JSON Schema validation for external `verify-results.json` imports if accepted later. |
| R-008 Worktree Safety | Isolated worktree evidence should record task, status, branch, commit, and path; missing event evidence must be `unknown`. | `docs/specs/schemas/worktree-status.schema.json`; `packages/agents/src/worktree.test.ts`; `packages/loop/src/loop-engine.test.ts`; `packages/cli/src/proof-cli.test.ts`; npm install smoke evidence commands; `docs/specs/test-vectors/OS-EVID-001.json`. | Covered | Add a negative fixture for malformed worktree event payloads. |
| R-009 Proof Pack | Proof pack must include required artifacts; `agent-runtime.json` must record agent/auth/roles; manifest artifacts must include sha256 and byte count. | `docs/specs/schemas/proof-pack-manifest.schema.json`; `docs/specs/schemas/agent-runtime.schema.json`; `packages/cli/src/proof-cli.test.ts`; `scripts/smoke-npm-install.mjs`; `scripts/smoke-deliver-proof.mjs` compliance render from proof dir; `docs/specs/test-vectors/OS-EVID-001.json`. | Covered | Add schema validation for externally supplied proof evidence files if imports are accepted later. |
| R-010 Conformance Levels | Reports should display highest provable L1-L4 conformance level. | `docs/specs/OSSTACK_RUN_SPEC_V1.md`; `packages/loop/src/report.test.ts`; `packages/cli/src/report-cli.test.ts`. | Covered | Add external fixture vectors for L3/L4 once proof-pack schema validation runs at runtime. |
| R-011 Knowledge Evidence | Knowledge packs must conform to `knowledge-pack.schema.json`; external knowledge must be transformed and retain attribution; cloud failures should fail open; report/proof should record packs/chunks. | `docs/specs/schemas/knowledge-pack.schema.json`; `docs/specs/test-vectors/OS-KNOW-001.json`; `packages/knowledge/src/pack.test.ts`; `packages/cli/src/knowledge-cli.test.ts`; `packages/loop/src/report.test.ts`; `scripts/smoke-knowledge-cloud.mjs`; `scripts/smoke-npm-install.mjs`. | Covered | Add cloud outage fallback coverage to remote CI after workflow-scope push is available. |
| R-012 PR Evidence | PR body should be derivable offline; dry-run must not write to GitHub; create mode must run readiness checks and fall back to manual steps. | `packages/cli/src/pr-cli.test.ts`; `packages/cli/src/proof-cli.test.ts`; `scripts/smoke-deliver-proof.mjs`; `packages/cli/src/bin.ts` PR command implementation. | Covered | Add GitHub connector/`gh` integration smoke after branch can push to remote. |
| R-013 Versioning and Deprecation | Spec versions must use semver; breaking schema/clause changes must increment major version; deprecated fields should remain accepted for one minor unless unsafe. | `docs/specs/OSSTACK_RUN_SPEC_V1.md`; `packages/cli/src/run-spec-files.test.ts`. | Partial | Add a deprecated-field compatibility fixture when the first deprecated schema field exists. |
| R-014 Test Vectors | Implementations must use `test-vectors/` as compatibility examples; every MUST should map to schema, vector, or verifier rule. | `docs/specs/test-vectors/OS-GOV-001.json`; `docs/specs/test-vectors/OS-EVID-001.json`; `docs/specs/test-vectors/OS-KNOW-001.json`; `packages/cli/src/run-spec-files.test.ts`; this matrix. | Covered | Expand vectors with L3/L4 reviewed/audited examples. |

## Current Conformance Summary

| Level | Current Proof Surface | Status |
|---|---|---:|
| L1 Tracked | Loop state, events, run ids, loop ids, state-file rendering, daemon loop events. | Covered |
| L2 Verified | Verify results in loop/report/proof, scorecard gates, `OS-EVID-001`. | Covered |
| L3 Reviewed | Reviewer/checker evidence can enter report/proof, but canonical L3 fixture is not yet present. | Partial |
| L4 Audited | Proof pack includes decision, events, verify, knowledge, governance, sha256 manifest; worktree/diff/risk evidence exists; compliance render can map proof dir evidence to internal controls. | Partial |

## Required Follow-Up Tests

1. Add external fixture vectors for L3/L4 reviewed/audited proof examples.
2. Add schema validation for externally supplied proof evidence files if imports are accepted later.
3. Add `smoke:deliver-proof` and installed-CLI knowledge fallback smoke to remote CI after workflow-scope push is available.
