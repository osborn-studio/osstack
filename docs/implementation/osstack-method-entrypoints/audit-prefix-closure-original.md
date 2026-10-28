# Preserved audit text

This text block retains the original audit verbatim. Example links are quoted audit data, not navigation in this document.

Original SHA-256: `dd51a94766a05283125d48b28499dcbcb9ea67a25701bca426f0180f0e535eb2`. Original byte length: 3794.

````````text
# Verdict: PASS

This is a read-only review of the embedded text and diff. I executed nothing and did not verify the commit hash. The claims about the 880001-byte input (a 4 s timeout before, about 220 ms now) are the author's, not reproduced by me.

## Semantic equivalence

The old check was `!/^ {0,3}$/.test(prefix) && /^[ \t>+*\-\d.)]+$/.test(prefix)`.

- **Simple prefix:** `label.start - lineStart <= 3 && /^ {0,3}$/.test(slice)` is the same predicate. The length guard only avoids a long slice.
- **Container prefix:** the old `+` required a non-empty prefix made entirely of class characters. The new `label.start > lineStart && label.start <= containerPrefixEnd` is equivalent, because `containerPrefixEnd` is the first non-class index from `lineStart`, and `[`, `]` and `\n` are not in the class.
- **Character class:** it is unchanged. Per-character `/[ \t>+*\-\d.)]/.test(ch)` matches the old bracket class.
- **Branch order:** the same container-prefix check runs first, then the simple-prefix branch. I traced `- `, `> `, `  1. ` and `> - ` by hand. All four still throw `link_unsupported`. A prose prefix such as `x[a]:` stays ignored.

## Cache validity

- `lineStart` changes only on `\n` in the main loop, and `containerPrefixEnd` is reset at that same point.
- `targetAt` cannot skip a `\n`. It skips only space and tab, and stops at any `\s`. The reference-definition path returns `i-1` at `\n`, `\r` or EOF, so the next iteration still sees the newline.
- The cache is therefore never stale across lines.

## Linear bound

- **Class scan:** it runs at most once per line, only when a `]:` with a label is hit. Lines are disjoint and `\n` stops the scan, so the total is O(n).
- **Remaining per-`]:` work:** the simple-prefix slice is at most 3 characters. The `prose.slice(label.start, i).includes('\n')` slice runs only after `simplePrefix` is true. That requires `label.start` within 3 characters of `lineStart`, and the following `targetAt` then throws or consumes to end of line, so this is also bounded per line.

## Does the test detect the issue?

Tracing the test input:

- **Input size:** `'- '.repeat(200000)` is 400000 characters, `x` adds 1, and `'[a]:'.repeat(120000)` adds 480000. The total is 880001 bytes, under the 1 MiB cap. That makes it one line with no backtick runs, so masking is a no-op.
- **Old code:** every `]:` hits the non-simple prefix and rescans 400000 class characters before failing at `x`. That is about 4.8e10 steps per scan, with roughly 8 scans per dry-run (4 entries transformed, plus the second validation pass over outputs). It cannot finish inside the 4000 ms SIGKILL bound, so `run` rejects and the test fails.
- **New code:** one 400000-character scan, then 120000 O(1) iterations. Every label has `label.start > containerPrefixEnd`, so nothing throws and the status is `planned`. This is consistent with the author's ~220 ms, an ~18× margin under the bound.

The test count is 62 + 1 = 63, which matches.

## Non-blocking suggestions

- **Cache reset is untested.** Every container-prefix test is a single line. If the `containerPrefixEnd = null` reset were dropped, a later `- [x]: ../../outside.md` line after an earlier `x[a]:` line would silently pass, which fails open. A two-line case such as `x[a]: ok.md\n- [b]: ../../outside.md\n` expecting `link_unsupported` would pin it. The current code is correct.
- **Timing bound:** the 4 s wall-clock bound may flake on a loaded CI host. This is carried from the prior review and is not new.
- **Prior optional items:** scheme autolinks after an unmatched `<`, the HTML attribute blocklist, and the documentation notes stay as optional and are not regressions.

No directly introduced regression found. Closure of the single remaining blocker is confirmed on the stated scope.
````````
