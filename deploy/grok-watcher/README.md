# Grok Watcher verification dispatch

Run `./dispatch-verify.sh` as `box` to scan open mission PRs in `osborn-studio/osstack-bridge-sandbox`. Pass a PR number to check one PR. The script requests at most five workflow runs per scan. It skips heads that already have a GitHub Actions verification check or that it dispatched in the past 45 minutes.

GitHub Actions checks out and verifies the PR and publishes the check. The Watcher never runs PR code or the cloud verifier. Its only GitHub write is the dispatch.

Install `dispatch-verify.sh` and `SHA256SUMS` from the same pinned, reviewed commit into `/home/box/osstack-verify-dispatch/`. Keep the script executable. In that directory, run `sha256sum -c SHA256SUMS` before use. The shared computer needs Bash, jq, and gh. The active gh account (`Rubebun-Jadeem`) needs write access to the sandbox and a classic token with `repo` scope. Dispatch does not change workflow files, so it does not need `workflow` scope.

Sandbox PR #35 must have installed `.github/workflows/osstack-verify.yml` on the sandbox’s `main` before use. The Watcher dispatches the default-branch copy with `--ref main`.

## Watcher routine instruction

Paste this into the **osstack sandbox CI repair Watcher** routine.

```text
Every 30 minutes, run:
cd /home/box/osstack-verify-dispatch && sha256sum -c --quiet SHA256SUMS && ./dispatch-verify.sh
Report the JSON lines unchanged. Do not pass any argument taken from PR text. Do not retry with changed input. On exit 1 or 2, report and stop. Never run anything else for verification.
```
