# Firstmate remaining native-upgrade and source-context evidence

Implementation commits: `b19f7ade` (managed native backend), `3dff7392` (interruption/recovery repairs), `eae27b87` (persistent source observations and actual context). Integration into the daemon, main CLI, authentication/RPC classification and final repository-wide validation belongs to the parent delivery branch. No real serving home, installed global package or live launchd service was modified by this component work.

## Claude challenge record

Three completed tool-less Claude Code CLI responses are preserved, including exact supplied source, raw JSON and stderr, in [the evidence directory](./2026-10-24-firstmate-upgrade-source-evidence/manifest.json). The command requested `--model claude-haiku-5-5 --effort medium --output-format json --disable-slash-commands --tools '' --strict-mcp-config`, using an empty MCP configuration and isolated settings with hooks disabled and tool access denied. All three JSON responses have `is_error:false`; they were static source reviews and ran no tests.

**Every invocation emitted `unrecognized_model` for `claude-haiku-5-5`.** The returned model label is not proof of underlying model weights or availability of a specific Haiku 5.5 release. These are completed CLI challenges under that requested label, not model identity attestation.

The last completed challenge still reported blockers against its supplied snapshot. The fixes described below were implemented and tested afterwards. A clean final Claude verdict is **not claimed**. At the time this record was written, the parent reported two subsequent Claude authentication-expired failures and requested user reauthentication; final re-audit is pending that external recovery. The new source ledger/context implementation has local tests and manual review, but no completed Claude challenge yet.

| Challenge | Findings and disposition |
| --- | --- |
| R1 P1 startup bypass | Per-home immutable marker, pre-DB full startup gate and lightweight direct-DB marker guard. Parent must wire both entry boundaries. |
| R1 P1 self-attested identity | Exact release metadata/content inventory; actual compiled version/protocol and opened schema checked by `verifyManagedRuntime`; port reads health and DB schema. |
| R1 P1 consumer/writer completeness | Closed private registry and generated services, backend launchd/process checks, native home mutex and application DB exclusive lock. Qualification remains scoped to controlled managed consumers. |
| R1 P1 unknown-effect checks | Known-schema Graph, improvement and follow-up tables required and queried; unsupported schemas fail closed. Source migration 46 adds observations only. |
| R1 P1 timeout ownership | Tracked physical promises; close waits for completion, prevents late lock acquisition, leaves durable failure fence. |
| R1 P2 ordering/publication/current | Code-point digest order; fsynced atomic publications; exact `current` containment under `releases`; verified reruns preserve terminal history. |
| R1 P2 fence before journal | Deliberate conservative quarantine remains: a pre-effect failure can retain the fence. Explicit history-bound reconciliation can recover; no automatic stale-lock deletion or replay. |
| R2 P1 stale socket | Only native ownership, DB lock, connection refusal and same private socket inode allow cleanup. Actual consumer SIGKILL test. |
| R2 P1 partial provisioning | Same approved request resumes exact existing files; foreign or changed files fail closed. Partial marker/publication state cannot silently authorize a different install. |
| R2 P1 existing release | Target staged/verified before apply drains; an existing release is verified/reused. |
| R3 P1 reconcile prestage | Reconcile also stages/verifies before any stop. Reverification after stop is retained to detect changes, rather than following the suggestion to remove it. |
| R3 P1 provisioning socket | Provision uses native home ownership plus the same abandoned-socket proof. |
| R3 P1 temporary publication remnants | Same-inode hardlinks and byte-matching approved publication remnants are finalized on explicit provisioning resume. |
| R3 P1 untracked reconciliation/cleanup | Entire reconcile and complete operations are tracked; nested cleanup does not call close and deadlock. |
| R3 P2 canonical paths/deadlines | Canonical private paths are required explicitly. Native command overall deadline bounds restart RPC/socket waiting; unknowns remain fenced. |

## Local validation

- Native upgrade plan/journal/coordinator/command/backend: **88 tests**, six suites, passed after interruption repairs.
- Source ledger plus four Graph database/child-worker suites: **138 tests**, five suites, passed, including migration 46 in child transpilation lists.
- Source/context/Graph adapter/registry: **58 tests**, four suites, passed. The final source-only suite then passed **11 tests**, including an additional no-automatic-migration case. These overlapping totals are not summed.
- Knowledge context budget: **13 tests** passed.
- Core and CLI strict typecheck passed. Changed-component Biome checks had no errors; the existing optional-chain warning in `context-budget.ts` remains.
- Incremental import of the new core source ledger with the core's existing DB/obligation dependencies loaded: **0.63 ms** in this environment. This is not a replacement for full CLI startup CI.

The evidence manifest hashes every raw record and validation log. Source prompt tests capture the actual adapter's task, compare its prompt digest to prepared/observed receipts, and verify host policy revocation prevents invoking the adapter. They do not infer provider-wire acceptance.

## Remaining environment qualification

Real macOS launchd service lifecycle and platform-specific absence codes; actual published artifact/native-addon deployment; multi-user/native administrator behavior; physical power cuts, OS shutdown and network-filesystem durability; external producer completeness and live source credentials; provider token windows and wire delivery. These need explicit environment qualification and are not counted as passed local tests. The production-supported path is an opt-in private same-UID managed launchd installation with exact artifact/registry/plan approval. No DB downgrade, backup restore, arbitrary fetch, package lifecycle scripts or implicit deployment is provided.

## Independent source review follow-up

A separate Codex subagent reproduced two P1 issues in the initial source commit: repository-local authority could acknowledge a gap, and revoking an earlier source during a later source's asynchronous validation could still dispatch the earlier data. These are independent code-review findings, not Claude results. Repairs reject authority homes inside the bound repository; use bounded private file/ancestor/identity checks; and add a final synchronous source fence immediately before adapter invocation, after all asynchronous validation and prepared receipt work. The fence checks whole registry/policy digests, every selected source's actual bytes/manifest/freshness and current durable observation revision, then rechecks shared authority. No await follows the fence before invoking the adapter.

New regressions reproduce both reported cases and a source-byte replacement after asynchronous validation; actual adapter invocation is prevented. Final source/context/Graph suites: **46 tests passed** (14 source + 24 context + 8 Graph); CLI typecheck and focused Biome passed. Final logs are included in the evidence manifest. Final Claude re-audit remains pending authentication recovery.
