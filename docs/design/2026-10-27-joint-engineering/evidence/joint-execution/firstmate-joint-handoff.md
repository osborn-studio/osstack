# Firstmate batch handoff to the joint OSStack project

**Handoff status: COMPLETE for this implementation batch. GitHub main check is still PENDING.**
The joint project entry explicitly takes over CI follow-up, readiness, independent review and merge ordering.
All five PRs remain Draft. The four Graph matrix checks passed on each current head; the paid DeepSeek job
is configured skipped. The main check is in progress. No failed remote check was observed at the saved snapshot.
No CI-pass or Ready claim is made. See the timestamp and exact head/base in `ci-latest.json`.
No new development package or A/B thread will be started by this batch owner.

## Ownership and commits

- Joint project main entry: `01a178ed-616a-7bb1-8d20-13f4c1019245`.
- This integration thread: `01a1693a-3d49-7b92-b1b4-5344ff4ad2e7`.
- A: `01a17bd6-5177-7941-a4cf-2726226b1108`; B: `01a17bd6-a137-79d3-8a64-f52abcb8bf13`; both completed and idle.
- #271 merged at `ce543535be9b1ef96a8c4fb14d13ea8483444051` (last fetched main).
- Full production test + final audit candidate: `20b4a81dfcffd80b4919643be362dcfcefad7cf5`.
- Final integration branch `codex/firstmate-batch1-integration`: `dd0f8d09687c6d77394771f61102c9685ec33b2c`.
  Only post-test delta: three generated lines in `docs/inventory/PUBLIC_EXPORTS.md`. Source equivalence checked.

