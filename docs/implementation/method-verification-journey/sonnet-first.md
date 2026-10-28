Original audit text (unchanged inside the text fence):

````text
## Verdict: REVISE

This is a static read of the diff only. I ran nothing. I have no artifact behind the author's `author14offline` / `actualrun` claims, so I treat them as unverified. The core design is sound, and the defects below are targeted fixes.

## What holds up (read from the code)

- **Doctor to driver:** doctor runs with `--doctor` and the evidence dir must still be absent afterwards. The driver then runs per case with its own fixture and evidence dir.
- **Receipt and manifest:** the receipt must byte-equal the driver's stdout. The manifest inventory must exactly equal the directory listing, and manifest paths are flat and de-duplicated. Required raw records are enforced even after a reseal.
- **Behavior:** the verifier re-runs `evaluateCase` on the retained raw stdout/stderr. Healthy requires exit 0, and missing-ref requires exit 1 plus `unreachable: no_matching_ref`.
- **Exit distinction:** the driver exit must be 0 while the product exit is pinned to 0 or 1 per case. This separation is real.
- **Cleanup:** the cleanup claim is checked against an actual `lstat` of an owned-path fixture.
- **Failure handling:** the wrapper has no `rm`, and failure stops the second case.
- **Tests:** they cover receipt tamper, resealed missing files, resealed raw contradiction, a still-existing fixture, foreign cleanup paths, and duplicate manifest members.

## Findings (visible directly in the diff)

**F1. Fixture origin is never pinned (medium).** `verifyCaseEvidence`, the `fixed_source` check.
- It checks id, ref and `blessed_sha`, but not `origin`.
- Trigger: `expectations.json` and `*.input.json` carry any origin (an https URL or another repo) with matching raw output, and the verifier passes. The README says "real local Git fixtures", but the verifier never confirms that.
- Related: `current_sha` is not reconciled with any `git-NN.stdout`. `run.commands` is not cross-checked against retained records, and `environment.json` and the git records are not required.
- Fix: require `origin === pathToFileURL(join(cleanup.fixture_path,'origin')).href`. Optionally require every `run.commands[].record` to be in the manifest with a recorded exit code. This is consistency checking, not authentication, which fits your stated scope.

**F2. `feature-map.md` points to evidence that may not exist (low-medium).** `runJourney`.
- `features[i].evidence = directory` is set before doctor runs, and the map prints `cases/<id>/manifest.json` whenever `evidence` is set.
- Trigger: doctor failure. This is exactly the "failed doctor" test path, and the row cites a nonexistent manifest.
- Fix: set `evidence` only after an `lstat` of the directory, otherwise print `not_created`. Print `unsealed` when the directory exists without a manifest.

**F3. Failed attempts are retained but not sealed (medium, preservation).** `journey-manifest.json`.
- `case_manifests` comes only from `manifest_sha256`, which is set only on a verified return.
- Trigger: driver exit 1 with a valid receipt and manifest (for example a cleanup failure), or any verifier rejection. The raw drive stdout is hashed, but the per-case manifest hash is not. Nothing inventories `cases/**`.
- Fix: on failure, if `manifest.json` exists, hash it and record `{case_id, sha256, verified:false}`. Add a non-recursive-safe listing of `cases/` and `scratch/` leftovers, noting that timed-out orphans may still write.

**F4. SIGKILL timeout pre-empts the driver's own abort path (low-medium).** `invoke`, with `killSignal:'SIGKILL'`.
- `smoke-skills-check.mjs` handles SIGTERM and SIGINT by aborting commands and cleaning up when the direct child exit is confirmed.
- Every outer timeout therefore guarantees an unsealed evidence dir and a retained fixture, where a graceful attempt could often avoid that. The README states the retention honestly.
- Suggestion: send SIGTERM, wait a short grace period, then SIGKILL, and record which signal ended the driver.
- The failure string `drive_execution_failed` doesn't distinguish timeout, maxBuffer or signal. Only the raw `*.command.json` does.

**F5. Wrapper has no signal handling (low).** Trigger: a lone `kill <wrapper pid>`.
- `execFile` does not kill its child when the parent dies, so the driver is orphaned.
- `journey.json` stays `status:"running"` with no feature-map or manifest.
- A terminal Ctrl-C also reaches the driver through the process group. That part is a hypothesis about shell behavior.
- Fix: on SIGINT/SIGTERM, finalize with `status:'failed', failure:'interrupted'` and forward the signal to the child.

