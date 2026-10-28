# Architecture design method

This author slice adds [architecture design guidance](../../../osstack-methods-skill/references/architecture-design.md) and this record. It starts with caller usage, derives domain types and signatures, compares distinct ownership structures, and specifies lifecycle, compatibility and falsifiable checks. It does not implement the example service or add runtime behavior.

The baseline is `711c45e75264000bde859328bd7dc131f68461d1`. Shared entry routing, source attribution and exporter tests belong to the integration owner. This isolated slice does not claim eleven-method navigation, actual host use or improved design quality.

## Original sources and adaptation

The source is `cursor/plugins` at `99b609a72323b70204eab407c622f436e858e112`. The author read the complete [architect skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/SKILL.md), its [design red flags](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/references/design-red-flags.md), [rationale template](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/references/rationale-template.md) and [runner prompt](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/references/runner-prompt.md).

The supporting principles read at the same pin were `principle-foundational-thinking`, `principle-model-the-domain`, `principle-boundary-discipline`, `principle-type-system-discipline`, `principle-separate-before-serializing-shared-state`, `principle-make-operations-idempotent`, `principle-exhaust-the-design-space`, `principle-encode-lessons-in-structure`, `principle-redesign-from-first-principles` and `principle-migrate-callers-then-delete-legacy-apis`. Exact Git blob IDs, SHA-256 values and original bytes are retained in the author source anchors.

OSStack retains caller-first sketches, different structural candidates, interface depth, domain ownership, lifecycle reasoning and design revision when repeated evidence shows the shape is wrong. It does not import fixed model defaults, required arena execution, a hard call-chain file-count limit or automatic permission to implement. Design-only stays design-only. Existing implementation authority does not acquire a new approval gate.

Two adaptations are material. First, trusting internal types does not remove validation at a new database, IPC or RPC boundary, or checks for mutable authorization and ownership. Second, discarding a bad design means revising the proposal and planning migration; it does not authorize deletion of working code, user changes or required compatibility paths. Independent facts can have separate writers, but a required canonical outcome still needs a real ownership mechanism.

## Grounding and example scope

The baseline `AGENTS.md`, prompt-language policy and existing feature/refactoring methods were read in full. The author also inspected `packages/core/src/scratch.ts`: its typed allocation API accepts a kind, label and environment and creates a fresh directory, but does not take responsibility for the caller's later cleanup. That source observation illustrates why a public signature must be read together with its resource lifecycle; it is not a new defect or a proposed change to scratch handling. No allocator or product driver was run.

The report-service example is synthetic. It compares a durable coordinator with independent worker-attempt records and a merged view. The stated single-outcome requirement favors the coordinator in that example; it is not a universal recommendation. The caller operations, result distinctions, ownership and four failure scenarios are manually cross-checked. There is no fabricated compiler result, crash-test output or host observation.

Independent criteria were frozen before author implementation at SHA-256 `637590cc7b487b039e5c4f85469b494fe671aadaef236bbc25886a1a44b2a101`. Author scratch evidence under `method-framing-architecture-20261029/architecture` retains source anchors, the synthetic walkthrough, document-link and whitespace checks, and exact candidate binding. The integration owner handles actual exports, independent review and any later audit. A structural documentation check does not prove the design will work when implemented.

Author checks passed for seven local documentation links and nineteen retained source hashes. The synthetic walkthrough manually compares three caller operations, two structures, four lifecycle counterexamples and two additional invariant violations. These are document and reasoning checks, not six executed failure tests.
