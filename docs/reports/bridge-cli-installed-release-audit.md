# Installed bridge candidate audit

Date: 2026-11-07. Worker model: `gpt-6.1-sol`.

**Verdict: package integrity and bridge import checks pass. Production acceptance remains CLOSED.** This candidate is inactive and is not approved for deployment. Two P2 packaging limitations were found outside the bridge path. No P1 was found in the checks performed.

## Scope and evidence

- Read-only target: `/Volumes/AIMATE_WORK/osstackgrokbot/releases/candidate-78abb868c644`.
- Declared source: `78abb868c64488e7e2ae303cb54c60ef02f0fb11`.
- Audit checkout baseline: `75c007667eccd0b24384338cf4f4d4d12848d2de`. Source comparison used the declared commit's Git objects, not this checkout's working files.
- Retained archives: `/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-final-validation/packs/78abb868c644`.
- Raw evidence and one-off inspection transcripts: `/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-cli-installed-release-audit`. These are local scratch artifacts, not a new supported smoke tool.
- Private test home: that evidence directory's `home/`. Node: `v26.5.0`.

Read [graph](../plans/bridge-graph/graph.md), [progress](../plans/bridge-graph/progress.md), [bridge runbook](../runbooks/bridge.md), canonical `.cursor/skills/verify-osstack/SKILL.md`, and the existing [npm install smoke](../../scripts/smoke-npm-install.mjs), [package artifact smoke](../../scripts/smoke-npm-package-artifacts.mjs), and [package preparation](../../scripts/prepare-npm-package.mjs) first. The verification skill excludes npm packaging and bridge acceptance. No duplicate skill or permanent tooling was added.

The full npm install smoke was **not run**: it builds every package, packs and installs again, provisions launchd metadata, starts services and runs commands outside this assignment. Existing fixture smoke tests do not inspect this candidate. This audit directly checked the retained archives and installed prefix instead.

## Integrity and provenance

Manifest SHA256: `1f25ae9900d492331e579fd05a3ba3b75e83b0ec42efac1d24273270b34ad763`.

All 22 retained tarballs match the manifest. All **1,763 regular archive members** exist in their installed package and match byte for byte, including package manifests, runtime code, maps, types and shipped assets. There are zero missing or changed archive members and zero test/spec artifacts in the archives. This checks archive members; it is not an attestation of all third-party files added by npm.

