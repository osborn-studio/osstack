# Verdict: REVISE

Candidate `4b0f2267…`. This is a read-only review with no execution, so every counterexample below comes from reading the code and should be reproduced by the author. I marked the one finding where I'm unsure of the complexity class.

Nothing I found breaks the core no-overwrite property. That includes the `lstat` check on existing and dangling symlinks, non-recursive `mkdir`, `wx` writes, the manifest written last, and the dry-run path. The `installed:false` and `host_discovery_verified:false` claims also hold.

## Blockers

**B1 (High): the link scanner fails open on valid Markdown, so a broken link exports silently.**
- **Location:** `scripts/lib/osstack-method-export.mjs`, `destinations()`, inline pattern `!?\[[^\]\r\n]*\]\(…`.
- **Trigger:** In any entry file, use one of these:
  - Hard-wrapped link text: `See [the common⏎evidence rules](../../references/evidence.md).`
  - Nested brackets: `[the [draft] plan](../../references/evidence.md)`
  - A badge link: `[![b](https://example.invalid/b.svg)](../../references/missing.md)`
- **Observed (by reading):** No span is recorded for the real destination. In the badge case only the inner `https:` target is seen. The source-time check, the `../../` rewrite and the export-time check all skip it. The export succeeds, and the output keeps `../../references/…`, which resolves to `.agents/references/…` and does not exist.
- **Why it blocks:** The code throws on HTML navigation "rather than silently unchecked", and the manifest claims file existence is checked. This contradicts both.
- **Expected fix:** Fail closed. After masking, require that every `](` occurrence begins a recorded span, otherwise throw `link_unsupported` with the file path. Or scan link text with bracket balancing that allows newlines. Add tests for the three inputs above.

**B2 (Medium): `references/host-usage.md` is stale for this layout, and it ships in every bundle.**
- **Trigger:** The template says to read `<checkout>/osstack-methods-skill/SKILL.md` and "the entry for `create-verification`". Neither exists. The layout is `entries/<4 names>/SKILL.md`, and `create-verification` is a reference.
- **Effect:** Everything under `references/` is copied into each skill, so every bundle carries an instruction that cannot be followed. The file itself says the template was never tested.
- **Expected fix:** Rewrite it for the actual layout, or move it out of `references/` so it isn't exported. Then add a check that fails when a doc-named path is missing.

**B3 (Medium): regex CPU cost is unbounded within the byte caps.**
- **Location:** `destinations()`, with the same pattern in the HTML check.
- **Trigger, all inside the 1 MiB file cap:**
  - A single line of `[` repeated about 200k times. The inline-link pattern is quadratic.
  - A line of `<` repeated about 200k times. The `/<[^>]+\b(?:href|src)…/` check is quadratic.
  - A line of about 20k backticks. The `(`+)[^\n]*?\1` backtracking looks cubic, but I'm less sure of that degree. Please time it.
- **Why it blocks:** The size and node limits imply hostile-content hardening, but a crafted `references/x.md` hangs the exporter, including `--dry-run`.
- **Expected fix:** Replace these with a linear scanner, or bound per-line length. Add a timing test.

**B4 (Low–Medium): the source-root symlink refusal is bypassed on the real CLI path.**
- **Location:** `scripts/export-osstack-methods.mjs` passes `fileURLToPath(new URL('../osstack-methods-skill/', …))`, which keeps a trailing slash. `lstat('…/link/')` follows the symlink, so `sourceDirectory(sourceRoot)` sees a directory.
- **Repro:** Call `exportMethods({ ...f, sourceRoot: linkToSource + '/' })` in a test. It succeeds instead of throwing `source_symlink`. The CLI equivalent is a checkout where `osstack-methods-skill` is a symlink.
- **Why it slipped through:** The existing `source-root` test passes the path without a trailing slash.
- **Expected fix:** Normalize with `resolve(sourceRoot)` before checking, and add a trailing-slash test.

## Non-blocking findings

1. **Memory and enumeration bounds (Low–Med).**
   - `boundedRead` allocates 1 MiB+1 per file and returns a `subarray`, so every file retains the full buffer. That is up to about 256 MiB held against an 8 MiB budget. Copy to an exact-size buffer.
   - `readdir` loads the whole directory before `count()` stops it. Use `opendir`.
2. **Protected-home guard (Low).**
   - It only covers the fixed names `~/.agents`, `~/.claude`, `~/.codex` and `~/.osstack`. It ignores overrides such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `OSSTACK_HOME`.
   - The check is a string comparison. Whether `realpath` normalizes case on a case-insensitive APFS volume is unverified, so please try `~/.CODEX/x`. An ancestor dev/ino comparison would be sturdier.
   - "Never installs into global homes" in `EXPORT.md` overstates it. Say what is refused.
3. **`resolve(output)` collapses `..` lexically (Low).** For `/a/link/../new` it creates `/a/new`, not the kernel's resolution. This isn't unsafe, but rejecting `..` segments would be clearer.
4. **Source hygiene (Low).**
   - `.DS_Store` and other dotfiles pass the name regex and are exported into all four skills. This is likely on macOS.
   - `.MD` and `.markdown` files skip validation, because the check is a case-sensitive `.endsWith('.md')`.
5. **Parser edge behavior (Low).**
   - Unclosed fences aren't masked.
   - Fences nested more than 3 spaces deep, or inside blockquotes, aren't masked.
   - `[^1]: text` footnotes are misread as link definitions.
   - A stray `<` followed later by `src=` trips the HTML error.
   - `srcset` is not checked.
   - Several errors omit the file path.
6. **Locale-dependent ordering (Low).** `localeCompare(…,'en')` feeds `source_digest`. Use code-unit comparison so an independent verifier can reproduce the digest. No test recomputes `source_digest`.
7. **`setup-osstack` authorization (Medium wording).**
   - The text doesn't say that invoking the skill, or asking for setup, is not itself write authorization. The spec requires that.
   - "already authorized these settings" is undefined. Require that the user named the host, scope and settings, or approved the displayed diff.
   - Consider requiring a backup or rollback note before a write.
8. **Self-containment and portability (Low).**
   - Entries link to sibling entries, so copying a single skill breaks them. The test title "self-contained" overclaims. Add "copy all four together" to `EXPORT.md`.
   - The shipped references assume the OSStack repo (`scripts/smoke-engineering-decision.mjs`, `docs/reports/…`) and use jargon like MethodBinding without defining it.
9. **Missing tests.**
   - No test exports the real `osstack-methods-skill/` tree. Please attach dry-run output for both hosts; I expect 40 files, and the real files looked clean when I read them. Gate this in CI.
   - Untested paths: `.agents`, `.claude` and `.osstack` guards, a symlinked-parent alias, `output_inside_source`, FIFO, the byte, node and depth limits, case collisions, invalid UTF-8, and HTML navigation.
10. **Unverifiable citations (Info).** I could not check `learn.chatgpt.com/docs/build-skills` or the pinned GitHub URL in `host-usage.md`. The spec asks for retained captures of such checks, so please attach them.

## Scope notes

- The Codex (`.agents/skills`) and Claude (`.claude/skills`) layouts, the YAML front matter, and the stated limits are consistent with a D2a material export. The limits are no discovery, no runtime, and no qualification.
- I raised nothing about installation, native discovery or principal qualification.