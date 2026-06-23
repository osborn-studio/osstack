# UmaDev Code Benchmark For Osstack

> Date: 2026-06-23
> Reference repository: `umacloud/umadev`
> Reference clone: `/Users/gilbertchen/Documents/CODE/agentsteam/_references/umadev`
> Reference commit inspected: `a16d4f3`
> Purpose: turn UmaDev code-level observations into osstack-native upgrade work.

## Executive Decision

Do not fork UmaDev into osstack. Use UmaDev as a code-level benchmark and pattern library.

The reason is architectural: osstack is already a TypeScript local control plane with daemon, loop engine, worktree isolation, multi-agent routing, proof packs, Knowledge Cloud, npm distribution, and EdgeOne deployment. UmaDev is a Rust reference implementation around a spec-driven delivery shell, a full-screen TUI, a curated knowledge corpus, governance hooks, contract validation, and single-binary distribution.

The best path is selective borrowing:

- copy no product identity;
- keep osstack's daemon and loop architecture;
- translate useful UmaDev patterns into osstack modules, commands, tests, and docs;
- record MIT attribution/provenance when any code or knowledge content is adapted.

## Repository Shape Observed

UmaDev snapshot:

| Area | Evidence |
|---|---|
| Language/runtime | Rust workspace |
| Crates | 10 crate manifests under `crates/` |
| Source scale | 79 Rust files |
| TUI stack | `ratatui` + `crossterm` |
| CLI stack | `clap` |
| Knowledge corpus | 417 Markdown files under `knowledge/` |
| Spec vectors | 4 JSON vectors under `tests/spec_vectors/` |
| Distribution | npm wrapper plus platform-specific packages |
| Website | Next.js marketing/documentation site |

Osstack snapshot at time of comparison:

| Area | Evidence |
|---|---|
| Language/runtime | TypeScript monorepo |
| Packages | 15 package manifests under `packages/` |
| Source scale | 163 TypeScript/TSX files |
| TUI stack | CLI terminal cockpit plus first `--interactive` action selection |
| Test stack | Vitest |
| Knowledge assets | 7 JSON knowledge pack files |
| Spec vectors | 9 JSON vectors under `docs/specs/test-vectors/` |
| Distribution | npm primary path, Bun single-binary candidate, EdgeOne Knowledge Cloud |

## What UmaDev Has That Osstack Should Learn

### 1. Full-screen TUI As Product Entry

UmaDev has a dedicated `crates/umadev-tui` package with a stateful app model and rendering layer:

- `app.rs`: app state, modes, chat history, picker state, input model, actions;
- `ui.rs`: ratatui render functions and theme tokens;
- no-subcommand entry launches the TUI as the recommended path.

Osstack already has `cockpit tui --json`, terminal panels, `--action N`, and `--interactive`. The next borrowing step is not to port Rust UI code. It is to adopt the architecture:

- split cockpit state/model/render/input into a dedicated TypeScript module;
- keep `cockpit tui --json` as the stable data contract;
- add full-screen rendering over the same model;
- make keyboard navigation testable through deterministic input streams;
- keep action selection non-mutating unless the user explicitly confirms execution.

Suggested osstack task:

| Item | Target |
|---|---|
| Module split | Move cockpit model/render/interactive logic out of `packages/cli/src/bin.ts` |
| Runtime choice | Prefer lightweight terminal state machine first; evaluate Ink/blessed only after model split |
| Smoke | Extend installed CLI smoke to cover interactive quit, invalid selection, and action selection |
| Acceptance | `osstack cockpit tui --interactive --json` remains stable; full-screen mode can reuse same model |

### 2. Knowledge Corpus Organization

UmaDev has a broad domain knowledge tree, including governance, AI, architecture, CICD, development, design systems, operations, product, security, testing, and seed templates. The code scans this corpus with BM25 and optional vector fusion.