| Tarball | SHA256 (verified) |
|---|---|
| `osstack-agents-0.23.0.tgz` | `d9b3a5a7fd8c44a92f85dc002cbc691659a3db7e9be32ca9c66ca705415083a1` |
| `osstack-autonomy-0.23.0.tgz` | `08bc51f8437aa17dd1cd27ab263eeb1ec213342fd7b1faca44904b5f5eb2dd74` |
| `osstack-cli-0.23.0.tgz` | `3b61ab505786dce5f72d83ef24f20c779a5c29a9efd91677e8055ebf5b3b78ca` |
| `osstack-compliance-0.20.0.tgz` | `89c1281fb3000702c7661e87434a3e7f44b2e6551c390f10de19d1f1c2965a2e` |
| `osstack-config-0.23.0.tgz` | `8adf03356541b2bb4189da2aafbf8c86357ae3870d0c6dc245c8950ca868e92d` |
| `osstack-conformance-0.23.0.tgz` | `f5508e444cbb68a2c34a6b7d72f6b34e475f0be7912af5e95d283f20a082f055` |
| `osstack-contracts-0.20.0.tgz` | `41562e57ca1bee2b04aeb7b84ff2c46cb0ee3334112255994299b78daa01cdd7` |
| `osstack-core-0.23.0.tgz` | `89beb75b32731b2b3a9bb446c02b1905fb5269224a37ca7af0ed20dec3a9fa7d` |
| `osstack-github-0.23.0.tgz` | `5603aeddb53fcf34c78b44c98ef02cf6da3333818f59494f221695481ddda27d` |
| `osstack-governance-0.23.0.tgz` | `b4d5556ce387e24fc1953cbc2eac63aff6f11c6220e2ef71973e679bfc70759f` |
| `osstack-graph-0.23.0.tgz` | `2b9a46d21859b8f738d62b3bd3994a983c6fd1465c699609b4be3a0c3865091f` |
| `osstack-hermes-adapter-0.23.0.tgz` | `8a202435e6a69391b087762249c8436875ad5f4e52aba0c93a326cbe6b09e392` |
| `osstack-knowledge-0.22.0.tgz` | `115bb96616d2b1b740221ee87b03b09ee0fd976489ee8d214d14ccd1fd4aa1fa` |
| `osstack-knowledge-cloud-0.22.0.tgz` | `1efccb7f7f15681661843b0588c9289925695af6f9adda5d53013bce1f2d54fd` |
| `osstack-loop-0.23.0.tgz` | `38cb7bb51b287582cb8cadf4679566f8121b1ca946b8af140267e62029ce121d` |
| `osstack-neat-eval-0.1.0.tgz` | `1a530f2b874ef5b8bc79e8871c90f069d94a8f662419defcbfd938805b847c68` |
| `osstack-plugins-0.23.0.tgz` | `57de5856a02f976a00f3e9974ba5537bd48d52ae2e4003de13d0806e25d91a05` |
| `osstack-protocol-0.23.0.tgz` | `d98e66359792e492af8182d958cbbb2a5bed0a788ab0db4f458cb2a6ad42bfd8` |
| `osstack-runtime-0.20.0.tgz` | `c9640f7e71cc8d97bb29d30f529a3b145322428195bcc3d3ac05c8352783f9b0` |
| `osstack-skill-registry-0.23.0.tgz` | `4a1bd61097b7d6f3ae5c01836d4a8c33ae900a5098d3ce82279d6b62adc4c4d9` |
| `osstack-skills-0.23.0.tgz` | `ce796cbd76b617c90f008b8aaee5a57365c1eb97cf064b32d18bb29bbe28e41b` |
| `osstack-supervisor-0.23.0.tgz` | `2a0f69befb067249896c626b8a61dfb405e2cc0962b9674c50e02a12afd98635` |

The CLI source maps contain 212 unique `packages/cli/src/*` sources. All match the declared Git commit exactly; there are no missing source objects, mismatches or conflicting embedded copies. This includes the production factory, RPC acceptance lock, assembly, ports, grants, runner, publication, receipt, retry and ledger code. Source maps are corroborating provenance, not a reproducible-build or signed supply-chain attestation. Other package outputs match their tarballs; this audit did not rebuild them or prove their compilation from source.

All declared non-wildcard dist entrypoints exist. All internal `@osstack/*` production dependency versions equal their installed versions. None uses `workspace:`, `file:`, or `link:`. All 20 symlinks under the release resolve inside the release. The executable shim resolves to `lib/node_modules/@osstack/cli/dist/bin.js`. No external checkout is used to resolve the tested bridge imports. One absolute developer path remains in optional loop publishing; see P2-1.

Installed regular-file inventory digest after inspection:
`73b92e879a76324971fa12ac4b096862cd61e093bd8bef9c4ee34500d65145ce`.
Definition: sort regular non-symlink paths, join `relative-path:sha256(file)` with newlines, then SHA256 the result. It includes npm's third-party dependency files. Final comparison after all import and CLI checks: identical digest (`final-check.json`).

## Installed CLI and bridge building blocks

The CLI package has no `exports` map. Its supported executable is `bin.osstack`; the explicit tsup bridge entries are accessible by installed file path. They should not be described as a new package export map.

The following nine installed entry modules imported successfully, without constructing services or calling effects: `bridge-production`, `bridge-kit`, `bridge-reader`, `bridge-fixture`, `bridge-github-app`, `bridge-ports`, `merger-reader`, `bridge-marker`, `merger-sandbox-fixture`. Four package roots also imported successfully: core, agents, GitHub and governance. Every resolved root is inside this installed prefix.

