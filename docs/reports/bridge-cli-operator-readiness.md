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

`readiness` is always `not_assessed`, and `evidenceScope` is `github_metadata_only`. `productionGate` is always `closed`. `platformUnknowns` always lists U-1 through U-11 as `not_verified`. These fields do not change from GitHub configuration alone.

## Evidence and reuse

The collector reuses `parseRegistry` and `assertSandbox` from `scripts/lib/bridge-probe.mjs`. It reuses `loadRulesetFiles`, `readLiveRulesets`, and `checkRulesets` from `scripts/lib/rulesets.mjs`. It adds no dependency, root script, verification skill, or change to those utilities. The existing `.cursor/skills/verify-osstack` remains canonical.

Each repository has separate `mainBranch`, `classicProtection`, and `rulesets` sections. The main branch is read explicitly. An absent, inaccessible, or non-main response makes collection incomplete and prevents the protection request. The classic section reports review settings, admin enforcement, conversation resolution, and known required checks with producer IDs. Unknown check names are counted without copying their text. A protection 404 is `unknown`: it can mean absent protection or unavailable access. It is not converted into a claim that protection is absent.

Ruleset comparison uses the current checked-in baseline: `sandbox` for the registered sandbox and `main-repo-interim` for the main repository. The latter does not cover the unresolved main-update merge allowlist. `comparison.complete: false` preserves that limitation. Differences and notes are counted rather than printing remote text. Unregistered ruleset names appear as `unregistered`. Missing bypass visibility makes collection incomplete. An empty, completely read ruleset list is still evidence; the comparison reports missing rulesets.

`grokCheckBinding: configured` means main was observed and an active branch ruleset named `main-quality` contains exactly one `grok/verify-osstack` entry bound to the registered App C ID under recognized main ref conditions. The collector resolves exact refs, `~ALL`, and `~DEFAULT_BRANCH` against repository metadata. Excluded or non-main refs do not establish the binding. Glob or additional conditions remain `unknown`. Multiple same-name check entries are `conflicting`. This does not prove effective protection, installation, actual check production, or platform behavior. It is separate from baseline comparison: adding the phase 6 check to the current baseline produces a difference. No ruleset application is performed.

Public bot-user lookups cover all six App slugs in ADR-006. The report distinguishes `registeredAppId` from the observed `publicBot.userId`. It checks the returned login, numeric ID shape, and `Bot` type. Distinct registered logins that return the same user ID are all marked `unknown` with reason `identity_conflict`. A public user lookup does not establish the App-to-user binding or installation access. Owner confirmation remains required, including App A/C/D IDs.

## Read boundary

All external calls use `gh api --hostname github.com --method GET` with an argument array and `shell: false`. The transport allows only metadata for the main and registered sandbox repositories, main branch and classic protection, scoped ruleset list/detail, repository-owner organization ruleset detail, and registered public bot-user endpoints. Installation, token, authentication, unrelated repository/user, and unrelated organization endpoints are rejected even with GET. Ruleset detail IDs and optional source fields must match the requested scope. Duplicate summaries are rejected before detail reads. Authentication stays inside gh. The collector does not read credential files, call `gh auth token`, exchange installation tokens, or print response bodies, stderr, URLs, or arbitrary remote strings.

Each repository permits at most three ruleset pages of 100 summaries and 50 total API requests, including metadata, main branch and classic protection. The existing reader receives the bounded transport. A full third page causes an incomplete result before page four is sent; an exhausted request budget also stays incomplete. Each of the six public bot lookups adds one request. The maximum is 106 requests per invocation, with no retry. Each gh process has a 15-second timeout and a 4 MiB output limit. A failed section does not erase the other section's observations. No Link URL supplied by GitHub is followed.

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

The bypass completeness defect was found and fixed before commit. Repro: supply a live expected ruleset without `bypass_actors`; the public GET can succeed while bypass evidence is unavailable. The regression requires `collectionComplete: false`. At the end of the first pass, no further P1/P2 implementation defect was known in the owned paths. The second-pass findings below supersede that statement. Live repository findings remain unknown until the parent runs the probe. Full acceptance, model review, docs audit, branch integration checks and CI remain with the parent.


## Second adversarial pass

The follow-up changes are left for the parent's explicit-path commit. No git mutation ran during this pass. The existing first-pass commit is `8477b9fb`; this section describes the subsequent working-tree delta.

Twelve new fake-API test cases exercise:

1. HTTP 401, 403, and 404 remain distinct numeric observations for classic protection and public bot lookups. All remain unknown, with no claim of absence or platform capability.
2. GET installation, token, auth, unrelated repository/user/organization, and absolute-URL endpoints are rejected before invoking gh.
3. Duplicate bot-user IDs across distinct registered logins become identity conflicts.
4. Duplicate ruleset summaries fail before any detail read.
5. Mismatched detail IDs and unrelated inherited organization sources cannot switch evidence scope.
6. Null rules, non-array required-check evidence, repeated rule types, missing ref conditions, and null bypass actors cannot count as a complete read.
7. A main-branch 404 suppresses the protection request and leaves the main check binding unknown.
8. A non-main branch response is invalid; `~DEFAULT_BRANCH` on develop cannot establish a main binding.
9. A full first page followed by a short second page still stops at exactly 50 transport calls per repository. Pagination completion does not bypass the detail-read budget.
10. Conflicting same-name check producers do not establish App C binding. Readiness stays unassessed and every platform requirement stays unverified.
11. Non-main refs, excluded main, disabled rules, unresolved glob refs, and recognized exact-main refs remain distinct.
12. Owner-organization inheritance works; contradictory detail-source metadata is rejected.

