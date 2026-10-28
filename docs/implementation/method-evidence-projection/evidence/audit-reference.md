Original static audit text, unchanged in fence:

````text
# Verdict: REVISE

This is a static read of the supplied diff and files only. I executed nothing and make no claim that any test passes. Two blockers are below, followed by items I could not confirm from this slice.

## Blockers

1. **`skills-check-journey.md` contradicts the same commit about projection.**
   - The reference says it "does not provide a filtered evidence interface or a registered projection command."
   - The same commit registers `method:project-evidence` in `package.json` and runs it in CI against exactly this evidence.
   - A reader in the target checkout will find the command and see the reference denying it.
   - Reword to state the actual scope, for example "this recipe does not use or require the projection command". Otherwise, point to the command and say who may consume the packet instead of the full bundle.

2. **The scratch setup is underspecified against `runJourney`.**
   - The script reads `process.env`, so `OSSTACK_SCRATCH_ROOT` must be exported. A plain shell variable expands in the snippet but is invisible to Node. Node then falls back to `tmpdir()/osstack`, and the run is refused with `output_outside_scratch` or fails with `ENOENT`.
   - The script calls `realpath(scratchRoot())` and `realpath(dirname(output))`, so both the root and the output's parent must already exist. The doc says only "create its `runtime` child if that parent does not exist", which leaves root creation implicit.
   - If the variable is unset, the snippet expands to `/runtime/skills-check-journey-…`. That fails closed, but the error is confusing.
   - "The script also supports the platform temporary `osstack` root when unset" is misleading. It holds only if that directory already exists, and the snippet's `$OSSTACK_SCRATCH_ROOT` path would not use it.
   - Give the exact preamble: `export OSSTACK_SCRATCH_ROOT=<absolute owned path>`, then `mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"`, then a `${OSSTACK_SCRATCH_ROOT:?}` guard in the output path. Drop or qualify the unset-variable sentence.

## Non-blocking

- "Retain the invocation stdout/stderr and separate build log" has no location or redirect in the snippet. The output directory must not exist beforehand, so it cannot hold those logs. Name a sibling path outside `$journey_output`, for example `> "$journey_output.stdout"`.
- The added doc-parser test only proves `--output <abs>` is accepted by `parseOptions`. It does not exercise the `journey_output=` path construction, the scratch containment, or the parent-exists requirement. That is why blocker 2 is invisible to tests. Phrase any claims about that test accordingly.
- The new CI steps rely on the earlier `mkdir -p …/runtime` step. This is acceptable because the steps are sequential and gated on success. Say so if you want it explicit.

## Checked and consistent

- **Checkout vs export:** the doc requires the target checkout root, says exported skill directories hold no script or `dist`, and requires install and build first. It matches the `binding_anchors` (`packages/*/dist/*`) and the `product_entry` check on `join(target,'packages/cli/dist/bin.js')`.
- **Wrapper interface:**
  - It accepts only `--output`, and the exit codes (0, 1, 2) match the code.
  - An existing output or symlink is refused by non-recursive `mkdir`.
  - Output outside scratch is refused after `realpath`.
  - Refusal before `mkdir` creates no artifacts.
  - Doctor runs before each case and stops the journey on failure.
- **Expected negative:** the doc's claim that `missing-ref` is an unrecovered source failure matches the code. The code checks `expected_exit` 1, `failed` 1, the `refs/heads/not-present` ref, and unchanged input (`manifest_before_sha256` and `manifest_after_sha256` equal the input hash). The `maintain-verification` and `feature-map-template` additions are consistent.
- **Cleanup claims:** the code checks `fixture_removed`, an absent fixture path, and `scratch` containing only an empty `smoke`. `descendant_termination` stays `not_attested`. Evidence lives in `cases/`, outside the fixture. The timeout and interrupt wording matches the direct-child SIGTERM then SIGKILL logic. The unsealed / unverified / `not_created` states match `retainedState`.
- **Link wiring:**
  - `create-verification`, `maintain-verification` and `feature-map-template` each contain a `[...](skills-check-journey.md)` link, which satisfies the new regex test.
  - The doc has exactly one line-initial `node scripts/method-verification-journey.mjs …`, so the `commands.length === 1` assertion is consistent.
  - The journey's own links (`maintain-verification.md`, `sources.md`, `evidence.md`) are same-directory targets.
- **CI order:** the projection contracts, project, `--check` and packet-upload steps come after build, `test:method-export` and the journey step, so input exists whenever they run.
  - The two projection commands run under `bash -e`, so a failure in the first stops the second.
  - The upload `if` skips cleanly when the journey fails, because the projection outcome is then `skipped`.
  - The artifact name is unique, the action pin matches the existing steps, and the path matches the env.
  - `package.json` stays valid JSON.

## Cannot confirm from the supplied material

- Whether the "missing advertised `skills-check-journey` fails before reserving output" test can pass. `export-osstack-methods.mjs` is not in the diff, so that depends on the exporter deriving required references from links rather than from a hard-coded list.
- Whether `skills-check-journey` is reachable from all four entries on both hosts. It is linked only from the three verification references, so it depends on mode routing to `create-verification`, as for `engineering-decision`.
- Whether the exporter rejects text naming both `.agents/skills/` and `.claude/skills/` in one reference.
- The `no_matching_ref` and healthy-status strings, which live in `evaluateCase` in `lib/skills-check-verification.mjs`, and the "read-only doctor" claim in `smoke-skills-check.mjs`.
- That `scripts/project-method-journey-evidence.mjs` and its `.test.mjs` exist at c04f7ed. `package.json` and CI depend on both.

I would move to PASS once blockers 1 and 2 are fixed and the exporter, reachability and file-existence items are confirmed. Merging remains your decision.
````
