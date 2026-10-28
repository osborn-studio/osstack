# Feature and refactoring methods (D2a)

OSStack now supplies two more shared methods through its existing four entries. A user can ask `osstack-mode` to add a feature or preserve behavior while changing structure. `osstack-help` explains that choice; `osstack-agent` applies it to an owned delegated slice. The source router also links both methods. The exporter copies the same canonical reference bytes into each Codex or Claude entry.

| Intent | Material | Required distinction |
| --- | --- | --- |
| Add or intentionally change behavior | [Feature](../../../osstack-methods-skill/references/feature.md) | Domain shape, owned slices, actual entry-point acceptance and affected existing behavior |
| Change structure while preserving behavior | [Refactoring](../../../osstack-methods-skill/references/refactoring.md) | Baseline behavior pin, caller migration, same-input comparison and unexplained differences |

Use the current exported `osstack-mode` with a concrete task and repository scope. For example: “Add an optional filter to this command and verify its accepted and empty-result paths.” For a refactor: “Extract the formatter while preserving output ordering, errors and exit behavior on the current fixtures.” These examples select a workflow; they do not execute code by themselves or grant publication authority.

Feature/refactoring remain reference methods, not new slash commands or native agents. There are four named entries and six shared methods. The change does not install a host package, add a CLI command, select a model, change a runtime contract or pass a joint gate.

## Source and adaptation

[The source map](source-map.json) records original Git paths, the fixed upstream commit, byte counts and SHA256 values. The source is pstack by poteto at `99b609a72323b70204eab407c622f436e858e112`. OSStack prose is independently written. The adaptation keeps behavior pins, design choices, small verified units and explicit write ownership. It uses the existing authorization and host tools for delegation. It does not import a mandatory model/arena or assume permission to break external consumers during an API cleanup.

## Verification

The new tests invoke the real export CLI for both hosts, walk the exported local-reference graph from every entry, and check canonical method bytes and source/output hashes. Removing an advertised reference from a controlled source copy must fail before creating the output directory. Existing exporter failure, path and bounded-input checks remain intact.

The first targeted run preserved the capability gap: both real CLI export cases lacked the new method file. The two negative-case setups also failed because those new source files did not yet exist; these are not claimed as successful negative checks. After implementation, the complete exporter suite passed **67/67**, with no skips. Five source/entry frontmatters passed the skill validator. Fresh actual exports each contain **48 files**, and their full manifests are retained under `evidence/`. [Validation](evidence/validation.json) links the scope and limits; raw RED/GREEN outputs are retained.

These are packaging, link-reachability and structural checks. They do not prove a model will choose the right method or produce an effective implementation. Independent material review and the parent-owned audit cover the new instructions separately. Prior native-discovery runs used older method bytes; their results are not relabeled as acceptance of feature/refactoring. Full-repository tests and model audit are owned by the integration thread and are not claimed here.
