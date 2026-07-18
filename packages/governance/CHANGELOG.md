# @osstack/governance

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
