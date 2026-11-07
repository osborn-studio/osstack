# 执行进度

续做时先读 [graph.md](graph.md) 与本文件，从“下一步”继续。

## 图

- **比较快照：** candidate `78abb868`，原始 main 基线 `b7815b6c`。只读远端复查显示 #417 已以 `a9b1a605` 合入 main；这不意味着 candidate 或其他 PR 已合并。
- **已合并：** N1–N8、N12；D7 #412、D9 #414、停止扫描服务 #416、历史 TLA #413、反馈定位 #417。
- **开放 PR：** #418 head `2da03590` 修复了取消夹具的权限撤销顺序，新 CI 待定；#419 head `5b5b70c4` 的普通检查与矩阵全绿（付费 smoke 按配置跳过）；#420 head `5cd15888` 矩阵全绿，主 `check` 仍运行。开放与 CI 通过均不等于已合入 main。
- **N9 已本地实现：** bounded 回执恢复、启动恢复屏障、生产 App A/W13 装配、pending check scheduler、App B token 后栅栏、签名 grant 的基线意图与 exact commit-range ledger。`assertLiveBridgeAcceptance` 仍拒绝正常 live 启动，不能写成已生产启用。GLM-5.3 最终 delta 的四项修复已获认可；共享读取取消是否污染后续服务这一条件 P2 仍由 production 核实。
- **N10：** 已有定向故障/真实 owner 接管、19 个源变异和两组 10k properties 的通过记录；旧失败与后续覆盖必须在 phase5 报告中按提交绑定。两个 broad TLC 仍 pending，因资源争用暂停并保留 checkpoint。历史 #413 不证明本轮 Phase 5 模型已穷举完成。
- **当前全仓验证：** 第三轮按 workspace 串行，仍在运行；没有最终 pass。TLC 暂停以减少争用。
- **N11：** `scripts/smoke-bridge-revision-sandbox.mjs` 已提交。真实 Docker 已运行，App/Codex/Docker/规则集 preflight 通过；实际 `--execute` 等用户批准，未声称 5-G 通过。
- **N13：** 用户提供共享云电脑与 gh 工作流是一条操作路径，不能替代 App C/D 迁移、身份读回和 U-1…U-11 能力证据。
- **模型分工：** 代码与测试全部 `gpt-6.1-sol`；GLM-5.3 无写工具只读评阅。确定性检查由命令结果决定。

## 产物与剩余 PR 拆分

两个新 PR 都以 main 为 base，不把 #418/#419 的历史提交或整个集成分支合并进新分支。先等依赖合入，再从新的 main 建分支最稳妥；提前准备时，缺依赖的分支只能标 blocked，并在独立 test-merge 结果上验证，不能冒充 main-base 已独立构建通过。

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

**Merge-after：** #418、#419；#417 已满足。#420 不提供 runtime API，属于全仓门的夹具前置修复，应先完成以减少无关 CI 噪声。`4da09d92`、`ba3cc487` 不是单独可从旧 main 编译的“无依赖”提交：它们使用 #418 的 publication port 与 #419 的 live/read-limiter 服务。

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

**Merge-after：** N9。N10 的源码变异目标、基线属性与真实 driver 均依赖 N9，不能只提前导入 tests 然后跳过失败。graph deadline fix 只有一个测试文件、无 N9 API 依赖；如需先稳定 N9 的全仓门，可把该提交另开独立小 PR 提前合并，再从 N10 清单去掉，避免重复提交。该选择不是放宽生产超时。

**N10 导出清单：** 不新增生产 public export；CLI package 与 `pnpm-lock.yaml` 必须成对纳入 fast-check。脚本为 `verify-bridge-phase5-{mutations,tlc}.mjs`、`smoke-bridge-revision-sandbox{,.test}.mjs`；模型为 `bridge.tla`、`bridge-bounded.cfg` 和 README。必须带最终属性修正，不能停在历史绿色快照。

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
scripts/smoke-bridge-revision-sandbox.mjs
scripts/smoke-bridge-revision-sandbox.test.mjs
scripts/verify-bridge-phase5-mutations.mjs
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

1. 保存第三轮 workspace 串行全仓结果；完成前保持 pending。跟踪 #418 head `2da03590`、#419、#420 的当前 CI 与最终 main SHA。
2. 按上述 N9 清单建独立 main-base PR，依赖 #418/#419；保持生产 acceptance lock。完成 shared-read 取消条件 P2 的核实。
3. 按 N10 清单建独立 main-base PR；归档最终源码绑定的 properties/mutants 记录。资源允许且串行门完成后，再恢复两个 broad TLC 的 checkpoint，不能以仍有 queue 的运行声称穷举通过。
4. N10 门满足且用户批准后，才执行 5-G driver 的 `--execute`。Docker 已不是缺失条件；真实运行未发生。
5. App C/D 身份迁移、主仓库规则读回和连续五条链验收仍分别属于 N13/N14/N15，不由共享云电脑 gh 流程或本地 preflight 代替。
