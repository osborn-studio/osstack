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
   typecheck, tests, and `pnpm smoke:npm-install`. The smoke packs every
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

## Channels

| dist-tag | audience | promotion |
|----------|----------|-----------|
| `latest` | all machines (launchd autoupgrade follows this) | train-day publish |
| `canary` | the maintainer's own box | optional: `pnpm changeset publish --tag canary` from main between trains |

## Prerequisites (one-time)

- **NPM_TOKEN secret** on the GitHub repo: an npm automation token with
  publish rights to the `@osstack` scope. Until configured, release.yml
  only maintains the Version PR and skips publish.
- The `@osstack` npm scope must exist and be owned by the publishing account
  (`npm org` / scope settings on npmjs.com).

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
