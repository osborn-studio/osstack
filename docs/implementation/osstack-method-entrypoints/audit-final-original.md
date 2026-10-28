# Verdict: REVISE (narrow, one blocker)

R1, R2, R3 and R4 are closed on their stated scope. One new blocker comes from the R2 repair: an unbounded prefix regex makes a hostile line quadratic.

This is a read-only review of the embedded text. I executed nothing and did not verify the commit hash. I expanded the `test(` loops by hand and get 49 earlier plus 13 new, which is 62 and matches your count. "0 skipped" depends on `~/.codex` existing on the run host.

## Closure of R1-R4

| | Status | Basis |
|---|---|---|
| R1 | Closed | The opener now requires `marker[1][0] !== '`' || !marker[2].includes('`')`. The fence regex runs on the line with the `\r` stripped, so the opener and closer both match under CRLF. `'```npm i``` is…'` falls through to inline pairing, and the two 3-runs mask only that span. An escaped single run is skipped as an opener and an escaped run longer than one throws. All three RED cases then reach the scan and fail with `link_*`. Masking keeps code-unit offsets (`' '.repeat(line.length)`, `split('')`), so span offsets stay valid. |
| R2 | Closed (semantics) | `-`, `>`, `1.` and `> -` prefixes throw `link_unsupported`. Prose prefixes with other characters are still ignored, which is correct. Only the cost is wrong; see Blocker 1. |
| R3 | Closed | `transform` now collects pieces and joins once. Spans are emitted in ascending, non-overlapping order, and `'../../'` is 6 characters, so `slice(6)` is right. Offsets in `prose` and `text` agree because masking preserves length. BOM and bytes survive because the decode is fatal with `ignoreBOM`. `prefixed-mixed-inline-backticks` does reach the pairing path, since it is one 180k line with 48k runs of lengths 1-4. |
| R4 | Closed | The tree listing shows `osstack-methods-skill/SKILL.md` at the old revision, so the earlier "router absent" claim was wrong and I withdraw it. The method references in `host-usage.md` are also in the listing. The product-script caveat is explicit in `host-usage.md`. The new existence test pins the nine named paths in the current checkout. The listing is paths only, with no object id shown, so I accept it as provided. |
| HTML quote-aware `>` | Closed | `<a title="a>b" href=…>` now yields `angle` containing `href=` and throws. The scan is still one pass because `i = end + 1` consumes each region once. |

## Blocker

**1. The R2 repair adds a quadratic path, which makes the "linear" comment false.**
- **Cause:** in the `]:` branch, `/^[ \t>+*\-\d.)]+$/.test(prefix)` scans the whole prefix from `lineStart` each time. The old `/^ {0,3}$/` failed within 4 characters, so this cost is new.
- **Trigger:** the regex only fails fast if a non-class character appears early. Here the prefix starts with a long run of class characters, then one non-class character, then many `]:` occurrences. Each `]:` rescans that long run, and none of them throws. About N×K steps are possible within 1 MiB.
- **Estimate:** with K≈400k and N≈120k that is roughly 5e10 character steps. That is well over the 4 s bound the B3 tests use, and a reference file is scanned about 8 times per export. This comes from reading the code, not from a run.
- **Repro:** put `'- '.repeat(200000) + 'x' + '[a]:'.repeat(120000)` on a single line in `references/hostile.md`, which is about 880 KB. Run it in the existing bounded-subprocess dry-run harness with `timeout: 4000` and expect `status: 'planned'`. I expect this to time out today.
- **Fix, either of these:**
  - Scan backward from `label.start - 1` over `[ \t>+*\-\d.)]` and stop at `lineStart` or the first other character. Each label's run is then disjoint from the previous label's, because `[` and `]` are not in the class, so the total is linear.
  - Or compute once per line the length of the leading container-class run, and test `label.start - lineStart <= lead`.

  Use the same approach for the `{0,3}` space check. Add the repro above as a test.

## Optional future improvements (not blocking)

- **Scheme autolinks:** the scheme test runs only at the start of each angle region. An earlier unmatched `<` hides a later `<file:///etc/passwd>`, as in `a < b <file:///etc/passwd>`. The same applies after an apostrophe inside an autolink, which opens a quote that runs to EOF. The `href|src|srcset` check is unaffected because the region contains the later text. The comment "unmatched '<' must not hide later Markdown" is true only for Markdown links. Fix: apply the scheme test with a sticky regex at every `<`, which stays linear.
- **HTML attributes:** the check is a blocklist of `href|src|srcset`. `action`, `formaction`, `data`, `poster`, `cite`, `background`, `ping` and `<meta http-equiv=refresh>` pass unvalidated. For "no HTML navigation", consider rejecting any tag that is not an allowed autolink.
- **Test robustness:** the 4 s wall-clock bound will flake on a loaded CI host. Consider a looser bound or a growth-ratio assertion. The router test hardcodes its nine paths and could parse `SKILL.md` and `host-usage.md` instead.
- **Documentation:** these inputs are over-checked, which is fail-closed. They are CR-only line endings, multi-line code spans, 4-space indented code, fences inside containers, and `\]` escapes. Add a line in `EXPORT.md`, along with a line about `.DS_Store` blocking export with `source_format`.
- **Carried from the prior report:** case-insensitive APFS (`~/.CODEX`) is untested, and CI with `OSSTACK_HOME` set above the scratch root would hit `output_protected_home`.
- **Setup-confirmation deferral:** per your note, I accept the existing authorization and do not reopen it.

After the Blocker 1 fix and its timing test pass, I would give PASS for the stated scope.