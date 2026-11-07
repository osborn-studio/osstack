# Cold restart integration review

Worker: `gpt-6.1-sol`. Date: 2026-11-07. Status: active review; no 5-G qualification.

## Snapshot record

| Snapshot | Evidence | Verdict |
| --- | --- | --- |
| `b44a9ddf8506f21aa0b0f776d54b30a2e4337e2c` | Driver source reviewed through git objects. Selected installed-runtime provenance exists for candidate source `78abb868c64488e7e2ae303cb54c60ef02f0fb11`. | Driver still replaces the host in-process. No cold helper descriptor or parent reclaim/rebuild integration yet. Acceptance gap remains explicit. |
| `523d860a590834a85aa2eac214fe86e6a744861b` | Adds the accepted helper/tests/report to the driver owner's branch; driver blob `b85cbf050025fff9eafe9819be7c0521ff981412` is unchanged. | Helper present; driver integration still missing. |
| `dd1ad6c2`, observed at tip `9376dfecfbc5afbdfc62de9d511024fc4b63db34` | Driver blob `6fac7f10268aa8be4a0e12ca3f9e266ff9b96352`; helper blob remains `a4a3bf92dabe79d8544c31c2dc01dc12b045a279`. | Cold handoff integrated. Descriptor shape, cancellation-first isolation, and parent rebuild are present. Durability and failure masking remain open. |
| `caee026de7286f704990bc0e48ca8086213c48eb` | Driver blob `4b8ae3c2` adds the publication authority hook; helper unchanged. | Reopened parent ports are rewrapped with the real publication hook. Cold descriptor and shutdown/reclaim sequencing remain unchanged; no unchanged product gate rerun. |
| `961202391c91d48132e5a64a62926cb9f149a3f4` | Delta tightens revoked-authority receipt/journal proof only. Installed provenance metadata unchanged. | No cold source change; existing product gate not rerun. |

Only changed source snapshots are reviewed. No other checkout is opened or edited. Parent inbox and STOP marker are checked during the watch; absent on the initial snapshots.

## Product findings

### P2: fresh product connections use NORMAL and recovery writes fail

Helper source blob: `a4a3bf92dabe79d8544c31c2dc01dc12b045a279` (commit `81d4401f`, also present at owner snapshot `523d860a`). `recoverCancelledSandboxMission` calls `core.openDb({path})` and constructs real stores without promoting connection durability. Installed `openDb` sets `PRAGMA synchronous=NORMAL`. `ContainedMissionStore.write` requires FULL. Connection-local synchronous settings do not carry over from the closed parent connection.

Repro uses the new product fixture with a private real control.db, existing root/child/chain, released root claim, active cancelled-child claim, no pending receipt, and a closed target chain. The fresh worker exits 1 (`COLD_WORKER_FAILED`) and cannot release the child's claim. This blocks the positive real-product recovery case. The fake helper suite does not exercise this requirement.

The driver snapshot at `b44a9ddf`/`523d860a` also opens with default NORMAL before its first `missions.authorize`, so it separately reaches `durability_required`. The product test initially reproduced this during fixture seeding. The fixture now sets FULL on its own parent connections so it can isolate the worker defect. No existing helper, driver, or runtime file was changed.

Required integration repair: set FULL on every newly opened parent and worker control connection before constructing or using Mission/chain write paths. Then rerun the product positive case. This report does not treat the current product failure as a pass.

At driver blob `6fac7f10268aa8be4a0e12ca3f9e266ff9b96352`, both initial open (line 316) and parent reopen (line 429) still use the NORMAL default. The helper is unchanged. No unchanged product gate was rerun for that source review.

### P2: cancel_requested recovery leaves its terminal claim for a later recovery pass

Actual `ContainedMissionHost.recover` takes the cancellation branch for `cancel_requested`, transitions to `cancelled`, and returns. Claim release is in its separate terminal-state branch. `tick` does not release a terminal Mission's active claim. The current helper accepts `cancel_requested` but requires a released final claim after only one recover/tick cycle.

Confirmed with real installed host/store APIs after fixing durability only in the new product fixture's own parent connection: one `host.recover()` yields `cancelled` with an active claim; `host.tick()` leaves that claim active; a second `host.recover()` releases it. No external command was invoked. Helper blob `a4a3bf92dabe79d8544c31c2dc01dc12b045a279` therefore has a second false-negative path even after its durability issue is fixed. Parent integration must either require an already cancelled child at handoff, or the helper owner must deliberately complete the terminal-claim recovery phase. This reviewer does not edit that helper.

The newly integrated driver cancels before the child's first host tick. Its current no-process route normally returns `cancelled`, so the narrower driver scenario avoids the pending-cancel branch. This does not repair the helper's advertised pending-cancel contract or establish cancellation after a released write.

### P2: a failed parent reopen replaces worker failure evidence

Driver blob `6fac7f10268aa8be4a0e12ca3f9e266ff9b96352`, `handoffSandboxColdRestart`: `try { return await restart(); } finally { await reopen(); }`. If both phases reject, JavaScript propagates the finally rejection. The original `COLD_WORKER_FAILED`/timeout and its child PID/exit/signal evidence are lost. The new helper-order tests cover worker failure with successful reopen, but not double failure.

Source-level repro: call the exported handoff function with successful `close`, `restart` throwing an Error containing worker exit evidence, and `reopen` throwing `Error('reopen-failed')`. The caller receives only `reopen-failed`. Preserve the primary worker error and attach the reopen failure separately, as the driver's existing outer cleanup contract already does. This finding is source-derived; the live driver was not executed to reproduce it.

