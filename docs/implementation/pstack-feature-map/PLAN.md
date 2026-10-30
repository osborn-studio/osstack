# W18: next implementation boundary

Historical pre-implementation decision; current bounded implementation and validation are recorded in [delivery](README.md). Original scope decision status: ready to implement, not implemented or accepted. This decision follows the bounded post-hoc C0 tutorial; it does not repeat that closed experiment. Baseline control `147c59cfab63de7cb93d0445c63334a52f5c57a0`, actual main `01ec1852ffcf0cff4f1e4a0632b1ae3a8ddc1211`. PR310 is merged. Firstmate deep runtime remains prohibited by the user's instruction.

## Next delivery

Implement a callable, offline feature-map selector with three actual CLI user journeys: maintain the fixed-five expectation map, run the full skills-check journey, and inspect/project a retained journey evidence packet. The packet journey requires the journey leaf. A maintenance query need not load every leaf merely because its driver internally calls the journey.

Use the existing public `searchKnowledgePacks` BM25 function on index metadata only. Read selected leaves only after ranking and required dependency expansion. Do not build another search engine, load all leaf bodies into a pack, use cloud retrieval, or change the optional host-context budget contract.

The author owns `scripts/method-feature-map.mjs`, its adjacent test, and `docs/verification/features/`. Split implementation into a four-file first vertical slice (reader/test/index/maintenance leaf), then a second bounded slice adding the journey and packet leaves and README. Root owns aliases, CI integration, changeset if required, ledger, PR and the single full regression queue. A second worker freezes independent cases before reviewing results; a third reviews actual command/leaf accuracy and W19 boundaries. No duplicate owner or additional subagents.

## Decisions made before implementation

1. This batch has three CLI scenarios, not a real CLI/UI or CLI/RPC cross-surface journey. Do not sign complete A35. The independent two-entry fixture tests coverage bookkeeping only. A48 routing, actual host delivery and recipe correction remain separate integration work.
2. Local closed index/leaf formats are authoring and retrieval data, not the strict `material:feature_map` protocol body. Do not add fields to that existing schema or change admission/qualification. Leaf references and content hashes identify materials; they are not authenticated runtime evidence.
3. Freeze the index/leaf schema and examples before implementation tests. Limits: index 64 KiB / 32 IDs; query 4 KiB; initial limit 1–5; selected plus required closure at most 8 leaves, each 32 KiB, total 128 KiB. Bounds reject instead of silently dropping required material. Reject duplicate IDs, unknown dependencies, cycles, path escapes and unsupported file types. Explicitly document symlink policy and test it.
4. Return selection reasons, required dependencies, omitted scope and material digests. No match is explicit. Exit zero means complete material selection/read only, never product success. Malformed input, missing required material, drift and exceeded budget must remain distinguishable. Final exact result schema/error codes are frozen with the implementation examples, not inferred from old tools.
5. Freshness comparisons require explicit observed source/driver bindings; absent observations remain unknown, mismatches remain drift. A content hash match alone must never become current product verification. Do not invalidate all leaves merely because any unrelated Git commit changed. First implementation does not resolve live-evidence authority: last-live claims stay draft/unverified, historical records retain their original identities.
6. Preconditions are descriptions plus explicitly supplied observations, never implicit credential probing or command execution. Missing known requirements are blocked, unobserved requirements unknown. If observations are supported, their caller-declared nature must be shown. No implicit not-applicable success. Maintenance owner is a project-configuration reference; unconfigured stays unassigned. A worker or upstream author is not the owner.

## Required implementation checks

Run the actual selector CLI over all three local leaves, including deliberate query correction. Instrument or inject the read operation to prove unrelated leaf bodies were never read, including unrelated ranking bait. A required low-ranking leaf must still load. Exercise missing required leaf, same-size altered content, stale observed bindings, unknown preconditions, no match, cycles, path escape and budget exhaustion. Preserve expected failures. Selection success and execution/coverage states must be separate fields.

The independent five vector groups in [scope inputs](scope-inputs/independent-scope.md) are proposed checks, not completed tests; freeze concrete inputs and expected outcomes before candidate results. Any live product demonstration must be a distinct authorized task using the selector, not a replay that relabels the closed C0 packet. Existing history can be cited only as history. No new model/host experiment is needed to implement the reader; any later experiment requires its own scope, guard and budget.

Before publication, root runs applicable targeted checks and the required repository regression, retains raw results bound to exact code/tree, and applies the established independent review/CI workflow. Build fresh knowledge output for validation; save generated-byte/hash/patch evidence and restore only after all validation. Read-only scope analysis below is not that review or validation.

## Remaining original obligations

W18 actual cross-entry driving, formal evidence resolution and host consumption remain unverified. W19 still owns configured maintenance responsibility, health queries, relevant change triggers, fault classification and actual repair/re-drive under A45. No scheduler is needed to prove that unconfigured periodic work stays off. Original W17 pre-interface causal validation is not satisfied by the earlier post-hoc tutorial. C0, C1 and C2 remain incomplete; all formal gates and whole-capability counts stay unchanged.

## Source analysis retained

- [Implementation proposal](scope-inputs/author-proposal.md)
- [Independent scope and unexecuted vectors](scope-inputs/independent-scope.md)
- [W18/W19 maintenance boundary](scope-inputs/maintenance-boundary.md)
- [Root Git blob bindings](scope-inputs/source-bindings.json)

These three workers only read fixed sources and wrote reports. No product, model, new host experiment or whole-suite execution occurred for this scope decision. No new activity card or PR is created for planning. The next authorized action is implementation of this reader, not another scope-only round or another check of merged PR310.
