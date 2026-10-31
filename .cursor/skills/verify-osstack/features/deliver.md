# Deliver a task

`osstack deliver` is the product entry: a user gives a prompt plus how to execute and verify it, and osstack queues a task, runs the loop, verifies it, and writes a report, scorecards, and a checksummed proof pack into the workspace.

## Sub-features

- `deliver-success` runs `--execute` then `--verify`, outcome `success`, exit `0`.
- `deliver-artifacts` writes `reports/osstack-report-<loop>.md`, `release/osstack-scorecard-<loop>.{md,html}`, `release/osstack-proof-<loop>/` and `.zip`.
- `deliver-proof-validate` validates the proof pack from a second command; `proof-core` passes only for a landed worktree run.
- `deliver-worktree-land` `--worktree --land-branch main` runs in an isolated git worktree and merges into the scratch repo's `main`.
- `deliver-verify-fail` a failing verify command ends in a non-success outcome and non-zero exit.
- `deliver-report` re-reads the run with `osstack report`.
- `deliver-cockpit` the workspace cockpit view counts the new report and proof pack.

## How to get to it (user POV)

- Run `osstack deliver "<prompt>" --workspace <repo> --execute "<cmd>" --verify "<cmd>" --auto-agent [--json]` in a terminal.
- Read results with `osstack report --workspace <repo>` and `osstack proof validate <loop_id> --workspace <repo>`.
- See the counts in `osstack cockpit --workspace <repo>`.

## Driving it with verify-osstack.sh

Preconditions:

- Doctor healthy. A fresh workspace: `W=$($V workspace deliver)`. `hello.txt` does not exist in `$W`.

- **Deliver.** Run `$V cli deliver -- deliver "Write hello.txt" --workspace "$W" --execute "node -e \"require('fs').writeFileSync('hello.txt','hi')\"" --verify "node -e \"process.exit(require('fs').existsSync('hello.txt')?0:1)\"" --auto-agent --json`. Exit `0`; stdout JSON has `completed_tasks[0].outcome == "success"`, a `loop_id`, and `artifacts.{report,scorecard_markdown,scorecard_html,proof_dir,proof_zip,proof_manifest}`.
- **Side effect.** `cat "$W/hello.txt"` prints `hi`.
- **Proof pack.** `artifacts.proof_dir` contains `manifest.json`, `verify-results.json` (`status: "pass"`, reviewer `local-verifier`), `sha256sums.txt`; run `(cd <proof_dir> && sha256sum -c sha256sums.txt)` — all `OK`.
- **Validate (plain run).** Run `$V cli proof-validate -- proof validate <loop_id> --workspace "$W" --json`. Observed 2026-10-31: exit `1`, `ok: false`, `missing[0].control_id == "worktree-isolation"` because `worktree-status.json` is `{"status":"unknown"}` without `--worktree`. Record it as the plain-run result; do not report it as a validated pack.
- **Worktree + land.** In a fresh `W3=$($V workspace deliver-land)` (a local repo with no remote), run `$V cli deliver-land -- deliver "Write hello.txt and land" --workspace "$W3" --execute "node -e \"require('fs').writeFileSync('hello.txt','hi')\"" --verify "node -e \"process.exit(require('fs').existsSync('hello.txt')?0:1)\"" --worktree --worktree-root "$W3/.osstack-worktrees" --land-branch main --auto-agent --json`. Exit `0`; `git -C "$W3" log --oneline main` shows `osstack loop task task_<id>` on top of `init`; `$W3/hello.txt` is `hi`.
- **Validate (landed run).** Run `$V cli proof-validate-land -- proof validate <loop_id> --workspace "$W3" --json`. Exit `0`, `ok: true`, `missing: []`.
- **Report.** Run `$V cli report -- report --workspace "$W"`. Stdout starts `# Osstack Loop Report - <loop_id>` and shows `Success: 1`.
- **Cockpit.** Run `$V cli cockpit-ws -- cockpit --workspace "$W"`. Stdout has `evidence reports=1 proof_packs=1` and `latest_proof=<proof_dir>`.
- **Verify failure.** In a second fresh workspace `W2=$($V workspace deliver-fail)`, run `$V cli deliver-fail -- deliver "Must fail" --workspace "$W2" --execute "true" --verify "node -e 'process.exit(1)'" --auto-agent --json`. Exit non-zero (observed `2`) and outcome is not `success` (observed `escalated`).
- **Cockpit page.** Run `$V screenshot cockpit-ws "/dashboard?workspace=$(node -p 'encodeURIComponent(process.argv[1])' "$W")" "Proof packs"`. `ui/cockpit-ws.text.txt` shows `Reports` / `1 markdown report(s)` and `Proof packs` / `1 checksumed proof pack(s)`.
- **Keep.** `$V keep deliver "$W/release"` and `$V keep deliver "$W/reports"` before cleanup.

## Gotchas

- The task queue persists in `$W/tasks`; a second `deliver` in the same workspace re-reports earlier tasks in `completed_tasks`. Use a fresh workspace per journey.
- `deliver` runs locally and writes into the workspace; it does not need the daemon and does not appear under cockpit `recent runs` (those are daemon tasks). Cockpit evidence counts appear only with `--workspace`.
- The workspace is left with untracked `LOOP-STATE.json`, `STATE.md`, `tasks/`, `reports/`, `release/`. Never point `--workspace` at a real repo during verification.
- `--worktree` without `--land-branch` leaves the worktree `preserved` (branch `osstack/loop/<loop>/<task>`, commit recorded) and `proof validate` still reports `worktree-isolation` missing; only the landed (`merged`) run passes `proof-core`. Whether that is intended is not settled by this map; report what you observe.
- `--land-branch` merges locally into the given branch of `--workspace`. Use it only on a scratch repo with no remote.
- `--execute` uses the shell executor, so this path proves loop/verify/proof plumbing, not the Claude/Codex adapters. Never add `--autonomy guarded-git` in verification: it opens PRs, waits on CI, and merges.