| Building block | Installed evidence |
|---|---|
| Production factory and host | `bridge-production.js` exports `createProductionLiveBridge`, `createContainedMissionPorts`, `ContainedMissionHost`, `ContainedMissionService`, `EngineeringAccess`, `readBridgeAncestry` |
| App A publication / App B evidence | `bridge-kit` exports `createBridgeKit`, `appCredentialRunner`; `bridge-github-app` exports token source, config loader and distinct permission sets; ports exports `fencedDeliveryRunner` |
| Live assembly and configuration | Imported assembly chunk exports `assembleLiveBridge`, `loadLiveBridgeConfiguration`; source validates App configuration, producer registry, signed issuer and launch caps before installing ports |
| Recovery and startup barrier | Imported receipt adapter and publication chunks expose `createReceiptReadAdapters`, `createRevisionReceiptRecovery`, `reconcileReceipt`, `recoverRevision`; source-bound RPC/assembly includes recovery before scanner start |
| Live and stopped reconciliation | Imported chunks expose `LiveReconciler`, `StoppedChainScanService`, `BridgeReadLimiter` |
| Same-PR revision and exact ledger | Imported publication and ledger chunks expose `createRevisionPublicationPort`, `publishRevision`, `compareBridgeLedgerRange`, `verifyBridgeLedger`, `recoverBridgeLedgers`; runner source matches commit |
| Signed grant and pending checks | Imported chunks expose `RevisionGrantService`, `loadRevisionIssuer`, `RevisionCheckRetryScheduler`, `createRevisionCheckRetryScheduler`; issuer key functions were not invoked |
| Durable stores / W13 | Installed core exports `RevisionChainStore`, `HostProcessStore`, `MergerShadowStore`; agents exports `createHostProcessProbe`, `classifyHostProcess`, host-process error types |
| Protected-set calculation | Installed governance exports `missionProtectedSetDigest` |
| App E shadow merger | Merger reader and fixture entry imports pass; shadow chunk exports `MergerShadowReconciler`, ledger and mission views. No live merger qualification follows from this |
| Schema and workers | Installed `CURRENT_SCHEMA_VERSION` is 55. Graph worker entry/client/runtime and protocol graph-worker assets exist and match archives |
| Native SQLite | Both CLI and core have `better_sqlite3.node` under their installed dependency trees. Native binding load, DB migration and worker execution remain untested |

Presence, source binding and successful imports prove packaging of these building blocks. They do not prove runtime recovery, token scopes, fenced process behavior, Docker execution, GitHub writes or end-to-end acceptance.

The installed RPC module's pure mode parser returned `off` for `0`, `shadow` for `shadow`, and threw exactly `BRIDGE_LIVE_NOT_IMPLEMENTED:acceptance_required:5-F:5-G` for `1`. No daemon was started to test this. The gate is a code lock, not a launchd setting that an operator can safely override.

## Exact checks and results

Commands were run from the assigned checkout unless stated. All CLI invocations used the explicit private home.

```sh
E=/Volumes/AIMATE_WORK/tmp/osstack/runtime/bridge-cli-installed-release-audit
R=/Volumes/AIMATE_WORK/osstackgrokbot/releases/candidate-78abb868c644
python3 "$E/audit.py" > "$E/audit.json"
OSSTACK_HOME="$E/home" OSSTACK_UPDATE_CHECK=0 OSSTACK_BRIDGE=0 "$R/bin/osstack" --version
OSSTACK_HOME="$E/home" OSSTACK_UPDATE_CHECK=0 OSSTACK_BRIDGE=0 "$R/bin/osstack" --help
OSSTACK_HOME="$E/home" OSSTACK_UPDATE_CHECK=0 OSSTACK_BRIDGE=0 node "$E/exports.mjs"
OSSTACK_HOME="$E/home" OSSTACK_BRIDGE=0 node --experimental-import-meta-resolve "$E/linkage-esm.mjs"
```

