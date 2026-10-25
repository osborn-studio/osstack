# Evidence lesson bridge audit disposition

Requested CLI model: `claude-haiku-5-5`; tool access, slash commands, hooks, plugins and MCP disabled via the recorded command/settings. The CLI emitted `unrecognized_model`; its returned JSON is retained as an external audit result, not authentication of the underlying model identity.

## First audit

- P2 RPC identity mismatch: fixed by validating returned run ID and canonical repo against request, including dry-run and pre-publication recheck. Tenant/qualification are strict schema literals.
- P2 payload fingerprint disclosure: fixed by never reading or hashing payload contents. Fingerprints bind persisted event metadata and payload byte length, not same-length payload edits. This limitation is explicit in guide/draft.
- P2 large draft/reviewed file handling: fixed via metadata-only reviewed existence checks and bounded read with oversized edits treated as preserved content requiring a revision. Symlink draft leaves remain rejected.
- Existing P1 automatic Loop writer overwrote user edits: parent authorized fixing it in this batch. Now create-only atomic publication, unchanged-input idempotency, bounded deterministic revisions, reviewed-state checks, collision-resistant names for normalized/long task IDs.
- Existing P2 explicit skill append before lifecycle move: fixed retry duplication using source-bound marker and no-overwrite lifecycle links. Injected link EIO verifies retry appends only once. Failure after a successful link but before unlink can leave both copies; neither is overwritten, and manual reconciliation is documented.

## Validation

- CLI attention-lesson: 19/19 tests.
- Loop lesson-draft: 24/24 tests, including actual LoopEngine hook.
- Loop build and CLI/Loop typecheck passed.
- Biome: four changed TS files passed.
- TDD negative log retained for old overwrite/collision/concurrent-write behavior.
- Existing root-owned full suite and real daemon/bin route integration remain parent responsibilities.

## Scope

Ordinary authenticated daemon evidence produces investigation drafts only, using the existing explicit review lifecycle. Strong Graph failure→repair→verification-success qualification is planned and pending trusted host registration and complete attempt history. No success-after-repair bridge is claimed.

## Second audit

Second audit: no critical/high findings; all four medium/low issues fixed: canonical skill target preserves symlink, original skill mode preserved, generated task namespace reserved to prevent literal-name collision, and all-event session conflict check catches contamination beyond page 128.

Third audit explicitly returned `p0_p1_findings: []`. Its two residual P2/P3 findings were fixed with regression cases: verify resolved target basename is SKILL.md; return preserved revision conflict state for edited/oversized revision files without throwing. Final narrow closure audit is recorded in `haiku-result-4.json`.

All source inputs/results/stderr are retained. Final source hashes are in `source-manifest.json`.


Fourth narrow audit closed canonical skill basename validation. It raised a conditional P1 only because the narrow context omitted safeRead/writeRunLessonDraft, hypothesizing oversized inputs returned null or threw. Fifth evidence-completion audit included the exact unchanged helpers and passing test log, retracted that conditional finding as never confirmed, and returned confirmed_counts P0=0/P1=0 with no new findings. All five raw rounds are retained; final closure is `haiku-result-5.json`.
