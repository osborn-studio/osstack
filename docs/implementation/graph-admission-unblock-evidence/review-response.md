Reviewed the diff against the supplied sources for the stated semantics. No tools were used; fixture code was not supplied, so two test assumptions are flagged as unverifiable.

**Correctness and security findings**

- **Admission gate is correctly placed.** `packages/cli/src/graph-rpc.ts:184-193` runs the `admitNewRuns` and `assertGraphDeliverySupported` checks inside the immediate transaction, after `authorize()`, before `runs.create`. A throw rolls back with no `graph_runs`, `graph_requests` or `graph_public_delivery` row. Gating on `!prior` is exact: a prior row means `create` replays rather than reserves, and a mismatched digest still yields `IDEMPOTENCY_CONFLICT`. I found no path that creates a new reservation while skipping the gate.
- **Fail-closed on non-true values holds.** `admitted !== true` rejects `false`, Promises, and truthy non-booleans, and the stray Promise is settled with a no-op catch. No blocker.
- **Three defensive layers are consistent.** Service snapshot at `graph-rpc.ts:184-193`, `GraphDelivery` constructor at `graph-delivery.ts:80`, and broker bind at `graph-action-broker.ts:182`. The broker check runs before intent reservation and capacity acquisition, and it also covers the reviewer adapter installed later through `prepareGraphVerificationBranch`.
- **Existing work is not halted.** Resume, cancel, status, result and the in-run `retryAuthorized` path never consult `admitNewRuns`. The deferred launch and epoch takeover reuse the snapshotted delivery, which was already asserted at reservation.
- **Config reread is owner-only.** `graph-rpc.ts:298` reads through `trustedConfig`, which enforces mode and uid. The flag is top-level and excluded from `bindingDigest`, so toggling does not invalidate the registration. Omission defaults to enabled as documented.
- **Wrapper `confirmStopped` change is benign.** `graph-action-broker.ts:543` now returns `{ stopped: false }` instead of falling through to the command branch. Both were fail-closed. After the new assert, the `original.confirmStopped` is always present, so the new fallback is dead code. Not a blocker.
- **Minor: two independent config reads per new admission.** `authorize()` and `admitNewRuns()` each open the file. An owner racing their own atomic replace can validate the binding against one version and read the flag from the next. Worst case is a reservation that fails at launch with status `failed` at generation 0. Not a security issue. Folding the flag into the `authorize` read would make it one snapshot.
- **Minor: config errors surface as the wrong public code.** If `trustedConfig` throws inside `admitNewRuns` you get `INTERNAL_ERROR`, and a Zod failure maps to `INPUT_CONTRACT_INVALID` via `graphRpcError`. The CLI then advises `fix_input`. This is fail-closed and identical to the pre-existing `authorize()` behavior, which runs first anyway.

**Test gaps**

- No test for a truthy non-boolean `admitNewRuns` return such as `1` or `"true"`. The code handles it, but the async test is the only non-boolean case.
- No test for an omitted `admissionEnabled` through `loadLocalGraphRegistration`. The reload test only exercises explicit `false` and `true`.
- No test that the switch flipping to `false` between the reservation transaction and the `setImmediate` launch still launches. The disable test flips after the writer is observed, and the reload test cancels before launch. The code is correct by inspection, but the "reservation is the cutoff" claim in the docs is not directly exercised.
- The first and third admission tests rely on `delete f.writer.confirmStopped` reaching `f.registration.delivery.writer.adapter` by object identity. If `graphRpcFixture` wraps or clones adapters, those tests pass for the wrong reason. Same dependence in the new broker test on `fixture(adapter)` holding the adapter by reference. Verify in the fixture.
- No test that the CLI keeps `retryable: false` for these codes when the server message is long or empty. Low value.

**Pre-existing limitations, not introduced here**

- Queued runs from a dead host are never relaunched by a replacement host. The fresh-host test documents that they stay `queued` until cancelled.
- Adapter `confirmStopped` remains self-attested, subject only to the one-second race in `execute`. This slice only requires its presence, as stated.
- `INTERNAL_ERROR` mapping to `fix_input` in the CLI predates this change.

**Verdict**

Accept as the bounded slice. No blockers were introduced. The gate rejects unsupported writer or reviewer and disabled admission before any durable reservation or effect, false and async results fail closed, replay, read, result, cancel and live resume keep their existing grant checks, and the config is owner-only and reread. The dead fallback branch and the double config read are cleanup candidates, not conditions for merge. The test gaps worth closing before G26 relies on this switch are the truthy non-boolean return, the omitted-flag default, the flip-between-reserve-and-launch case, and confirming the fixture shares adapter objects by reference.
