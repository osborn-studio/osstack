# Actual Sonnet 5.5 audit

The first audit reviewed supplied files from `1e9525971176510c4008b3fcea9c6d199147882c` and requested revision. The second reviewed `73d446b46e444ff5b8ef9a39c5fab962793967fd` and passed the limited B1/N1–N9 closure. These were actual CLI invocations with `claude-sonnet-5-5`, not agent simulations. Tools were disabled; the model reviewed the supplied source and records, not a live execution. Root independently checked the final supplied bytes against Git. Prompts, raw JSON responses, stderr, settings, commands and bindings remain in the [verified archive](evidence/manifest.json). Optional follow-ups remain non-blocking; no formal runtime qualification follows from these opinions.

## Original first report

````text
# Verdict: REVISE (narrow)

One factual error in the committed record needs fixing before publication. The method text, routing, and exporter coverage held up under static reading. Nothing below was executed and I made no edits, so no hashes, test results, or scratch records are independently verified. I could not see `evidence.md`, `bug-fix.md`, `refactoring.md`, the exporter library, or the scratch records.

## Blocker

**B1. The README misstates the candidate's file set.** (`docs/implementation/method-code-review/README.md`, "Scope and verification")
- The README says "The slice changes nine files … The integration owner updates `EXPORT.md` separately."
- The diff itself edits `osstack-methods-skill/EXPORT.md` twice, so the candidate changes ten files.
- Nine matches the README's own list: the new reference, the root skill, four entries, `sources.md`, the test file, and the README. That list excludes `EXPORT.md`.
- This is a durable provenance statement, and it is false against the candidate.
- **Fix:** write "ten files", add `EXPORT.md` (two wording updates: the later-additions caveat and the mode summary), and delete the "updates separately" sentence.
- **Same edit:** the sentence about starting from provisional PR #295 on `42dbdb0a` is authoring-time history. The candidate now sits on `70924ee`, whose tree equals the published #295. Restate it as history, or bind it to `70924ee`.

## Non-blocking, ordered by value

1. **Untrusted-code execution is unaddressed.**
   - Step 3 of "Test a finding" says to reproduce "when it is safe and practical" but never says what safe means.
   - A PR candidate's tests or install scripts are attacker-controlled code.
   - **Fix, one sentence:** run candidate code only in an isolated scratch checkout with no credentials and only the network and write access the task grants. Otherwise keep the finding source-supported.
   - The method says not to stash or reset someone else's work, but not how to get a clean checkout. Say "use a scratch worktree or export of the head commit".

2. **The security lens omits two common cases.**
   - Missing authorization on new entry points and secret exposure are absent, and the text only asks for an "input path".
   - Evidence pointers could copy a leaked credential into the report.
   - **Fix:** add both cases to the lens list and say to redact secret values in findings and logs.

3. **Unknown intent has no handling.**
   - The method says "Record the intended outcome" and nothing about when it can't be established.
   - Your frozen criterion M01 requires "unknown intent is stated and bounded".
   - **Fix:** if intent can't be derived from the task, PR, commits, or code, state the assumed intent and limit findings to it. Ask only if the answer would change the verdict.

4. **Review-and-fix has two gaps.**
   - The method permits source-only findings ("say the reproduction was not run"), but the mode entry routes fixes to bug fix, which the root table scopes to a "reproducible defect" with an "original failing observation". Say what happens when a finding was never reproduced, for example "fix only if the static path is conclusive, recheck by the nearest feasible observation, and label it".
   - The publication clause lists feedback, approval, and merge. Pushing fix commits to a PR branch is also outward-facing, so add it.

5. **The README claims a root-cause lens the method lacks.**
   - The table says `rubric.md` retains "root cause".
   - The lens list has no "guard, retry, or cast that masks a violated invariant" item.
   - **Fix:** add that item to the lens list, or soften the README row.

6. **Source attribution is inconsistent.**
   - The `code-review.md` footer names three sources (rubric, lead judgment, behavior-test).
   - `sources.md`, the README, and the test list five, adding `interrogate/SKILL.md` and `code-quality-review.md`.
   - The README says the opening-a-PR playbook was "inspected", but `sources.md` doesn't mention it or pin it.
   - **Fix:** name all five in the footer, or point only to `sources.md`. Add a one-line "inspected, not imported" entry to `sources.md`, or drop the README sentence.

7. **Test hygiene.**
   - I counted exactly 77 test registrations in the final test file, which matches the author's number as a declared count.
   - Two tests skip conditionally: the write-failure test skips on Windows or root, and the `~/.codex` test skips if that directory is absent.
   - "77/77 passed" therefore means zero skips. The pending root run should report pass and skip counts separately.
   - The test titled "six method references" now omits the seventh. Add `code-review` to its list so existence and non-emptiness are asserted. The new navigation test only reads the file.
   - The navigation test matches by link label, so a link under the wrong row would still pass. The test file already labels these tests as navigation-only, so I'd leave it.

