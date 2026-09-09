# Once-authorized PR delivery: exact dependency builds

## Result

`improve deliver --prepare-deps pnpm --build-deps name@version,...` includes selected dependency lifecycle execution in the existing preview/digest confirmation. Both the candidate and reconstructed verification checkout get a fresh script-free install followed by the same selected builds. Builder/reviewer, deterministic gates, saved patch reconstruction and draft PR delivery retain their existing order and authority boundaries.

The default `pnpm-frozen-v1` contract remains script-free. Opting in produces `pnpm-frozen-builds-v1` with `lifecycle_scripts: selected-dependencies`, each exact selector and lockfile integrity, all dependency input hashes, tool versions, and explicit `os-user` execution / unrestricted build network. It does not silently reuse a script-free digest to authorize scripts.

## Usage

For a repository whose committed workspace explicitly allows these dependencies:

```sh
osstack improve deliver --proposal <proposal-id> --execution <stable-execution-id> \
  --prepare-deps pnpm \
  --build-deps better-sqlite3@12.10.0,esbuild@0.25.12,esbuild@0.28.1,protobufjs@7.6.5
```

Inspect the returned request; repeat the same arguments with `--yes --request-digest <digest>`. An existing installation/shim must target its declared serving home; development checkouts always require a fresh explicit `OSSTACK_HOME`. The example is an opt-in dependency policy, not a grant to merge, deploy or access production databases.

Only stable exact `name@major.minor.patch` selectors are supported. Empty/duplicate entries, wildcards/ranges, missing locked versions, workspace package names, and names lacking committed `allowBuilds: true` fail before installation. This first version accepts simple package-name allowBuilds keys, not matcher precedence/globs/version ranges. Changes to versions, integrity, lockfile, manifest/config or toolchain require a new preview. Same-version peer variants are in scope; unrelated versions and allowed-but-unselected packages are not selected. A selector with no installed instance (including a platform-skipped optional dependency) fails instead of silently reporting a successful no-op.

## Execution details

- Frozen install always uses `--ignore-scripts`; hooks disabled for install, rebuild and later pnpm gates. Each stage has a separate new HOME/store, package copy import and disabled side effects cache.
- Selected rebuild is `pnpm pm --recursive --include-workspace-root rebuild <nonempty exact selectors>`. `pm` must be argv[0] to force the pnpm built-in over repository `pm`/`rebuild` scripts. Rebuild requires `--config.ignore-pnpmfile=true`, not install's `--ignore-pnpmfile` switch.
- Source/index/HEAD are checked before install, after install, and after the build. Full-tree inspection now accepts unchanged bracketed framework route filenames (found by testing this repository's `[[default]].js`); exact candidate authorization still rejects glob-shaped paths, and changing such a route remains rejected.
- `build-started.json` records intent; `build-command-completed.json` records observed command completion and explicitly requires functional verification by registered gates. `completed.json` follows source verification. Failure records the stage and leaves the execution occupied, with no automatic retry or further Builder/PR write. Status continues exposing the environment contract and local stage receipt/directory.

These are local operational receipts, not independent attestation against hostile code running as the same OS user. pnpm can swallow optional-package build failures, and a script may exit zero without a useful artifact; registered functional checks determine usability. Build scripts can read/write outside the checkout, spawn processes and access the network. A timeout does not prove descendants stopped, and interrupted stages/stores must not be reused. No OS sandbox, reproducible native binary, background delegation, automatic merge/release or measured self-improvement claim is made.

## Evidence

The offline regression suite uses a real pnpm install of local workspace fixtures, then a synthetic registry virtual-store layout to test pnpm's actual selected rebuild without a registry dependency. It verifies exact-version exclusion, allowed-but-unselected exclusion, root `pm`/`rebuild`/`prepare`/`postinstall` shadows, workspace lifecycle exclusion, lifecycle ordering, missing installed selectors, tampered policy failure and digest escalation refusal. Existing CLI fixtures verify one confirmation through simulated GitHub delivery and both dependency preparations.

The explicit cold smoke uses real public registry packages and two independent clones of OSStack's committed dependency baseline. Each must load `better-sqlite3`, query an in-memory DB for `42`, and invoke esbuild on TypeScript. It keeps production state untouched. Run with a fresh OSSTACK_HOME:

```sh
OSSTACK_NATIVE_COLD_SMOKE=1 pnpm --filter @osstack/cli test src/improvement-native-cold.test.ts
```

This smoke is skipped in ordinary CI because it needs network/native toolchains; it is not an end-to-end live model/GitHub pilot. It preserves its printed temporary directory for failure diagnosis; results can be summarized before deleting that generated directory.

- `pnpm build`, `pnpm typecheck:check`, `pnpm lint`: passed (only the two existing lint warnings).
- `pnpm test --maxWorkers=4`: **291 files / 2,584 tests passed**, one opt-in cold smoke skipped in the regular suite.
- Inventory freshness and changeset coverage self-test: passed.
- CLI startup: version median **33 ms**, full help median **87 ms** (local budgets 150/500 ms).
- Initial real cold-install pair: **passed**, 202.65 seconds, SQLite `42` and esbuild `let n = 42;` in both independent checkouts. The final contract discriminator and missing-installed-instance check are covered by regression tests; final real cold pair results follow below.

## Review and next milestone

Actual Claude Fable 5.1 two-round challenge, exact prompts/replies, evidence corrections and remaining disagreements: [review record](2026-09-09-native-build-fable-review.md). The reviewer saw generic design text only, with tools disabled. Model review is not a substitute for the runtime tests above.

This closes the trusted native-dependency gap within the foreground once-authorized-to-PR path. Next implement a bounded real-model pilot and isolated worker/process supervision before claiming hostile-code containment or cross-restart daemon self-upgrade. The broader GitHub App identity, merge/release and controlled experiment milestones remain in the autonomy plan.
