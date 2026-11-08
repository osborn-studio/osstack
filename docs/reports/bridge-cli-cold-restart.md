# Separate-process cancelled Mission recovery probe

Date: 2026-11-07. Worker: `gpt-6.1-sol`. Base: `5699e884`.

## Result and scope

Added only these files:

- `scripts/lib/bridge-sandbox-cold-restart.mjs`
- `scripts/bridge-sandbox-cold-restart.test.mjs`
- This report.

The helper launches a fresh Node process from its own module. It waits for process exit and pipe close before returning sanitized evidence. Local tests use private temporary directories, fake core/runtime modules, and real local child processes. No real GitHub, Codex, Docker, token minting, serving DB, or production runtime execution occurred. The existing sandbox driver and runtime are unchanged. **5-G remains unqualified.**

## Public contract

`runSandboxColdRestart(descriptor, { spawn, timeoutMs } = {})` validates and copies the descriptor, creates a private temporary descriptor file, and invokes exactly:

```text
<process.execPath> <this module> --cold-restart-worker <private descriptor path>
```

There is no shell, command string, eval, arbitrary argument list, or configurable worker entrypoint. The optional `spawn` seam is for tests. The default worker environment contains only PATH, HOME, TMPDIR, and the bound scratch/home variables; it does not inherit NODE_OPTIONS, NODE_PATH, agent credentials, or GitHub token environment variables. The process runs in its own POSIX process group.

`timeoutMs` defaults to 45,000 and must be an integer between 100 and 60,000. Combined stdout/stderr is limited to 32,768 bytes. Timeout or excess output sends SIGTERM to the process group, then SIGKILL after 250 ms if needed. The parent waits for `close`, records PID/exit/signal, and discards raw stderr. Worker exceptions produce a fixed error code. Success output is parsed, validated, and rebuilt from an allowlist of fields.

Success has this shape:

```js
{
  ok: true,
  childPid, exitCode: 0, signal: null,
  parentShutdownProven: false,
  readback: {
    owner: { instance_id, generation },
    mission: { mission_id, state: 'cancelled', stop_obligation: 0 },
    chain: { chain_id, published_head },
    intents: [{ intent_id, kind, state }]
  }
}
```

Errors use `COLD_*` codes. Errors after child creation include `error.evidence` with child PID, exit code, signal, and `parentShutdownProven: false`. They do not return worker stacks, config contents, keys, prompts, review text, or raw process output.

`recoverCancelledSandboxMission(descriptor, { importModule } = {})` exposes the worker body for local fixtures. Validation precedes imports. The real worker does not accept injected implementations through its descriptor or CLI.

### Required descriptor fields

All objects have allowlisted keys. Unknown keys, including command arguments and embedded private keys, are rejected.

| Field | Required binding |
| --- | --- |
| `version` | `1` |
| `repository`, `repositoryId` | Exact sandbox name and numeric ID from the local ADR-006 registry |
| `scratchPrefix`, `runRoot` | Existing canonical scratch prefix and a strict child directory; runRoot must be owner-only |
| `runtimePrefix` | Existing canonical code prefix containing both selected module files; `/` and the user's home are rejected as prefixes |
| `home`, `dbPath`, `authorityPath` | Exactly `runRoot/home`, `home/control.db`, `home/authority.json` |
| `repositoryPath`, `worktreesRoot` | Existing canonical paths strictly within runRoot |
| `scopeId`, `chainId`, `childMissionId` | Existing DB identities; scope is a 64-character hexadecimal ID |
| `expectedBranch`, `expectedHead` | Existing `osstack/mission/...` branch and full 40/64-character hexadecimal head |
| `modules.core`, `modules.runtime` | Each `{ path, sha256 }`; an existing `.js`/`.mjs` file under runtimePrefix with the expected SHA256 |
| `handoff` | `{ parentPid, servicesStopped: true, hostClosed: true, databaseClosed: true, previousOwner }` |
| `handoff.previousOwner` | Exact prior `{ home_id, instance_id, generation }` row |
| `ports.runtimeRoot` | Canonical runRoot child; it may not exist yet |
| `ports.markerDir`, `ports.journalRoot` | Canonical home children; they may not exist yet |
| `ports.codex` | `{ bin, sourceCodexHome, model: 'gpt-6.1-sol', identityBinary? }`; canonical existing path references, no arguments or credentials |
| `ports.verification` | `{ socketPath, daemonId, baseImageId }`; canonical socket path reference and immutable `sha256:...` image ID |
| `ports.bridgeConfig` | Actual BridgeConfig shape: `{ repository, publisher, evidence, mission_ruleset_ids }`; no `version` field |
| Each App reference | `{ app_id, installation_id, private_key_path }`; positive IDs and a canonical owner-only key file reference |
| `launchCaps` | Current driver defaults: `{ executor_seconds: 600, verify_seconds: 120 }` |