Osstack has taken a better product direction by converting external knowledge into Osstack-native JSON packs and serving them through Knowledge Cloud. But UmaDev still wins on breadth and taxonomy.

Borrow the structure, not the raw public-facing wording:

- use UmaDev's directory taxonomy as an input map;
- transform content into Osstack-native packs with Osstack terminology;
- preserve MIT attribution internally in `source_provenance`;
- keep user-facing search results branded as Osstack Knowledge Cloud;
- add review queue entries for adapted packs before publish.

Suggested osstack task:

| Item | Target |
|---|---|
| Taxonomy expansion | Add planned pack families: `ai`, `architecture`, `development`, `security`, `testing`, `operations`, `product`, `design-systems` |
| Ingestion gate | Extend `knowledge ingest` to produce an adaptation report: rewritten title/body, provenance, review status |
| Cloud workflow | Use `/v1/review/queue` as the operator surface for adapted packs |
| Eval | Add retrieval fixtures per new pack family before official publication |

Implemented guardrail:

- `@osstack/knowledge` now exposes `createKnowledgeAdaptationPlan()` for external MIT-style corpora.
- The plan groups source files by family, assigns `osstack-corpus/*` target pack ids, maps known families to Osstack taxonomy, and requires four actions before publication: rewrite in Osstack voice, record provenance, review before official publish, and add retrieval evals.
- `validateKnowledgeAdaptationPlan()` rejects upstream-branded target identities such as `umadev/*` or `UmaDev ...`, rejects missing taxonomy, and rejects raw `MIT` target labels for `processed_mit` publication.
- This keeps UmaDev as an internal learning/reference source while making the eventual cloud knowledge base Osstack-owned, reviewed, and traceable.

### 3. Retrieval Engine Boundaries

UmaDev separates retrieval into `umadev-knowledge`, with:

- markdown-aware chunking;
- BM25 index;
- tokenizer;
- optional vector path;
- phase-aware subdirectory filtering;
- fail-open retrieval.

Osstack already has local/cloud search and BM25-style ranking. The borrowing point is packaging and boundaries:

- move search/ranking internals behind a clearer `@osstack/knowledge` retrieval interface;
- add explicit query masking / low-signal term handling tests;
- add corpus-scale index/cache tests once Knowledge Cloud storage grows;
- keep cloud outage fallback to local cache.

Suggested osstack task:

| Item | Target |
|---|---|
| Retrieval interface | Add `retrieveKnowledge({ packs, query, mode })` wrapper around current search |
| Ranking tests | Add rare-term vs common-term regression tests and CJK/token edge cases |
| Cache | Add index metadata for pack version and source hash |
| Future vector | Add vector interface only after BM25/cache/storage is clean |

### 4. Spec As Data Plus Prose

UmaDev keeps the host spec in prose and also has a spec crate. It treats clauses, phases, gates, runtime kinds, and test vectors as things the implementation can reason about.

Osstack already has `OSSTACK_RUN_SPEC_V1`, schemas, vectors, and `CONFORMANCE_MATRIX.md`. The borrowing point is to make the spec increasingly data-driven:

- keep every MUST clause mapped to schema/test/vector/smoke;
- add a small generated or parsed clause inventory;
- fail CI when a new normative clause lacks conformance mapping.

Suggested osstack task:

| Item | Target |
|---|---|
| Clause inventory | Add machine-readable extracted list of `R-*` / MUST clauses |
| CI gate | Test that every clause has a matrix row and at least one evidence source |
| Docs | Keep prose as source of truth, data as verifier aid |

### 5. Contract Validation Layer

UmaDev has `umadev-contract`, a focused layer for deriving, rendering, and validating API contracts against frontend calls.

Osstack's current governance is broader and proof-oriented. A small contract-validation package would help close a real product gap: frontend/backend alignment.

Suggested osstack task:

