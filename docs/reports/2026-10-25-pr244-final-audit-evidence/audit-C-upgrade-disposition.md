# C3/C6/C7 managed upgrade audit fixes

## C3: completion fence crash window — confirmed and fixed

`ManagedNativeUpgradePort.doComplete` previously removed restart permission before the operation fence. It now verifies exact owned plan/registry/artifact and any surviving permit binding, then removes operation, fsyncs root, removes permit, fsyncs root. Both unlinks tolerate ENOENT. The durable ordering prevents leaving a blocking fence without startup permission during normal completion. Same-owner repeat completion is idempotent.

For already interrupted older executions, `reconcileForward` now checks the current history first under the installation owner lock. If terminal verified history exactly matches the approved history digest and the pinned active release exactly matches the approved target, it performs only idempotent claim/fence cleanup. It does not require services to remain running after historical verification. It does not start or stop any process, migrate or restore a DB, or re-run upgrade steps. Returned reason `verified_history_fence_cleanup_only` explicitly limits this result to historical verification plus cleanup, not a claim of current service health. Non-completed history still requires the exact operation fence and existing forward-recovery path. The apply-upgrade completed early-return now routes through this checked cleanup instead of leaving a surviving fence untouched.

Both managedStartupIdentity and assertManagedHomeMarker now translate a missing restart permit under an operation fence to `upgrade_start_blocked`; other malformed/private-file errors remain fail closed.

Tests added: three real-process/filesystem fixtures first finish an actual upgrade then stop both consumers; remove permit only / operation only / both; history-bound reconciliation completes without starting either service, preserves terminal history, removes both artifacts and supports repeat complete. Existing startup guard test now asserts exact `upgrade_start_blocked` in both gates with byte-identical DB before/after. Existing SIGKILL, unknown restart, stopped DB lock, exact release and ownership regressions remain passing.

## C6: compiled runtime check before DB migration — confirmed and fixed across root + this scope

Added `verifyManagedCode(expected, {version, protocol_version, database_schema})` in upgrade-native-backend.ts. It compares the artifact declaration to actual compiled identity (including compiled schema target) before database construction. Root agent owns its daemon startup call before buildContext. Existing verifyManagedRuntime remains after open to compare actual opened DB and identity, never override runtime metadata.

Added table tests reject independent version, protocol, and compiled-schema mismatches. Root must retain daemon startup ordering/integration evidence and include it in final review. This report alone does not assert that a source helper guarantees call-site ordering.

## C7: marker publication before durable registry — confirmed and fixed

Provisioning now creates consumer registry files and service plists, stages/verifies exact release, switches and durably publishes installation.json BEFORE publishing any home managed-consumer marker. All relevant daemon ownership locks remain held through publication. A crash before any marker leaves unmanaged homes unchanged. A crash during marker publication can leave a subset managed, but every published marker already references a complete active installation; retry remains create-only/identical-resumable.

Added real filesystem fault fixture: an approved resumable provisioning claim plus a regular file blocking the releases directory forces staging failure. Assert installation.json absent AND every consumer marker absent. Remove fault and resume successfully. Existing interrupted-identical provisioning/resume regression remains.

## Files and review locator map

- upgrade-native-port.ts: doReconcileForward completed branch; doComplete; assertPins/assertOperation and installation owner lock for authorization context.
- upgrade-native-command.ts: initialStatus.completed apply branch now calls reconcileForward with exact observed history digest under approved plan.
- upgrade-native-backend.ts: managedIdentityForConfig permit lookup; verifyManagedCode; verifyManagedRuntime.
- managed-home-guard.ts: operation/permit guard.
- upgrade-managed-provision.ts: consumer/service preparation loop, switchRelease+installation publication, final marker loop.
- upgrade-native.test.ts: complete real-process fixtures, three new completed-history crash fixtures, strengthened startup guard and provisioning-failure fixture.
- upgrade-native-command.test.ts: new compiled identity mismatch table.
- daemon.ts (root-owned): managedIdentity setup, pre-buildContext verifyManagedCode, post-buildContext verifyManagedRuntime; include matching startup test.

## Executed validation

`audit-C-upgrade-tests.log`: 2 files,23 tests passed,16.96s. Native fixture executes actual child processes, SQLite databases, filesystem release switching, SIGKILL and kernel-lock recovery. This does not qualify real launchd, power loss, or multi-home production deployments.

No commit made; parent agent owns final combined validation and commit.

## Second-round fixes