| PR | Branch/head | Base | State |
|---|---|---|---|
| [#275](https://github.com/osborn-studio/osstack/pull/275) | `codex/firstmate-behavior-contract` / `48d6b927d36e5c673eb80c8956daa69779614cc7` | `main` | Draft; CI running |
| [#276](https://github.com/osborn-studio/osstack/pull/276) | `codex/firstmate-behavior-loader` / `5e86a77859367a333829748908bbf986048132b9` | `codex/firstmate-behavior-contract` | Draft; CI running |
| [#277](https://github.com/osborn-studio/osstack/pull/277) | `codex/session-receipt-fix` / `585ed985ac4a8513778470f6443d0ce7ce2c7893` | `main` | Draft; CI running |
| [#278](https://github.com/osborn-studio/osstack/pull/278) | `codex/session-start-cleanup` / `81f01d1a91248396dfdd2dce1132b69d478556cf` | `codex/session-receipt-fix` | Draft; CI running |
| [#279](https://github.com/osborn-studio/osstack/pull/279) | `codex/session-terminal-fence` / `cae25bc612e6e6884cf548e5bc8d3a745863a909` | `codex/session-start-cleanup` | Draft; CI running |

Merge order: #275 then retarget #276 to main and verify its diff/CI; separately #277, then retarget
#278 to main and verify, then #279. Dependent PRs intentionally remain Draft to prevent merging
into an intermediate branch. Do not auto-merge another thread's PRs or weaken main protection.
Only #275/#277 should become Ready after their checks pass.

Shared external work: #272 → #273 → #274. Public contract `@osstack/protocol/joint` belongs to #273.
This batch has no joint import or competing method/recovery authority. The recovery 47→48 candidate
DDL is not registered and is not J12. Do not claim tests of a combined unmerged joint+Firstmate tree.
Future dependent integration must consume those actual PRs after retarget/revalidation.

## What is delivered and what is not

R01 delivers strict versioned behavior/source/qualification/evidence/delivery schemas for FM-01..24 IDs.
R02 delivers a pure synchronous evaluator with signatures, issuer scope, complete-record digest
revocation, source membership, evidence/chain/dependency checks, bounded inputs and context anchors.
It does not authenticate its caller's roots, clock, build or host, and grants no authority. No daemon route uses it.
R03 extraction, R04 actual behavior mapping/fixtures, R05 signing/verifier protocol, V03 host measurement
and V06 trust operations/rollout remain future work. This is not completion of all 24 capability implementations.
DEBT03 preserves committed/duplicate/uncertain receipts during cleanup. The separate start fix clears
ephemeral markers while retaining obligations. The terminal fix prevents iterator EOF from becoming
successful start or silently releasing unconfirmed execution.

## Tests and audit evidence

All evidence below is preserved in this directory; do not remove it during takeover.

- `final-verification.json`, `final-summary.json`: Node22/macOS monorepo 6,032 passed / 5 skipped / 0 failed;
  lint/build/typecheck, decision smoke, startup, inventory, changeset and 13 Python tests passed.
- `final-test.log`; `final-decision-smoke.log`: 13 smoke self-tests and full local decision journey.
- `final-startup.log`: --version median47ms (150ms budget), --help115ms (500ms budget).
- `final-verification-before-inventory-fix.json` preserves the stale generated export-inventory failure;
  `final-inventory-recheck.log` records its deterministic regeneration/check. No production change after full tests.
- Prior failed attempts are not discarded: `r01-debt03-first-attempt.json` (tracked stale build artifacts),
  `r01-debt03-retry-verification.json` and test log (one Graph polling timeout); isolated Graph30/30 and final full run passed.
- `round1` through `round6`: original model response/raw text, input manifests and actual CLI run metadata.
  Model is verified `claude-sonnet-5-5`, tools/hooks/MCP disabled. Final round6 verdict PASS_WITH_CONCERNS,
  zero concrete P0/P1/P2. `audit-dispositions.md`, `round6-dispositions.json` distinguish host decisions from model text.
- `thread-a-*`, `thread-b-*`: local red/green and mutation tests, reciprocal reviews, limitations and import costs.
  `r02-cross-review/` preserves50 independent snapshot probes; `r01-cross-review/`57 contract probes.
- `ed25519-small-order-evidence.json` pins the libsodium source and local identity-key reproduction;
  `ed25519-malleability-probe.json` records 8/8 valid acceptance and S+L rejection on current Node/OpenSSL.
- `final-pr-split.json` binds branches, PRs and per-file Git blobs; `ci-latest.json` is the most recent remote snapshot.

Four nonblocking P3 followups remain in existing cards: missing-native-ID completion-boundary test
clarification, deterministic ordering for rejected-document diagnostics, documenting bound/synchronous
readArtifact callbacks, and a redundant assertion in the real Codex-adapter fixture. Eligibility and physical
drain assertions remain effective; do not say the final audit was unconditional PASS.

## Real environment limits

No new Session live-provider fault, process-death recovery, OS reboot, physical power loss, hostile
same-UID containment, remote host or long soak qualification. Actual CodexCliAdapter was tested with
a local fake executable; it is not a live Codex service test. Existing Graph tests have their own scope.
Fresh-process drain does not enumerate every retained writer lock; persistent reconcile locks still
refuse stale reuse. DEBT02/J11/J12 owns durable obligation visibility and authenticated operator recovery.
Before a resumable adapter gains cached positive stop proof, bind it to each invocation. Claude SDK EOF
completion needs provider-specific qualification. No production home, npm release or deployment was changed.

## OSStack management entry and binding

Use the installed shim, **not a development-checkout CLI against a reserved/default home**:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack
export OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/osstack/runtime/session-debt-20261026/ledger-home
export OSSTACK_SOCKET=/tmp/osstack-debt-ledger.sock
export OSSTACK_DASHBOARD_PORT=0
/Volumes/AIMATE_WORK/tmp/osstack/runtime/firstmate-release-20261025/registry-install/bin/osstack --version
```

Verified installed version: **0.22.1**. Ledger DB: `$OSSTACK_HOME/state.db`.
The management daemon is currently PID74854, cwd this evidence directory; it is a ledger-only workspace,
not the production/default home. Source repository is `/Volumes/AIMATE_WORK/Developer/CodeX/osstack`.
Do not reinterpret daemon cwd as a code execution workspace. If daemon is not live, inspect the socket/PID
before starting that exact installed shim with `serve` from this directory. Do not run a second daemon.
No credential is recorded here.

RPC wrapper: `/Volumes/AIMATE_WORK/tmp/osstack/runtime/session-debt-20261026/ledger.py`.
It uses length-prefixed JSON over the exact socket above. Read examples:

```sh
python3 /Volumes/AIMATE_WORK/tmp/osstack/runtime/session-debt-20261026/ledger.py kanban.board '{"board":"firstmate-upgrade-roadmap","include_archived":true}'
python3 /Volumes/AIMATE_WORK/tmp/osstack/runtime/session-debt-20261026/ledger.py kanban.board '{"board":"session-pilot-debt","include_archived":true}'
```

Supported writes used by this batch: kanban.comment `{card_id,author,body}`, kanban.move
`{card_id,status,actor,blocked_reason?}`, kanban.create `{board,title,body,priority,assignee,card_type}`.
No raw DB updates. No body-upsert or dependency enforcement was assumed. Dependencies are explicit card text.
Frozen 50-card design remains planned; runtime delivery/comments hold precise implementation scope.
The two audit defect cards are implementation followups, not two new roadmap features.

| Board | Card ID | Work | Current status |
|---|---|---|---|
| firstmate-upgrade-roadmap | `card_2ff6f711` | [R03] 原始材料快照与差异索引 | todo |
| firstmate-upgrade-roadmap | `card_c96c79e2` | [R04] 行为场景与来源映射 | todo |
| firstmate-upgrade-roadmap | `card_313e9767` | [R05] registry 一致性与资格检查 CI | todo |
| firstmate-upgrade-roadmap | `card_126c8bc6` | [R01] 将本设计注册表升级为运行时协议 | blocked |
| firstmate-upgrade-roadmap | `card_9ccb91b2` | [R02] 受信 registry loader | blocked |
| firstmate-upgrade-roadmap | `card_934c2a5e` | [V03] 宿主/Provider/隔离实测 | blocked |
| firstmate-upgrade-roadmap | `card_67df3d72` | [V06] 灰度、回退与默认启用 | blocked |
| firstmate-upgrade-roadmap | `card_4676bb72` | [DEBT03] 已应用手工发送回执保全 | blocked |
| session-pilot-debt | `card_c676432e` | DEBT01 Refine pre-rename publication failure cleanup without weakening proof | todo |
| session-pilot-debt | `card_f251dadf` | DEBT02 Design trusted operator recovery for retained unknown execution obligations | todo |
| session-pilot-debt | `card_9a161476` | DEBT03 Preserve applied receipt on manual session.send cleanup failure | blocked |
| session-pilot-debt | `card_4e8147d9` | [AUDIT-R1-06] Preserve Session start results after cleanup failure | blocked |
| session-pilot-debt | `card_d1a582eb` | [AUDIT-R3-H6] Require Session terminal completion before releasing execution | blocked |
| session-pilot-debt | `card_d21a83d5` | LIVE01 Qualify live provider, containment and physical durability | blocked |
| session-pilot-debt | `card_f9a5c968` | INT01 Repair main integration path for merged feature-base PRs | done |
| session-pilot-debt | `card_f4e6a395` | CORE01 Preserve identity reconciliation after original proof and manual turn | done |
| session-pilot-debt | `card_6bd0b827` | RUN01 Prove drain safety across delayed and failed lease cleanup | done |
| session-pilot-debt | `card_a0d941ce` | SMOKE01 Ship bounded compiled CLI and independent daemon smoke | done |
| session-pilot-debt | `card_cb0c70ea` | EVID01 Publish honest task and qualification evidence ledger | done |
| session-pilot-debt | `card_a7b41724` | VERIFY01 Run full suite, Sonnet 5.5 audit and fix findings | done |

Final counts: roadmap = 35 todo / 7 blocked / 8 local-scope done (50 cards); debt board = 2 todo / 4 blocked / 6 done.
Six current delivery cards moved to blocked with exact PR/dependency reasons. This means awaiting CI/review/landing,
not failed local validation. R02 whole production-host integration is still outside this local slice.

## Local preservation and cleanup

`local-branch-preservation.json` enumerates every unpublished commit on this batch's source/integration
branches. A and B source commits are retained locally; their final content is cherry-picked into the pushed
PR branches. The combined integration branch is local only. Five PR branches are pushed at the exact heads above.
No task changes remain uncommitted. The four tracked knowledge/dist build outputs were restored after local
verification and before removing the integration checkout; they are excluded from PRs. All source, tests and
generated inventory changes are committed. A fresh build is required in any newly created checkout.

All eight batch source/PR/integration worktrees have been removed after clean-status checks; branches remain
in the common repository. See `worktree-cleanup.json`. To repair CI, create a fresh worktree from the exact PR
branch under `~/Developer/CodeX/.worktrees/osstack/<task>`, use Node22 and an explicit scratch OSSTACK_HOME.
Do not resume code edits in the deleted A/B checkouts.
The earlier plan-closeout worktree was already removed. Scratch evidence/test logs and the ledger home are preserved.

Primary checkout remains on `codex/firstmate-supervision` at `0a61d278a6cede4fa7b3142fae3e7ab13cc4ed41`.
Its111 pre-existing dirty/untracked status entries match the starting inventory; none were reset, stashed or committed
by this batch. `primary-status-before.txt` / `primary-status-after.txt` list them. They include original design/reports
and unrelated development. Do not treat them as missing PR changes or discard them.
Other joint/cost/loop worktrees were not touched. No credentials or private configuration were copied.

## Takeover

Takeover is now complete for this batch. The joint entry owns pending CI, Ready transitions, independent review,
merge ordering, retargeting and subsequent roadmap packages. Re-read actual main and PR states before each action.
No new A/B turn or development package will be started here. The ledger daemon/home/socket remain accessible;
this owner performs no more card writes after this handoff. The new owner can first back up/export, then use existing
RPC for the joint board. Default/reserved homes and branch protections remain unchanged.

If the ledger must be restarted, first verify PID/socket ownership. After confirming the old instance has exited,
use the environment block above, change directory to this evidence folder, and run:

```sh
/Volumes/AIMATE_WORK/tmp/osstack/runtime/firstmate-release-20261025/registry-install/bin/osstack serve
```

No need to rebuild or run a development CLI to manage this ledger. Keep `state.db` and its SQLite companions together;
use a consistent backup/export while live. Do not copy just a live DB file and assume its WAL is included.