Executable, Codex-home, Docker-socket, and App-key references may be outside scratch. They must be explicit canonical references. Home, DB, authority, repository, worktree, marker, journal, runtime-data, and module paths must stay under their declared scratch/runtime prefixes. Symlink aliases and traversal paths are rejected. The existing private DB must be a regular single-link file, at most 64 MiB, with no group/other permission bits. Existing DB sidecar paths must also be canonical under home.

`control-plane-reserved.json`, `managed-consumer.json`, `daemon.pid`, and `daemon.sock` in home cause refusal. Home bridge files and authority must be private regular single-link files. Home apps/rulesets must agree with the descriptor, and home producers must name the sandbox. Production loaders perform the remaining configuration and authority schema checks.

### What the worker does

1. Revalidate descriptor privacy, paths, registry identity, module hashes, and parent PID in the new process. Acquire an exclusive probe lock in home. This serializes cooperating probes; it is not the daemon's kernel lock.
2. Import the selected core/runtime files. Open the existing control.db. Validate the prior owner, scope, chain, root, cancelled child, every stored Mission's repository/worktree paths, and host-process journal paths.
3. Reject unrelated outstanding Missions, other non-closed chains, and unsettled receipts belonging to other chains. Snapshot publication facts. Bound each audited table to 128 rows.
4. Construct `AttentionStore(db, dbPath)` and call `claimOwner('sandbox-cold-<pid>-<uuid>')`. Require the same home ID, a different instance ID, and exactly one generation increment. Construct fresh Mission/chain stores with that owner.
5. Install connection-local guards against new Mission, chain, or publication-intent rows. Rebuild real ports, `EngineeringAccess(authorityPath)`, `ContainedMissionHost({ ports, worktreesRoot, maxConcurrent: 1 })`, and `createProductionLiveBridge(...)`.
6. Keep live authority disabled. Replace execution, workspace-write, verification-launch, publish, and check-publish ports with rejecting recovery-only guards. Do not start live/scan/check scheduler services. Call `host.recover()`, `bridge.revisionRecovery(signal)`, then `host.tick()` once.
7. Require cancelled state, no stop obligation, a released claim, unchanged publication facts and published head, no external-write ledger stop, and no confirmed push for the cancelled child. Confirm that the worker still owns the DB. A pending receipt may settle to failed; a new confirmed publication may not.
8. Attempt all bridge service stops, host close, DB close, and probe-lock cleanup in `finally`. Cleanup failure prevents success. Emit evidence only after cleanup completes.

On forced termination, JavaScript `finally` cannot be guaranteed. The OS closes the worker's handles. After observed exit, the parent removes a leftover probe lock only when its PID and descriptor digest identify that worker. It also removes the private descriptor directory. It never deletes an unrelated or unproven lock.

API inspection used the actual `AttentionStore.getScope/claimOwner` and store constructors, `ContainedMissionHost.recover/tick/close`, `EngineeringAccess` constructor, `createContainedMissionPorts`, and `createProductionLiveBridge` implementations. Host `recover` and `tick` are whole-store scans. Revision recovery also scans receipts and live ledgers across the DB. No invented single-Mission recovery constructor or API is assumed.

## Parent integration requirements

The driver owner must integrate this helper. A direct replacement of the present same-process restart block is insufficient.

