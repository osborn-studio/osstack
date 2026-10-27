# Final implementation audit dispositions

Candidate under final validation: `20b4a81dfcffd80b4919643be362dcfcefad7cf5`.
This is the host's assessment. Raw model findings remain unchanged in round1–round6-raw.md;
model identity, invocation outcome and input hashes are in each run/manifest JSON.
The final review and verification result must be read from their actual receipts, not inferred here.

## Confirmed defects fixed

- R1: committed send results overwritten by cleanup, pre-handoff duplicate result overwritten,
  and Session start result/active marker lost during cleanup. Concrete real DB/RPC/lock tests.
- R1/R2: evidence candidate/limitations binding, strict identity tokens and bounds, dependency closure,
  typed source manifest membership, authenticated duplicate detection, independent byte budgets.
- R2: public API renamed to evaluateBehaviorRegistry, explicit caller-trust boundary, independent
  expected/observed registry digests, restricted CI/host differences, SPKI-only key input.
- R3-H6: registered adapter may exhaust a stream without terminal; start previously recorded success,
  send returned failure but released without stop confirmation. Fixed separately, with red/green proof.
- R4-01: authenticated cross-issuer record-ID conflict. Uniqueness now uses signer + record ID.
  Revocation targets complete canonical document digests; old bare-ID host input is rejected.
- R4-03/05: deterministic chain choice, no qualification hashes on ineligible entries, fingerprints of
  registry version, full revocations, trust configuration, windows and epoch floor.
- R4-H1: identity Ed25519 key accepts a trivial signature in the observed Node/OpenSSL build.
  Known degenerate encodings and sign variants are now refused using fixed libsodium reference data;
  actual verification remains Node crypto. No new curve arithmetic or dependency was introduced.
- R5-01/02: successful cleanup and post-terminal fault coverage. Four happy-path tests include the
  actual CodexCliAdapter with a local fake executable; four trailing-fault tests prove retention.
  Two deliberate code mutations were caught. Final source was restored and hashed before commit.

## Scope decisions, not concealed fixes

- R1 failed/unknown evidence remains valid diagnostic wire data; R02 requires passed evidence.
- R2/R4 raw input flooding: limits remain finite and fail closed. Host must select a bounded,
  provenance-filtered snapshot. No availability claim for an attacker-controlled append-only store.
  Moving caps after unlimited parsing/signatures would defeat resource safety and was not adopted.
- R2/R4 caller clock/root/pins: the evaluator cannot authenticate its own caller. R05/V06 must supply
  independently authenticated keys, full revocations, persistent epoch/digest floor, build/host/time.
  Package exports or types are not an authority boundary. No daemon path uses this library yet.
- R3/R5 fresh-process drain visibility remains DEBT02/J11/J12. Existing reconcile locks refuse stale
  automatic reuse, but fresh daemon drain does not enumerate all retained obligations.
- R3/R5 identity-only cleanup diagnostics correlate logs; they are not durable recovery evidence.
- R3-H5: the concrete metadata guard wait is bounded at two seconds and was fault-probed. Arbitrary
  filesystem stalls remain unqualified; a detached timeout was not introduced.
- R3-H7: Session leases are not passed through withWriteGuard; its release rejection is unreachable
  in the present Session call graph. Future callers must preserve this ownership boundary.
- R5 synchronous supervision hypothesis: the concrete SupervisionService schedules work through
  Promises and returns a Promise on every path; its callback failures are asynchronous. A substituted
  throwing implementation is not the production construction inspected here.
- Start replay RPC ok means a stored snapshot was read; clients must check state. Failed/starting
  snapshots do not become successful execution. Existing semantics are now documented.
- Per-invocation positive stop evidence, cross-protocol issuer key custody and revocation pruning
  remain prerequisites for future providers/trust operations; not claimed delivered in this batch.

## Evidence and external limits

A reviewed B receipt paths; B performed 50 independent R02 probes and an earlier 57 contract checks.
These bind their recorded file hashes, not every later edit. Final integrated tests/audit bind the final
candidate separately. No audit output is itself a production qualification record.

The new Session failure scenarios have no live Claude/Codex provider-fault, OS reboot, physical power
loss, cross-host or long-soak qualification. Normal local subprocess adapter parsing was exercised.
No production OSSTACK_HOME or deployment/npm channel was modified.

Shared J01/J11 work is separately submitted as #272 → #273 → #274. Current code has no joint imports
or competing method/recovery authority. Candidate recovery DDL is not a registered migration or J12
implementation. The combined unmerged joint branches have not been tested by this batch.
