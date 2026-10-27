BEGIN_AUDIT

**Verdict: PASS**

Scope: static read of the `safeParse` hardening in `joint-recovery.ts`, the changed tests, and the third-audit disposition text. I ran nothing, so nothing below is a test-execution claim. The code is treated as untrusted data and judged only on what it shows.

**1. Dirty-subject containment (the third report's P2): resolved.**
- In Zod 3, a `ZodEffects` refinement still runs on a dirty, non-aborted inner result. That is how `home_id: ''` reached the refinement and then threw from `RecoverySubject.parse`. The same applies to a value whose subject fails only a string-level check.
- Both `RecoveryProofEnvelope.superRefine` and `RecoveryReceipt.superRefine` now wrap `recoverySubjectDigest(v.subject)` in `try/catch`. On failure they emit `INVALID_SUBJECT` and return before any further subject access.
- The early return skips every later check that dereferences `v.subject.*`, including `v.subject.kind` and `v.subject.home_id`.
- When the subject has a structural type error, the object result is aborted and the refinement never runs. That path never threw, so nothing is lost.
- `let subjectDigest: string` is assigned only in `try`, and the `catch` returns. TypeScript definite assignment is satisfied.
- A lone surrogate that passes the shape but fails canonicalization inside `jointDigest` is also caught, because the digest call sits inside the same `try`.
- `verifyRecoveryProofEnvelopes` calls `recoverySubjectDigest(envelope.subject)` after the envelope has passed `RecoveryProofEnvelope`. That subject has therefore already passed the digest `try`, so the call cannot throw there. Throwing `Error` is the intended contract on that function.

**2. Regression check: none found.**
- The success-path ordering is unchanged. Subject digest, then record/subject/effect/broker checks, with the same issue codes.
- The broker-identity check in the envelope omits the `schema` comparison that the receipt has. That is pre-existing and was already accepted, since the envelope has no `actual_target_schema` to compare against.
- The bare `catch` could in principle relabel a non-validation fault as `INVALID_SUBJECT`. The `try` body is pure, so this is theoretical and not a finding.

**3. Tests.**
- The dirty-subject test is sound for what it guards, which is that `safeParse` does not throw for either schema or for the `JointContract` union, with `''` and `'\ud800'`. A regression back to throwing would fail it.
- P3, non-blocking: it asserts only `success === false`. With these inputs the shape-level checks, or the mismatched `subject_digest` and `effect_id: 'x'`, could also cause the failure. It therefore does not pin `INVALID_SUBJECT` specifically. That is acceptable because the contract being tested is no-throw, and the disposition text claims no more than that.
- The broker-proof test now collects `issues.map(i => i.message)` and expects `UNEXPECTED_BROKER_PROOF`. Rejection no longer depends on an unrelated failure. The Attention receipt may also trip `UNKNOWN_CANNOT_RESOLVE`, depending on its fixture phase. That is harmless because issues accumulate and the loop emits `UNEXPECTED_BROKER_PROOF` independently. The broker-proof shape is valid, so it does not abort the object before the refinement runs.
- The positive Attention containment case overrides `prior_phase` to `dispatch_committed`. By the code it avoids the legacy rule, which applies only to `legacy_unknown`. It also avoids the effect-identity rule (non-effect subject), `ALREADY_COMMITTED`/`NOT_COMMITTED` (phase and decision are compatible), the broker rules (non-broker subject), and the proof-count rule (one `invocation_contained` proof). Whether it passes depends on the fixture's `target`, `owner_generation` and similar fields, which I cannot see.
- The case documents that a committed Attention receipt may carry null binding and profile. That follows from the current rules and matches the README ("Legacy unknown has only an Attention subject with null binding/profile"). It does not contradict an accepted position.

**4. Documentation.** The "Third audit" section matches the code: it names the P2, both refinements, the empty and lone-surrogate tests, the union coverage, and the split into a reason-asserting negative test and a separate positive test. It claims no runtime guarantee beyond structural no-throw. The README is unchanged by this delta and remains consistent with it.

**5. Structural boundary.** I found no new claim of authentication, freshness, or invocation identity. Those stay with the host and J12 as stated.

**Concrete findings requiring revision: none.**

END_AUDIT