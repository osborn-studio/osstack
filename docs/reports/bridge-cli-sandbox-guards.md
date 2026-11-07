# Phase 5 sandbox driver: egress and failure cleanup audit

Date: 2026-11-07. Implementation and tests: `gpt-6.1-sol`.

Audited checkout HEAD: `75c007667eccd0b24384338cf4f4d4d12848d2de`.
Driver: `scripts/smoke-bridge-revision-sandbox.mjs`.
Driver SHA-256: `0e7ffbbd4f6473a85b8562840df0379d2b1970f3b1e19ed962b869e6205a472b`.

Only the adjacent test file and this report changed. The runtime driver remains unchanged.
The graph and progress files were read first. The existing `.cursor/skills/verify-osstack/SKILL.md` was read; no duplicate skill was created.

## Result and checks

| Command | Result |
| --- | --- |
| `node --test scripts/smoke-bridge-revision-sandbox.test.mjs` before edits | Exit 0; 4 passed |
| `node --test scripts/smoke-bridge-revision-sandbox.test.mjs` after edits | Exit 1; 73 tests; 70 passed; 3 failed; 0 skipped; 0 TODO |
| `node --check scripts/smoke-bridge-revision-sandbox.test.mjs` | Exit 0 |
| `git diff --check` | Exit 0 |
| `git add -- scripts/smoke-bridge-revision-sandbox.test.mjs docs/reports/bridge-cli-sandbox-guards.md` | Exit 128; cannot create worktree `index.lock`: Operation not permitted |

The three failures are denial regressions against runtime defects. Each reports `AssertionError: Missing expected exception.` They remain ordinary failing tests. They were not skipped, marked TODO, weakened, or retried.

The suite uses imported pure guards, local fake records, local URL parsing, and injected `runSmoke` effects. Its `--execute` argument is passed only to injected fake effects, as in the original test. The actual `execute` and `preflight` exports are never called. No tokens were minted. No subprocess, daemon, database, Docker workload, or network request was started by these tests. No scratch files were needed.

No full-monorepo test, typecheck, build, dependency installation, remote check, service change, push, PR, or deployment was run. Full acceptance belongs to the parent worker.

## Coverage added

- Default and explicit preflight return an unqualified result. A failed fake preflight prevents execution in all three modes. Invalid options prevent both effects. A fake execution rejection preserves the original error and report reference.
- Options reject missing values, duplicate flags, conflicting modes, relative paths, run traversal, an alternate home/repository, unsafe image syntax, and invalid environment paths or scratch roots.
- Egress has positive controls for reads, an owned review, an owned PR close, and an owned ref probe. Each write requires execute and explicit ownership.
- Egress denials cover absent paths and ownership, other repositories and PRs, branch prefix lookalikes, nested refs, wrong HTTP methods, ref creation/deletion, merge, PR creation, query/fragment suffixes, trailing slashes, absolute URLs, dot segments, encoded separators, and backslashes.
- Timeline tests use a two-commit revision range. They reject omitted, extra, reordered, and duplicate remote commits; an unconfirmed published push; missing baseline receipts; and missing, duplicate, failed, pending, or wrongly attributed checks. An unrelated App check cannot replace the required evidence.

## Findings and local reproduction

No P1 was established. Four P2 findings remain for the runtime owner.

### P2: control characters bypass the GET repository boundary

Source: `assertRequest`, driver lines 54–62.
Test: `egress denies control-character traversal before URL normalization escapes the sandbox`.

Local repro: construct `path = 'repos/' + SANDBOX + '/\t../other'`, where `\t` is an actual tab. Call `assertRequest('GET', path, { execute: false })`. It returns successfully. Parse the same path with `new URL('https://api.example.invalid/' + path)`. Its pathname is `/repos/osborn-studio/other`.

The raw segment is not equal to `..`, so the guard accepts it. URL parsing removes the tab and resolves the parent segment. The claimed sandbox boundary does not hold for this input.

The current driver constructs paths from fixed prefixes and controlled run names. This audit did not establish an attacker-controlled call site or a remote write exploit. The reproduced defect is in the exported GET guard. Reject control characters and validate the normalized request target in the runtime owner’s change.

### P2: a confirmed revision can lack its ledger range

Source: `assertTimeline`, driver lines 115–123.
Test: `timeline denies a confirmed push with no ledger range even when remote history omits it too`.

