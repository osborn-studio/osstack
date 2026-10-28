# Verdict: PASS (closure of the six publication findings only)

This is not a runtime, J01 or complete-host qualification, and the full-repo REVISE stands. My shell tool failed this turn, so I did not re-hash anything. This verdict rests on the text and records you supplied.

## Findings

| # | Finding | Result |
|---|---|---|
| 1 | Test SHA vs candidate | Resolved |
| 2 | `--safe-mode` and restricted-mode claims | Resolved |
| 3 | Codex sentence in `EXPORT.md` | Resolved |
| 4 | Missing or superseded artifacts | Resolved |
| 5 | Initialize record not raw | Resolved |
| 6 | Possible dead links | Resolved |

1. **Test SHA vs candidate.**
   - The README now binds `pnpm test` to `4d6bb58` and says it excludes the later docs.
   - The source proof lists the trees (`9efad98…`, `e87a60e…`, `9a0b0af…`) and the full diff scope.
   - The 0ebaceb file list contains only docs plus `EXPORT.md`, with no product paths.
   - Both exports checked 40 files with hashes identical to the frozen experiment.
   - Targeted export, docs and hygiene checks ran at head `0ebaceb` with exit 0.
   - Export hashes stayed unchanged after `EXPORT.md` grew. That implies `EXPORT.md` is not an exported member, so I infer the relative link in it is safe.
2. **CLI mode claims.**
   - Safe mode is labelled help-derived and "not a model experiment".
   - The 13-word quote count is consistent (7+4+1+1).
   - Restricted mode is hedged to "this environment, without proving every internal causal step".
   - One wording nit: "rather than a model experiment" would read better as "not a model experiment".
3. **Codex sentence.**
   - It now says shell `cat`, with no native skill-invocation event attested.
   - It carries `inconclusive_observability`, the Git-metadata gap, the unexposed resolved model, and the missing PID/timing and vendor fingerprint.
   - The `../docs/...` link resolves correctly from `osstack-methods-skill/`.
4. **Missing or superseded artifacts.**
   - Both pre-deny settings files exist and match the prepared hashes.
   - The final settings differ only by 53 added `Skill` denies. I counted 53 and no removals.
   - The three excluded vendor excerpts have sha256s and a stated reason.
   - The disposition says the original checker is not replayable from the public archive alone.
5. **Initialize record.** The README states that the `control_response` is account-redacted and re-serialized, and that only the model and tool event lines are original.
6. **Dead links.**
   - Every README link target is in the added-files list.
   - The grade copies match the archive (`1fc19e5a…` and `62c47cdb…`).
   - The final archive check byte-matched all eight named copies.

## Lower-severity notes

All are now disclosed in the README or backed by the final archive check:
- Visible paths, usernames and quota metadata, and the limited HOME replacement.
- The narrower scope of the token-shape scan (712 members, 0 findings, stated as heuristic).
- Reuse of the operator's authentication.
- The Codex overall label and the H2 gap.
- The manifest being bound by the commit rather than self-hashed.
- The source acceptance review not covering the final README.

## Non-blocking conditions

- **Archive binding.** `final-archive-check` bound the then-uncommitted files. Confirm that the committed `evidence.tar.gz` at `0ebaceb` hashes to `77560906…` and `manifest.json` to `6169173…`. I did not run that check.
- **Settings in the archive.** I did not see the manifest listing the two `settings-before-builtin-deny.json` files. `audit.md` says they were added, and the archive check covers manifest-to-member parity, so this is likely fine.
- **Stale sentence.** `audit.md` ends with "限定修订复审尚待执行，不提前标 PASS". After this closure that line is out of date. Record the result by binding to `0ebaceb` outside the repo, or in a follow-up commit. Editing it in place changes the candidate and invalidates the hashes above.