8. **README durability.**
   - The scratch-root path and the historical-walkthrough hashes and commands (`1038dc9a…`) point at records outside the repo that a future reader can't check.
   - The "passed 77/77", "56 files", and "5 quick_validate" lines are present-tense facts that are author claims.
   - **Fix:** prefix them with "author-reported at `<commit>`", or move them to the PR description.

9. **Stale counts may exist outside the diff.**
   - Unchanged files such as `host-usage.md`, `evidence.md`, `engineering-decision.md`, and the native-discovery README may say "six" methods or "four-method". I can't tell from the diff.
   - Grep for these before merge.

## Checked and consistent

- **Routing:** all four navigated entries reach `code-review.md` with exactly one `Code review` link each. `setup-osstack` reaches it through `osstack-mode` and correctly says "seven".
- **Authority:** review-only versus review-and-fix is stated in the mode, help, agent, and method text. The agent entry still forbids spawning more workers, so the method's "additional reviewers" clause can't widen a delegate's scope.
- **Portability:** the method has no Cursor slugs, Task tool, slash commands, or required multi-model spawn. Reviewer identity is limited to what host evidence establishes.
- **Exporter safety:**
  - `code-review.md` contains no constructs the strict link subset rejects: no HTML, backticks, bracketed labels, or `[x]:` lines.
  - The new D2a negative test fails on a missing advertised reference.
  - The RED counts are internally consistent: 3 passing, 5 failing.
  - The 56-file figure is consistent: 4 × (1 + 13 references).
- **Verification honesty:** the tests are explicitly navigation-only, and the README disclaims model review quality, host selection, and independence. I found no overclaim there.

Once B1 is fixed, I'd treat this as PASS. Items 1–6 are cheap to bundle into the same revision but don't need a second audit.
````

## Original closure report

````text
# Verdict: PASS (limited closure scope)

This is a static read of the FINAL texts and diff you supplied. I executed nothing, verified no hashes, and made no edits. I did not inspect commit `73d446b4…` directly. The dispositions are bound to `ac9d8e60…`, and I saw no mapping from that commit to the root candidate. The verdict holds only if the supplied FINAL files are the bytes at `73d446b4`.

## B1 and N1–N9

| Item | Result | Basis |
| --- | --- | --- |
| B1 | Closed | The README now separates the author candidate (nine files) from the integration candidate (ten method-related files: the nine plus `EXPORT.md`). The "updates separately" sentence is gone. The #295 history is restated as history with the `70924ee` binding. FINAL `EXPORT.md` carries the later-additions caveat and the seven-path mode summary. |
| N1 | Closed | Candidate tests and install scripts are named untrusted code. They run only in an owned isolated checkout or export, with no injected credentials and only task-permitted network and write access. Otherwise the review stays source-supported. |
| N2 | Closed | Missing authorization and secret exposure are in the lens list, with a rule to omit secret values from findings and shared logs. |
| N3 | Closed | The method derives intent, states an assumption when unsure, bounds the review to it, and asks only if the answer would change the verdict or permitted scope. |
| N4 | Closed | Static-only fixes need a conclusive path. The nearest feasible check must be labeled and not called a reproduction. Pushing commits is now in the publication clause. |
| N5 | Closed | The guard/retry/cast lens item exists, so the README's "root cause" row is now supported. |
| N6 | Closed | The footer points only to `sources.md`, which now lists the opening-a-PR playbook as inspected, not imported. The attribution test's required local links (`evidence`, `sources`, `bug-fix`, `refactoring`) are still present. |
| N7 | Closed | The test is renamed to "seven" and includes `code-review`. I counted 77 registrations statically, expanding the loops, which matches the declared count. The navigation test still reads only link labels and is labeled navigation-only. |
| N8 | Closed | The 77/56/5 results are bound to `1d00ac4f…` as author-reported. The scratch path is described as a locator, and later revisions need separate records. |
| N9 | Plausible, not independently checked | The one remaining "four-method" mention in FINAL `EXPORT.md` is historically scoped (bound to `ca95aba1`). I could not see the other files your scan covered. |

## Optional, no re-audit needed

1. **README/`sources.md` mismatch:** the README lists "publication, reset, model and automatic readiness" as unimported rules. `sources.md` lists only "reset, publication and automatic readiness". Align the wording.
2. **Bug-fix tension:** `bug-fix.md` step 2 says to report a blocker when a safe driver is missing. The new review-and-fix rule allows a conclusive static-path fix. A literal reader of bug-fix could stop early. A short "except as `code-review.md` allows" would remove the ambiguity.

## Carry-forward caveats

- **Skip count:** "0 skipped" depends on the environment. The write-failure test skips on Windows or as root, and the `~/.codex` test skips if that directory is absent. The pending root Node22 counts should report passed and skipped separately.
- **Unverified author claims:** these remain unchecked by me:
  - the equal-tree claim for `70924ee` and `d63dbdce`
  - the tarball SHA-256 and "148 verified members"
  - the `77 passed, 0 failed, 0 skipped` rerun
  - the opening-a-PR URL at the pinned commit
````