- Completed archive/source inspection: exit 0, results above (`audit.json`).
- `--version`: exit 0, `osstack 0.23.0`. `--help`: exit 0, full command surface; socket in help points at the private scratch home. Outputs saved as `version.txt`, `help.txt`.
- Installed entry/chunk/root imports: exit 0 (`exports.json`); no constructors or write ports called.
- Advisory literal import scan: 554 osstack dist JS files, 2,331 non-builtin literal references (`linkage-esm.json`). It found two documentation-string `require("./LOOP-STATE.json")` examples, not real module dependencies, and the real optional generator failure in P2-2. This regex scan is not a parser or a complete dynamic-import proof.
- First archive inspection aborted with `IsADirectoryError` on the dependency directory named `ipaddr.js`. It produced no verdict. The inspection was corrected to check regular files. The original failure is retained in `audit-first-failure.txt`; no package was repaired or rebuilt.
- The earlier advisory CommonJS-resolution scan (`linkage.json`) produced false findings for import-only exports and quoted documentation. Those are not accepted findings. ESM resolution and actual installed bridge imports supplied the relevant evidence.
- No full tests, typecheck, build, dependency install, daemon, DB command, launchctl operation or remote operation ran. No default/reserved home was used. The private home contains no files.
- Report validation: 6 relative Markdown links resolve; `git diff --check` passed. Final installed inventory digest equals the earlier digest; private home is empty.
- The required governance docs audit was not run: this isolated worktree has no `node_modules/.bin/vitest`. No dependencies were installed for this report. Parent must run the narrow docs check below in its prepared validation checkout.

## Findings and reproduction

**P2-1 — optional loop publishing retains a developer checkout dependency.** The installed `@osstack/loop/dist/publisher.js` defaults `PublishConfig.command` to `/Volumes/AIMATE_WORK/Developer/ClaudeCode/01_active/osborn-studio-skill-hub/tooling/osstack_publish.mjs`. `enabled` defaults false. If skill publishing is enabled without a command override, the runner selects this external script. This breaks portability and can invoke a developer copy rather than release-owned code. Bridge startup does not require it. Keep that optional publisher disabled until its command is explicitly configured and reviewed, or fix its default in a separately owned source change.

Safe reproduction: use `createRequire(R + '/lib/node_modules/@osstack/cli/package.json')` to resolve `@osstack/loop/dist/publisher.js`, import it by file URL, and evaluate `PublishConfig.parse({})`. This audit did so and saved `ancillary.json`. It did not call `runPublish`.

**P2-2 — shipped protocol generator cannot import in the production installation.** `@osstack/protocol/dist/generate.js` imports `zod-to-json-schema`, but protocol declares that package only as a devDependency. The shipped wildcard export permits resolving this dist module. Its installed import fails with `ERR_MODULE_NOT_FOUND`. This is an ancillary schema-generation surface; the tested bridge runtime does not import it. Parent should either exclude/private this build-time module or make its intended installed dependency contract explicit in a separate source change.

Safe reproduction (performed): resolve `@osstack/protocol/dist/generate.js` from the installed CLI package, then `await import(pathToFileURL(resolved))`. Exact error: `Cannot find package 'zod-to-json-schema' imported from .../@osstack/protocol/dist/generate.js`. No generation function was called.

No P1 is established by this audit. Missing acceptance evidence is a deployment blocker, not proof of a production code defect.

## Parent handoff: remaining acceptance and deployment steps

1. Preserve the ongoing full acceptance result against its exact source SHA. This worker did not read a final result or replace it with a new run. Follow the graph's separate N9/N10 main-base integration, model review and exact-head CI gates. Do not label this candidate main-approved from its manifest alone.
2. Finish N10 broad TLC from retained checkpoints after the other validation work releases resources. Record queue exhaustion, exit status, model/config hashes and exact source binding. The existing TLC script starts new four-worker runs; do not use it blindly to resume or compete with the parent process. Preserve historical failures and mutation/property snapshot coverage.
3. Finish N11 only after its existing specific sandbox-write authorization and N10 gates. The current driver hardcodes checkout paths for `packages/cli/dist/bridge-production.js` and `packages/core/dist/index.js`. Therefore a pass from it would qualify those checkout builds, not this installed prefix. Parent must add a reviewed installed-runtime selection to that existing driver, or separately prove immutable byte identity of every consumed runtime file before claiming installed acceptance. Do not add a second competing smoke driver.
4. Complete N13: both cloud bots currently share Rubebun-Jadeem; PR Reviewer is paused and has no proven formal `CHANGES_REQUESTED` capability. Capture App C/D identities, installation scope and U-1…U-11 evidence. Shared gh access is not the required App migration. Do not resume or message a bot from this worker.
5. Obtain owner-controlled N14 ruleset configuration and readback, then the reviewed code change that opens the live acceptance lock. Repackage and re-audit the new immutable candidate: this candidate will always reject `OSSTACK_BRIDGE=1` as shipped.
6. Complete private App/issuer configuration, contained executor credentials, immutable image digest, engineering authorization and attention settings. The external launchd templates deliberately omit required settings, refer to an absent `current` link, and contain no role provisioning. The candidate has no `dist/control-plane.json`, as expected before deployment. The installer provisions a role declaration beside the real binary; reserve and validate exactly the chosen channel/home. Sharing one prefix between two homes requires an explicit reviewed role design.
7. Only after owner approval, use the completed deployment runbook to provision a fresh qualified release, consistent backup/rollback plan, one channel's config mappings, role declaration, current link and launchd installation. Verify native SQLite, worker execution, CLI/daemon version handshake, startup recovery and logs in an authorized isolated acceptance home before any production startup. Do not activate this audited candidate directly.
8. N15 still requires approved main-repository shadow operation, one scoped live root with one revision round, five consecutive clean chains and readable bridge stats, with PR timeline and ledger evidence. An installed `--help` pass cannot replace those records.

