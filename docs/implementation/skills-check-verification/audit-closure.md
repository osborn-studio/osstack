**Verdict: PASS.** R1, R2 and R3 are closed, and I found no new blocking bug. This is a diff-only review. I ran nothing and rely on your report of 25 passing tests and the symlink RED then GREEN.

## Closure

**R1: closed.**
- The main guard now compares `realpath(resolve(argv[1]))` with `realpath(fileURLToPath(import.meta.url))`, so a symlinked entry path runs the driver.
- When the module is imported by tests, `argv[1]` is the test file, so the guard stays false.
- The symlink test requires exit 0, a non-empty stdout, a parseable receipt with the selected case, `receipt.json` equal to the stdout receipt, manifest hashes that match the files, and a removed fixture.
- The `catch {}` around the guard can still fall through to exit 0 with no output if `realpath` throws. That is acceptable only because the parent now rejects exit 0 without a receipt, so keep that parent rule.

**R2: closed.**
- `createScratchDir`'s result is assigned and recorded in `cleanup.fixture_path` before canonicalization, so a canonicalization failure no longer leaks it or reports `fixture_not_allocated`. The seam test covers this.
- `assertOwnedFixture` fails closed unless the fixture is a real directory, not a symlink, and a direct child of `realpath(scratch/smoke)`, which must itself be a direct child of `realpath(scratch)`.
- It also requires the fixture name to match `skills-check-[A-Za-z0-9_-]+` and rejects any fixture that equals or contains the evidence directory.
- It runs both at allocation and again before `rm`. A failed check retains the fixture and records `fixture_cleanup_failed` with the reason.
- The ownership test covers the scratch root, `smoke`, the evidence directory, an outside directory, a final symlink, nested evidence and equal evidence.

**R3: closed.**
- `failureReason` maps `AbortError` to `'interrupted'` and coerces everything else with `String(...)`.
- It is applied to both the main catch and the cleanup catch.
- The test confirms the DOMException has code 20 and still maps to `'interrupted'`, and that `{code: 99}` becomes `'99'`.
- Adding the failing operation to fs-code labels was optional and is not asserted.

## New-bug check

Nothing blocking:
- `assertOwnedFixture` now throws `ENOENT` if the fixture is already gone before cleanup. That reports a failed cleanup instead of tolerating it. This is fail-closed and fine.
- The `skills-check-` name regex also matches sibling `skills-check-evidence-*` directories from other runs. A regressed core returning one of those would pass. That is a hardening gap (a marker file would close it), not a regression against R2 as written.
- The ownership check uses `scratchRoot()`. If `dist/core` ever derived its scratch root differently, runs would fail closed and retain the fixture rather than delete anything. The real-run tests passing shows the two agree today.

## Parent receipt gate

Beyond exit 0, require:
- stdout parses as JSON with `status === 'passed'` and `driver_exit === 0`.
- `selected_cases` equals what was requested.
- `cleanup.status === 'passed'`, `fixture_removed === true`, and the fixture path no longer exists.
- `evidence/receipt.json` is byte-equal to the stdout receipt, and every `manifest.json` file hash recomputes correctly.

The manifest's own hash is still not anchored out of band, so the parent should record it itself. That remains optional hardening.

The full regression and the black-box run can proceed.