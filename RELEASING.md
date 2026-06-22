# Releasing osstack

osstack ships on a **bi-weekly release train**: every other Friday, whatever
is merged and green on `main` goes out. Nothing is rushed onto a departing
train — if a change isn't ready, it simply takes the next one. After 2–3
smooth cycles, tighten the cadence to weekly by just doing it every Friday.

## How a change gets released

1. Land your PR with a changeset:

   ```bash
   pnpm changeset          # pick bumped packages + semver level, write summary
   ```

   Every user-visible change needs one. Pure-internal changes (CI, docs)
   can skip it (`pnpm changeset --empty` if the bot insists).

2. CI (`.github/workflows/ci.yml`) gates the merge: Biome lint, build,
   typecheck, tests, and `pnpm smoke:npm-install`. This daily PR gate runs on
   Ubuntu so ordinary development is not blocked by paid macOS runner
   availability. The smoke packs every
   `@osstack/*` workspace package, installs the tarballs into a temporary
   global npm prefix, then verifies `osstack --version` and
   `osstack loop doctor --workspace <tmp> --json`.

3. The release workflow (`.github/workflows/release.yml`) keeps a
   **"Version Packages" PR** open on main. It accumulates pending changesets
   into version bumps + CHANGELOG entries.

4. **Train day (every other Friday):** merge the Version Packages PR.
   The workflow publishes all bumped packages to npm under the `latest`
   dist-tag and tags the release.

5. Verify on a machine: `osstack upgrade --dry-run`, then `osstack upgrade`.

The macOS single-binary release-candidate smoke lives in
`.github/workflows/macos-release-candidate.yml`. It runs on `main` changes that
touch the binary release path and can also be triggered manually:

```bash
gh workflow run "macOS Release Candidate" --ref main
```

## Channels

| dist-tag | audience | promotion |
|----------|----------|-----------|
| `latest` | all machines (launchd autoupgrade follows this) | train-day publish |
| `canary` | the maintainer's own box | optional: `pnpm changeset publish --tag canary` from main between trains |

## Prerequisites (one-time)

- **NPM_TOKEN secret** on the GitHub repo: an npm automation token with
  publish rights to the `@osstack` scope. Until configured, release.yml
  only maintains the Version PR and skips publish.
- **FLY_API_TOKEN secret** on the GitHub repo: a Fly.io token with deploy
  rights to the `osstack-knowledge-cloud` app. Until configured,
  Knowledge Cloud deploy runs can validate build/smoke checks but must not
  be run with `deploy=true`.
- The `@osstack` npm scope must exist and be owned by the publishing account
  (`npm org` / scope settings on npmjs.com).

Before merging the Version Packages PR, run:

```bash
osstack release doctor --target all --json
osstack release plan --json
```

The plan is safe to execute only when `safe_to_execute` is `true`.
If GitHub Actions cannot start jobs because account billing or spending limits
are blocked, `release doctor` reports `github_actions` as an error and the
plan keeps publish/deploy commands unsafe.

If GitHub marks the Version Packages PR CI as `action_required`, rerun the
latest workflow before merging:

```bash
gh run list --branch changeset-release/main --limit 5
gh run rerun <latest-ci-run-id>
gh run watch <latest-ci-run-id> --exit-status
```

This is expected when GitHub requires an operator decision for the bot-created
Version Packages PR workflow.

## Hotfix flow (between trains)

1. Branch from main, fix, add a `patch` changeset, merge (CI must pass).
2. Merge the regenerated Version Packages PR immediately instead of waiting
   for the train.
3. Machines pick it up on their next weekly `ai.osstack.autoupgrade` run,
   or run `osstack upgrade` manually for instant rollout.

## Consumers to keep in sync

- **hermes-skill/SKILL.md** declares `daemon_npm_version: @osstack/cli@<v>`.
  Until this is automated, bump it in the same PR as breaking daemon changes.
- **partner-os** consumes `@osstack/{core,agents,hermes-adapter}` — after the
  first npm publish, switch its `link:` deps to semver ranges (tracked in its
  own RELEASING.md).

## Rollback

`osstack upgrade` health-checks the daemon after install and rolls back
automatically. Manual rollback: `npm i -g @osstack/cli@<previous>` and
restore the matching `~/.osstack/backups/state-v<previous>-*.db` snapshot
only if the bad version migrated the schema.

## Knowledge Cloud deploy

Run a validation-only deployment check first:

```bash
gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=false
```

After `FLY_API_TOKEN` is configured and release readiness is clean, deploy:

```bash
gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true
gh run watch <knowledge-cloud-deploy-run-id> --exit-status
```
