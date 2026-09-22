# Graph apply → freeze bridge

Date: 2026-09-21. Baseline: `9718086`. Branch: `codex/graph-decision-development`.
Scope: Graph only; Jev remains paused. This is an experimental host integration, not production enrollment.

## Behavior delivered

`freezeGraphChangeset` connects a committed bounded changeset to the existing artifact store. It requires a confirmed implementation/repair outcome and an immutable `applied` resolution in SQLite. A completion artifact left behind by a failed database commit is insufficient.

The bridge checks scope, run, generation, owner, program digest, workspace lease reference, exact implementation receipt, provider terminal, journal digest, proposal digest, usage, and the physical workspace directory identity. It pins the implementation's exact base commit (or the repair action's prior candidate commit), not merely a tree-equivalent parent. It checks FULL/EXTRA WAL, current fence, deadline, cancellation/reconciliation and accounting state. It rechecks after asynchronous host authority callbacks.

The original implementation admission must remain held through freeze. The bridge does not acquire, release, transfer or reconcile that admission. Provider HTTP completion is not physical producer stop: the caller must independently verify the actual canonical lease, registered workspace, current grant, and absence of every physical producer through publication.

`GraphFreezeAuthority.expectedTrees` carries host-derived base/candidate tree hashes. The artifact store snapshots these before any asynchronous work, compares HEAD's base tree and the complete captured candidate tree, and applies the same constraint to replay. The broker now preserves and snapshots these constraints instead of discarding them when binding registrations. Existing v1 inputs/manifests and artifact digest format remain unchanged.

## Integration proof

A fake provider proposes three operations against a real Git repository: create `src/a.ts`, replace `keep.txt`, delete `remove.txt`. Real invocation evidence, SQLite apply intent/completion, physical writes, artifact freezing, bundle verification, replay, and restore are exercised. Restored bytes/deletion and target tree are checked. No provider API is called by the tests; authority callbacks are explicitly fixture capabilities, not evidence of production enrollment.

Rejections cover wrong scope/owner/workspace/receipt/terminal/base commit, extra tracked or ignored content, missing committed completion, released admission, revoked state after a callback, and physical producers still active. Core tests cover constraint mutation, malformed hashes, wrong base/candidate trees, constrained replay and unchanged legacy behavior.

## Claude CLI Opus 5 audit

Read-only CLI review, exact model `claude-opus-5`; no tool access. The first review found no exploitable blocker under the declared trusted-callback/private-store boundary, but requested:

- Explicit journal binding keys: adopted. Every current binding field is scalar; the review's separate hypothetical object-reference concern does not apply to the strict current schema.
- Held admission at freeze: adopted. This deliberately requires a future broker lifecycle change, rather than pretending its current release-after-action behavior works with the bridge.
- Terminal version and provenance checks: adopted.
- Exact parent commit provenance: adopted for both implementation and repair shapes.
- Parsed JSON object guards: adopted; malformed evidence fails closed.
- Ignored-file capture evidence: added a regression test. Capture includes the raw file, causing a target-tree mismatch.

The audit is static review, not execution of our tests. A second delta review raised three claimed blockers. We independently checked them:

- Read consistency: adopted a final read with the *same* fence revision and a second admission check after evidence I/O. Core getters own BEGIN IMMEDIATE transactions and explicitly reject nesting; an outer deferred transaction, as proposed by the reviewer, would break those APIs. Immutable evidence rows plus revision fencing are retained. Added a test releasing admission inside evidence reads.
- Missing binding keys on both sides: the invocation reader already parses a strict schema with required scalar fields. Explicit journal key checks against that validated request cannot silently pass an absent key on both sides.
- Claimed TypeScript narrowing failure: strict `tsc --noEmit` passed; this was an incorrect static-review inference. JSON non-object evidence is guarded; JSON syntax/filesystem errors still fail closed and do not publish a candidate.

The first review's request for ignored-file evidence led to a real failing test: historical capture used `--exclude-standard`. Constrained capture now includes ignored files, including on replay and the final recapture. Its executable mode uses the Git owner bit to match the applier. A separate test confirms the historical capture behavior remains unchanged.

## Remaining production gates

1. A versioned host/registry/compiler profile; frozen v4 must keep its existing behavior.
2. Broker ownership spanning invocation → apply → freeze, retaining admission on uncertainty and avoiding duplicate begin/settle transitions. The existing adapter branch releases after each action and cannot simply invoke this bridge.
3. Real synchronous physical lease/registration/grant verification for apply, and verified input-token upper bounds. Fixture callbacks cannot be promoted.
4. Complete reviewer-envelope transport wired into independently restored review workspaces, with bounded usage and stopped execution evidence.
5. Three-file daemon → independent review/tests → join → ready integration, then recovery/fault matrix and offline evaluation.
6. SHA-256 repositories remain unsupported by the existing artifact format: this bridge fails closed at freeze for those, even though the pure applier accepts their hashes.

No production daemon/DB, paid writer API, Jev key, push, merge, PR publication or release was used.


## Final audit resolution

A third Opus 5 pass was given the strict invocation parser and core transaction implementation. It explicitly withdrew the three claimed blockers and reported no remaining concrete blocker within the experimental scope. It did not run tests. Physical exclusion and trusted directory ancestry remain host prerequisites; this is not a production-readiness approval.

| Review | Actual model | Complete response | Response SHA-256 |
| --- | --- | --- | --- |
| Initial | claude-opus-5 | is_error=False | `98111a173bb4ad08a828d687f78fdf394a1db183456a7a4054e517de8b25beb4` |
| Delta | claude-opus-5 | is_error=False | `e6659845ca6eff556718d7ccaecd593ffdc3bb2dda9f36188e57e9988867881a` |
| Resolution | claude-opus-5 | is_error=False | `38b2fb460dd5c1522a5b737e9498ba9be6b05f2c0c39b1d77b7d91a2ae5fbe38` |

The local raw responses are `/tmp/osstack-freeze-opus.json`, `/tmp/osstack-freeze-opus-final.json`, and `/tmp/osstack-freeze-opus-resolution.json` (temporary files, not durable repository artifacts). The adopted/rejected findings and reasons above are the durable record.

## Validation

- Core artifact suite: **28 passed**.
- CLI host invocation/apply/freeze: **44 passed**. Total across the listed suites: **139 distinct passing tests**.
- Broker and boundary suites: **53 passed** (36 + 17).
- Existing action-freeze, delivery and compatibility integration: **14 distinct cases passed** across the initial run and targeted environment rerun. One compatibility case initially hit the machine's disk-space guard (system volume about 2.3 GiB free); rerunning that case with a private external-volume TMPDIR passed. No health threshold changed.
- Core build, CLI build and strict CLI typecheck passed. Biome and inventory freshness checked.
- Initial new tree-constraint tests were RED before implementation; the ignored-file regression was also RED before constrained capture changed. One new owner-binding test hit its unchanged 5-second timeout under concurrent suite load; the host suite was rerun alone, without relaxing assertions or timeouts.
- No claim of a full-monorepo run or a production daemon end-to-end acceptance run.
