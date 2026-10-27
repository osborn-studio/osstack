# Review: OSStack candidate 635be2a (R01 protocol + DEBT03 receipt fix)

I treated the first line of the request (R01 and DEBT03 only, R02 deferred) as controlling. The later "R02 trusted registry loader" scope sentence contradicts it, so I did not report the loader's absence or review loader safety. This review is static: I ran nothing and had no test output.

## Verdict: PASS_WITH_CONCERNS

I found no P0 or P1 issue. The DEBT03 core claims hold on code reading. The R01 schemas are shape-only as claimed, but they leave several trust-relevant gaps that should be closed or documented before R02 consumes them.

## Proven findings (from the supplied source)

**1. P2: Qualification payloads can carry failed, unknown or not-run evidence.**
- Location: `behavior-capability.ts:71-73` (`EvidenceList`) and `:83` (`evidence_refs: EvidenceList`).
- The evidence list is shared between `BehaviorEvidenceBundleV1`, where failed results must be representable, and the signed qualification payload. A record claiming `level: "contract_tested"` therefore parses with every evidence entry `result: "failed"`.
- Reproducer: take the test's `qualification` and set `evidence_refs[0].result = "failed"`. `BehaviorQualificationV1.safeParse` succeeds.
- Impact: any consumer that treats a parsed qualification as "level reached" is one missed check from accepting a failing record. This is defense in depth, since the signature and verifier come later.
- Fix: use a separate `PassedEvidenceList` in the qualification payload that requires `result === "passed"`. Keep failed results only in the bundle schema.

**2. P2: The evidence bundle does not bind candidate or limitations, as ADR-09 requires.**
- Location: `behavior-capability.ts:66-73`.
- ADR-09 says the bundle contains "场景 ID、候选、检查器身份/版本、结果与限制". The implemented bundle is `{schema_version, evidence[]}`, and entries have no `candidate_sha`, no limitations, and no definition of what `subject_sha256` refers to.
- Impact: a bundle fetched and re-hashed to match `evidence_bundle_sha256` cannot prove it was produced for this candidate. Cross-candidate bundle reuse depends on the unspecified meaning of `subject_sha256`.
- Fix: add `candidate_sha` and `limitations` to the bundle and `candidate_sha` to each evidence entry. Document that `subject_sha256` must equal `target_code_sha256` or `behavior_contract_sha256`. If the existing `qualification-contract.schema.json` deliberately omits these, record that as a spec deviation. I did not see that file.

**3. P2: Identifier fields accept control characters, bidi and zero-width characters, and non-normalized Unicode.**
- Location: `behavior-capability.ts:4-7` (`text`/`Id`), used for `signer_key_id`, `record_id`, `scenario_id`, `checker_id`, all profile fields, `owner_component` and `trigger`.
- `Id` blocks only NUL, blank strings and lone surrogates. It allows `\n`, ESC, U+202E, U+200B, leading and trailing spaces, and NFC/NFD variants.
- Reproducer: `required_scenarios: [{id:"AC-FM-09"},{id:"AC-FM-09\u200b"}]` passes the `unique` check as two scenarios. `signer_key_id: "ci-key\n[ok] verified"` parses.
- Impact:
  - Terminal and log injection in the CLI, which prints these fields.
  - Confusable key IDs in trust-store lookups.
  - Near-duplicate scenario IDs that defeat the uniqueness check.
- Fix: add a restricted `Token` type such as `/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/` for identity and binding fields. Keep free text only for summaries and invariants, and require NFC and reject C0/C1/bidi-format characters there too. Use `Version` for `daemon_version`, `adapter_version`, `executor_version`, `template_version` and `checker_version`, or define why they are free-form.

