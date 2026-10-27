# Final adversarial source review: OSStack candidate `20b4a81d` (base `ce543535`)

**Verdict: PASS_WITH_CONCERNS.** I found no concrete P0, P1 or P2 defect in R01, R02 or the Session boundary.

I read the source only and executed nothing, so I have not confirmed that any test passes. The specific checks you named were cross-signer conflict, digest revocation, low-order keys, chain selection with context anchors, and cleanup bypassing stop confirmation. All hold under the stated host-trust model.

## Disposition of the checks you named

| Check | Result | Basis |
|---|---|---|
| Cross-signer record-ID conflict | Fixed | `behavior-registry.ts:319` scopes IDs by `canonical([signer_key_id, record_id])`. Conflicts are computed at `:320-326`, only over records that already passed `authenticationError`. Duplicate public keys are rejected at `:196` via the SPKI fingerprint, so a second `keyId` cannot be used to dodge the scope. A revoked or expired duplicate is excluded before conflict detection. |
| Digest revocation | Fixed | `:286` matches the SHA-256 of the raw canonical bytes, which `parseArtifact` forces to equal the canonical serialization. Predecessor links use the same digest. A revoked predecessor leaves `verified`, so `chain()` at `:332` fails. The legacy `revokedRecordIds` field is rejected at `:178`. |
| Low-order key rejection | Fixed, with a gap noted in H1 | `:106-113` clears the sign bit and checks the seven libsodium y-encodings, which I confirmed cover every small-order point plus the p and p+1 aliases. The check runs after the `ed25519` type check and before the key is stored. It does not reject non-canonical aliases of full-order points or mixed-order keys, but those cannot forge a signature without the private key. |
| Deterministic chain selection and context anchors | Fixed for selection, with a diagnostics gap in F2 | Authenticated and verified records are inserted in sorted-digest order (`:320`). Selection uses a strict `>` on effective validity at `:371`, so ties go to the smallest journey digest. A journey digest determines its chain uniquely. The context carries the registry version, the revocation snapshot digest, the trust digest, the epoch floor and both window limits (`:226-235`). |
| Successful cleanup bypassing stop confirmation | No bypass found on a non-completed stream | In start, `settled` is set only after the loop and the `terminalCompleted` check (`daemon.ts:669-670`). In send, `settled` moved to `:1049`, after the check. Early returns, exceptions, a failed terminal, and a completed terminal followed by a fault all leave `settled` false. The `finally` blocks at `:720-733` and `:1095-1111` then abort, call `confirmAdapterStopped` (which returns false when the verifier is absent, throws or times out), and retain. `retain()` quarantines before writing stderr (`governed-execution.ts:227`), so a throwing stderr cannot undo retention. |

## Concrete findings (all P3, none blocking)

### F1. Start releases without stop proof when a completed terminal arrives with no native session id
- **Where:** `packages/cli/src/daemon.ts:670-671`. `settled = true` is set before the `nativeSessionId === undefined` throw.
- **Reproducer:** use a `startSession` that yields an `assistant.message` and `session.terminal: completed` but never emits `native_session.started`. Set `failCleanup: false` and `stopUnconfirmed = true`.
  - Observable result: the session ends `failed` and the response is `agent_failed`.
  - Stop-verifier calls: `stopChecks` stays `[]`, because `finally` takes the release branch.
  - Drain: `drained: true` with zero holds.
- **Impact:** low. A completed terminal plus a drained iterator is the stated baseline, and every shipped adapter converts the missing-native-id case into a failed terminal (`claude-code.ts:419-426`, `codex-cli.ts:495-502`, `controlled-session.ts:233`). It is still an incomplete outcome that is reported as failed yet releases the writer without stop proof, and no test pins it.
- **Fix:** move `settled = true` below the native-id check, and add the test above. Conforming adapters are unaffected.

### F2. `qualificationRejections` is not input-order independent when invalid documents are present
- **Where:** `behavior-registry.ts:268-276`. Parse and oversize rejections are pushed in input order, while later rejections are pushed in digest order. Oversized entries carry `sha256: ""`, and identical invalid bytes supplied twice are pushed twice.
- **Reproducer:** pass `[junkA, junkB, ...valid]`, then the reversed array. The `qualificationRejections` arrays differ, so `toEqual` between the two snapshots fails. The existing determinism test uses only valid records.
- **Impact:** the winner and entries are deterministic. Only diagnostics vary, which matters if a host fingerprints the whole snapshot.
- **Fix:** sort the final rejection list by `(sha256, reason)`, and add an index or reason for the empty-digest case.

