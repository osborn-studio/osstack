# G05 executor evidence

Implemented only protocol graph boundaries and this note. Read the three requested plans, AGENTS.md, and supervisor `review-followup.md` before final validation. Parent owns task status, commits, independent review and full validation.

- Added strict Zod 3 v1 spec/scope/budget/result/error/state contracts, start/resume/cancel requests, ledger effect identities, worker requests/responses and pre-allocation rejection responses. Fixed template is `code-delivery-v1`, publication is `artifact_only`; no topology compiler or checkpoint/ledger implementation.
- JSON input is checked before recursive parsing: at most 65,536 UTF-8 bytes, depth 16, 4,096 values, 16,384 characters/string. Rejects cycles, sparse arrays, accessors, hidden/symbol/prototype-pollution keys, nonfinite values and class/SDK instances. Structured objects reject unknown fields. Resume's explicitly declared JSON data remains inert data, never authority.
- Inbound helpers require trusted resolver code returning separately validated transport scope/current worker binding; absent identity, forged flags and scope/run/generation mismatches fail closed. The resolver is an integration dependency, not cryptographic verification. G10/G12 must bind it to authenticated connections/registry, current grants and atomic fencing. Public schema parsing alone does not authenticate anyone.
- Input digest uses domain-separated SHA-256, sorted object keys and preserved arrays. Only root `metadata` (strict trace/requestedAt) and root idempotency routing key are excluded; nested business time/trace, source request identity, scope and expectedRevision remain significant. A fixed digest vector is tested. Same scope/key/digest replays before revision CAS; changed digest conflicts; fresh resume/cancel requires exact currentRevision. These are pure snapshot decisions; durable transaction/unique-key enforcement remains G08/G11/G12.
- Worker transport retries preserve requestId, generation and business fields. Effect identity includes scope/run/spec/epoch/node/logicalAttempt/slot and excludes generation. Workers request register-or-return by slot; only the ledger allocates logicalAttempt. Unknown/cancel-pending outcomes cannot advertise automatic retry. Artifact references and results require trusted verification in later tasks.
- Existing JSON Schema manifest/generator retained; added `graph.schema.json` registry with root references for recursive JSON and updated `schemas.test.ts` inventory. Its comment documents additional Zod/helper checks that JSON Schema cannot express. No dependency/version changes.

Evidence directory: `/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-kernel-z3zisd4r/evidence`.

| Evidence | Result |
| --- | --- |
| `G05-red.log` | Missing graph module/artifact fails; 134 existing tests pass |
| `G05-green.log` | Initial implementation: 191 tests pass |
| `G05-boundary-red.log` / `G05-boundary-green.log` | 3 rejection/uncertain-retry failures reproduced, then 193 tests pass |
| `G05-run-binding-red.log` | Cross-run resume with worker-bound context fails before fix |
| `G05-final-tests.log` | Final GREEN: 194 tests pass, including 58 graph tests and existing protocols |
| `G05-build.log`, `G05-final-typecheck.log` | Protocol build/typecheck pass |
| `G05-schema-generate.log`, `G05-final-schema-check.log` | Generated registry; all schema artifacts fresh |
| `G05-final-lint.log` | Biome passes for all five changed TypeScript files |
| `G05-import-cost.log` | Before eager barrel export: compiled graph import 9.910166 ms on Node 26.5.0 |

All build/test/schema/lint commands used `node scripts/graph-test-env.mjs -- ...`; no default DB access. Validation is limited to the protocol package on this host; parent handles Node20/22 and full workspace checks. No commits, task-plan writes, nested agents/loops or changes outside the authorized package/evidence scope.