**4. P2: The protocol exposes no way to detect duplicate keys or produce RFC 8785 bytes and digests.**
- Location: `behavior-capability.ts:77-79` (`canonicalization: "RFC8785"`) and the exports in `index.ts:127-132`.
- The schemas accept already-parsed `unknown`. `JSON.parse` has already collapsed duplicate keys, so a duplicate key in an on-disk record cannot be rejected. ADR-09 explicitly requires rejecting duplicate keys.
- Nothing in `@osstack/protocol` canonicalizes or hashes `BehaviorContractV1`, `BehaviorRegistryV1` or the qualification payload.
- The repo already has two inequivalent canonicalizers: `sessions.ts:83` sorts with `localeCompare`, which is locale-dependent and not JCS, while `session-continuations.ts:57` sorts by code unit.
- Impact: R02 can verify a signature over `canonicalize(JSON.parse(bytes))` while a different byte stream sits on disk, or can pick the wrong canonicalizer.
- Fix: export one `canonicalizeJcs` and `digestOf(...)`, plus `parseBehaviorDocument(bytes)` that rejects duplicate keys, lone surrogates and non-finite numbers before schema validation. Add tests for duplicate keys and for key-order independence.

**5. P2: The registry schema does not check dependency closure, version match, or cycles.**
- Location: `behavior-capability.ts:50-54`. The test at `behavior-capability.test.ts:51-53` itself parses a one-entry registry whose FM-09 depends on an absent FM-02.
- A registry can therefore reference missing dependencies, dependency versions that do not match the shipped entry, or cyclic dependencies.
- Impact: if R02 relies on "registry parsed", it inherits a dangling or cyclic graph. R05 lists cycle injection as a test, so the check will be needed somewhere.
- Fix: add a pure `assertRegistryClosed(registry)` in the protocol package, or document that parsing implies no graph validity. Do not leave it implicit.

**6. P2: The same release-failure bug class remains in `handleSessionStart`.**
- Location: `daemon.ts:716-724`.
- `await lease?.release()` and `confirmAdapterStopped` run in a bare `finally`. If either throws, the following `ctx.activeRuns.delete(runId)` and `requestSupervisionScan` are skipped, and the thrown error replaces the response even though the run was already finalized and the session is persisted.
- Reproducer: apply the same `release` injection to `session.start`.
- Impact:
  - The `activeRuns` entry leaks, so `run.status` reports `active: true` and `drain` cannot reach `active_runs: 0`.
  - This is outside the literal `session.send` DEBT03 title but is the same defect. E04's "清理失败场景" verification will reach it.
- Fix: apply the same nested `try/catch/finally` structure there.

**7. P2: The cleanup failure is only observable through an anonymous stderr line.**
- Location: `daemon.ts:1089-1094`.
- The `session.send` response carries no indication that admission is held. The stderr line has no run, session or repo identifier, and nothing durable is recorded.
- The next send gets a generic `admission_denied`. After a real process restart the explanation is gone.
- Fix: include `session_id` and `run_id` in the diagnostic. Add a bounded, non-authoritative field to the success result, such as `cleanup: "admission_retained"`. Optionally write a durable event.

**8. P3: The test comment claims retention across restart, but only an in-process simulation backs it.**
- Location: `session-send-receipt.test.ts:141-143`.
- After `daemon.close()` and `boot()`, the same process still owns the writer-lock file, so `next` is denied because that PID is alive. A real restart is a new process.
- What this proves: replay never invokes the adapter after a restart, which is DB-driven and valid. What it does not prove: that admission stays retained after the old process dies. The lock's stale-owner reclamation was not supplied.
- Fix: reword the comment. Do not assert cross-process retention without a test using a separate process.

**9. P3: Smaller R01 bounds.**
- `Version` (`:10`) allows unbounded numeric components, up to 64 characters. Numeric comparison would lose precision above 2^53.
- `Timestamp` and `expires_at` have no maximum validity window. Continuation grants cap at 24 hours; qualification records do not.
- There are no aggregate byte limits. Per-field maxima allow tens of MB per registry (24 entries × 128 sources × 4096-character paths, and so on).
- `repository` and `license` are free text. `repository` is not constrained to a pinned URL form.
- Fix: bound the version components, export a `MAX_BEHAVIOR_DOCUMENT_BYTES` constant, and decide on a maximum record lifetime.