- P2-A orphan restart permission: under acquired installation owner lock, resolveAuthority removes an orphan permit only if no operation fence exists, finishes any interrupted private publication, fsyncs removal BEFORE any staging/consumer drain. Existing operation fences are never bypassed. New real-process test leaves another plan's permit then successfully completes the new upgrade.
- P2-B publication peers: pre-DB privateJson now matches readPrivate's exact rule: nlink1 or nlink2 with exactly one regular `.publish-<32hex>` peer matching dev+inode in same directory; arbitrary hardlinks still rejected. Completion finishes interrupted publication before deleting operation/permit. Added positive single-peer and negative arbitrary-peer regression.
- P2-C historical state ambiguity: response retains verified history state but adds explicit `services_observed:false` alongside reason verified_history_fence_cleanup_only. Tests assert the field, preserving historical state without claiming current service health.
- P2-D direct DB compiled identity is root-owned: bin now routes relevant access through assertManagedCliHome + verifyManagedCode with VERSION/PROTOCOL_VERSION/CURRENT_SCHEMA_VERSION; serve errors map to exit78. Include current root code/test evidence.
- Q4 daemon pre-open ordering regression exists in local-ledgers-daemon.test.ts. Full openDb source and startup helpers supplied to reviewer for remaining context.
- Renamed misleading provisioning test to explicitly describe resumable interrupted staging; it makes no claim of testing fresh existing-root refusal.

Validation so far: r2 focused CLI67/67; CLI typecheck passed; all core848/848. A final small addition exposing read-only clock status requires a focused recheck after rebuild, reported separately.

## Third-round remaining N1/N2 and direct-DB coverage

- N1: resumable provisioning cleanup treats a private regular `.publish-<hex>` file with nlink1 as unlinked, never-published temporary output, safely removing it without requiring its potentially torn bytes equal a complete record. A linked publication peer still must match an expected record. Fixture adds a zero-byte temp in consumers after interrupted staging and resumes successfully.
- N2: complete enforces permit-plan binding while an operation fence exists. With no operation, a foreign permit has no effect and is removed as an orphan after private-file verification/publication finishing. New completed plan A + orphan plan B test succeeds without any additional starts.
- Direct writable/migrating paths were enumerated in cli-db-open-managed-coverage.md and cli-db-open-sites.txt. Full guarded-open-db and graph-maintenance now supplied; both call the marker with real compiled VERSION/PROTOCOL_VERSION/CURRENT_SCHEMA_VERSION before writable DB construction. Marker verifies already-bound release manifest target against compiled constants (plus target digest/current directory match). Native test pins matching and independent version/protocol/schema mismatch cases.
- Full cli-entry top-level error handling supplies deterministic direct-command exit1/no stack; serve guard uses78. This is established CLI behavior, not an unknown promise rejection.
- Accepted production qualifications: managed invocation uses exact OSSTACK_HOME/OSSTACK_SOCKET/OSSTACK_MANAGED_INSTALLATION; approved release must be self-contained; manifest build provenance is not independent cryptographic measurement of all possible external runtime modules. Real launchd, power failure and production multi-home still unqualified. Historical cleanup requires original approved plan/registry/artifact retained and reports services_observed:false; loss of those records remains fail-closed manual operator recovery, not blind fence removal.
- The read-only clock-status changes are separately reviewed in source scope A.

Latest combined native/source/daemon focused87 tests and strict CLI typecheck pass. Main agent owns full-suite/CI verification after this freeze.

## Round 4 closure
- r3 .current-<32hex> torn symlink publication is now safely cleaned under owner lock only for an exact releases/<64hex> target; arbitrary entries remain fail-closed. Provisioning fixture now includes this crash residue.
- source-observation-host passes actual compiled version/protocol/schema to marker before writable ledger construction.
- guardedOpenDb now resolves the actual existing DB file before deriving managed home and opens that canonical path. A final dangling file symlink is rejected before creation. Regression proves malformed target marker blocks migration through an outside alias (schema remains0), dangling target is not created, ordinary explicit scratch home still opens.
- Corrected operator contract: full daemon/full CLI managed startup checks declared environment plus full release identity. Indirect marker-guarded DB commands check marker, bound release manifest and compiled version/protocol/schema, but do not claim equivalent environment/full byte hashing. These are distinct guarantees; no blanket requirement that all managed direct commands require declared environment.
- Full DB-open closure enumeration covers migrations, SQLite constructors, aliases/imports and read-only attention DB handling. Supplied coverage is static evidence, not proof of running every command. Historical cleanup still requires approved artifacts and does not attest current service health. Real launchd/power-loss behavior remains unverified.
- Latest focused wrapper/source tests22/22 passed, preceding source/loop/native46/46 and core35/35 passed. No reviewer ran these tests.