**F6. Cleanup predicate covers only the claimed fixture path (low-medium finding, with a hypothesis).**
- Both the driver and the wrapper check only `cleanup.fixture_path`.
- The product receives `OSSTACK_SCRATCH_ROOT=output/scratch` via `fixtureEnvironment`.
- Finding: any other directory under `scratch/` is invisible to both predicates.
- Hypothesis: the product's `skills check` creates scratch dirs outside the fixture. The core product is not in this diff, so I can't tell.
- Fix: after each passing case, require `readdir(scratch)` to contain only `smoke` and `readdir(scratch/smoke)` to be empty. This is cheap, and still not a descendant claim.

**F7. Weak run identity (low).**
- `manifest.run_id === receipt.run_id && run.run_id === receipt.run_id` passes when all three are `undefined`.
- Fix: require a UUID string.
- Related nit: `product_exit` is assigned from the constant `expectedExit`, not `observed.actual_exit`. Today they are equal because of the checks, but the report should carry the observation.

**F8. Binding scope is narrower than the README wording (low).**
- The wrapper checks internal consistency and cross-case equality. It never recomputes `sourceBindings(repository)` after the last case.
- `tool_files` hashes three scripts but not `scripts/lib/scratch.mjs`, which the wrapper imports.
- Either import `sourceBindings` and compare at the end, or reword the README. The README already disclaims compiler proof, so this is only about the checkout.

**F9. Row-level state can mislead after late failures (low).**
- If `cross_case_bindings_changed` fires, `features[1]` has already been replaced with `verification:'passed'`. `journey_tools_changed` leaves both rows passed.
- The journey header says failed, but the rows disagree.
- Add a per-row `journey_status` or note.
- For a failed verification the map shows `not_observed` even when `reported_product_exit` is retained. Show `reported:1 (unverified)`.

## Test gaps (findings)

- **Timeout:** no test exercises the real `invoke` timeout/maxBuffer mapping, or a drive record with `killed:true`. The README's "uncertainty retained" claim is untested.
- **Seamed run:** no end-to-end `runJourney` with two seamed successful drivers. That means no assertion on `journey-manifest.json` content, cross-case binding mismatch, tool-hash change, or feature-map success text.
- **Driver exit 1:** no test where the driver exits 1 with a parseable receipt, which would check that `reported_product_exit` is retained and verification is `failed`.
- **Tampering:** no tamper test on `expectations.json` (`expected_exit`), a flipped `descendant_termination`, or a mismatched `bindings.json` digest.
- **Output validation:** no test for output outside scratch, or for an existing symlink as the output leaf.
- **Missing-ref:** no mutation where missing-ref exits 0 and the driver is faked to accept it.

## Hypotheses (not established by the diff)

- **Test portability on macOS:**
  - The verifier compares `dirname(fixture_path)` to `join(realpath(scratch),'smoke')`.
  - The test fixture uses un-realpathed paths from `createScratchDir`.
  - With `OSSTACK_SCRATCH_ROOT` unset, the default tmpdir (`/var/...` to `/private/var/...`) would make every positive test fail with `cleanup_ownership`.
  - Your `/Volumes/...` scratch is probably fine. Realpath the fixture in the test to remove the dependency.
- **README vs code on the default root:** the README says "beneath `OSSTACK_SCRATCH_ROOT`". The code silently falls back to `tmpdir()/osstack` when the variable is unset. The README should say so, since the check is against the resolved root.
- **Driver stderr:** the driver's stderr is not asserted empty on success. It is retained, so this is minor.

## Scope honesty

The README is mostly honest:
- `descendant_termination:not_attested`
- omitted cases listed as unrun
- no oracle, provider or J03 claim
- offline tests described as not product observations

Nits:
- Missing spaces in the README ("exit0", "a30-second", "a180-second", "90-second").
- The README says exit 1 means a failed or blocked journey. Pre-journey refusals (output outside scratch, existing output, missing scratch root) also exit 1 with no artifacts. Say so.

## Required before PASS

F1, F2 and F3 are the changes I'd require. F4 is a design call, so either change it or document why SIGKILL-first is chosen. F6 and F7 are cheap hardening, and the missing tests above should accompany them. F5 and F8 to F9 are optional. Nothing above requires full descendant attestation or an authenticated oracle.
````
