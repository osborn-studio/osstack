# Bridge operator readiness collector

Date: 2026-11-07. Scope: remaining phase 6 handoff evidence (N13/N14). The main production gate remains **closed**.

This report describes the collector and its offline checks. It contains no live GitHub readback. No platform capability, installation, service activation, or production acceptance is proved here.

## Run and interpret

From the repository root, the parent can later run this read-only command outside the nested sandbox:

```sh
node scripts/inspect-bridge-operator-readiness.mjs
```

The command prints JSON. It always targets `osborn-studio/osstack` and the sandbox registered in [ADR-006](../decisions/ADR-006-bridge-s0-decisions.md). It checks the sandbox name and numeric repository ID before reading its settings. `--help` makes no API request. Other arguments are rejected. The collector does not invoke osstack or open an OSSTACK_HOME.

Exit codes:

- `0`: all selected metadata was read, including ruleset bypass visibility. This does **not** mean readiness. A missing or differing ruleset can still produce exit 0 because the read itself completed.
- `1`: evidence collection is incomplete. Inspect the section with `status: unknown` or `readComplete: false`.
- `2`: invalid usage or unreadable/invalid local registry or ruleset files.

`productionGate` is always `closed`. `platformUnknowns` always lists U-1 through U-11 as `not_verified`. These fields do not change from GitHub configuration alone.

## Evidence and reuse

The collector reuses `parseRegistry` and `assertSandbox` from `scripts/lib/bridge-probe.mjs`. It reuses `loadRulesetFiles`, `readLiveRulesets`, and `checkRulesets` from `scripts/lib/rulesets.mjs`. It adds no dependency, root script, verification skill, or change to those utilities. The existing `.cursor/skills/verify-osstack` remains canonical.

Each repository has separate `classicProtection` and `rulesets` sections. The classic section reports review settings, admin enforcement, conversation resolution, and known required checks with producer IDs. Unknown check names are counted without copying their text. A protection 404 is `unknown`: it can mean absent protection or unavailable access. It is not converted into a claim that protection is absent.

Ruleset comparison uses the current checked-in baseline: `sandbox` for the registered sandbox and `main-repo-interim` for the main repository. The latter does not cover the unresolved main-update merge allowlist. `comparison.complete: false` preserves that limitation. Differences and notes are counted rather than printing remote text. Unregistered ruleset names appear as `unregistered`. Missing bypass visibility makes collection incomplete. An empty, completely read ruleset list is still evidence; the comparison reports missing rulesets.

`grokCheckBinding: configured` means an active branch ruleset named `main-quality` contains `grok/verify-osstack` bound to the registered App C ID. It does not prove branch applicability, effective protection, installation, actual check production, or platform behavior. It is separate from baseline comparison: adding the phase 6 check to the current baseline produces a difference. No ruleset application is performed.

Public bot-user lookups cover all six App slugs in ADR-006. The report distinguishes `registeredAppId` from the observed `publicBot.userId`. It checks the returned login, numeric ID shape, and `Bot` type. A public user lookup does not establish the App-to-user binding or installation access. Owner confirmation remains required, including App A/C/D IDs.

## Read boundary

All external calls use `gh api --hostname github.com --method GET` with an argument array and `shell: false`. The transport allows only repository metadata, main classic protection, ruleset list/detail, organization ruleset detail, and public user endpoints. Authentication stays inside gh. The collector does not read credential files, call `gh auth token`, exchange installation tokens, or print response bodies, stderr, URLs, or arbitrary remote strings.

Each repository permits at most three ruleset pages of 100 summaries and 50 total API requests, including metadata and classic protection. The existing reader receives the bounded transport. A full third page causes an incomplete result before page four is sent; an exhausted request budget also stays incomplete. Each of the six public bot lookups adds one request. The maximum is 106 requests per invocation, with no retry. Each gh process has a 15-second timeout and a 4 MiB output limit. A failed section does not erase the other section's observations. No Link URL supplied by GitHub is followed.

## Remaining handoff evidence

The collector cannot establish the platform requirements in [the phase 6 specification](../design/2026-11-06-bridge-phase6-operator.md). The handoff still needs:

- App C/D migration, installation and permission readback, event delivery, and owner-confirmed identity bindings.
- U-1 through U-11 evidence, platform logs, sandbox V-1 through V-31 results, and rollback evidence.
- Formal `CHANGES_REQUESTED` behavior, including blocking and clearing it. PR Reviewer is paused and has no proven formal capability.
- Independent Watcher and Reviewer execution identities. Their shared `Rubebun-Jadeem` use is current owner-provided context, not a finding from these GET requests.
- Owner decisions, authorized main ruleset application/readback, and the later production acceptance gates.

The collector neither enables services nor sends messages, pushes, creates PRs, changes settings, or deploys. The parent owns those gates.

## Validation and failure record

Only focused Node checks ran. No full-monorepo test, typecheck, build, dependency install, or live probe ran.

| Check | Result |
| --- | --- |
| `node --test scripts/inspect-bridge-operator-readiness.test.mjs` before implementation | Exit 1: expected RED, `ERR_MODULE_NOT_FOUND`; the new collector did not exist. |
| Same command after initial implementation | Exit 0: 9 passed, 0 failed. |
| Same command after adding incomplete-bypass regression | Exit 1: 12 passed, 1 failed. `collectionComplete` incorrectly stayed true when a live ruleset omitted bypass actors. |
| Same command after fixing evidence completeness | Exit 0: 13 passed, 0 failed, 0 skipped. No timeout change or retry was used to obtain this result. |
| `node --check scripts/inspect-bridge-operator-readiness.mjs` | Exit 0. |

The tests cover fixed GET transport, host pinning, bounded pagination and detail reads, sandbox mismatch, hostile inherited paths, missing classic access, malformed responses, identity mismatches, baseline differences, App C producer binding, bypass visibility, secret-free output, and CLI exit semantics.

The bypass completeness defect was found and fixed before commit. Repro: supply a live expected ruleset without `bypass_actors`; the public GET can succeed while bypass evidence is unavailable. The regression requires `collectionComplete: false`. No unresolved P1/P2 implementation defect was found in the owned paths. Live repository findings remain unknown until the parent runs the probe. Full acceptance, model review, docs audit, branch integration checks and CI remain with the parent.
