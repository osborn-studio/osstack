# OSSTACK_RUN_SPEC_V1

Status: Draft
Version: 1.0.0
Date: 2026-06-22

This specification defines the minimum interoperable contract for an Osstack run, loop session, report, scorecard, and proof pack.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119.

## R-001 Lifecycle

An Osstack run MUST follow a durable lifecycle:

1. Discover work.
2. Plan the task and select an agent.
3. Execute through an adapter or local executor.
4. Verify with deterministic gates and/or reviewer adapters.
5. Iterate, stop, or escalate.
6. Persist state, events, and evidence artifacts.

Every persisted run MUST have a stable `run_id`. Every loop session MUST have a stable `loop_id`.

## R-002 Task Schema

Discovered work MUST conform to `schemas/task.schema.json`.

A task MUST include:

- `task_id`
- `capability`
- `prompt`
- `source`

The `source` field MUST be one of `git_diff`, `gh_issue`, `github_branch`, `ci_log`, `task_queue`, or `manual`.

## R-003 Capability and Adapter Contract

An adapter MUST declare at least one capability id and capability kind. An adapter invocation MUST emit ordered events or an explicit failure.

An adapter SHOULD report availability before it is selected. A router MAY choose a fallback adapter when the preferred adapter is unavailable, but the decision reason MUST be recorded.

## R-004 Policy Decision

Agent selection MUST be recorded as a policy decision when a route or policy engine selects an agent.

The policy decision artifact MUST conform to `schemas/policy-decision.schema.json`.

The decision MUST include:

- `task_id`
- `agent_id`
- `reason`
- evidence pointer such as `event_seq`

If no policy decision evidence exists, the artifact MUST explicitly use status `unknown`; it MUST NOT invent a decision.

## R-005 Event Schema

Run and loop events MUST be replayable in sequence order. Loop events MUST conform to `schemas/event.schema.json`.

Events MUST include:

- `event_id`
- `loop_id`
- `type`
- `seq`
- `created_at`

The event stream SHOULD include `loop.plan.done`, `loop.execute.done`, `loop.verify.done`, `loop.state.written`, and `loop.stopped` for a complete loop run.

## R-006 Loop State

Loop state MUST conform to `schemas/loop-state.schema.json`.

The state file MUST include:

- `loop_id`
- `started_at`
- `updated_at`
- `completed_tasks`

Missing optional sections MUST be rendered as empty or `unknown`; renderers MUST NOT crash on absent optional fields.

## R-007 Verify Gates

Verification evidence MUST be recorded for each executed task when verifier results exist.

Verify results MUST include:

- `task_id`
- pass/fail status
- reviewer or verifier id when known
- summary
- event sequence pointer when event evidence exists

If no verifier event exists, the proof pack MUST mark verifier evidence as `unknown` or derive a clearly labeled state-only status.

## R-008 Worktree Safety

When isolated worktrees are used, worktree evidence SHOULD record:

- task id
- created/merged/cleaned status
- branch
- commit
- path when available

Successful merge or cleanup evidence MUST be replayable from events. If no worktree event exists, the proof pack MUST mark worktree status as `unknown`.

## R-009 Proof Pack

A proof pack MUST conform to `schemas/proof-pack-manifest.schema.json`.

A proof pack MUST include:

- `manifest.json`
- `report.md`
- `scorecard.md`
- `scorecard.html`
- `loop-state.json`
- `events.jsonl`
- `policy-decision.json`
- `verify-results.json`

A proof pack SHOULD include `worktree-status.json` when worktree evidence is available. Every artifact listed in `manifest.json` MUST include a sha256 checksum and byte count.

## R-010 Conformance Levels

### L1 Tracked

A run is L1 when it records `run_id`, events, and loop state.

### L2 Verified

A run is L2 when it satisfies L1 and at least one verify gate passes, or each verification failure has an explicit recorded reason.

### L3 Reviewed

A run is L3 when it satisfies L2 and a reviewer/checker or human review result is present in the report or proof pack.

### L4 Audited

A run is L4 when it satisfies L3 and the proof pack contains agent decision, diff or worktree evidence, logs/events, verify evidence, review evidence, and risk evidence.

Reports SHOULD display the highest conformance level that can be proven from available evidence.

## R-011 Knowledge Evidence

Knowledge packs used by a run MUST conform to `schemas/knowledge-pack.schema.json`.

A knowledge pack MUST include:

- `id`
- `version`
- `name`
- `license`
- `source_kind`
- `quality_score`
- `chunks`

The `source_kind` field MUST distinguish osstack-native material from processed MIT-compatible, curated external, or internal material. Processed external knowledge MUST be transformed into Osstack concepts and MUST retain license/source attribution metadata.

Runs MAY operate with knowledge mode `off`, `local`, or `cloud`. If cloud knowledge is unavailable, the run SHOULD fail open to `local` or `off`. Reports and proof packs SHOULD record injected knowledge pack ids and chunk ids when knowledge is used.

## R-012 Versioning and Deprecation

Spec versions MUST use semantic versioning. A breaking schema or clause change MUST increment the major version.

A deprecated field SHOULD remain accepted for one minor version unless it creates a security risk.

## R-013 Test Vectors

Implementations MUST use the vectors under `test-vectors/` as compatibility examples:

- `OS-GOV-001.json`: policy and governance evidence.
- `OS-EVID-001.json`: state, event, and proof evidence.
- `OS-KNOW-001.json`: knowledge pack metadata and local/cloud mode evidence.

Every MUST clause above SHOULD map to at least one schema, test vector, or deterministic verifier rule.
