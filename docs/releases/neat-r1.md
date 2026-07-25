# neat R1 release candidate

R1 adds portable resolution evidence and one policy-gated, low-risk write path
without changing the default read-only behavior of `osstack neat check`.

## Included

- strict resolution and review-artifact v1 schemas tied to report `diff_id`;
- atomic `neat review` authoring with active and evidence-preserving resolved
  report views;
- `--review-file` exit policy based only on unresolved findings;
- closed patch action/plan v1 schemas and deterministic previews;
- one action, `create_instruction_import`, which can only create a missing file
  containing one exact confined import line;
- `neat fix`, preview-first, with complete-report/config-hash checks, execute
  policy, docs allowlist, atomic no-replace apply, conflict detection, and
  idempotent `already_applied` results;
- companion skill support for `reviewed_no_change` without fake documentation
  edits.

## Safety boundary

No R1 command deletes, renames, replaces, or creates symlinks. `--yes` is only
command confirmation and does not satisfy a `requires_approval` policy. The
default checker still performs zero writes, and persistence remains out of R1.

Publication still requires the normal repository release-owner approval and
full monorepo release gates.