## Focused product fixture

New owned test: `scripts/bridge-sandbox-cold-restart.product.test.mjs`. It requires explicit `OSSTACK_COLD_PRODUCT_RUNTIME_PREFIX`; otherwise it reports skips. The selected prefix is inactive and read-only. It uses real installed core/runtime exports, real SQLite/store APIs and real host/factory/access construction. It never copies or modifies installed modules.

The fixture has no executor, verification job, host process, pending receipt, or open chain. App key references contain invalid non-credential text. The Docker socket is a nonexistent private path. PATH points to local gh/git/docker/codex tripwires, and tests require that none is invoked. Only local store transitions create synthetic fixture history. No SQL trigger is disabled.

Command:

```sh
env OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack \
  OSSTACK_COLD_PRODUCT_RUNTIME_PREFIX=/Volumes/AIMATE_WORK/osstackgrokbot/releases/candidate-78abb868c644 \
  node --test scripts/bridge-sandbox-cold-restart.product.test.mjs
```

Initial execution: 2 failures at fixture `authorize`, both `durability_required`. After adding FULL to the new fixture's own connections: 2 failures. The positive worker case exits 1; the pending-cancel case remains `cancel_requested`. These failures are preserved. They are not the existing fake suite's passing evidence.

The follow-up fixture separates those issues: **1 passed, 1 failed**. Its characterization case proves NORMAL write refusal, real fresh-worker owner persistence on the same DB inode, parent reclaim and real factory/access reconstruction, and the two-pass claim behavior above. Its positive end-to-end product helper assertion still fails (`COLD_WORKER_FAILED`, worker exit 1), as expected while the helper durability defect is unresolved. Logs: `/Volumes/AIMATE_WORK/tmp/osstack/bridge-cli-cold-restart/product-tests.log`. The new test's syntax check passes. No timeout was increased and no product assertion was skipped when the explicit prefix was supplied.

Installed provenance observed:

- Source: `78abb868c64488e7e2ae303cb54c60ef02f0fb11`.
- Runtime entry SHA256: `d4ebd2adbce778b4ae108595f41de1d0876b922602ee11e79afd982d101e6fa7`.
- Core entry SHA256: `d64887e3e893727ff3fc9a09da9f26e9b445b4b0b40d2a9df095ab012a59a4ec`.
- Prefix: `/Volumes/AIMATE_WORK/osstackgrokbot/releases/candidate-78abb868c644`.

## Integration gates still open

- Descriptor uses the actual selected provenance entry paths/hashes and same canonical prefix/source in parent and child.
- Parent awaits all old scheduler/scanner/host/outer-loop closes, then closes the original DB before invoking the worker.
- Real child owner claim and recovery operate on the same persisted private DB.
- Parent reopens, sets durability, reclaims ownership, and rebuilds stores, ports, access, host, and production factory before further scenarios and cleanup.
- Global recovery/tick is isolated from peer unfinished Missions and other live chains. Reordering before the halted workflow scenario can remove that peer; other nonclosed chains still need a deliberate isolation decision under the helper contract.
- Authority config remains private and outside the repository, uses the same authenticated principal/session, and is rebuilt after reclaim.
- Installed entry and source-marker hashes remain unchanged across handoff. Entry hashes do not independently pin transitive imports.

### Review of integrated source at `9376dfec`

- Descriptor keys exactly match the helper contract. `BridgeConfig` has no spurious version field; Codex and verification options use real option names; module `{path,sha256}` objects come directly from selected provenance. App and binary/socket references are canonicalized, and apps.json is rewritten to the same canonical App references.
- Cold cancellation runs before A/B and workflow scenarios, so it has no peer live chain. `rootMission` explicitly calls host recovery after publication to release the root claim. This addresses the prior global-scan isolation objection without weakening the helper guard.
- Normal shutdown awaits check retry, live, stopped scan, and host close in sequence, then closes DB and clears old host/bridge references before invoking the worker. The surrounding root/review/dispatch loops are awaited manual loops; no separately started service timer appears in this path. A shutdown rejection prevents worker launch. These are source sequencing observations, not physical shutdown proof.
- Reopen uses the same selected core module, same DB path and canonical runtime tree; it creates fresh attention/owner, Mission/chain stores, access, ports, host, and factory. Closures reference the updated bindings. The outer cleanup reads those current bindings rather than retaining stale stores. FULL still must be set on the reopened connection.
- Authority stays at home/authority.json, outside the repository, and a fresh EngineeringAccess reads it after reclaim. The real product characterization test also constructs that access implementation and refreshes its original principal/session after reclaim.
- The selected provenance source and entry hashes are saved in the report. The helper revalidates both entry hashes before child import. The driver does not independently rehash its source marker on reopen; keeping the selected tree frozen remains a caller obligation. The product fixture checks its selected entries and manifest before cleanup, including failure paths.
- The helper itself returns `parentShutdownProven: false`; driver source does not turn it into physical shutdown proof. No real sandbox execution or end-to-end cold evidence is available at this snapshot.

No full build/suite or real sandbox execution was run. Production gate is CLOSED. The review does not establish remote-head stability, App identity capability, parent physical shutdown, or full 5-G acceptance.

Git staging was attempted after the focused checks. It failed with `Operation not permitted` while creating the shared worktree `index.lock` outside the writable checkout. These two new files remain unstaged. No permission bypass or alternate git index was attempted.