| Item | Target |
|---|---|
| Package | `@osstack/contracts` or a governance submodule |
| Inputs | architecture/API table, OpenAPI subset, source scan |
| Outputs | `contracts/openapi.json`, `contract-validation.json` in proof pack |
| CLI | `osstack contracts check --workspace . --json` |
| Proof | Add contract evidence to `proof validate` and compliance mapping |

### 6. Governance Hook Kernel

UmaDev has a compact pure-rule governance kernel where each rule returns a structured decision containing `block`, `reason`, and clause id.

Osstack already supports fail-open governance and strict opt-in. Borrow the rule shape:

- every governance finding should carry a spec/control id;
- rule output should be stable JSON;
- strict mode can block only when the user opts in;
- default mode remains advisory for loop stability.

Suggested osstack task:

| Item | Target |
|---|---|
| Finding schema | Add `clause_id` / `control_id` fields consistently |
| Strict gate | Extend fixtures for warning vs strict behavior |
| PR evidence | Surface rule ids in PR body and proof pack |

### 7. Distribution Lessons

UmaDev's npm layout includes wrapper packages and platform packages. Osstack already has npm primary and Bun single-binary candidate. Borrow only the release ergonomics:

- keep npm primary;
- use platform packages only if single-binary demand proves real;
- keep SBOM/checksum/signing artifacts;
- finish Developer ID notarization before calling it public release-grade.

## What Not To Borrow

| UmaDev pattern | Why osstack should not copy directly |
|---|---|
| Rust rewrite | osstack already has working TypeScript daemon, CLI, CI, npm, EdgeOne, proof, Knowledge Cloud |
| Linear phase chain as core | osstack's moat is loop engine, queue, daemon, router, worktree isolation |
| Raw knowledge mirror | User asked for Osstack-owned cloud knowledge; raw mirrors preserve upstream product traces |
| Full blocking governance by default | osstack loop must stay stable; strict mode should be explicit |
| Product naming/UX identity | osstack should absorb patterns but keep its own vocabulary |

## Priority Backlog From This Benchmark

| Priority | Work | Reason | Acceptance Evidence |
|---:|---|---|---|
| P1 | Split cockpit TUI model/render/input from `bin.ts` | Reduces largest current CLI technical debt and prepares full-screen workbench | CLI tests pass; no behavior regression in `cockpit tui --json`, `--action`, `--interactive` |
| P1 | Add contract validation slice | High-value UmaDev feature missing from osstack proof chain | `osstack contracts check --json`; proof pack contains contract validation evidence |
| P1 | Expand Knowledge Cloud taxonomy plan | Lets osstack learn from UmaDev corpus breadth without mirroring it | New pack family plan, provenance policy, review queue workflow |
| P2 | Add retrieval interface and ranking edge tests | Makes Knowledge Cloud search easier to evolve toward index/vector storage | BM25 regression tests for rare/common terms and CJK/token cases |
| P2 | Strengthen conformance matrix automation | Keeps `OSSTACK_RUN_SPEC_V1` honest as it grows | CI fails if a MUST clause lacks evidence mapping |
| P2 | Full-screen TUI renderer | Closes UmaDev's TUI polish advantage | Keyboard navigation, refresh, action selection, proof/knowledge browsing |
| P3 | Platform-specific binary packages | Optional if single-binary distribution becomes a real user need | GitHub Release assets, notarization, cross-machine smoke |

## Immediate Recommendation

Use this benchmark to sequence the next work:

1. Finish cockpit technical debt first: split TUI model/render/input out of `bin.ts`.
2. Add a contract-validation proof slice, because it directly improves deliverable quality.
3. Expand Knowledge Cloud taxonomy using UmaDev's corpus structure as a map, but rewrite into Osstack-native packs with internal provenance.
4. Only after model split, decide whether to use Ink/blessed/full-screen terminal UI.

This keeps osstack moving toward the upgrade plan while benefiting from UmaDev's codebase without inheriting its architecture wholesale.
