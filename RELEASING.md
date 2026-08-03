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
   dist-tag and tags the release. Public workspace packages are published in
   dependency-first topological order, one at a time. The first publish error
   stops the train before any dependent package can become visible with a
   missing exact internal dependency.

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

- Every public workspace package must exist on npm before Trusted Publishing
  can be configured. Publish a new package's first version manually from an
  authorized npm account, then configure `gilosbornhello/osstack` and
  `release.yml` as that package's GitHub Actions Trusted Publisher.
- The Release workflow uses GitHub OIDC (`id-token: write`) and does not need a
  long-lived `NPM_TOKEN`. Local npm login/token access is only a bootstrap and
  manual recovery path.
- The `@osstack` npm scope must exist and be owned by the publishing account
  (`npm org` / scope settings on npmjs.com).
- **EDGEONE_API_TOKEN secret** on the GitHub repo: the Tencent EdgeOne Makers
  API token used by the Knowledge Cloud deploy workflow. Until either this
  token or the optional `EDGEONE_DEPLOY_HOOK_URL` fallback is configured,
  Knowledge Cloud deploy runs can validate build/smoke checks but must not be
  run with `deploy=true`.

Before merging the Version Packages PR, verify every public package has been
bootstrapped and the local recovery account remains usable:

```bash
pnpm smoke:npm-bootstrap
pnpm preflight:npm-bootstrap
pnpm smoke:npm-trust
pnpm configure:npm-trust -- --json
pnpm configure:npm-trust -- --execute
pnpm preflight:npm-trust
pnpm smoke:npm-deprecation
pnpm deprecate:npm-broken -- --json
pnpm smoke:npm-publish-order
pnpm preflight:npm-publish
```

The bootstrap check is a hard OIDC publish gate inside `pnpm release`; it does
not prevent Changesets from maintaining the Version Packages PR. The local
publish-access check is diagnostic only and does not represent the workflow's
OIDC identity. The trust preflight is read-only but npm requires a fresh 2FA or
web-auth session before it will reveal package trust mappings. The configuration
command is non-mutating unless `--execute` is present. Execute mode uses the
official npm 11 `npm trust github` interface, preserves correct mappings, refuses
to replace mismatches, audits every mapping before any write, requires the
`osbornhello` npm account, verifies every applied mapping, waits two seconds
between changes, and can be rerun safely after an interruption. npm documents
that the first command requires 2FA and that a five-minute skip window can cover
a bulk configuration run: https://docs.npmjs.com/cli/v11/commands/npm-trust/

The broken-version deprecation command also defaults to a no-network plan. Its
explicit `--execute` mode binds the two known-broken exact `0.13.0` versions and
their upgrade messages, requires the `osbornhello` account, audits both registry
records before any write, refuses to replace a different existing warning, and
verifies each applied warning. Run `pnpm deprecate:npm-broken -- --execute` only
in the same fresh interactive npm session. The wrapper deliberately does not
rely on `npm deprecate --dry-run`, because npm documents that dry-run is not
honored by network-related commands:
https://docs.npmjs.com/cli/v11/commands/npm-deprecate/

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

After `EDGEONE_API_TOKEN` is configured and release readiness is clean,
deploy:

```bash
gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true
gh run watch <knowledge-cloud-deploy-run-id> --exit-status
```

`EDGEONE_DEPLOY_HOOK_URL` is still supported as a fallback for projects that
already use EdgeOne webhook deployment, but the primary path is the EdgeOne
Makers CLI with `EDGEONE_API_TOKEN`.