## Hypotheses requiring missing context

- **H1: unretained lease on a throw (P2).** In the abort branch at `daemon.ts:1084-1088`, if `confirmAdapterStopped` throws, neither `release` nor `retain` runs. The new catch then logs "admission remains held". The slot stays held only if `ExecutionLease` or `GovernedExecution` never auto-releases, and that code was not supplied. If it does auto-release (TTL or GC), a possibly-live worker's lock could be freed.
  - Fix: in the catch, call `lease?.retain("session cleanup failed")` in a guarded nested `try`, unless release has already succeeded.
- **H2: other callers that relied on the throw.** `executeReservedSessionTurn` also backs `attention.answer`, engineering dispatch and probably the continuation path. Previously a cleanup exception propagated to them. Now they see the original result. If the continuation controller used the exception to block its grant, it may now proceed to the next step while admission is held. That would be safe but surprising. Verify the caller sites.
- **H3: the "GovernedExecution retains admission" claim.** The comment at `daemon.ts:1090` asserts it, and the test confirms it only for the `acquireRepoWriteLock().release` injection point. The unconfirmed-adapter-exit and `confirmAdapterStopped`-throws paths are untested.
- **H4: the test spy may not intercept the real lock.** `vi.spyOn(autonomy, "acquireRepoWriteLock")` on a namespace import only works if the daemon's governed-execution path resolves that same export binding. The test's `execution_lease_holds: 1` assertions suggest it does, but I could not verify it. Run the test against BASE to confirm it fails there (red/green).
- **H5: JSON Schema drift.** `index.ts` says `schemas/` holds generated JSON Schema. Zod `refine` and `superRefine` constraints (uniqueness, role/level, predecessor, expiry ordering) do not appear in generated JSON Schema. If a schema-sync check or consumer exists, the new exports may be missing or looser.
- **H6: compatibility with `qualification-contract.schema.json` v1.** The code comment claims it. I did not see that file and no test cross-validates against it.
- **H7: nested `release()` throw in `handleSessionSend`.** The `finally` at `daemon.ts:880` awaits `admission.release()` when not handed off. On the post-admission duplicate path (`:872-876`), a release failure would replace a valid `duplicate` success with a thrown error. This path is race-only and low severity.

## Verified DEBT03 properties (code trace)

- **Applied preserved after cleanup failure:** after the transaction commits at `:1049-1070` nothing can throw before `singleOk`. The cleanup catch and inner `finally` cannot throw, so the committed result survives.
- **Duplicate and restart do not re-call the adapter:** `existingMessage` is checked at `:782` before admission and before `executeReservedSessionTurn`. Applied returns `duplicate`, accepted and failed return `delivery_uncertain`, and a changed payload returns `message_id_conflict`.
- **Unknown is not reset to unsent:** `retryFailedMessage` is not called anywhere on this path. A failed completion persistence leaves `accepted` or `failed`, and both replay as `delivery_uncertain`.
- **Concurrent same-session sends:** the `activeSessionSends` check and set happen without an intervening await, so two sends cannot race through.

## Explicit limitations

- Nothing was run: no tests, no typecheck, no BASE-versus-candidate comparison.
- I did not see `ExecutionLease`/`GovernedExecution`, `acquireSessionAdmission`, `confirmAdapterStopped`, the continuation and engineering callers of `executeReservedSessionTurn`, `qualification-contract.schema.json`, or the schema-generation tooling.
- R02 loader safety, signature verification, the trust store, revocation, rollback and staleness enforcement were out of scope. Where I touched them, the points are R01 contracts R02 will depend on.
- Neither the schema nor the session fix claims runtime activation, a migration, or operator recovery. I found no such claim in the diff or changesets.
- The user text mentions both "R02 is separate" and "R02 loader in scope". I followed the former.

AUDIT_COMPLETE
