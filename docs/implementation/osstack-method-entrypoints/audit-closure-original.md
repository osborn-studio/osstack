# Verdict: REVISE (narrow)

B4 is closed, and the three named B1 triggers and three confirmed B3 cases are closed by my reading. B2 and the full B1/B3 intent are not yet closed.

This was a read-only review of the embedded source. I executed nothing and could not confirm that the source is `4611fd6…` (no git, no tools). I did count 49 `test(` declarations, which matches the reported 49, but two are conditional skips (`~/.codex` absent, and root). Please attach the pass/skip breakdown.

## Per-blocker closure

| | Status | Basis |
|---|---|---|
| B1 | Named triggers closed; same-class holes remain | See R1 and R2 |
| B2 | Not verifiably closed | See R4 |
| B3 | Named cases closed; one new quadratic path | See R3 |
| B4 | Closed | `plan()` calls `resolve(sourceRoot)`, which strips the trailing slash before `collectSources` runs `lstat`. The new alias-with-`/` test would hit `source_symlink`. |

**B1 traces.**
- Wrapped label: the label slice contains `\n`, so it throws `link_unsupported`.
- `[the [draft] plan](…)`: the outer label has `nested=true`, so it throws.
- Badge: the inner link records a span, then the outer `](` sees `nested` and throws.
- The `](` branch now always throws or records a span, so unmasked text fails closed.

**B3.** `maskCode` pairs backtick runs with a per-length `next` map, and the scanner is a single pass. `indexOf` for `<` and `>` consumes each character once, so the `[`/`<`/backtick scans are linear.

## What blocks closure

**R1 (Medium). `maskCode` can hide real links.**
- **Fence regex:** ``^ {0,3}(`{3,}|~{3,})(.*)$`` accepts a backtick fence with a backtick in the info string. A line such as ```` ```npm i``` is the command ```` is an inline code span in CommonMark. Here it opens a fence, and every later line is masked until a closing fence appears. A broken `../../references/x.md` link after it is unchecked and unrewritten, which is the B1 failure mode.
- **CRLF:** `.` does not match `\r`, so a CRLF fence line never matches. A file with an LF opener and a CRLF closer masks to EOF. In an all-CRLF file, fenced examples get scanned and may be wrongly rejected.
- **Escaped backticks:** a link between two `` \` `` escaped backticks is also masked. This is lower priority.
- **Fix:** do not open a backtick fence when the info string contains a backtick, and tolerate a trailing `\r`. Add tests for each.

**R2 (Low–Medium). Indented definitions are skipped.**
- `]:` is only treated as a definition when the prefix matches `^ {0,3}$`. `- [x]: ../../references/missing.md` and `> [x]: …` are valid CommonMark definitions, but the scanner never records them. They pass the source check, the export check and the rewrite silently.
- This keeps `link_scope: "unsupported navigation rejected"` in the manifest overstated.
- **Fix:** throw `link_unsupported` when the prefix is only spaces, `>` and list markers. Add tests.

**R3 (Low–Medium, likely but not measured). Entry rewriting is O(links × bytes).**
- In `transform`, each reversed span does `text.slice(0,start)+…+text.slice(end)`. V8 flattens the rope on every `slice`.
- An entry `SKILL.md` near 1 MiB with tens of thousands of `[a](../../references/evidence.md)` links would copy about 1 MiB per link, ×4 entries. That is plausibly several seconds, past the 4 s bound the B3 tests use.
- The hostile tests only exercise `references/`, where no rewrite happens.
- **Fix:** collect slices into an array and `join` once. Add a timing test with a link-dense entry.
- The backtick test (`` ` ``×20000) is itself a fence opener, so it never reaches the inline-pairing path. Add a prefixed, mixed-length variant.

**R4 (B2). The router claim is unverified.**
- The "Original source checkout" section states that the source router is `osstack-methods-skill/SKILL.md`. The original audit said that exact path does not exist at `4b0`. Nothing embedded here shows it was added, and the exporter and `EXPORT.md` never reference it.
- The exported-project section matches the real layout: `entries/<4>` plus `references/`, and the four methods as reference methods. I cannot confirm those four reference files exist from the embedded text.
- No check was added that doc-named paths exist, which the audit's fix asked for.
- **Closure evidence:** a listing of `osstack-methods-skill/` showing the router, or reword the section. A small test that the named paths exist would settle it.

## Notes (not blocking)

- **Setup-confirmation deferral:** `setup-osstack/SKILL.md` was not embedded, so I did not assess it. "User authorization persists" does not answer the audit's point, which was that the shipped text lacks the sentence that invoking the skill is not write authorization. Record it as an accepted deferral rather than a closed item.
- **Protected homes:** env overrides are now covered, with tests. Case-insensitive APFS behaviour (`~/.CODEX`) remains untested. If `OSSTACK_HOME` is set in CI to a parent of the scratch root, the export tests will fail with `output_protected_home`.
- **`.DS_Store`:** it now blocks export with `source_format`. That is acceptable fail-closed behaviour, but worth a line in `EXPORT.md`.
- **HTML scan:** an attribute value containing `>` before `href` (`<a title="a>b" href=…>`) defeats the angle-region scan. This is exotic and low priority.

Fixing R1–R4 with the listed tests should be enough for a PASS on a re-check.