## Final2 remaining-item disposition (supersedes broader earlier wording)
1. Existing guardedOpenDb files must be regular and nlink1 after realpath; hardlink aliases reject db_path_not_single_file before migration. Explicit :memory: retains core's in-memory behavior without filesystem effects. There are no non-test CLI writable URI callers; URI filenames are not promised by this wrapper.
2. Source ledger is more restrictive than wrapper: its DB must be a regular single-link state.db in the canonical configured home, and must not itself be a symlink. Home ancestor aliases remain allowed for observe/status/events; file aliases are rejected for both read and write. New symlink/hardlink fixtures preserve exact source events/high-water.
3. Closure documents corrected by independent delivery agent: core exports are unguarded library APIs, NOT a general control-plane security boundary for arbitrary programs. Repository-owned CLI entry paths are the scope. All-packages search shows other packages inject handles rather than constructing writable DBs. Attention readonly timeout1000 is corrected; refreshed source-host evidence uses current source.
4. Compiled version/protocol/schema is explicitly checked in guardedOpenDb, graph-maintenance, source ledger, and full daemon/bin managed startup. Other assertDbAccessAllowed-only/read-only callers perform marker/bound-manifest target checks without compiled tuple. Marker checks do not verify every release byte and cannot protect against same-UID malicious replacement of markers/manifests; full startup has stronger verification. No general all-caller identity claim remains.
5. tsup now replaces process.env.OSSTACK_VERSION with package version literal in shipped CLI chunks. Build output currently contains const injected="0.21.0". A real Node process with environment999.999.999 importing built VERSION returned0.21.0. Single-binary builds consume these built chunks. Unbundled source is a developer path, not the production managed-release contract. DAEMON_VERSION is directly VERSION (daemon.ts150).
6. Memory semantics regression fixed explicitly and tested. Latest wrapper5+source21=26 tests pass; build/typecheck/Biome pass. Prior test-only failure compared current_time_ms rather than durable state; corrected assertions target durable events/highwater and keep failed raw log.

## Final3 delta closure
R1: final DB file symlinks are now rejected before realpath, in both directions (managed→outside and outside→managed). Ancestor-directory aliases remain separately guarded. The reverse fixture proves target schema unchanged.
R2/R3: shared assertSingleSqliteFiles refuses every existing DB, -wal, -shm, -journal that is not a regular single-link file; all three entry paths call it before SQLite. graph-maintenance owned() additionally requires nlink1. Fixtures cover hardlinked WAL/SHM/journal, source symlinked journal, maintenance hardlinked DB and symlinked WAL. These are pre-open integrity checks, not protection against malicious same-UID replacement after the checks.
R4/R5: apps/ and bin/ do not exist at repository root. Current all-packages and CLI raw sweeps include ts/js/mjs/cjs, regenerated after final production edits; manifest records roots and list hashes. Core openDb/runMigrations remain unguarded public library APIs; only repository CLI entry paths are claimed.
R6: deliberate qualification: standalone graph-maintenance module is NOT supported as a managed-home CLI entry and fails the installed serving-entry gate. It exports functions but has no standalone command invocation. Existing installed-host maintenance remains usable for non-managed homes under control-plane declaration; managed invocation must originate through the exact declared serving entry. No new managed maintenance route is advertised or added; future route wiring requires separate implementation/qualification. Added this limitation to module API comment. argv is a routing consistency check, not cryptographic identity; full runtime byte attestation is not claimed here.
Validation: wrapper9+source22=31 passed; maintenance2 passed; CLI typecheck and focused Biome passed. Existing A PASS and prior resolved upgrade behavior are unchanged by these pre-open file checks. Shipped tsup version literal proof remains applicable, no version change after Final2.

## Final audit outcome
Final3 resolved every production finding R1-R4 and accepted R6 as a qualification, finding no new code defect. Its remaining R5 evidence inconsistency was closed by Final4 PASS (scoped to R5 evidence), with the reviewer also correcting its own mistaken ledger line count. Final4 prompt excludes the superseded cli-db-open-closure.txt raw listing; current raw evidence is cli-db-open-sites.txt and all-packages-db-open-closure.txt. Generation validated all279 source lines and recorded extensions ts/tsx/js/jsx/mjs/cjs/mts/cts, root absence and hashes in db-closure-final4-manifest.json.
The final chain is therefore complete for assigned A and C3/C6/C7 scopes: A final PASS, upgrade Final3 production RESOLVED/qualification + Final4 evidence PASS. This is not an all-PR or CI verdict.
Final validation: source+wrapper31, maintenance2, rebuilt CLI/daemon/native-upgrade integration49 passed; strict CLI typecheck, targeted Biome, build and diff check passed. Earlier core35 tests also passed. No production edits after the Final3 snapshot; build regenerated identical supplied version chunk.
Limitations remain explicit: helper covers wrapper/source-ledger/maintenance, not upgrade-native stop-lock opens or every readonly SQLite path (which may affect shared-memory sidecars). Core DB/migration exports are unguarded library primitives. Managed standalone maintenance has no shipped route. Same-UID concurrent file replacement is not prevented. Source dispatch/ack require canonical home and fresh registered evidence for clock reset. Actual launchd/power-loss, cross-home production rollout and compiled Bun binary execution were not tested.
Claude CLI invocations all used requested claude-haiku-5-5 and returned exit0/nonerror/token-bearing results; stderr unrecognized_model warning is retained. This confirms CLI execution, not independent proof of provider backend weights.
