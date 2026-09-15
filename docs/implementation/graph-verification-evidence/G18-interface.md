# G18 proposed interface (before implementation)

Owned modules: registry.ts and spec-compiler.ts (+ focused tests). No exports/integration edits.

- GRAPH_REGISTRY: deeply immutable versioned fixed registry; registered input/output field kinds, tools, costs, routes.
- validateGraphRegistry(unknown): validates and snapshots the fixed allowlist. Trusted host may change registry/schema version labels; definitions/costs/routes cannot change through this API.
- compileGraphSpec(unknown, registry = GRAPH_REGISTRY): pure (except SHA256), returns deeply frozen {spec, specHash, compilerVersion, registryVersion, schemaVersion, plan, budget, source, compiledProgramDigest}.
- validateGraphPlan(plan, registry): validates the compiler's fixed topology and typed mappings. Not an arbitrary topology admission API.
- Plan node: {id, taskName, epoch, operation, effectSlot, inputs, maxLedgerAttempts}; input mapping identifies a spec/start field or predecessor node output + field and declared field kind. join is a reserved pure node; all effect nodes carry trusted registry token costs. Branch attempts reserve ledger retries for the SAME slot; no new logicalAttempt or effect slot is emitted.

Execution boundary: selfcontained ESM export run(ctx) consumes the existing GraphWorkerProgramContext. Worker runtime provides the Functional entrypoint; emitted source creates stable named ctx.task functions and invokes ctx.action for epoch0 workspace_create -> implement -> freeze -> ordered parallel review/tests. Dynamic lease/receipt/candidate values come only from validated predecessor outputs. It returns the candidate and complete ordered branch results to the enclosing entrypoint. No production saver is replaced.

G19: host registers all planned epoch/node/slot/actions against trusted workspace/capability/evidence resolution. Per-action workspace integration remains host-owned; worker action mappings are requests, never authority. acceptanceRef resolves the trusted test command specification (no command text in spec).
G20: consume fixed candidate + ordered review/tests outputs for join/routing. Emitted G18 scaffold does not claim G20 routing/G21 complete template. Later epochs and finite ledger retries are fully reserved but not automatically dispatched; extending execution requires a new exact-source digest/compiler version. Do not append source while retaining the old digest. No generic callbacks/code/topology are accepted by compileGraphSpec.

Budget: reserve workspace_create, implement/repair, freeze, review, tests per epoch. Review/tests each reserve maxBranchAttempts starts and trusted tokens; other operations one each. join is pure. Explicit host retryAuthorized owns retry admission; uncertainty never selects a fresh slot. Repository lifecycle/release and complete repair feedback/template integration remain G21 work; scaffold returns artifact candidates, not a ready/publication claim.

Decoded plain JSON is the contract boundary (hostile in-process Proxy traps are not supported). Typed output structure and request correlation are checked; host independently validates stored evidence and workspace provenance. Compilation performs no IO and never runs supplied functions/accessors.