Local repro: start with the valid local fixture. Delete `ranges.get('revision')` by calling `ranges.delete('revision')`. Keep the confirmed revision intent and its successful App B check. Set `remoteCommits` to the baseline alone. `assertTimeline` accepts the fixture.

The `?? []` fallback makes the confirmed push contribute no expected commits. Equality with remote history then passes. The evidence check still passes because it uses the intent head rather than the range. A missing range must fail independently of remote equality.

### P2: a confirmed head need not equal its range tip

Source: `assertTimeline`, driver lines 115–123.
Test: `timeline binds each confirmed new_head to the last commit in its ledger range`.

Local repro: start with the valid local fixture. Change the revision intent’s `new_head` to a fourth fake SHA. Change its check’s `head_sha` and `external_id` to match that fake head. Leave remote history and ledger ranges unchanged. `assertTimeline` accepts the fixture.

The function compares remote commits with ranges and checks with intent heads, but never connects those two comparisons. It can qualify evidence for a head absent from the recorded range and remote history. Require each confirmed publication’s nonempty range to end at its `new_head`.

### P2: cleanup does not cover all allocated resources or preserve the primary failure

Source: `execute`, driver lines 144–171, 236, 309–338. Source audit only; no real or fake `execute` invocation was made.

Two reproducible failure-injection recipes for the runtime owner are:

1. In a fully isolated harness, replace `buildBridge` with a rejection after DB and host construction. Alternatively, reject a report input read after bridge construction. The main `try` has not started, so neither service stops, host close, nor DB close runs. No report is saved through the main failure handler.
2. Reject a scenario operation with one error, then reject `privateJson(output, report)` in the final save with a second error. The second rejection replaces the primary error. `db.close()` is after `await save()`, so it does not run. A thrown store lookup during final ledger construction has the same close bypass.

These are control-flow findings, not claims that an actual leaked process or database lock was observed. The runtime owner should cover resource allocation from the first owned resource, make DB close unconditional, and retain the primary failure if report serialization or writing fails.

## Egress and cleanup boundaries reviewed

`assertRequest` guards the driver’s App-token request closure and its explicit host review POST. It is not a universal network interceptor. `ghRead` uses `gh api` directly; token sources, Git clone/push, and production ports use separate transports. Their presence does not prove arbitrary egress: current direct driver paths are constructed from the fixed sandbox, controlled branches, or recorded ledger heads. The unit tests do not validate every downstream transport.

Within the scenario `finally`, `enabled` becomes false first. Each service stop and host close is attempted independently. A failed stop marks cleanup incomplete and does not skip later stop calls. PR discovery uses the run’s recorded branches and requires the exact head ref and sandbox head repository ID. Discovery is bounded; truncated results fail cleanup. PR close goes through the owned-request guard. Branch history and private evidence are retained. If cleanup fails after a successful scenario, qualification is revoked.

The restart scenario stops the old bridge and host before constructing replacements. If replacement host construction succeeds but replacement bridge construction rejects, the scenario `finally` sees the new host and old bridge. It still attempts their cleanup; this does not solve failures before the scenario `try`.

The process-level `OSSTACK_HOME` and `OSSTACK_SCRATCH_ROOT` assignments are not restored. The actual CLI normally exits after one run. Reusing the exported runtime in a process would retain these values; such reuse was not tested.

## Acceptance limits

These local tests do not prove key permissions, App identity, Docker readiness, active rulesets, genuine ruleset rejection, live grant revocation, process termination, PR cleanup, or ledger readback from GitHub. Those need authorized execution and separate evidence. The source audit also cannot prove failure cleanup completes under real transport or process failures.

The production gate remains closed. Cloud Grok Bots share Rubebun-Jadeem. PR Reviewer remains paused, and formal `CHANGES_REQUESTED` capability is unproved. No N11 or production acceptance gate is opened by this report. The parent owns remote actions and the broader acceptance decision.

## Commit handoff

No commit was created. Staging the two owned paths failed because the linked worktree’s index is outside this session’s writable roots. The failed operation did not stage either file. Approval is disabled, so no escalation or alternate Git metadata write was attempted.

The parent can stage exactly these two paths and run a separate commit command with subject `test(bridge): audit sandbox egress and ledger denials`. This is a deliberately red regression-test handoff; the runtime defects must be resolved by their owner before acceptance.
