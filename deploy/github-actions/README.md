# GitHub Actions verification template

This workflow verifies mission PRs in `osborn-studio/osstack-bridge-sandbox`. Each job runs on a separate GitHub-hosted runner.

1. `prepare` reads the live PR, checks its eligibility, and records its head commit.
2. `verify` checks out that commit with read access, confirms its SHA, and runs the sandbox check. For another repository, replace only the step marked “Repository verification”.
3. `report` uses check-write access to publish `osstack/verify-actions` on the recorded commit. It reports success only when `verify` succeeds.

Install the template through a reviewed PR that copies it to `.github/workflows/osstack-verify.yml` in the target repository. After merge, the host pins the installed file’s Git blob SHA. Get that SHA from the target repository with `git hash-object .github/workflows/osstack-verify.yml`.

The Grok Bot triggers the workflow in the target repository with `gh workflow run osstack-verify.yml -f pr=<n>`. Replace `<n>` with the PR number. This is the only input.