Exact parent commands below are handoff instructions, **not commands executed by this worker**. Run repository commands only from the parent's designated prepared validation checkout; never another worker's checkout. Set `PARENT_ACCEPTANCE_HOME` to a new private home under scratch, not a serving or reserved home.

```sh
# Narrow documentation gate. No full-monorepo check is requested here.
OSSTACK_HOME="$PARENT_ACCEPTANCE_HOME"   pnpm --filter @osstack/governance test src/knowledge-hygiene/osstack-config.test.ts --maxWorkers=1

# Existing offline sandbox-driver contract tests, if changed for installed-runtime selection.
node --test scripts/smoke-bridge-revision-sandbox.test.mjs

# Read-only sandbox preflight; parent owns remote access and its result record.
OSSTACK_HOME="$PARENT_ACCEPTANCE_HOME" OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack   node scripts/smoke-bridge-revision-sandbox.mjs --preflight --run installed-audit-preflight

# Only after all preceding gates and specific sandbox-write approval.
# Current driver uses checkout runtime: do not call its output installed-prefix acceptance.
OSSTACK_HOME="$PARENT_ACCEPTANCE_HOME" OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack   node scripts/smoke-bridge-revision-sandbox.mjs --execute --run installed-audit-execute

# After selecting a NEW qualified release and reviewing one channel's completed env,
# this stages an unloaded plist and provisions its real-bin role file. It MUTATES files.
# QUALIFIED_RELEASE, APPROVED_CHANNEL_HOME and APPROVED_LAUNCH_AGENTS_DIR require owner review.
OSSTACK_HOME="$APPROVED_CHANNEL_HOME" OSSTACK_LAUNCH_AGENTS_DIR="$APPROVED_LAUNCH_AGENTS_DIR"   "$QUALIFIED_RELEASE/bin/osstack" serve --install --no-load   --bin "$QUALIFIED_RELEASE/bin/osstack" --json
```

No current-link or launchctl activation command is supplied for this candidate because its acceptance lock is closed and the target environment remains incomplete. Parent must review the concrete completed channel configuration before activation. All remote state and the inactive release were left untouched.

## Commit handoff limitation

The report is complete but **uncommitted**. Explicit staging failed:

```text
git add -- docs/reports/bridge-cli-installed-release-audit.md
fatal: Unable to create '/Volumes/AIMATE_WORK/Developer/CodeX/osstack/.git/worktrees/bridge-cli-installed-release-audit/index.lock': Operation not permitted
```

The worktree's Git metadata is outside this worker's writable sandbox. No alternate index or Git metadata workaround was used. No commit was attempted after staging failed. Parent can complete the requested single conventional commit from this assigned worktree in a session authorized to write its Git metadata:

```sh
git add -- docs/reports/bridge-cli-installed-release-audit.md
```

Then run this as a separate command:

```sh
git commit -m "docs(bridge): audit inactive installed CLI candidate"
```

This worker changed only the new report. Keep the worktree until parent captures the report; worktree removal is not appropriate while this artifact remains uncommitted.
