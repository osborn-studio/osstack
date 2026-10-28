**Verdict: REVISE.** Reviewed from the diff only; I ran nothing. One required fix is a fail-open (the driver can exit 0 without verifying anything). Two smaller required fixes concern cleanup ownership and the interrupt label. The rest is optional hardening.

## Required

**R1. High. `scripts/smoke-skills-check.mjs`, main guard: the driver can silently do nothing and exit 0.**
- The guard is `import.meta.url === pathToFileURL(resolve(process.argv[1])).href`.
- Node resolves the main module's realpath for `import.meta.url`, but `process.argv[1]` is only `path.resolve`d.
- If the script is invoked through any symlinked path, the two differ. The body never runs, and the process exits 0 with empty stdout and stderr. On this Darwin host `/tmp` and `/var` are symlinks, so it is easy to hit.
- Fix: compare `realpathSync(process.argv[1])` against `fileURLToPath(import.meta.url)`, or move the CLI entry into a separate tiny file.
- Add a test that invokes the driver through a symlink and requires a receipt.
- The host-assisted parent runner should treat "exit 0 with no parseable receipt" as failure.

**R2. Medium. `scripts/smoke-skills-check.mjs`, fixture ownership and `rm`.**
- `fixture = await realpath(await createScratchDir(...))` is one expression. If `realpath` throws, the created directory is leaked and the receipt says `not_required: fixture_not_allocated`. Assign the `createScratchDir` result first and set `cleanup.fixture_path` from it.
- `removeFixture(fixture, {recursive, force})` runs on a path returned by `dist/core`, which is the build under test, and nothing validates it. A regression there (for example, returning the scratch root or `scratch/smoke`) would delete this run's own evidence directory.
- Before `rm`, assert that the fixture is a strict descendant of `realpath(scratchRoot())` and not an ancestor of, or equal to, the evidence directory. Dropping a marker file at creation and checking it before deleting would also work.
- Add a test with a stub path that the guard must refuse.

**R3. Low. `scripts/smoke-skills-check.mjs`, `catch (error) { failure = error.code ?? error.message ... }`.**
- When `controller.signal.throwIfAborted()` throws between commands, the error is a `DOMException` with `code === 20`.
- `failure` becomes the number `20`, and the later `failure ??= 'interrupted'` cannot override it. The receipt then carries a numeric, mislabeled reason.
- Map `error.name === 'AbortError'` to `'interrupted'` and coerce the rest with `String(...)`.
- Bare fs codes like `ENOENT` also drop the failing operation, so consider adding it to the label.

## Optional (non-blocking, in rough priority order)

1. **Weak output predicate (`evaluateCase`).**
   - Per-source lines are checked with `stdout.includes(...)`. Duplicate lines, reordered lines, trailing text, or an extra `✓` line in the `empty` case all pass.
   - Render the full expected stdout and compare exactly. The output is deterministic.
   - The strict `stderr === ''` check could break on a Node deprecation warning in some CI Node version. Raw stderr is retained, so it would be diagnosable.
2. **Child PATH versus the recorded git.**
   - `preflight` resolves `''` and relative PATH entries against the driver's cwd. The product child runs with the fixture as cwd and looks up `git` itself.
   - So `git_executable` may not be the git the product uses.
   - Normalize PATH to absolute entries and pass that to children.
   - Record `git --version`. Preflight reports `ready` without any Git version check, but `--initial-branch` needs 2.28 or later and `GIT_CONFIG_COUNT` needs 2.31 or later.
3. **Evidence anchoring.**
   - `manifest.json` is self-consistent, but its own hash is never emitted out of band, so it is not tamper-evident. Print its sha256 from the CLI wrapper.
   - On a binding mismatch only the digests survive. Write the after-list too.
   - `run.json` is rewritten at the end, which loses the original "running" snapshot. Write a separate final file.
   - Consider `flag: 'wx'` on every evidence write.
4. **`git rev-parse HEAD` in `repository` is a hard failure.** It can trip on dubious ownership because HOME and the global config are isolated, or on a non-checkout. The source hashes already bind the bytes, so make it best-effort.
5. **Test gaps.**
   - Nothing exercises the safety-critical retain-fixture-on-timeout path (`commandsSafeToClean=false`), `driver_deadline`, interrupt handling, the symlink check in `walk`, `unexpected_home_side_effect`, or `sealEvidence`'s existing-manifest refusal.
   - The env test is nearly tautological, because `fixtureEnvironment` is a whitelist. Assert the exact key set, and run the integration test with sentinel `GIT_DIR`, `NODE_OPTIONS` and `ANTHROPIC_API_KEY` in the parent. Then assert the recorded `command.json` environments exclude them.
   - Negative-mutant tests exist only for missing-ref and drift, not for mixed or empty.
6. **CI.**
   - Evidence lives under the runner's tmp and is discarded, so a CI failure leaves only the stdout receipt. Pass `--evidence-dir` under `${{ runner.temp }}` and upload it with `if: failure()`.
   - Local runs accumulate `skills-check-evidence-*` directories with no retention note in the README.
7. **Smaller items.**
   - `exists()` rethrows on `ENOTDIR`/`EACCES`, so doctor crashes unstructured instead of reporting a failed check.
   - An `--evidence-dir` inside a bound `packages/*/{src,dist}` tree fails late as `source_or_build_changed_during_run`. Reject it in preflight.
   - README says "implementation in progress", and the spec says audit records are "to be appended". Update both before merge.

## Checked and found sound

- Evidence reservation: exclusive non-recursive `mkdir`, which also covers dangling symlinks.
- The fixture is kept separate from the evidence directory.
- Cleanup detects both a throwing remove and a no-op remove, and the inner `ENOENT` logic works.
- Output is bounded per stream. A timeout, output limit, interrupt or unconfirmed exit marks the fixture unsafe to clean, so it is retained.
- The 90s limit is a subprocess-sequence deadline with per-command clamping, and docs and code agree on its scope.
- The child environment is a whitelist with the Git config, hooks and template paths isolated, plus `GIT_ALLOW_PROTOCOL=file`.
- Driver exit, inner product exit and cleanup status are kept distinct.
- The `manifest.json` write uses `wx`.

Full regression and the independent black-box run should wait for R1–R3. R1 especially changes what "driver exit 0" means.