# @osstack/governance

## 0.23.0

### Minor Changes

- b103f62: Add the contained Mission patch classifier as pure functions: `classifyMissionPatch` parses a bounded unified diff and returns `rejected`, `T2`, `T1` or `T0` with stable, ordered reason codes, using a digested protected set and cumulative caps that a spec may only tighten. `scanForSecrets` and `redactSecrets` scan and redact any executor output channel (patch, final message, stdout, stderr) without ever returning the secret value.

### Patch Changes

- 0d9dca7: Add the contained Mission runner. It advances one step at a time from workspace creation through qualification, a proxy executor turn, patch classification, exact host-side patch application and plumbing commit, to verification and repair cycles. Every executor channel is secret-scanned and redacted before anything is recorded, and decisions follow the W11 decision table.

  Patch changes to the runner, patch applier, mission RPC and CLI now escalate to T2 in the Mission patch classifier.

  The contained ledger now opens a stop obligation on entering `verifying` and requires container stop evidence before a verification result is recorded.

- d26c920: Protect the contained Mission path's own code in the Mission patch classifier. Changes to the shared contained verification, the verification image build, host workspace writes, the Codex proxy executor, the contained ledger and the upgrade holds now escalate to T2.

## 0.20.0

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.

## 0.18.0

### Patch Changes

- 249554f: Add a fixed, bounded `deepseek-no-tools` semantic judge profile, route neat
  semantic and dependency judgments through a shared
  provider registry, and make semantic parity readiness provider-neutral.
  Provider responses now fail closed when the reported model identity differs
  from the requested model.
  Propagate sanitized, closed-registry provider failure codes through semantic
  coverage reports and live diagnostics without exposing provider response bodies
  or exception text. Classify output-token exhaustion, content filtering, and
  provider resource interruption separately while retaining a safe unknown
  finish-reason fallback.

## 0.16.0

### Patch Changes

- 9cc8a37: Canonicalize overlapping narrative candidates and reject duplicate finding fingerprints so Neat reports and recorded history retain the same unambiguous finding set.

## 0.15.0

### Minor Changes

- be6cc63: Add an explicit, read-only Codex local generated-memory adapter for `osstack
neat`. The adapter inventories only an operator-selected directory, emits
  portable metadata and hashes without file content, rejects symlink traversal,
  and deliberately exposes no mutation or Claude-specific limit rules.

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- 35141a8: Render Probe Markdown without trailing whitespace so portable evidence passes
  repository whitespace checks.

## 0.13.1

### Patch Changes

- 733c82a: Publish the review-boundary evaluator required by the Loop reviewer isolation runtime.

## 0.12.0

### Minor Changes

- 4a3dffd: Make knowledge-hygiene ReportV2 the default `neat check` contract, add honest
  coverage and assessment scope, evidence-bound semantic auditing, recoverable
  memory and narrative transactions, append-only V2 lifecycle history, and
  cross-repository dependency obligations with an isolated no-tools judge.
  Explicit `--schema-version 1` remains available for one minor release and now
  emits a deprecation warning.

## 0.11.0

### Minor Changes

- 48ad63d: Publish the strict probe v1 domain contracts and generated JSON Schemas.
- f041063: Add canonical portable probe ledgers, manifest-last repository rendering, artifact receipts, and destination attestations.
- a90f3a5: Add evidence-bound dynamic probe questions plus standalone and session-attached registration of skill-produced restatement findings.
- 73f89fd: Compile resolved probe decisions into reviewable Loop EvaluationSpec deltas through a closed registry of parameter-validated templates.
- 53db533: Inspect portable probe artifact sets during knowledge hygiene checks for ledger integrity, missing decision destinations, stale deferrals, and expired waivers.
- 223a240: Emit replayable probe metric facts, derive all section 10 outcome rates from append-only events with explicit legacy coverage, and surface baseline-only aggregation in supervisor reports.
- 92249dc: Add strict probe readiness policies and a `probe gate` command for live sessions and independently verifiable portable ledgers.

## 0.10.0

### Minor Changes

- 276428b: Add the versioned knowledge-hygiene report, finding, metric, check-input, and
  configuration contracts. Publish strict YAML loading, repository path
  confinement, stable finding fingerprints, and a read-only canonical instruction
  source inspector as additive governance APIs. Include deterministic v1 path
  pattern matching for exact paths, `*`, and complete-segment `**`, plus explicit
  Git worktree/range change sets with portable content-addressed diff IDs. Add a
  bounded, symlink-safe inventory of recognized repository knowledge surfaces
  and a closed rule registry for instruction, required-surface, budget, and
  incomplete-scan findings. Compose these boundaries into a deterministic,
  injectable, read-only report engine with suppression accounting. Evaluate
  configured change-review contracts against structured Git change sets. Check
  plain relative Markdown links and exact-line instruction imports with
  conservative parsing and repository-confined symlink handling. Publish frozen
  JSON Schema artifacts and labelled compatibility vectors for the finding and
  report v1 contracts. Add a hermetic twelve-scenario golden evaluation with
  explicit false-positive accounting and reproducible precision gates. Add
  portable resolution and review-artifact v1 contracts with stale-diff and
  unknown-fingerprint validation, schemas, and compatibility vectors. Apply
  matching review artifacts into separate active and evidence-preserving resolved
  report views without mutating the source report.
  Publish closed low-risk patch action/plan v1 contracts: the only action is
  `create_instruction_import`, with confined paths, mandatory absent-target
  preconditions, content hashes, source findings, and frozen compatibility vectors.
  Plan byte-stable previews for eligible missing instruction mirrors, refusing
  existing targets, symlink-only modes, and unavailable canonical sources.
  Apply validated plans with atomic no-replace creation, parent-symlink
  confinement, current-state conflicts, before/after hashes, and idempotent exact
  replay.
- 25b3f4a: Add the versioned read-only knowledge-surface adapter contract and the first
  explicitly enabled Claude Code auto-memory adapter. Inventory one exact memory
  directory, publish portable adapter-tagged metrics, and report the documented
  Claude-specific `MEMORY.md` 200-line/25KB limit with official-source evidence.
  Expose `--adapter claude-code` and `--claude-memory-dir` without changing the
  default repository-only check.

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.
