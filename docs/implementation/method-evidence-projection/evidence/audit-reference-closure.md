Original static audit text, unchanged in fence:

````text
# Verdict: PASS on both reference blockers. Exporter, reachability and CI compatibility are not decided by this read.

This is a toolless static read of the supplied diff and files only. I executed nothing and claim no test result. Your "author tests passed" and "independent shell in progress" stand as your reports, not mine.

## Blocker closure

**1. Projection contradiction: closed.** The new text says the recipe "does not use or require an evidence projection command". It defers to the target checkout's own documented input boundary and disclaims host or qualification claims. That no longer contradicts `method:project-evidence` being registered and run in CI. It also makes no claim about whether the command exists, so the reference doesn't depend on `scripts/project-method-journey-evidence.mjs` being present.

**2. Scratch root and parent: closed in text and test.**
- `export` makes the value visible to Node, so the `OSSTACK_SCRATCH_ROOT` fallback to `tmpdir()/osstack` can't silently apply.
- `${…:?}` plus the `/*` case rejects unset, empty, whitespace-only and relative values.
- `mkdir -p "$OSSTACK_SCRATCH_ROOT/runtime"` creates both the root and the parent the wrapper `realpath`s.
- The `.stdout`/`.stderr` redirects are siblings of the output, not inside it, so the output directory stays new.
- The recipe uses POSIX constructs only.
- The new preamble test would fail if `export` were dropped: the child would see `undefined` and `record.scratch` would not equal `chosen`.
- I checked the test's mechanics: the `split(/\s+>/)` fix, the `replace()` string (no `$&`, `$'` or `$$` patterns), `slice(0, -7)` for `.stdout`, and `argv[1]` under `node -e`. They are consistent.
- The space in `owned scratch/new root` exercises the quoting.

## Non-blocking edits

1. **Artifact wording.** The recipe's shell now creates `.stdout`/`.stderr` (and `runtime/`) even on refusal. The failure section still says "Refusal before the wrapper acquires its output directory creates no run artifacts." An agent could report "no artifacts" while the refusal reason sits in the log. Scope the sentence to the wrapper's output tree and add that the shell logs still exist and hold the refusal.
2. **Whitespace edge.** `scripts/lib/skills-check-verification.mjs` tests `.trim()` but resolves the untrimmed value. `scripts/lib/scratch.mjs` resolves the trimmed value. A root such as `/abs/x ` (trailing space) therefore passes the shell case. Which side wins depends on which helper the wrapper uses, and I haven't seen the wrapper. Likely outcome is `output_outside_scratch`, after the shell has already created `/abs/x /runtime`. Either reject it (`*[[:space:]]`) or state "no leading or trailing whitespace".
3. **`exit` in a snippet.** `exit 1` and `exit 2` end an interactive shell if the block is pasted in. Say to run it as a script or `sh -c`, or accept that behavior.
4. **Exit status and path.** Say to capture `$?` straight after the `node` line. Optionally print `"$journey_output"`, since stdout is redirected away.
5. **Test strength.** The unset and relative cases only `assert.rejects`, which also passes for unrelated bash failures. Assert exit code 2 and the stderr text. Consider running the block under `sh` as well as bash, since the doc says `sh`.
6. **Permissions.** `mkdir -p` and the shell-created logs follow the umask, whereas the driver writes `0700` and `0600`. Mention `umask 077` if the logs matter.

## Not decided by this read

These files weren't in the supplied slice (only the thin `export-osstack-methods.mjs` was):
- `scripts/lib/osstack-method-export.mjs`
- `entries/*/SKILL.md`
- `package.json`
- `scripts/method-verification-journey.mjs`
- the projection script and its test

- **Reachability.** The D2a test's BFS follows only inline links and allows hops into sibling entries. It proves bundle-level reachability from each entry, not within an entry, and the entry sources would show which path is used. It also doesn't mask code fences. A reachable document with an example link or a `[x](<…>)` destination would make `readFile` throw rather than skip. Your passing run is the real evidence.
- **Dual-namespace text.** The D2a assertion that exported `references/*.md` are byte-identical to source means the reference's dual-namespace sentence is not rewritten. Whether the exporter would reject it would only show up in the D2a tests, which I haven't seen run.
- **Root CI.** The unchanged CI shape is compatible with the new tests. They need `/bin/bash` and `node` on `PATH`, both present on ubuntu-latest, and they delete `OSSTACK_SCRATCH_ROOT` from the child env. The CI projection steps still depend on the unconfirmed script and `package.json` entries.

If the exporter lib, entries and `package.json` are supplied, I can close the reachability and CI items statically. Merging remains your decision.
````
