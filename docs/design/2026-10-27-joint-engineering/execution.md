# 联合执行与交接

目标不变：吸收 Firstmate 的持续负责、监督和恢复能力，以及 pstack 的调查、设计、验证与工程方法，形成 OSStack 的统一能力。不能以完成基础设施代替两条端到端旅程。

## 单一负责人

唯一主入口为本会话 `01a178ed-616a-7bb1-8d20-13f4c1019245`。Firstmate 主会话完成现有批次后交接，不再自行领取新包。A/B 执行会话的已提交成果由其集成候选保全。历史审计输入和规划表保持冻结；当前状态只在执行账本及对应 OSStack 卡片维护。

Git/GitHub 保存提交、CI、评审和合并事实。OSStack 保存执行、阻塞与证据引用。执行账本是可随仓库恢复的检查点，不是第二套运行时调度器。若看板和 GitHub 冲突，先核验候选 SHA 并纠正投影，不能凭卡片颜色宣告完成。

## 每批推进规则

1. 获取最新 main、前置 PR 的准确 head/base、评审及 CI；保存观察时间。
2. 检查功能依赖、共享文件顺序、开放未知与实际支持范围。
3. 一次推进一个有限实现切片；使用独立 worktree。
4. 在相同候选上完成测试、构建、类型检查和相关场景；运行 Claude CLI Sonnet 5.5 审计，保存完整输入输出及逐项处置。
5. 开小 PR；待合并前置采用明确的 stacked base 与 Draft。前置合并后重定向并重新验证。
6. 将 PR、提交、证据、未验证项、下一步写回 OSStack 与本账本。完成一个切片不等于完成整个 Jxx 或来源能力。

OSStack 管理端使用已安装、固定版本。测试端使用独立 OSSTACK_HOME。当前只承诺有证据的进度管理，不承诺自动恢复本 Codex 桌面会话或自动完成整个项目。

## 当前切片与后续依赖