1. Run the cancellation scenario before other live chains exist, or use a dedicated run home for it. Other chains in that home must be closed, other receipts settled, and every other Mission terminal with its claim released and stop obligation cleared. The helper rejects unrelated outstanding work because the real recovery APIs are not scoped to one Mission. It also limits Missions, chains, intents, events, and host journal rows to 128 per table.
2. Bind an existing root PR and an existing revision child on the existing sandbox branch. Request cancellation before handoff. The child must be `cancelled` or `cancel_requested`, and the chain's current-child pointer must still identify it. Keep that run's bridge/issuer/authority files in place.
3. Stop and await check retry, live reconciliation, stopped scanning, all outer stepping/polling loops, and the old host. Capture the final owner row and all descriptor identities only after those awaits. Close the parent's DB. Then set the three shutdown attestation flags to true.
4. Canonicalize all referenced paths. Supply the selected built `packages/cli/dist/bridge-production.js` and `packages/core/dist/index.js` paths and SHA256 values under a frozen runtimePrefix. Their expected builds and dependencies must already exist. Set the closed DB's mode to `0600` if its creation umask left it more permissive. Keep home/runRoot `0700` and authority/config/key files private.
5. Call `runSandboxColdRestart` from that parent PID. Save its sanitized result or error evidence. Do not reuse the old host, ports, stores, or owner token while the child runs.
6. After child exit, including failure, re-open control.db, create a new AttentionStore, claim a new **parent** owner, and rebuild Mission/chain stores, ports, access, host, and bridge against that owner. Restore the driver's intended runtime environment. Re-read the cancelled child and intents from this newly owned connection before resuming other scenarios.
7. Update the driver's lexical bindings and cleanup/report code to use those rebuilt resources. Its current `const db`, `attention`, `owner`, `missions`, `chains`, and `ports` bindings cannot continue serving the rest of the run after child ownership takeover. Preserve separate-process evidence in the scenario report.

The flags enforce an explicit caller contract. They do **not** prove that the parent closed every handle or stopped every service. Evidence therefore always says `parentShutdownProven: false`. Owner generation and child PID prove takeover in a new process, not parent shutdown.

The existing driver currently places cancellation after multiple other live scenarios and retains its original DB/stores/ports during its replacement-host block. Those are concrete integration blockers under this contract. This worker did not weaken the guard or edit the driver to conceal them.

## Validation and failures

Initial test-first command:

```sh
node --test scripts/bridge-sandbox-cold-restart.test.mjs
```

It failed with `ERR_MODULE_NOT_FOUND` because the helper had not been created. No product code ran. After implementation, the first eight focused tests passed. Added cases then passed without timeout increases or skipped tests.

Final focused command:

```sh
env OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack \
  node --test scripts/bridge-sandbox-cold-restart.test.mjs
```

The final run passed **15 tests, 0 failed, 0 skipped**, in 2.052 seconds. Its diagnostic recorded parent PID `91324`, worker PID `91325`, exit `0`, signal `null`, owner generation `5`, and Mission state `cancelled`. The suite covers a real second PID and observed exit, new-owner generation, recovery/tick/cleanup order, path/ID/hash rejection, descriptor mode rejection in the child, post-validation module tampering, stale ownership and unrelated-work rejection, spawn failure, timeout and SIGKILL escalation, excess output, cleanup failure, and publication refusal. Fixtures use fake modules with the real API shapes and a private JSON stand-in for the DB; this is process-boundary evidence, not real SQLite recovery qualification.

`node --check scripts/lib/bridge-sandbox-cold-restart.mjs` and `node --check scripts/bridge-sandbox-cold-restart.test.mjs` passed. `git diff --check` and `git diff --cached --check` passed.

`pnpm exec biome check scripts/lib/bridge-sandbox-cold-restart.mjs scripts/bridge-sandbox-cold-restart.test.mjs` exited 1 because repository Biome configuration includes only `packages/**/src/**/*.ts`: **zero files processed**. This is not recorded as a lint pass. No configuration was changed to suppress it.

Final local test output is retained at `/Volumes/AIMATE_WORK/tmp/osstack/bridge-cli-cold-restart/tests.log`. It includes a whitelist-only diagnostic with actual test parent/child PIDs, exit status, owner generation, and cancelled state. Node was `v26.5.0`. No full repository suite, build, or typecheck ran.

## Limits and findings

No new production P1/P2 was demonstrated. The existing driver's same-process host replacement is the known verification gap: it reuses the original process and DB ownership. This helper supplies the missing process primitive, but driver integration and real sandbox execution are still pending.

The module hashes bind entry files only. The caller must freeze their transitive runtime tree. Descriptor privacy protects a trusted same-UID handoff; it does not sandbox hostile runtime modules or other same-UID processes. All physical process-group behavior here targets POSIX systems. Explicit external path references and the disabled launch/write ports were exercised only with local fakes.

Published head evidence is the DB readback. Production revision recovery performs its own remote ledger reads, but this helper does not export an independent remote-head readback and rejects an `external_write` ledger stop. It does not prove that the remote branch stayed unchanged between all observations. A complete 5-G run must retain the driver's own remote timeline/identity evidence.

The production gate remains CLOSED. No service was enabled, PR opened, branch pushed, repository setting changed, or message sent externally. Shared cloud Bot placement and the paused PR Reviewer's formal capabilities are unchanged.
