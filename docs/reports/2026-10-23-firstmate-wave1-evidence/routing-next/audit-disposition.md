# Routing golden audit disposition

Both calls requested `claude-haiku-5-5`, with tools/hooks/plugins/MCP/memory/persistence disabled. JSON results report modelUsage key `claude-haiku-5-5`; stderr includes unrecognized_model. This records the CLI request/response, not independently verified backend model identity.

Round 1 confirmed P0=0, P1=1, and listed six P2 defects plus coverage suggestions. Changes:

- P1 argv truncation: reject `=` in role_overrides values, the only IDs encoded as --role key=value. Structured builder/evaluator IDs retain their original semantics. Regression asserts no profile runner invocation on invalid input.
- P2 unreadable JSON hash: explicitly null dataset_hash, with an incomplete report and no claimed dataset.
- P2 missing/malformed capability output: undefined cannot become intentional null/no candidate; validate selected output; regression mocks malformed production returns only in the dedicated defensive test file.
- P2 ambiguous capability IDs: reject duplicates across adapters per case.
- P2 environment/config tests: defaultAdapters and loadConfig spies throw if reached; real CLI bridge provides all fixture dependencies and a fixed profile/hostname/model.
- P2 invocation counter: report explicitly says fixture_invoke_attempts; fixture adapter throws on attempted execution; report snapshot cannot be mutated after return. This measures attempts during the evaluation, not future use of a retained library callback.
- P2 expected mutation: snapshot expectations before invoking the trusted bridge and compare against that snapshot.

Round 2 independently reports confirmed introduced P0=0, P1=0, P2=0. Its latent concerns are not current CLI-path defects: future router error-code shape changes; non-JSON direct library inputs and canonicalization; post-return fixture invocation attempts outside the snapshot. Scope is documented and no provider client is created. Existing soft role preference fallback, generic capability fallback, and adapter-only independence remain unchanged and have explicit regression cases. Suggested additional coverage is future work, not claimed exhaustive coverage.

Evidence: audit-context.txt / audit-result.json / audit-stderr.txt, audit-round2-context.txt / audit-round2-result.json / audit-round2-stderr.txt, implementation-manifest.json, and verification-summary.json. All source changes are separate from the primary checkout WIP.
