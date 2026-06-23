# Task Breakdown

## Distribution

- Keep npm pack/install smoke green.
- Keep launchd install/status/uninstall tested.
- Evaluate optional single-file distribution without weakening npm path.

## Evidence And Governance

- Expand proof pack artifacts only when they map to real evidence.
- Keep governance warning by default and strict mode opt-in.
- Keep PR create mode behind readiness checks.

## Knowledge Cloud

- Maintain official packs and retrieval fixtures.
- Support private/team/project imports and cache search.
- Preserve source provenance internally.
- Expand the Osstack-native knowledge taxonomy using the UmaDev reference corpus as a structure map, not a public-facing mirror.
- Route adapted knowledge through provenance, rewrite, review queue, and publish gates before official cloud release.

## Product Surface

- Continue improving cockpit summary, report generation, proof browsing, and i18n.

## UmaDev Code Benchmark Borrowing Backlog

Use `docs/external/2026-06-23-umadev-code-benchmark.md` as the code-level reference. The goal is to learn from UmaDev's structure while keeping osstack's TypeScript control-plane, daemon, loop engine, proof chain, Knowledge Cloud, npm distribution, and EdgeOne deployment.

| Priority | Task | Acceptance |
|---:|---|---|
| P1 | Split cockpit TUI model, render, and input handling out of `packages/cli/src/bin.ts`. | `cockpit tui --json`, `--action`, and `--interactive` keep current behavior; interactive input is covered by deterministic CLI tests. |
| P1 | Add a contract-validation slice inspired by UmaDev's contract layer. | Initial slice: `osstack contracts check --json` validates `osstack.contracts.json` against frontend fetch calls and backend routes, and proof packs include `contract-validation.json`. Next: broaden route adapters and OpenAPI output. |
| P1 | Expand Knowledge Cloud taxonomy from the UmaDev reference corpus structure. | New Osstack-native pack families have internal provenance, rewritten Osstack terminology, review queue entries, and retrieval fixtures. |
| P2 | Formalize the knowledge retrieval boundary. | Search/ranking internals are exposed through a stable retrieval interface with rare-term, common-term, CJK/token, cache, and fallback tests. |
| P2 | Strengthen conformance matrix automation. | CI fails when a normative `OSSTACK_RUN_SPEC_V1` clause lacks a matrix row or evidence source. |
| P2 | Build a full-screen cockpit renderer after the model split. | Keyboard navigation, refresh, action selection, proof browsing, and knowledge browsing work over the same cockpit data model. |
| P3 | Evaluate platform-specific binary packages. | Only proceed after npm and Bun single-binary routes have notarization, checksum, SBOM, and cross-machine smoke evidence. |
