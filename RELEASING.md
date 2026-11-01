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
   missing exact internal dependency. When that publish fails, follow
   [Manual fallback publish](#manual-fallback-publish).

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
  authorized npm account, then configure `osborn-studio/osstack` and
  `release.yml` as that package's GitHub Actions Trusted Publisher.
- The Release workflow uses GitHub OIDC (`id-token: write`) and does not need a
  long-lived `NPM_TOKEN`. Local npm login is the bootstrap for a package's
  first version and the [manual fallback publish](#manual-fallback-publish)
  when Trusted Publishing fails. Keep `NPM_TOKEN` and `NODE_AUTH_TOKEN` out of
  [`.github/workflows/release.yml`](.github/workflows/release.yml).
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

### When organization policy blocks version PR creation

The Changesets step fails with `GitHub Actions is not permitted to create or
approve pull requests` and pushes `changeset-release/main` without opening a
PR. This happened for 0.23.0, whose Version Packages PR (#358) was opened by a
maintainer from the pushed branch.

`pull-requests: write` does not override the organization setting that forbids
GitHub Actions from creating pull requests. A repository-level attempt to enable
`can_approve_pull_request_reviews` can return HTTP 409 under that policy.
Keep the organization policy intact and use an authorized maintainer's `gh`
session to create the version PR from an isolated, clean checkout of current
`main`: run `pnpm install --frozen-lockfile`, `pnpm build`, then
`pnpm version:packages` (the inventory generator requires the built CLI),
inspect the generated manifests, lockfile and changelogs, and commit/push the
version branch. Create its PR with `gh pr create --base main` and require the
same independent review and CI as any other release PR. Do not put a personal
access token into the Release workflow to work around the organization setting.

Merge only after package bootstrap and publisher verification succeed. With
pending changesets consumed, the existing Changesets action takes its publish
path on that merge; it no longer needs to create a version PR for that train.
This is a manual release path, not a claim that automated PR creation is enabled.

### Repository transfers and Trusted Publishers

Package repository metadata and the npm publisher must both identify
`osborn-studio/osstack`, with workflow `release.yml`. A GitHub redirect from
`gilosbornhello/osstack` does not change the stored npm OIDC relationship.
The configuration script deliberately refuses to replace a mismatched mapping.
For a verified repository transfer, first inventory all existing package
mappings. For each exact old mapping, use `npm trust revoke <package> --id <id>`,
then `npm trust github <package> --repository osborn-studio/osstack
--file release.yml --allow-publish`, preserving any existing staged-publish
permission. Read it back before advancing. Stop on any unexpected repository,
workflow, environment, or permission, and record partial progress for recovery.

Use an interactive terminal for npm web authentication. npm's CLI requires both
stdin and stdout to be terminals before opening its web-auth flow; capturing
stdout in a subprocess can instead return `EOTP`, even after a successful login.
The website's temporary skip window still requires completing the CLI web-auth
handshake. Never print or persist the returned OTP as an operational workaround.

## Manual fallback publish

Use this section when the Release workflow's Trusted Publishing step fails for
a version that is already committed on `main`. The workflow publishes with
GitHub OIDC from
[`.github/workflows/release.yml`](.github/workflows/release.yml). Keep
`NPM_TOKEN` and `NODE_AUTH_TOKEN` out of that workflow.

[`scripts/publish-packages-safely.mjs`](scripts/publish-packages-safely.mjs)
retries a transient `E404`, `404 Not Found - PUT`, `E429`, `ETIMEDOUT`,
`ECONNRESET`, or `E5xx` error after 15 seconds, 30 seconds, 60 seconds, and
90 seconds. Use this fallback when those retries are exhausted, or when the
same package returns `404` on every attempt. Release 0.23.0 did that for
`@osstack/graph`.

This fallback publishes from an interactive npm login. A version published this
way has no provenance attestation. npm attaches provenance only for a Trusted
Publishing publish from a public repository when the package is public.
Source: https://docs.npmjs.com/trusted-publishers/#automatic-provenance-generation

The OIDC publisher is `osborn-studio/osstack` with workflow `release.yml`.
Login rules for this fallback are in
[Repository transfers and Trusted Publishers](#repository-transfers-and-trusted-publishers).

### 1. Confirm the release checkout

Run these commands from the repository root:

```bash
git status --porcelain
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

`git status --porcelain` must print nothing. The branch must be `main`. `HEAD`
must be the merge commit of the Version Packages PR for this train. If any
check fails, stop.

Build the packages. `prepack` refuses to pack a package that has no `dist/`.

```bash
pnpm install --frozen-lockfile
pnpm build
```

### 2. Confirm the npm account

Open a terminal where stdin and stdout are both terminals. A captured stdout
can return `EOTP`. Follow the web-auth rules in
[Repository transfers and Trusted Publishers](#repository-transfers-and-trusted-publishers).

```bash
npm whoami
```

The command must print `osbornhello`. That is the account required by
`scripts/configure-npm-trusted-publishers.mjs` and
`scripts/deprecate-broken-npm-versions.mjs`. If the command fails, or if it
prints a different name, stop. Log in as `osbornhello` in this same terminal.
`npm whoami` checks this local login. It does not check the GitHub Actions
Trusted Publisher.

### 3. Print the publish order

Print the order from the publisher. This command does not contact npm and it
does not publish:

```bash
node scripts/publish-packages-safely.mjs --plan
```

The JSON `kind` must be `safe-sequential-npm-publish-plan` and `ok` must be
`true`. Read `plan` from `order` 1 through the end. Publish in that order.
The order is `buildTopologicalPublishPlan` in
[`scripts/publish-packages-safely.mjs`](scripts/publish-packages-safely.mjs).
A package follows each of its internal dependencies. The ready set is sorted
with `localeCompare("en")`, and it is sorted again each time another package
becomes ready. Copy `name`, `version`, `directory`, `access`, and `dist_tag`
from this JSON. Use the `plan` array as the package list.

`dist_tag` is the `--tag` value. For a train-day release it is `latest`.
If the command fails with
`prerelease versions require OSSTACK_NPM_DIST_TAG to be set explicitly`,
set `OSSTACK_NPM_DIST_TAG` to the pre-release tag and run the command again.
If the command fails for any other reason, stop. The publisher refuses to
publish a pre-release version as `latest`.

`publish_argv` is the argument list for `pnpm`. The publish command in step 5
is that list.

### 4. Skip a version that is already published

For each plan item, before you publish it, run:

```bash
npm view "<name>@<version>" version dist-tags
```

Quote the package spec. Substitute `name` and `version` from that plan item.

- The command prints `version = '<version>'` and that value equals the plan
  `version`: this version is already on the registry. Skip the publish. Keep
  the next item's `order`. The Release workflow may already have published
  this version, with provenance. `dist-tags` on this output is the package's
  current tag map.
- The command fails and the message contains `E404` or `ETARGET`: this version
  is absent. Publish it in step 5.
- The command fails for any other reason: stop. Leave every later package
  unpublished.

Before you publish an absent version, and only when `dist_tag` is `latest`,
read the current tags:

```bash
npm view "<name>" dist-tags
```

`E404` means the package has no published version. Continue to step 5. Any
other failure: stop. When the command prints `latest`, compare that version
with the plan version by major, then minor, then patch, as numbers. When
`latest` is greater than the plan version, stop. A publish with `--tag latest`
would point `latest` at the older version. Leave the tag unchanged.

A skipped dependency stays in front of its dependents. Continue at the next
`order`. Publish a dependent only after every name in its
`internalDependencies` is on the registry at the plan version.

### 5. Publish one package

Publish one absent version with the plan item's `publish_argv`:

```bash
pnpm --dir <directory> publish --access <access> --tag <dist_tag> --no-git-checks --json --registry https://registry.npmjs.org/
```

Substitute `directory` and `access` from the plan item, and `dist_tag` from
the plan root. Run the command from the repository root.

`--no-git-checks` is part of `publish_argv`, the same list the Release
workflow uses. The empty `git status --porcelain` output in step 1 is the
clean-tree check for this manual run.

The command uses the `osbornhello` login from `npm whoami`. npm does not
attach a provenance attestation to this publish. The argument list has no
provenance flag. Provenance stays on the Trusted Publishing path linked above.

If the command fails, stop. Leave every later package unpublished.

### 6. Verify the published version

After each successful publish, run:

```bash
npm view "<name>@<version>" version dist-tags
```

A successful check prints `version = '<version>'` and
`dist-tags = { <dist_tag>: '<version>', ... }`. Check both fields:

- `version` equals the plan `version`.
- `dist-tags` includes `<dist_tag>`, and that tag's value equals the plan
  `version`.

If either check fails, stop. Leave the dist-tag unchanged. Leave every later
package unpublished.

After the last plan item, every public version in the plan is on the registry.
Record each version this procedure published. Those versions have no provenance
attestation. Versions the Release workflow published still have provenance.

This procedure does not create the git tag `<name>@<version>` and it does not
open a GitHub release. The publisher prints `New tag: <name>@<version>` only
for a version it publishes itself. A later Release workflow run skips a version
that is already on the registry and does not print that line for the skipped
version.

Then continue with step 5 of
[How a change gets released](#how-a-change-gets-released).

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