### F3. `readArtifact` is invoked unbound
- **Where:** `behavior-registry.ts:158, 257`. It is captured as `const readArtifact = input.readArtifact`.
- **Reproducer:** pass `readArtifact: store.read` where `read` uses `this`. Every read throws, is caught, and the result is `source_unavailable` or `evidence_unavailable`.
- **Impact:** fail-closed only. The guide at `docs/guides/behavior-registry-evaluator.md` says the reader is synchronous but does not mention `this` binding. An async reader also fails closed, because a Promise is not a `Uint8Array`.
- **Fix:** document "pass an arrow function or bound function", or invoke it as `input.readArtifact.call(input, d)`.

### F4. The built-in Codex test asserts stop checks on the wrong object
- **Where:** `session-send-receipt.test.ts:480`. `adapter.stopChecks` refers to the module-level `ReceiptAdapter`, not the registered `CodexCliAdapter`.
- **Impact:** the assertion is vacuous. The `drained: true, execution_lease_holds: 0` assertion at `:482-484` still catches a stop-then-release regression, so coverage is intact.
- **Fix:** delete the assertion, or assert against the registered adapter.

## Hypotheses and observations (not defects)

- **H1: Ed25519 signature malleability with S ≥ L.**
  - If the platform verifier accepted `S+L`, a third party could produce a second valid encoding of any signed record. That would evade exact-digest revocation and, because the variant shares `(signer_key_id, record_id)`, would create a conflict that denies the legitimate record.
  - The regex at `behavior-capability.ts:114` checks only canonical base64, not S < L, so the evaluator itself does not defend against this.
  - I believe modern OpenSSL rejects S ≥ L and canonical-compares R, but I could not confirm that for the Node and OpenSSL build in use.
  - A cheap pinning test would sign, add L to S, and assert the variant is rejected.
  - If the test fails, add an explicit S < L check in the evaluator.
- **H2: Claude adapter EOF completion.** `claude-code.ts:419-429` synthesizes `completed` at SDK EOF when a native id exists. For that adapter the no-terminal fence cannot catch a truncated stream. This pre-dates the candidate and belongs to adapter scope (require a `result` message).
- **H3: abort after completion retains.** If `controller.signal.aborted` is true when a completed turn reaches `finally`, the code requires stop proof (`daemon.ts:722, 1097`). Shipped adapters have none, so the lease is retained even though the result was committed. This is fail-closed and consistent with DEBT02, but I did not verify whether drain aborts runs in that window.
- **H4: shared swallow in other callers.** Other callers of `acquireManualSessionAdmission` and `executeReservedSessionTurn` (attention, engineering, continuation) inherit the new release-error swallow. They are not visible in this diff and not exercised by the added tests. The behavior is the intended one.
- **H5: spy interception.** I could not verify that `vi.spyOn(autonomy, "acquireRepoWriteLock")` intercepts the live import in `governed-execution.ts`. The `cleanupAttempts` assertions would fail if it did not, so the reported passing logs imply it works.
- **H6: round-5 finding 6 (`requestSupervisionScan` throwing synchronously).** The supplied `requestScan` (`supervision-service.ts:100-115`) returns a Promise on every path and cannot throw synchronously, so I consider this closed for that implementation.
- **Optional hardening.**
  - Size checks on trust-key elements and policy scenario arrays run after `structuredClone` (`behavior-registry.ts:168-212`), so a hostile host could still force large clones. The host is trusted by design.
  - The cleanup diagnostic (`daemon.ts:1115`) is a catch-all with no phase field. The `retain_log_throw` test would also see a hold count of 1 if `retain` had not set its flag, so it does not prove quarantine. Asserting a second admission in the same repo is denied would pin it.

## Documented limits (not defects)

- R02 does not authenticate roots, the clock, build pins or host identity, does not persist epochs, and has no caller.
- Raw count and byte caps fail closed. One shared 64 MiB evidence budget applies, and sources can starve later entries. This is deterministic and documented.
- Shipped Session adapters have no stop verifier, so any non-completed path retains until restart plus reconcile.
- Cross-process drain visibility and operator recovery remain DEBT02.
- Start replay returns `ok: true` with `state: failed` or `starting`. The changeset now says clients must check `state`.

## Test additions

None is required to merge. Recommended, in order:
1. A completed-terminal-without-native-id start test (F1).
2. An S+L signature rejection test (H1).
3. An input-order determinism test for `qualificationRejections` with invalid documents (F2).
4. The same valid record bytes supplied twice, to pin that identical digests do not self-conflict. The `Map` dedupe at `:275` and the `previous !== digest` guard at `:324` appear to handle it.

AUDIT_COMPLETE
