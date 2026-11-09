# 执行进度

## 2026-11-09 GitHub CI 首发路径

- 本地实现覆盖登记沙箱 scope 的无 Docker Mission 启动、真实 Actions 失败识别、一次修复派发、精确候选审批、W13 租约推送与复验结果读回。测试先复现旧入口拒绝空验证命令，再通过独立的 CI 准入路径。GitHub CI 证据与 App B 容器回执分别保存。
- 新读取器对 [沙箱 #29 的原失败 job](https://github.com/osborn-studio/osstack-bridge-sandbox/actions/runs/42552131265/job/128949826133) 完成只读核对。该 PR 仍处于人工暂缓推送，Docker 全程停止的新验收和阶段 6 的实际 Watcher、人工审批与 Merger 证据仍待完成。生产入口保持关闭。

| 工作包 | 依赖 | 验收证据 |
|---|---|---|
| 首发代码交付 | 代码和实施方案合成；审阅发现的旧绿灯问题修复 | 构建、类型、全套测试及正常 daemon 启动预检，提交进入 `main` |
| 沙箱自动推送授权 | [ADR-007](../../decisions/ADR-007-bridge-github-ci-first.md) 中的限时许可获批 | 旧 head、base、候选和权限负例全部拒绝，最多一次可对账的真实快进 |
| 沙箱失败修复 | Docker 全程停止；授权发出一条新 Mission PR | 原失败与修复后的 run、attempt、job 和提交都可读回 |
| 沙箱独立审批及合并 | Watcher 权限和 Merger 执行路径获批；修复 CI 通过 | 真实 Routine、当前 head 的计入审批、App E squash SHA 及 osstack 关单；同一 head 重跑使旧绿灯失效 |
| 生产单 scope 与验收 | 沙箱全链通过；单独批准生产规则和范围 | 影子观察、撤权恢复、连续五条生产链，至少一条包含真实失败修复 |

独立审阅复现了历史绿灯可被用于接受重跑期间的合并回读。回归先在旧代码上失败，修复后改为重读当前尝试与 squash 基线，并记录证据不齐的合并观察。单 scope 仍只允许一条活跃链。

负责人已批准一条新沙箱 Mission 的一次性自动推送与独立审批合并。沙箱 Watcher 的 Write 权限和 `verified` 标签已读回。正常 daemon 接入限时许可、一次性 App E 合并和关单投影。实际 Grok Routine、真实新 PR 和端到端结果仍待验收。

## Closeout snapshot — updated 2026-11-09

- Merge status checked on 2026-11-09: #425 through #435 are in `main` at `40b8d40f`. The delivery queue below records the status before those merges.
- **N11 fourth real v2 run PASSED**, `LIVE_5G_ONLY`, **13/13**, `qualified:true`, exit 0. Run `revision-5g-20261108d`, driver `c6c3dd93fc1b797e3bd17e171dc96c94d95a050c`, installed runtime `8120569883fd23c30bd99858de8f3d0c6a34aa55`, 2026-11-08 15:03:47–15:16:20 Asia/Shanghai. The owner authorized one additional sandbox-only attempt. No fifth run is authorized. **Production CLOSED.**
- Attempts 1–3 remain failed/unqualified, with unchanged original reports. Attempt 3 passed 7/13 then stopped at `ruleset_probe_not_rejected`; later HTTP 422 denial/unchanged-head evidence does not retroactively qualify it.
- Independent fourth-run readback used **68 successful GETs, zero failures**: six PRs (23–28) closed/unmerged after cleanup, eleven confirmed heads, six root publications/five pushes, eleven App B success checks and eleven App A activities. Driver final open-head assertion passed before cleanup; current open precondition false is expected. Real W13 failed intent `detail=grant_invalid` has one stopped/unreleased `git_push` journal, `stop_proof=never_released`, remote unchanged. Controlled hostile T2 is separate.
- All 69 host journals are stopped; all 14 mission stop obligations are zero. Two dispatched reservations, two awaiting-decision missions and two active claims remain for T2/revocation. **`ledger_settled:false`**; no row was manipulated to claim full settlement. Twelve range events include the failed revoked push; eleven publications are confirmed. Cold recovery still cancels before the first executor tick and does not prove in-flight recovery or parent shutdown.
- Historical full package gate at `7f657613`: 22 packages, 8,905 passed / 6 skipped (CLI 3,989 / 5). Final strict nineteen-mutant gate at `315e7fc4` and source-`7f657613` targeted protected-finding mutant remain separately scoped. Model/property/mutant limitations remain unchanged; no new heavy rerun was implied by the fourth sandbox execution.
- Reporter fix `05eb6600` validates the distinct `driver_source_commit`; targeted reporter suite **12/12** after an initial RED 11/1. Parent fifteen-file Node run: **484 passed, zero failed/skipped**, exit 0, 5178.63 ms (`fourth-followup-node-15.log`). The older 483-test pass remains historical. `fourth-acceptance-status.json` reports live PASSED 13/13, source driver `c6c3dd93` / runtime `81205698`, `all_tasks_done:false`.
- All five final Sol CLI scope reviews now PASS: rounds, containment and inventory plus resumed release/timeline deltas. The two initial retention gaps were resolved by frozen snapshot/raw complete GET artifacts, not original-report rewriting. GLM-5.3 post-run review is **SCOPED PASS**, no unresolved material findings; static strict-allowlist projection/artifact consistency only, no execution/authenticity/full-project claim. Input SHA256 `e8168ff7d72ac371ce0b232540eaad6a3a9147c38b0c059f5a01735c6c9279ea`, manifest/result `glm-fourth-postrun-manifest.json` / `glm-fourth-postrun.json`. Earlier static PASS results cover only their recorded source/scope.
- Actual external Grok capability, Watcher chat-failure/local-repair intake, production admission and five production chains remain incomplete. Reviewer stays paused/excluded; the counted Mission-main human gate is unchanged. Resume from [current v2 status](../../reports/bridge-phase5-verification/current-v2-status.md) and [fourth-run evidence](../../reports/bridge-phase5-verification/fourth-run-v2.md).

### Historical five-slice delivery queue (all bases were main)

| PR | Output | Merge dependency | Reported state before merge |
|---|---|---|---|
| #425 | Selected installed runtime provenance and bounded executor hook | — | Merged; main `f034a51eef26676506788be0dc66cd55a043efbf` |
| #426 | CLI runner oracle and targeted protected-finding mutant | #425 (merged) | Ready, base `main`; head `2013392ac8d08cf8502335d2f14e75feff6e0b97`, fresh CI running |
| #427 | Full v2 sandbox driver, security oracles and REST refusal repair | #426 | Draft, base `main` |
| #428 | Read-only ledger audit | #427 | Draft, base `main` |
| #429 | Bounded diagnostic, advisory reporter, all Markdown closeout and optional skill recipe | #428 | Draft, base `main` |

#426 was synchronized with merged main; its tree is byte-identical to previous head `75c5222c` and its portable eleven-file Node suite passed 358/358. The earlier Linux Node jobs for #427–#429 failed one history fixture because a hardcoded `/Volumes` scratch override caused `EACCES`. The test-only TDD fix honors and asserts the configured root: #427 `c481d583`, #428 `e4053b1d`, #429 `1a621ba2`. Replacement Linux Node jobs `42459490007`, `42459490062`, `42459489845` all succeeded. Portable local suites passed 422 (12 files), 441 (13 files) and 484 (15 files; `ci-portable-pr429-node.log`). This is a snapshot of those jobs, not an all-checks-pass claim. The real driver and fourth-run `c6c3dd93` source evidence are unchanged; no new live execution occurred.

The earlier feature-base settings for #426–#429 were corrected to `main`. Dependencies are merge-order gates, never feature-branch PR targets. After each prerequisite merges, reconcile the next branch with current main, verify its exact diff and new head, rerun affected deterministic/CI checks, then obtain review. Keep each dependent PR draft until its requirements pass. Humans merge main one PR at a time. The private `review-slices-manifest.json` and `pr-1-body.md` through `pr-5-main-base-body.md` preserve the original file groups; their older run/test/status prose is historical. Review progress, a sandbox PASS or a previous head's green CI does not replace current exact-head gates.

### Historical record

续做时先读 [graph.md](graph.md) 与本文件，从“下一步”继续。

## 本轮最新验收（2026-11-07）

以下结论覆盖本轮 N10 本地验证门，不表示真实沙箱、CI、main 合并或生产上线已通过。下方早期分支记录保留为历史背景。

- **N10 模型门已完成：** 模型源 `036d2be2` 未在运行中改动。main 穷举 69,290,566 distinct、depth 48；三次评审 rounds 穷举 95,121,536 distinct、depth 46；两者均 `No error`、queue 0、exit 0。另有较小 live 303,148 states 与独立 shadow 11,897 states 的完成记录。原 JVM 正常退出，不再运行。wall time 包含为低争用串行验收进行的 SIGSTOP/SIGCONT，未重启搜索。
- **N10 属性门已完成：** 在综合源 `f7f0615a36686ccfde1716a68fee9fd97bb09e15` 上，两组各 10,000 次、seed 51007、max/minWorkers 1 均 exit 0；日志首尾 HEAD、两测试/store/builder/lockfile SHA256 一致，tracked tree clean。CLI 类型检查与 15 个严格 classifier mock unit 也通过。精确 `publish_target` 与额外能力字段负对照已覆盖。
- **N10 变异门已完成：** 19 个源码变异由指定 unit/integration suites 杀死；两个早期 survivor 的后续修复与最终聚合单列。19 个最终日志均复核为真实断言失败，无 timeout/signal 诊断。14 个 TLA guard 配置均有反例；不声称属性套件杀死这 19 个源码变异。
- **独立补强：** `9db4ad02` 的正向 `extra_repair` runner 例通过，同例在移除 `acknowledgeAdvance` 后产生真实断言失败。`c7be0ba4` 是 5-G 测试专用 pre-launch hook，40 个纯 node fake tests 通过；它不替换真实 fence，不能代替 driver 的实际 journal/remote 断言。
- **评审与综合状态：** 主会话报告 GLM 对 `87375400` 复审 PASS、无新增 P1/P2。N9 新 PR #422、N13a 新 PR #421 已开；人负责合并。driver 两项小修复已于 `b5133e53` 完成；综合分支已合入最新 N9/N13a/driver 与本地验证证据，最终全仓检查与开 PR 由主会话推进。当前 main 位置以主会话最新观测为准，不能用本分支记录代替。
- **证据位置：** `docs/reports/bridge-phase5-verification/README.md`、`model-checks.json`、`final-property-runs.json`、`final-source-checks.json`、`source-mutants.json`、`mutation-log-audit.json` 与 `review-triage.md`。模型 raw fingerprint estimates 按原文保留；不声称绝对数学保证。真实 5-G Codex/平台归属、ruleset 与 timeline 全场景仍属于后续沙箱门，不能从这些本地结果推定通过。

## 图（早期快照；最新状态以上方与综合报告为准）

- **比较快照：** candidate `78abb868`，原始 main 基线 `b7815b6c`。只读远端复查显示 #417 已以 `a9b1a605` 合入 main；这不意味着 candidate 或其他 PR 已合并。
- **已合并：** N1–N8、N12；D7 #412、D9 #414、停止扫描服务 #416、历史 TLA #413、反馈定位 #417。
- **开放 PR：** #418 head `2da03590` 修复了取消夹具的权限撤销顺序，新 CI 待定；#419 head `5b5b70c4` 的普通检查与矩阵全绿（付费 smoke 按配置跳过）；#420 head `5cd15888` 矩阵全绿，主 `check` 仍运行。开放与 CI 通过均不等于已合入 main。
- **N9 已本地实现：** bounded 回执恢复、启动恢复屏障、生产 App A/W13 装配、pending check scheduler、App B token 后栅栏、签名 grant 的基线意图与 exact commit-range ledger。`assertLiveBridgeAcceptance` 仍拒绝正常 live 启动，不能写成已生产启用。GLM-5.3 最终 delta 的四项修复已获认可；条件 P2 由 `d8964643`（N9 分支对应 `c486bd69`）改为 invocation-scoped recovery cancellation，并已通过 GLM-5.3 复审。用户指定 Reviewer 已暂停，尚无其正式 CR；GLM 复审不替代正式 CR 或批准。
- **N10：** 已有定向故障/真实 owner 接管、19 个源变异和两组 10k properties 的通过记录；phase5 报告现已归档历史失败、严格 mutation 日志复核与 property provenance；新增 `87375400` classifier/F5 加强改变最终测试源，最终 head/source-hash 绑定的两组 10k 已在上方记录。两个 broad TLC 后续均已完成，精确结果见上方最新验收；此处早期暂停状态不再适用。历史 #413 不证明本轮 Phase 5 模型已穷举完成。
- **当前全仓验证：** 第三轮按 workspace 串行，仍在运行；没有最终 pass。TLC 暂停以减少争用。
- **N11：** `scripts/smoke-bridge-revision-sandbox.mjs` 已提交。真实 Docker 已运行，App/Codex/Docker/规则集 preflight 通过；实际 `--execute` 等用户批准，未声称 5-G 通过。
- **N13：** 用户提供共享云电脑与 gh 工作流是一条操作路径，不能替代 App C/D 迁移、身份读回和 U-1…U-11 能力证据。
- **模型分工：** 代码与测试全部 `gpt-6.1-sol`；GLM-5.3 无写工具只读评阅。确定性检查由命令结果决定。

## 产物与剩余 PR 拆分

本节保留 N9/N10 的历史提交拆分记录；当前交付采用上方五个 main-base PR。所有 PR 必须以 main 为 base，不以其他 feature branch 为目标。N9 依赖已由 #422 合入；历史 `codex/bridge-phase5-acceptance` 曾纳入 N9 作为本地 review 输入，这不是当前 PR base 指令。不得把整个 final candidate 或已撤销 skill 提交重新导入。

### N9 runtime：按以下顺序保留原子提交

| 顺序 | 源提交 | candidate 中对应提交 | 内容 |
|---|---|---|---|
| 1 | `4da09d92` | 同左 | 回执恢复、K1–K6、runner 与 core 查询 |
| 2 | `ba3cc487` | 同左 | 启动屏障、receipt adapters、可注入装配与 RPC 生命周期 |
| 3 | `57314dc2` | `ff96ce8f` | pending check 调度、闭链本地结算、exact child/head 绑定 |
| 4 | `85f85119` | `cc915f4b` | 生产 factory、真实 fenced adapters、`bridge-production` 构建入口 |
| 5 | `c85598c2` | `200c3070` | 只在明确目标 ref 拒绝时判 push failed |
| 6 | `2afd66b5` | `bb4fe831` | 安全诊断与同步重入先登记 |
| 7 | `bcd20732` | `1c6e5091` | 签名基线意图与 exact publication ledger |
| 8 | `8bcba635` | `5af50ed2` | token 后复查、读取取消与生产审阅修复 |
| 9 | `cbb6b7e5` | `7a12db28` | deferred receipt 审计、启动/观测保护与独立审阅修复 |
| 10 | `d8964643` | N9 `c486bd69` | recovery 取消仅属于当前 invocation，不毒化后续读取；GLM-5.3 复审通过 |

**历史依赖（现已合并）：** #418、#419、#417；#418/#419/#420 已进入 main `9e2eaf9c`。#420 不提供 runtime API，属于全仓门的夹具前置修复，应先完成以减少无关 CI 噪声。`4da09d92`、`ba3cc487` 不是单独可从旧 main 编译的“无依赖”提交：它们使用 #418 的 publication port 与 #419 的 live/read-limiter 服务。

**导出清单：** core 仅扩展已公开 `RevisionChainStore` 的方法；保持 `packages/core/src/index.ts` 的现有显式导出边界。CLI 新模块为 `contained-mission-bridge-{assembly,receipt-adapter,production,ledger}.ts` 与 `contained-mission-revision-check-retry.ts`；构建入口新增 `bridge-production`（`packages/cli/tsup.config.ts`），供隔离沙箱导入。同步其邻接测试、RPC/runner/ports/grant 的改动与各自 changeset；不得从深层跨包路径补导出，不引入 CLI entry 的 eager import。

### N10 tests/models/harness：候选提交顺序

| 顺序 | 提交 | 内容 |
|---|---|---|
| 1 | `934c034e` | 真实 5-G driver、离线 guard/timeline tests、使用说明 |
| 2 | `34af1e10` | properties、源变异 runner、CLI fast-check devDependency 与 lockfile |
| 3 | `1ae47396` | 基线意图遗漏变异；依赖 N9 exact ledger |
| 4 | `075874c1` | handled shutdown 恢复 mutation targets |
| 5 | `1d99f7a7` | 真实 owner takeover 发布栅栏回归 |
| 6 | `79efdaf8` | Phase 5 TLA、bounded cfg、TLC runner 和模型说明 |
| 7 | `b8c3d453` | readback/rejection 回归与范围属性修正 |
| 8 | `15bf8d9b`（原 `b9baca64`） | graph 轮询绑定真实 60s 请求期限；只改测试 |
| 9 | `78abb868` | 属性通过 intent binding 找范围，修复过时的 seq/head 假设 |
| 10 | `87375400` | mutation classifier 排除基础设施失败、15 个 mock units、精确 target property 与 provenance |

**已关闭的 Merge-after：** #421（N13a）、#422（N9）均已由用户合并 main `d89cd4a5`。N10 的源码变异目标、基线属性与真实 driver 均依赖 N9，不能只提前导入 tests 然后跳过失败。graph deadline fix 只有一个测试文件、无 N9 API 依赖；如需先稳定 N9 的全仓门，可把该提交另开独立小 PR 提前合并，再从 N10 清单去掉，避免重复提交。该选择不是放宽生产超时。

**N10 导出清单：** 不新增生产 public export；新增 `scripts/lib/bridge-mutation-result.mjs` 与 `scripts/verify-bridge-phase5-mutations.test.mjs`，phase5 evidence/report 归档位于 `docs/reports/bridge-phase5-verification/`；graph 三文档、N9/N10 preparation 报告是明确的元数据范围。CLI package 与 `pnpm-lock.yaml` 必须成对纳入 fast-check。脚本为 `verify-bridge-phase5-{mutations,tlc}.mjs`、`smoke-bridge-revision-sandbox{,.test}.mjs`；模型为 `bridge.tla`、`bridge-bounded.cfg` 和 README。必须带最终属性修正，不能停在历史绿色快照。

**明确排除：** #417 的反馈定位、#418 手动 check、#419 观测、#420 loop 夹具分别由其原 PR 落地，不重复 cherry-pick。`be180ae6`、`a57f04e7`、`76ba33fd` 是新增/修改/撤销 `.agents/skills/verify-osstack/SKILL.md` 的净零序列，三者均不进入 N9/N10；保留既有 Cursor verification skill，不复制为 `.agents`。本轮只提交文档，未创建远端 PR 或 push，也未修改 final candidate。

### 精确路径并集（仅用于核对，不是整文件覆盖指令）

以下由上表固定源提交的 `git show --format= --name-only` 生成。N9/N10 共享 publication/bridge 测试文件时，只导入该节点的 commit delta；把 candidate 的整文件覆盖到 N9 会提前带入 N10。

N9：

```text
.changeset/bridge-check-retry.md
.changeset/bridge-exact-publication-ledger.md
.changeset/bridge-live-lifecycle-assembly.md
.changeset/bridge-production-factory.md
.changeset/bridge-production-review-fixes.md
.changeset/bridge-push-rejection-proof.md
.changeset/bridge-receipt-recovery-complete.md
.changeset/bridge-recovery-cancellation-scope.md
.changeset/bridge-recovery-independent-review-fixes.md
docs/reports/bridge-production-review.md
docs/reports/bridge-receipt-independent-review.md
packages/cli/src/contained-mission-bridge-assembly.ts
packages/cli/src/contained-mission-bridge-ledger.test.ts
packages/cli/src/contained-mission-bridge-ledger.ts
packages/cli/src/contained-mission-bridge-live.test.ts
packages/cli/src/contained-mission-bridge-live.ts
packages/cli/src/contained-mission-bridge-process.test.ts
packages/cli/src/contained-mission-bridge-production.test.ts
packages/cli/src/contained-mission-bridge-production.ts
packages/cli/src/contained-mission-bridge-reader.ts
packages/cli/src/contained-mission-bridge-receipt-adapter.test.ts
packages/cli/src/contained-mission-bridge-receipt-adapter.ts
packages/cli/src/contained-mission-bridge-stopped-scan.ts
packages/cli/src/contained-mission-bridge.test.ts
packages/cli/src/contained-mission-bridge.ts
packages/cli/src/contained-mission-grant.test.ts
packages/cli/src/contained-mission-grant.ts
packages/cli/src/contained-mission-ports.test.ts
packages/cli/src/contained-mission-ports.ts
packages/cli/src/contained-mission-revision-check-retry.ts
packages/cli/src/contained-mission-revision-crash.fixture.ts
packages/cli/src/contained-mission-revision-publication.test.ts
packages/cli/src/contained-mission-revision-publication.ts
packages/cli/src/contained-mission-revision.runner.test.ts
packages/cli/src/contained-mission-rpc.ts
packages/cli/src/contained-mission-runner.ts
packages/cli/src/contained-mission-service-wiring.test.ts
packages/cli/tsup.config.ts
packages/core/src/state/engineering-revision-chain-store.test.ts
packages/core/src/state/engineering-revision-chain-store.ts
```

N10：

```text
.changeset/bridge-phase5-verification.md
docs/design/specs/README.md
docs/design/specs/bridge-bounded.cfg
docs/design/specs/bridge.tla
docs/reports/2026-11-07-bridge-revision-sandbox-driver.md
packages/cli/package.json
packages/cli/src/contained-mission-bridge.test.ts
packages/cli/src/contained-mission-revision-publication.test.ts
packages/cli/src/contained-mission-revision.spec-property.test.ts
packages/cli/src/graph-delegation.integration.test.ts
packages/core/src/bridge/revision-chain.property.test.ts
pnpm-lock.yaml
scripts/lib/bridge-mutation-result.mjs
scripts/smoke-bridge-revision-sandbox.mjs
scripts/smoke-bridge-revision-sandbox.test.mjs
scripts/verify-bridge-phase5-mutations.mjs
scripts/verify-bridge-phase5-mutations.test.mjs
scripts/verify-bridge-phase5-tlc.mjs
```

### Test-merge 风险

1. publication/runner 测试同时被 #418、N9、N10 改动；按语义保留共享投递、闭链和所有新增故障测试，不能整文件取某一侧。
2. assembly/RPC/ports/service-wiring 必须保留 recovery barrier → exact ledger → timers 的顺序与 stop/cancel 处理；`OSSTACK_BRIDGE=0|shadow` 的无写入性质和 acceptance lock 不得被冲突解决移除。
3. #419 的 shared read limiter 与 N9 的取消/ledger hooks 共改 live/stopped/reader；条件 P2 核实结果必须进入对应 runtime delta 与回归，不能以 GLM 认可其他修复代替。
4. `RevisionChainStore` 被回执查询、pending checks 和 baseline grant 同时扩展；防止漏掉 owner fence、exact push/child/head 绑定或闭链证据结算。
5. mutation runner 会修改被测源码；仅在独立可丢弃 checkout 串行运行，记录前后 status。不要与全仓测试、TLC 或别的 agent 共用 checkout。handled signal 的恢复不等于 SIGKILL 后也能自动恢复。
6. 每次 base/head 变化后重建合并结果，保存完整 SHA。已有 PR 的绿 CI 和 candidate 的旧 evidence 不能直接作为新 test-merge 的 pass。

## 失败与重试记录（失败也记，便于对比）

| 节点 | 尝试 | 结果 | 处理 |
|---|---|---|---|
| P-13 | 真实运行 1、2 | 分类器把 GitHub 的 “Bypassed rule violations” 当成拒绝 | 修分类器并加测试；第 3 次通过 |
| TLA+ | 不加约束的运行 | 2 100 万 / 1 500 万状态仍未结束 | 加 `FocusPublish` 约束，13 秒找到反例 |
| W13-B | Linux CI 第 1 次 | 替换标记测试在 Linux 复用 inode；T7 依赖 macOS `lsof` | 保持旧 inode 打开；T7 只在 macOS 跑 |
| W13-B | Linux CI 第 2 次 | `graph-recovery-crash` 测试读到未写完的 JSON | 与本 PR 无关，重跑通过；测试本身的竞态未修 |
| #391 + #393 | 合并后的 `main` | 两条 grant-store 测试失败 | 在 #394 对齐测试（6b58ba7b） |
| #383 | CI 第 1 次 | 文档链接指向未合并文件 | 改为路径加 PR 号 |
| D8 | Codex 沙箱内门禁 | 无网络，`pnpm install` 失败 | 主会话在沙箱外重跑全部门禁 |
| D8 / 5-C | 构建 | 旧 `tsbuildinfo` 让 protocol 不生成 `index.d.ts` | 删除 `*.tsbuildinfo` 与 protocol `dist` 后重建 |
| 5-C | CLI 全量（负载高） | 4 条测试 5 秒超时，每次不同 | `--testTimeout=30000` 通过；#407 把默认值提到 20 秒 |
| 5-C | ZCode 第 2 轮 | `project_token_timeout` | 重试一次通过 |
| 5-C | ZCode 第 2 轮 P2 | 称 GitHub compare 新到旧排序 | 用 8 个提交实测为旧到新，推翻 |
| T17 | Codex 沙箱 | 不能绑定 localhost，测试跳过 | 主会话在沙箱外运行，34 项通过 |
| TLA+ | 穷举 TLC 前两次 | zsh 不拆分 `$J`（`timeout` 找不到命令）；PATH 缺 `timeout` | 改用 bash 脚本与数组 |
| TLA+ | 穷举第 1、2 次 | `PendingBaseSafety`、`WriteAheadIntent` 反例 | 均为模型错误，已修；第 2 个成为 5-E 实现规则 |
| D9 | 第 1 轮后 CLI | 三条 5-B runner 测试失败（R2 让链停在 `awaiting_decision`） | 第 2 轮在 runner 入口接 `acknowledgeAdvance` |
| P3 跟进 | graph 恢复测试的 90 秒轮询 | 原本已有 120 秒超时，问题不存在 | 丢弃改动 |
| 本轮全量 | `pnpm test` | loop 两个进程夹具清理超时，单独复现仍失败 | 未改无关 loop；清理本次夹具，单跑 CLI 全量 |
| check 重试 | GLM 首轮审阅 | 并发重试重复结算同一 pending 意图 | 同端口合并投递，注册早于同步 sender；成功、失败、关闭与重入回归 |
| live 周期 | 人工与 GLM 审阅 | 旧关闭原因掩盖取消义务；遗漏 abandon/takeover | 优先关闭事件原因，补取消原因和重启回归 |
| 本轮文档门 | 第一次命令 | 测试文件过滤路径错误，未找到测试 | 改为 `src/knowledge-hygiene/osstack-config.test.ts` 后通过 |
| 最终集成全仓第 1 轮 | CLI 3931 pass / 1 fail / 5 skip | graph-delegation 的 20s polling 早于有效请求的 60s deadline，DeepSeek 在 22.376s 仍 running | `b9baca64`（candidate `15bf8d9b`）以 admission 时间绑定 deadline；旧 20s mutation 控制失败，8 项定向与 typecheck 通过 |
| 最终集成全仓第 2 轮 | 高并行 | loop `candidate-policy.test.ts` 命中既有 5s timeout | 降低争用后单 worker 39 项通过；不改全局 timeout，不等于全仓通过 |
| 最终集成全仓第 3 轮 | workspace 串行 | 正在运行 | 保持 pending；暂停 TLC，保存其 checkpoint |
| #418 CI | 原 head 54c62208 | 撤销 execute 后 await status，让 sibling 在取消意图持久化前观察撤销；可合法保留 cancel_pending | head `2da03590` 把 fresh status 移到 revoke 前，revoke/cancel 相邻；新 CI 待定。独立 250ms paired 控制分别得到 unknown/cancel_pending 与 failed/cancelled，未改生产状态机 |

## 决定

- 2026-11-07：采用门控节点图推进剩余工作（graph.md §7）。
- 已由用户决定：迁移号 52/53/54/55；阶段 5 默认值；授权用主机签名；W13 恢复不杀进程；P-13 只在沙箱；`OSSTACK_BRIDGE=0` 也停止 App A（#401）；阶段 5 补充决定 R1–R5 均为 (a)（#405）。
- 2026-11-07：最新分工为全部代码与测试由 `gpt-6.1-sol` 实现，GLM-5.3 无写工具只读评阅；旧 Opus/`gpt-6-sol` 配置已被取代。

## 待定

- App E 设计 §8 其余决定；阶段 6 规格 §13 八项；W13 设计 §10 其余决定。
- 确认 App A、C、D 的 bot 用户 id。
- 给 `listStoppedLive` 加部分索引需要新迁移（#412 延后）。

## 下一步

1. 保留第四轮 GLM SCOPED PASS 的输入 hash、静态范围和限制；按当前报告核对交付 diff。不得把静态一致性评阅升级为真实性或完整项目验收。
2. #425 已合并；等待 #426 新 head CI，并按 #426 → #427 → #428 → #429 的依赖顺序准备人审。所有 PR 的 base 都保持 main；每次 base/head 改变后重新核对 diff、受影响检查和 exact-head CI。不得把 draft、绿 CI 或沙箱 PASS 写成已合并。
3. 保留已通过的 TLC、两组 10k 属性和 source/model mutant 来源绑定；源变化或新失败需要时才追加受影响门，不重跑刷绿。
4. 保留第四轮原报告、不可变 snapshot、完整只读 timeline 与 T2/revocation 的两个待决状态；无第五轮授权，不再运行真实 driver 或 probe。
5. App C/D 外部能力、Watcher 失败到本地修复接入、主仓库规则与连续五条生产链分别补证；Reviewer 保持暂停/排除，human main gate 不变，生产 CLOSED。
