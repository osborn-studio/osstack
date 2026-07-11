---
"@osstack/core": minor
"@osstack/cli": minor
---

Policy Profile loader + `osstack policy check` + observe-mode gate (R1.3,
POLICY_PROFILE_V1). The human-owned, git-tracked contract that bounds what
osstack may do in a repository, enforced by the kernel — not by prompt text.

- `@osstack/core`: `packages/core/src/policy/profile.ts` — fail-closed Zod
  schemas for `.osstack/repo.yaml` (`RepoConfig`) and `.osstack/policy.yaml`
  (`PolicyProfile`), `.strict()` at every nesting level, the closed 13-category
  vocabulary (P-005), and cross-list disjointness via `superRefine` (P-003).
  `loadRepoConfig` / `loadPolicyProfile` return `undefined` for an absent file
  (legacy mode) and throw with the file path + issue list for a present-but-
  invalid file (P-001). `profileBudgetToLoopBudget` maps budgets onto the loop
  budget primitives per the P-003 table (minutes ×60000) without importing
  `@osstack/loop`. Adds the `yaml` dependency (already used by cli/config).
- `@osstack/cli`: new read-only `osstack policy check [--repo-path P] [--json]`
  validates both files and prints mode/budgets/category lists or the precise
  errors (exit 0 valid or both absent; exit 1 invalid). First enforcement point:
  `deliver` and `loop run` consult the workspace profile after workspace
  resolution — `mode: observe` refuses execution (exit 2) before any
  worktree/task work; `propose`/`execute`/absent behave exactly as before; an
  invalid policy file fails closed (exit 1).

No behavior change when policy files are absent. Finer-grained
`allowed_auto_changes` / auto-apply wiring is deferred to a later increment.