The existing full-three-page pagination case now uses distinct IDs across pages, so duplicate detection does not mask the page-limit assertion. The existing hostile-source case now uses a valid numeric ID to isolate source-path rejection. The detail-budget fixture now returns the requested ID. These fixture changes preserve each original test's purpose under the stricter evidence validation.

| Second-pass check | Result |
| --- | --- |
| `node --test scripts/inspect-bridge-operator-readiness.test.mjs` after adding the first ten cases | Exit 1: 15 passed, 8 failed. The failures exposed scope, identity, malformed-evidence, branch, and check-binding gaps. |
| Same command after source fixes | Exit 1: 21 passed, 2 failed. Old pagination/source fixtures hit newly added duplicate/ID validation before their intended assertions. |
| Same command after correcting those fixtures and validating detail source | Exit 0: 23 passed, 0 failed. |
| Same command after two additional applicability/inheritance cases | Exit 0: 25 passed, 0 failed, 0 skipped. |
| `node --check scripts/inspect-bridge-operator-readiness.mjs` and `node --check scripts/inspect-bridge-operator-readiness.test.mjs` | Both exit 0. |
| `git diff --check` | Exit 0. |

Proven P2 findings fixed in this delta:

- **Endpoint scope:** call the exported transport with `repos/other/project` or an unrelated public bot path. The first version passed those paths to gh. The transport now derives the permitted scope from the existing ADR registry. Token and installation endpoints were already blocked; the expanded test confirms they remain blocked.
- **Identity integrity:** return one numeric user ID for all six distinct registered bot logins. The first version marked all observed and could report collection complete. All conflicting lookups now become unknown.
- **Ruleset evidence integrity:** repeat a summary ID, return a different detail ID, or use a malformed rule/condition/bypass structure. The first version could label some of these observed. The collector now rejects them without changing the shared ruleset utilities.
- **Main/check configuration:** omit main, return develop for the main endpoint, use default-branch rules when the default is develop, or add both correct and incorrect producers for the Grok check name. The first version did not verify main and used an any-match producer test. The collector now verifies main, resolves only supported ref conditions, and marks duplicate entries conflicting.

No unresolved P1/P2 was identified in the final owned-code review. This is a focused local audit, not a claim that all defects are excluded. The transport's process boundary was faked; no live response, credential access, external write, deployment, or service change occurred. No full-monorepo checks ran. Glob/ref semantics beyond the small supported subset, enterprise or unrelated-organization inheritance, effective GitHub merge eligibility, App installation/permission state, and all Grok platform capabilities remain unverified. A public identity or correctly named check never proves operator readiness.

## N13a main-base integration (2026-11-07)

`codex/bridge-operator-evidence` starts at main `9e2eaf9c` and contains only the
collector, its Node test and this report. Original commits `8477b9fb` and
`82e2f7d6` were selected as `8844d4c4` and `8c59d677`; no N9 runtime dependency,
new package, root script or duplicate collector was added. Source is bound to
`8c59d677`; later documentation does not change it.

The parent independently sampled real read-only GETs into an external evidence
artifact, SHA256 `46f096bd39b29aa9c0cea65f76949840ce629d4ed82cd9f0928d9ce348c288e4`.
The expected CLI exit was 1: main classic protection requires one approval and
has no required checks; main-quality ruleset is missing. Sandbox has all four
matching rulesets, while classic protection HTTP404 remains unknown. All six
registered public Bot identities were observed. These are metadata observations,
not installation, credential, event delivery or U-1 through U-11 runtime proof.
Readiness remains `not_assessed`, scope `github_metadata_only`, gate closed.
This integration did not repeat that network probe.

GLM reviewed the collector/test diff and existing sample/test artifacts, without
executing anything: no introduced P1/P2. Reviewed diff SHA256 is
`a60262173cdeb2e6d31f49d71a259c652fb4744bf49600e5109e9d9737ebc4ed`;
response UTF-8 SHA256 is
`8bad42c5381af34be6fbda8956451aab71fa4d1e1ea66062cf887502e2f86434`.
No raw model session metadata is committed. This is a scoped static review,
separate from the following actual local checks.

Local integration validation: Node tests25/25, no skip; both `node --check`
commands pass; Biome2files pass using byte-identical scratch copies and the repo
rules with only file inclusion expanded to mjs. The default repo inclusion
excludes scripts, so the initial direct invocation processed zero files and is
not counted as success. Inventory fresh, changeset coverage0 release-sensitive
packages, diff check pass. Documentation audit resolves both report links and
checks the metadata-only/gate statements against the saved sample; it does not
certify the external platform. No build, typecheck or full-repo suite was needed
or run. No settings, service, Bot or remote mutation was performed.

Suggested main-base PR: `feat(bridge): collect read-only operator readiness metadata`.
Describe bounded allowlisted GETs, independent classic/ruleset evidence, public
identity conflicts and unknown handling. State the expected incomplete live
result and25 local unit checks; do not claim stage6 acceptance. CI test-step
integration is a separate dependent node. Parent owns push and PR creation.
