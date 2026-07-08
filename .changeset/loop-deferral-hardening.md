---
"@osstack/loop": patch
"@osstack/cli": patch
---

Post-completion hardening of the loop-engineering line (four documented minor
deferrals, all fail-closed):

- Verifier fails closed on unknown evaluation-id judgments instead of dropping
  them: a verifier-adapter judgment whose id matches no requested spec now
  surfaces an issue (rule `verify.unknown_evaluation_id`) — failing orphan =
  error, passing orphan = warning. A real failure reported under a mismatched id
  can no longer let a run pass silently.
- `osstack loop lessons promote --to-skill` refuses any target that is not a
  `SKILL.md` (external skill paths still allowed; arbitrary files are rejected).
- `DiscoveryPolicy` rejects unknown `source_authorization` keys at parse time
  (e.g. a typo'd `task_quee`) instead of silently falling through to the default.
- Scorecard scale (100 base, 110 with a budget dimension) is documented as an
  additive rubric with the denominator always rendered — never a bare percentage.