J02a 初次提交 [PR #281](https://github.com/osborn-studio/osstack/pull/281)：只读、离线、固定 Git 对象的来源检查器。依赖 J01 #273 固定候选，不修改方法授权、恢复入口或主控。

J02b 留给分型注册、行为/方法映射、实际采用依赖闭包和旧 manifest 接线；J02a 不提前把整个 J02 或 R03/R04 标为完成。J03 驱动夹具与 J12 真实恢复仍保留其独立验收门槛。

J02a 必须验证：脏工作区不影响结果、精确 commit 重放一致、缺对象/摘要漂移失败、路径与大小边界拒绝、符号链接和子模块拒绝、不执行上游文件、不隐式获取网络对象。SourcePin 的 repository 是调用方已验证的来源标识，本地 Git 配置不能自行提供身份认证。

## 冻结设计与当前实现

设计基线的 48 个来源能力、69 项原任务、32 个工作包与 124 个阶段节点全部保留。当前修订的设计校验包含 69 个未来验收场景、100 个 schema 例子与 227 个来源锚点；文档结构校验不代表全部来源本轮重新抓取，也不代表产品验收。

J01 实现采用 opt-in 的 `@osstack/protocol/joint`，当前实现合同以 #273 为准；设计中的原 schema 保留供追溯。J11 是恢复 DDL 与测试规格，J12 尚待实现。候选迁移号不构成生产编号预留。

## 审计补充的交接约束

若主入口会话不可用，执行状态转为 owner_unavailable，停止新派发，由用户指定接替会话。接替者必须重读账本、当前 main 和未合并 PR；不凭失联自动取消或释放未知执行。

Firstmate 本批移交范围固定为 #275–#279，集成分支 codex/firstmate-batch1-integration，最终代码候选 20b4a81dfcffd80b4919643be362dcfcefad7cf5；之后 dd0f8d09687c6d77394771f61102c9685ec33b2c 只更新导出清单。准确 PR heads 由执行账本记录。交接完成须同时保留发送方报告和本会话接收记录。

J02a 的合同基线固定为 #273 head fad0dd45377255a2d3dfceb08fb28c1524b88ead。源码/契约变化后，旧测试结果不能自动继承。实现者为 Codex；审计者为 Claude CLI Sonnet 5.5。模型审计不能满足 GitHub 所需的独立批准，也不构成运行资格签发。

切片在未合并时只能为 candidate。只有合并提交得到对应 CI/验收证据后才记为 done；真实环境资格另行记录。J02a 推进 J09 bug-fix 方法旅程的来源可重放性，不交付整个旅程。

Source inspection 输出必须携带并摘要绑定 dependency_resolution=not_performed、repository_identity=caller_asserted 及 expected_digest_checked。本切片不导出可脱离上下文的 SourceSnapshot，不将空依赖数组当作依赖闭包完成。J02b 在闭包验证后才构造可供采用的快照。

## 操作入口与恢复检查点

当前管理实例为交接中指定的已安装 OSStack 0.22.1，安装入口指纹保存在 execution-ledger.json。使用现有管理 socket 的 kanban.board / kanban.comment / kanban.move；不要让开发 checkout 打开管理库。精确 home/socket 与重启步骤见 evidence/joint-execution/firstmate/joint-handoff.md。

联合看板名为 joint-firstmate-pstack。每个 Jxx 对应的 card_id 已记录。依赖和验收规则仍由 work-packages.json / execution-gates.json 给出，当前看板 API 不自动执行这些门槛。不能用 kanban.move(done) 代替验收。

执行账本可离线检查：python3 docs/design/2026-10-27-joint-engineering/validate-execution.py。它检查节点、依赖、PR引用、前置候选漂移、交接哈希和完成证据字段；它不会查询实时 GitHub、执行验收或恢复数据库。当前 128 项正负例测试验证这些局部防错规则；这是账本一致性检查数量，不是产品验收通过数量。

管理库位于 scratch 根内，不能当作唯一持久副本。每批结束都将联合/原看板 JSON、事件回执、提交、CI观察、测试与审计绑定提交到 Git；重要证据有压缩前后哈希。若管理库被清理，先用版本化导出重建进度记录并核对当前 GitHub；不能把恢复卡片当成恢复任何执行锁、会话或生产状态。本批使用 SQLite backup 做一致性本地备份，没有复制正在写入的单独 DB 文件来假装完整备份。

## 历史首批验收检查点（当前重验见文末）

最终产品代码 `32bd1bd287a7125fcc71c7312392ec5a3af2413b` 本地全仓库 6161 项通过、5 项跳过；构建、类型检查、lint、清单检查均成功。Sonnet 5.5 最终静态审计 PASS，无具体 P0/P1/P2，原始多轮意见及处置保留。#281 的后续提交只包含文档和证据。GitHub CI 状态单独观察，不能用本地结果代替。

pstack 完整 pstack 子目录 200 个文件及 Firstmate harness-adapters 子目录 21 个文件已按固定 commit 和预期摘要实际重放。这没有验证 Firstmate 全部能力或采用依赖闭包。

当时的下一步为处理 #272 → #273，再重定向 #274 / #281；此步骤已按下述新检查点执行。Firstmate 交接链为 #275 → #276 与 #277 → #278 → #279。J02b 在确认 J01 合同与 J02a 检查输出后，推进分型注册、R03/R04 映射及实际采用依赖闭包；保留 J03、J12 各自的依赖和验收。不得绕过尚未完成的独立评审。

#280 早期 CI 揭示历史归档日志被全局 *.log 忽略、冻结输入保留源位置相对链接的问题。已显式纳入原始日志；只对 evidence/inputs/pstack-revision2-*.md 这组冻结引用适用仓库已有的归档规则，所有当前文档仍参加完整链接审计。

## #273 main 重定向与新审计

#272、#280、#275、#277 已合入。#273 从旧叠加分支改为 main，并合入 `4924d224ab9e6e2d7f801d68faea389fedf3751e`。初始重定向补丁逐字节一致，随后新审计推动了摘要关联、恢复证明上下文、预算不可证时拒绝和 safeParse 修订。最终代码与原始 J01b 已有明确差异，不再沿用原始测试结果。

新审计与完整处置位于 `docs/implementation/joint-contracts-retarget/`。#274/J11 必须消费新的 RecoveryProofEnvelope 上下文与 verifyRecoveryProofEnvelopes；#281 必须在新合同上重验。两者旧证据均保留为 historical，不自动升级。

账本 candidate_sha/head_sha 是各 PR observed_at 时观察到的提交，不能等于包含账本的提交自身。执行前必须重新读取 GitHub。离线检查器只验证该快照内部一致性；它不联网证明 CI、安装入口或 Git 可达性。新增检查显式识别旧基线、保持节点/卡片阻塞，并保留被替代候选与历史证据。

## #274 / #281 合并共享契约后的当前检查点

已确认 #273 合入 main `69859eecfcc84af9d6eff755ed41243ca5f51f95`。#274 与 #281 均改为 main，初次重定向补丁与原分支逐字节相同，之后按新审计修订，重新验证；原证据均保留为历史。

J11 当前代码 `7ea45584ce0de01860571100beb5daed4ff83f31`：全仓 6,174 通过、5 跳过、0 失败，14 项恢复规格测试。新增证明/收据/MigrationSpec 关联、SQL 阶段/home 防御检查；重新冻结 DDL/catalog 和 Python 向量。J02a 当前代码 `26e7e02d4cdc931aa6d2b852d1b83cedc74238ef`：全仓 6,194 通过、5 跳过、0 失败，来源包 37 项测试；批量 Git 对象读取和来源标识防护经审计修订，固定上游摘要重放不变。两者的 build/typecheck/lint/inventory/schema/Python 检查通过，Sonnet 5.5 最终静态审计 PASS，无 P0/P1/P2。

#274 维护此中央账本及 J11 证据，#281 维护来源实现及其证据。Git merge-tree 检查无冲突；不宣称组合树已获得运行资格。建议 #274 → #281，合并前使用各自当前 head 的必需 CI，由 gilberthello 独立审批。Docs-only 证据提交晚于 code_sha；账本 head 是 observed_at 的真实快照，不试图引用自身未来提交。

J01 的 #272/#273 已合并，移除旧合并阻塞；整体里程碑验收仍独立记录。J11 仍为规格，J12 负责真实恢复；J02b 仍负责来源认证、接收端校验、分型注册和采用依赖闭包。Firstmate #276 / #278 / #279 留在下一批，不能把本次通过当作其已重验。

检查点校验新增 main 基线、Ready 的开放 PR/当前审计/代码与通过测试绑定，以及历史叠加前置的保留。快照由逐 PR 观察构成，非跨 GitHub/本地原子事务；记录每条 observed_at，并在刷新前后 fetch 检查 main 漂移。模型意见及处置保留，离线校验不替代实时 CI、真实身份验证或运行时资格。


## #276 / #278 重定向及并行项目管理

#274 与 #281 已合并，核验 main 为 `8fed83136611948ee068801ab5cc1fd471f90078`。J11 规格与 J02a 来源检查的旧测试基线保留为历史事实；两项整体验收都没有因合并自动完成。

#276 与 #278 改为 main，初始重定向补丁与原叠加补丁逐字节一致。#276 后续修复重复坏对象读取、未知信任/策略字段、重复坏清单解析和非法回显；#278 产品补丁无需额外修改，只补充重放查询语义。原始 Sonnet 意见、主入口处置、完整测试日志和独立子代理证据分别保存在 `docs/implementation/joint-behavior-retarget/` 与 `docs/implementation/joint-session-cleanup-retarget/`。代码 SHA 与文档 head 分开绑定。

用户已授权本会话管理整个开发过程，只负责审批合并准备好的 PR。[项目推进规则](project-operations.md) 将三个子代理槽、共享文件 owner 队列、OSStack 三板和批次审批明确连接。已配置本会话每 30 分钟续办检查，状态未变时静默；这不是尚未实现的自动 goal_dispatch。

#279 已提前在 main + #278 组合上通过 89 项定向测试，四个新增回归经撤销修复的变异验证有效；测试提交 `aaa4aa00379361a3f9f28880c007ffedf6652345` 已在正式 #279 分支继承并补充。组合证据仅为 provisional。#278 已合并，#279 已改为 main；正式全量验证及 Sonnet 审计记录独立绑定，不继承预检通过为正式资格。J02b/J03/J12 的实际阶段门槛按推进规则核验，不以 PR 合并代替里程碑完成。


### 执行期间的远端变化

刷新账本时检测到 main 从 `8fed8313` 推进到 `28d116f3`，刷新立即停止，没有把旧基线盖成新基线。#278 合并 `0f6dc137` 包含本轮审计过的清理代码和证据；#276 合并的是原始 `5e86a778`，不含本轮纠正提交。补充 PR #282 以新 main 重新测试和审计这些纠正；旧 9b13e040 的 6263 项通过仅保留为历史证据。#279 前置已合并，正式适配和验证由子代理继续，主入口统一收口。

## #282 合并后的 #279 重验

GitHub 实际合并 #282 于 `ede5aadced37ac9dc29dd21f0e307ad2c46d2976`，包含已审计的 head `f81b72eb813533357e5317871dcbc5febe004244`。此前 #276 的旧候选与 #282 的补充修复继续分别记录；不会将 #282 的证据追溯归给 #276。

#279 分支已同步到该 main，正在重验；本轮结果以随本次提交归档的实际命令为准，PR 本身仍待用户审批合并。新测试扩展了 completed 后异常/failed 与停止确认的交叉分支，保留未确认时占用、确认后释放和幂等重放约束。本轮产品证据和原始 Sonnet 5.5 意见见 [独立归档](../../implementation/joint-terminal-post282/README.md)；最新状态由执行账本的观察窗口定义，最终 PR head 的 CI 必须另查。DEBT02 跨进程恢复和联合里程碑的正式验收未因此完成。

用户另行授权独立会话参与并行开发测试；当前代理树 3 个子代理是工具容量限制。独立 J01 oracle 会话的交付由主入口接收，与下一批 gate 提案、#279 产品收口分别拥有写入边界，详见 [项目推进规则](project-operations.md)。

## #279 合并收口与下一批候选

已通过 GitHub 和 Git 对象核实 #279 于 `2026-10-27T16:12:15Z` 合并，head 为 `3a5841eb9c4673c6e2ac924520b0acaf1c749956`，merge/main 为 `d3fa7ef681efc79a5fb2dff92172ef1be0978774`。该 head 的五项必需 CI 全部成功；付费 DeepSeek smoke 跳过，不计为通过。产品 `cb76b643` 的 6293 通过、5 跳过、0 失败和实际 Sonnet 5.5 审计保持原 `ede5aadc` 基线，不改写为新 main 上重新执行过的结果。

OSStack terminal fence 卡按其限定范围关闭，DEBT02 跨进程恢复仍待完成。J01/J11 不因前置合并自动通过。新批次从上述 main 启动：N0 组件契约与主机门槛分层、JP-17a broker SQL/held-orphan 离线规格候选，以及二者的独立反例验证。分层修订必须保留原 JA01/JA02 与 legacy/release 义务；broker 候选必须有真实可执行字节和明确身份，不能用模板或候选 tuple 冒充已部署资格。

本地主工作区仍保留历史 checkout 和其他未提交工作，不能从其旧账本推断最新进度。本检查点从已合并 Git 对象创建隔离工作树，原账本及测试、审计绑定保留在历史证据中。执行状态以新版本化检查点、当前 GitHub 和三看板共同核对。


## #284 合并后的执行窗口（2026-10-28，上海时间）

已从 GitHub 与远端 Git 核实：#283 合入 `697d0b9c86009a8ee11a1d06931fb787cf600f12`，#284 合入最新 main `3192b424174e5eb977d640cc0418e67c6b1461d1`。main 的 tree `228b2a0b9ae6708bc68bb3019921198484538320` 与此前独立合成验证的最终树完全相同；历史测试仍绑定原候选 SHA，本次不将树一致性写成新测试运行。两 PR 的发布 head 五项 CI 均成功，付费语义 smoke 跳过。

批次 `joint-post284` 三个独占任务已进入 OSStack：A 补齐 JP-01c 的 JA59 跨语言与 JA70 类型/关联回归；B 验证 JA20/JA47 home 与 broker 的真实离线输入及依赖反例；C 预冻结 J02b 离线采用闭包的夹具和边界。A/B 在隔离分支交付，C 仅写 scratch。中央账本及 PR 仍由主入口单一管理，全仓测试仅一个队列。

`J01.contracts` 尚未正式通过，模型名称不能代替可信 oracle principal，测试数量不能替代预冻结与身份条件。J02b/J03 产品开工保持依赖阻断；J03 不依赖 J02。J11/J12/J17 的正式授权、文件级崩溃和旧 writer fencing 义务保留；home 48、broker 0→1 均未被本次分配为生产迁移。所有新候选继续实际 Claude CLI Sonnet 5.5 审计、修复并保留原始意见；通知审批前重新查询发布 head 的 CI。

当前合并观察、三看板快照和派发回执见 [执行账本](execution-ledger.json)；较早章节是各自观察时刻的历史记录，不构成当前 Ready 或 gate 状态。


JP-01c 回归候选 `74ec436d` 已完成首轮问题修复和实际 Sonnet 5.5 复审 PASS。完整 protocol 1,012 项通过；20 个实际源码变异被捕获。初始组合 `9e292676` 的全仓 6,884 通过、5 跳过保留原绑定，后续只改测试/oracle 的修订另有完整 protocol 复验。详见 [组件回归交付](../../implementation/joint-contract-acceptance/README.md) 与 [主入口验证](../../implementation/joint-post284-control/README.md)。这是待发布/CI核验的回归候选，不是 J01.contracts 资格。J02b 草案仍在独立准备流程内，不作为已通过产品能力发布。

## 2026-10-28：按 verification 价值优先恢复开发

用户已明确要求推进附件所列能力，恢复本批开发。当前执行入口是 [verification kit](../../implementation/verification-kit/README.md)，对应看板 `card_f2a2453a`、分支 `codex/verification-kit`。先交付真实本地验证、持久证据与四条跨宿主共用方法材料；这属于 D2a 工程工具增量，不产生 J01/J11/J03/J09 资格。身份 issue #287 继续待确认，但不是该工具增量的依赖。旧 C30/bootstrap 工件没有随本批恢复。审计和测试结论以精确候选交付证据为准，只有用户 gilberthello 审批合并。


## 2026-10-28 PR288/289 CI and host-reading follow-up

PR288 published head `10629495` is Ready after five applicable checks succeeded; the first Node20 header-download failure remains preserved, and one failed-job-only retry succeeded. User `gilberthello` approves and merges. PR289 remains Draft: inherited upgrade tests exceeded the shared 30-second budget. Candidate `4dddf67a` separates 60-second real preparation from 30-second cleanup verification, preserves all operations/assertions, and has 37 focused tests plus actual Sonnet5.5 audit PASS; full regression and new CI remain required at this snapshot. The CI slow point is not established.

[Two actual host-reading experiments](../../implementation/joint-host-effects/README.md) preserve Codex and Claude outputs, errors, input bindings and limitations. They did not execute product tests or qualify runtime/provider behavior. Documentation revisions follow the observations; their effects are not yet tested. Root retains PR/ledger ownership and the single full-regression queue.


PR288 was subsequently verified merged at `4d31c3f540672c81a6c5d65b3a2b090dc32da027` (2026-10-28T07:38:44Z). Its tree equals published `10629495`. Latest main plus PR289 `48f5a9f1` yields exactly the independently tested composition tree `827495237d56c84a49f7785eda373c1771ff0eca`: fresh install/build, 27 focused cases and real retained-evidence smoke passed. This is tree equivalence to the tested composition, not a newly executed full regression. PR289 candidate `4dddf67a` separately passed 7,138 full tests / 5 skipped; new head CI run40651082036 remains pending at this snapshot.

PR289 subsequently completed run40651082036 with five applicable CI successes (paid smoke skipped) at published head `48f5a9f1`; all three native cases passed. Root marked it Ready after exact-head/main-composition verification and updated OSStack to await `gilberthello` approval/merge. This supersedes the earlier pending snapshot without erasing the original failure.

PR289 was then verified merged by the user at `64b203c32d245d5ad9a76914253ca18cbb54a073` (2026-10-28T07:59:34Z). Its actual main tree equals the previously tested composition. OSStack marks the CLI fix slice done. Next authorized D2a task `card_25794a87` / `codex/skills-check-verification` prepares a reusable fixed skills-check driver, with separate author, black-box validation and bounded host-assisted usage tasks; all are based on that latest main.

## Named OSStack method entries — 2026-10-28

PR290 merged at `f92914e0a98bd3e5f82765fddc5a275a93637f30`. PR291 initial CI found a mixed-case mismatch. Its repaired head `6df338e8` includes that main, a confirmed Git output-drain fix, 7,144 passing package tests and actual Sonnet audit PASS; new-head CI remains separately observed. The next D2a slice implements `osstack-mode`, `osstack-help`, `setup-osstack`, and `osstack-agent`, with self-contained project exports for both hosts. The slice does not port the entire upstream catalog or activate runtime gates. Root retains central ledger/PR ownership; materials, export implementation and independent forward review have separate owners. See [batch records](../../implementation/osstack-method-entrypoints/README.md).
