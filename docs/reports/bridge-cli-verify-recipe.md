# Bridge verification recipe handoff

Date: 2026-11-07. Base HEAD: `8120569883fd23c30bd99858de8f3d0c6a34aa55`. Scope: documentation only. The canonical skill already existed through engineer PRs #338/#340/#366/#374/#386; this change extends it in place.

## Files and behavior

- [Canonical skill](../../.cursor/skills/verify-osstack/SKILL.md): adds optional bridge routing in Drive. Existing frontmatter, default launch/doctor/drive/cleanup behavior and exclusions remain unchanged.
- [Feature map](../../.cursor/skills/verify-osstack/features/README.md): adds the optional entry and separates its preconditions from the default run.
- [Contained Mission bridge recipe](../../.cursor/skills/verify-osstack/features/contained-mission-bridge.md): maps the existing offline Node job (historical 218 tests), main/rounds TLC, two 10k properties and 19 source mutants. It defines a separately authorized real 5-G handoff with immutable trusted harness, installed source/hash provenance, App A/B/test reviewer, Docker/Codex, sandbox ID 1446327922, private scratch home and explicit result states.
- This report records local validation and limitations. No helper or production script changed. No `.agents` duplicate or new framework was created.

All four existing feature recipes (`deliver.md`, `kanban.md`, `cockpit.md`, `init-doctor.md`) remain byte-identical to the base. Thus all existing 31 UI/CLI recipes remain intact. A first local preservation check incorrectly expected 31 named Sub-features; it found 25 and failed. The corrected check verifies complete file bytes rather than equating named sub-features with the task's recipe count.

## Local checks

| Check | Result |
| --- | --- |
| `python3 /Users/osborn/.codex/skills/.system/skill-creator/scripts/quick_validate.py .cursor/skills/verify-osstack` | PASS: `Skill is valid!` |
| Original four feature files compared with `git show HEAD:<path>` | PASS: byte-identical |
| New feature H1, exact four H2 sections in existing order, Drive starts with `Preconditions:` | PASS |
| Local Markdown file references in changed skill/map/recipe and this report | PASS |
| Offline command file list compared with `.github/workflows/ci.yml` `bridge-offline-node-tests` | PASS at the original handoff: same nine files, same order. The current integrated list contains 15 files; see the integration follow-up below. |
| `git diff --check` | PASS |
| `pnpm --filter @osstack/governance test src/knowledge-hygiene/osstack-config.test.ts --maxWorkers=1 --minWorkers=1` | BLOCKED before Vitest: pnpm initiated automatic dependency installation; registry DNS returned `ENOTFOUND`. Stopped with SIGINT, exit 130. No docs audit pass claimed. Parent must run this narrow audit in its prepared environment. |

Only local documentation validation ran successfully. No offline 218 suite, TLC, property, mutation, full E2E or full repository tests were rerun. Existing historical evidence is linked with its source binding and limits, not attributed to this HEAD.

## Original handoff boundary (historical)

Per the user's latest handoff, real 5-G attempt 1 failed on journal-root setup before PR creation. It is **not qualified / not pass**. Another worker owns the root patch. This task neither tested that patch nor observed a later attempt. Historical reports that predate attempt 1 are not current live acceptance evidence.

The production gate stays **CLOSED**. App C/D migration and production launch remain outside coverage and subject to their own blocked gates. PR #421 operator checks and #422 N9 runtime were reported pending CI; no GitHub state was queried here. A GH200 Routine only wakes the existing engineer/Watcher. It proves neither execution nor completion.

Offline PR tests may run credential-free head code. Credentialed real 5-G must use a reviewed trusted harness and immutable pinned installed candidate outside PR-controlled code, with operator-controlled secrets. A modified PR skill cannot authorize itself. Each new external-write run needs explicit execute intention and complete preflight. Missing evidence, failed preflight, skipped scenarios, changed heads, absent attribution or remaining acceptance gaps cannot pass. Watcher does not automatically spend, write externally, approve, merge or replace Bot duties or the paused formal Reviewer.

No credentials/key contents, live DB, daemon, installed prefix, other checkout, GitHub operation, message or real 5-G execution was used by this task. The only dependency action was pnpm's unexpected automatic install attempt, stopped as recorded above. The parent owns remaining integration checks, privileged actions and Git metadata if local staging is blocked.

## Integration follow-up

The later [operator/skill integration report](2026-11-07-bridge-operator-handoff-integration.md) records current narrow validation, local capability limits and the reviewed journal-root baseline. Earlier blocked checks and status snapshots above remain historical facts, not current acceptance claims.

### v2 offline command integration — 2026-11-08

The current CI job and optional bridge recipe list the same **15 test files in the same order**. The previous integrated list contained 12. This follow-up adds `audit-bridge-sandbox-ledger.test.mjs`, `probe-bridge-sandbox-rulesets.test.mjs` and `report-bridge-acceptance.test.mjs`. The nine-file row above records the original handoff only. The default 31 UI/CLI recipes, original four feature files and helper remain unchanged.

After boundary review and repairs, the three tool suites passed **19/19**, **31/31** and **11/11**, respectively. The final 15-file command at frozen source `d98cc0fe` passed **483 tests, 0 failed, 0 skipped**, exit 0 (`integration-node-15-reviewed.log`, 5185.32 ms). The earlier 9/20/9 suite counts, twelve-file 369 result and initial 15-file 460 result remain historical. The ruleset diagnostic defaults to a plan with zero credential reads and network requests; its explicit execution mode is a separate bounded remote-write operation. Adding its offline tests to CI does not authorize that operation. The ledger audit reads a bound local SQLite artifact; the acceptance reporter reads explicit JSON artifacts. Their scoped results cannot qualify unrun live scenarios.

[Current v2 status](bridge-phase5-verification/current-v2-status.md) retains attempt 3 as FAILED, 7/13 scenarios passed, with `qualified:false`. A later HTTP capture proves a denied force update and unchanged remote head. The parser repair and local regressions do not rewrite that failure. No fourth full paid run was performed. Production remains CLOSED.

Local integration checks passed: CI/recipe file order and count, unchanged default skill/helper/four feature files, skill quick validation, Markdown references, `git diff --check`, and the governance docs audit (`osstack-config.test.ts`, 1/1). An earlier tooling GLM PASS missed concrete Sol-reproduced failures; those fixes and regressions are now committed. A fresh final-delta review is pending; no final review all-clear is claimed.

The final local ledger audit reports all seven unsettled counts zero, including chains and five reservations. It uses a manifest-bound immutable snapshot and exact report SHA. A separate post-run readback made 39 GET requests and bound seven heads to seven App B success checks, including PR 20 baseline check 128638788875, with three branch creations and four pushes attributed to App A actor 352680398. The original final timeline assertion was not reached; this partial readback cannot retroactively pass it. The external Grok/Watcher repair loop and production acceptance remain incomplete.
