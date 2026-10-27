# Firstmate × pstack 联合项目推进规则

本会话是唯一项目与 PR 主入口。OSStack 保存任务进度、阻塞与证据；本会话负责解释依赖、分配子代理、核验结果和管理 PR。用户只需处理已经整理好的审批合并批次，以及确实需要其决定的范围或权限问题。用户已明确授权主入口修改 PR 的目标分支（retarget base，不直接推送 main）、准备和提交 PR、转 Ready、分配子代理与执行验证；审批合并仍由用户负责。

本规则依据 `work-packages.json`、`execution-gates.json`、`acceptance-cases.json`、当前执行账本和 Firstmate 交接记录。它不改变冻结设计的验收门槛，也不把已合并 PR 自动等同于完成整个里程碑。

## 1. 一个入口、三个执行槽

| 角色 | 本批工作 | 后续滚动分配 | 写入边界 |
|---|---|---|---|
| 子代理 A：来源/行为实现 | #282 行为评估器审计修复的独立对抗验证 | J02b 来源采用与分型注册 | 自己的隔离 worktree、明确文件清单 |
| 子代理 B：Session/恢复实现 | #278 已合并后的账本验证与证据完整性检查 | J11/J12 受限切片的独立验证 | 自己的隔离 worktree；状态/schema 共享路径单一 owner |
| 子代理 C：独立验证 | #279 正式 main 适配、终态故障回归与审计 | J03 driver 可另开实施任务；此时原作者之外的人承担该项验收判定 | 默认只读冻结候选；测试脚本与报告写独立 scratch |
| 本会话：集成负责人 | main/PR 核对、依赖和写路径分配、Sonnet 审计、账本、Ready 批次 | 接收结果，解冲突，批准进入下一执行窗口 | 独占联合账本、PR 元数据及跨切片集成 |

最多 3 个并行子任务，每个子代理最多 1 个在制任务。某个任务等待 CI 时可释放槽位处理独立工作，但保留候选 SHA 和责任人。共享协议、schema、daemon 同一文件的改动进入 owner 队列；主入口安排串行整合。默认同时只跑一套全仓重回归，其余槽位跑有价值的定向测试，避免资源争抢制造超时噪声。

每次派发必须写明：工作项/卡片、输入 main SHA 和前置候选 SHA、允许写入路径、交付/验收范围、禁止操作、证据目录。子代理不得自行修改其他分支、Ready 状态、联合账本或合并 PR。主入口负责最终发布。

## 2. 三张看板保持同一事实

| OSStack 看板 | 卡片 | 联合归属 |
|---|---|---|
| `joint-firstmate-pstack` | J01 `card_6d5d3d02`；J02 `card_a502fa36`；J03 `card_7d169d5f`；J11 `card_79cdb3e7`；J12 `card_e342e365` | 共同职责、验收与跨项目依赖 |
| `firstmate-upgrade-roadmap` | R02 `card_9ccb91b2`；R03 `card_2ff6f711`；R04 `card_c96c79e2` | #276 + #282；J02b 的来源/行为映射子范围 |
| `session-pilot-debt` | cleanup `card_4e8147d9`；terminal fence `card_d1a582eb`；DEBT02 `card_f251dadf` | #278；#279；J11/J12 与持久恢复义务 |

三张板上的对应项使用同一批次 ID、PR 链接和证据入口，避免重复算完成。需补充其他卡片时先查询真实 card ID，不推测或创建重复卡。以上映射不是对当前状态的断言，执行前读取最新板快照。

使用已经交接的安装版 OSStack 与明确的管理 home/socket，通过 `kanban.board`、`kanban.comment`、`kanban.move` 更新；不操作默认 `~/.osstack`，不直接改 DB，不用开发 checkout 打开管理 DB。板卡正文中的依赖只是说明，依赖执行由本会话核对。

状态采用真实支持的 `todo / ready / running / blocked / done`：待执行任务用 ready，领取后 running；候选交付后若仅等用户审批合并则 blocked 并写明原因。GitHub Ready 与板卡 ready 不混为一谈。`done` 仅用于该卡声明范围实际完成，整项 J02/J11/J12 不能因其中一个 PR 合并就完成。

每次评论/版本化账本最少记录：任务和负责人、前置项、main SHA、候选 code SHA、PR head SHA、命令/结果/退出码、审计模型与结论、原始证据及哈希、未覆盖范围、下一步。代码改动使原代码证据过期；仅文档提交要另记 head SHA 并核对产品 diff 未变，远端 CI 仍按当前 head 读取。历史失败与原始审计保留，处置说明另写。

## 3. 每批的执行闭环

1. 主入口刷新 origin/main、前置 PR 的真实 merge commit 和检查状态；读取三板，核对上次候选是否漂移。
2. 分配互不冲突的隔离任务。独立验收用例的预期、判定者与摘要在候选/评估结果出现前冻结；不能把事后增加的普通回归冒充符合设计的独立 oracle。
3. 子代理实现并做必要的定向测试，提交候选 SHA。主入口统一做组合核验、全仓必要检查和 Claude CLI `claude-sonnet-5-5` 审计；确认的问题回到 owner 修复，冻结新的候选并重验受影响范围。
4. 下游可在显式记录的隔离组合候选上提前开发、运行测试。其证据标为 provisional，不能直接继承为最新 main 的通过证据。前置合并后必须 retarget main，复核真实差异、契约/迁移谱系与组合行为，重跑适用验证并更新审计绑定。
5. 主入口统一更新 PR 描述、原始审计及账本。满足候选条件后转 GitHub Ready；CI 尚未通过的候选只报告“Ready，检查等待中”，不放进“可审批合并”批次。
6. 审批批次只含：PR 链接、建议顺序/是否独立、代码和证据摘要、当前 CI/mergeability、未覆盖能力。推送包含账本的文档提交后，主入口再次读取 PR head，核对相对固定 code SHA 仅有已审核的文档/changeset 差异（可执行 Python 文档检查另有管理审计），并读取新 head 的 CI；离线账本不可能自引用包含自身的提交。用户用 `gilberthello` 审批合并。模型审计不替代 GitHub approval；当前没有自动合并授权。
7. 用户确认合并后，主入口查证 merge commit，更新卡片和版本化账本，启动已获授权且依赖满足的下一批。CI/测试/审计失败由主入口追踪修复；只有权限、资源、产品取舍等确实无法自行解决的阻塞才请求用户介入。

普通进展集中在批次更新；出现 Ready 批次、需要用户决策的阻塞或重大失败才通知用户。用户不用逐个提醒重新定向、重跑或追问测试。已创建 Codex 本会话 heartbeat「OSStack 联合开发续办」（automation ID：`osstack`），每 30 分钟检查 PR/main 和账本变化；无变化保持安静。它负责唤醒主入口，OSStack 负责进度和证据，两者不是 OSStack 自治运行时资格。唤醒可用性仍取决于桌面宿主和工具连接；不可用时记录阻塞，不能假装持续执行。

## 4. 下一批队列与准确门槛

| 工作 | 可以现在做什么 | 可交付/验收门槛 |
|---|---|---|
| #282 R02 审计修复 | #276 已合并旧候选；#282 在最新 main 上补齐已确认的预算、缓存和严格输入问题 | 候选代码绑定测试与 Sonnet 审计；最新 head 必需 CI、真实 main diff；不宣称 J02b 的采用依赖闭包已完成 |
| #278 cleanup（已合并） | 保留已合并候选的测试、审计和 merge commit；作为 #279 前置 | 历史证据保留原测试 base，不改写成当前 main 的验证；不宣称 terminal fence 或跨进程恢复已完成 |
| #279 terminal fence | #278 已合并，现已改为 main 并正式重验 | 确认无成功 terminal 的 EOF 不释放未知 producer 的 admission；重放不再次执行；重新运行停止证明和正常完成路径。#279 不解决 DEBT02 |
| J02b | A 槽可核对 J01 + 已合并 J02a/#281 的实际契约，准备采用、分型注册和 R03/R04 映射切片 | 正式 `J02.scoped` 依赖 `J01.scoped`，不能以 #273 合并代替整体 gate。验证来源认证/接收端校验、实际采用依赖闭包、inspection 到可采用快照/SourcePin 的映射和旧 manifest 兼容。JA03 验证源/采用依赖改变与未采用插件改变的不同影响；JA04 拒绝越界/未知字段且不执行 hook。R02 作为实际消费依赖时另显式加入其 SHA，不凭设计自动假定已接线 |
| J03 | 可在独立 scratch 做 session-answer-receipt driver；按 JP-03a/JP-03b 分拆 | `J03.scoped` 依赖 `J01.scoped`。JA05 走真实 host 的 doctor→drive answer→observe→cleanup 并读原 receipt；JA06 dry-run 对 DB/文件/进程无副作用；JA44 同 key 同输入重放、不同输入拒绝、资源只归本 run。使用 Session 新语义的最终候选必须覆盖 #278/#279 合并后的真实路径。J03 driver 通过不等于 live provider 资格 |
| J12 | B 槽在 #279 收口后优先准备 bootstrap/preflight 的受限实现；schema owner 独占共享状态文件 | #274 只是 J11 规格。先满足 `J11.scoped`，冻结实际 base/schema/DDL/构建谱系并通过 `J12.bootstrap_preflight`；之后才有 `J12.scoped`。JA52 要真实旧 hold、DDL 前/中/提交后退出、白名单单步迁移、普通 openDb 迁移前拒绝，原 hold 不变；JA51/JA21 验证权限、owner/generation、精确 invocation/证明、原子裁决与后态，不重发原 action。完整 `J12.full_recovery` 还依赖 `J17.recovery`，不能因局部恢复测试通过而宣称完整 broker/home 恢复 |

每个新切片启动前核对设计中 O03/O06 等未决项的实际关闭证据；冻结文件的 historical planned 标记与当前执行状态分开记录，不能默默擦掉未决项。迁移编号需按最新 main 的真实谱系重新确认，J11 候选编号不是生产预留。

## 5. 能力边界

这里使用的是“本会话驱动 + OSStack 管理进度与证据 + 子代理执行”的工作方式。没有调用尚未实现的 `goal_dispatch`，也没有由 OSStack 自动恢复、接管或重新启动 Codex 会话。数据库可保留任务/证据，不等于执行器拥有自动恢复资格。模型审计、真实回归、GitHub CI 与用户批准分别记录各自证明范围。


## 当前批次观察（2026-10-27 UTC）

用户已合并 #278 和 #276。#276 实际合入旧候选 `5e86a778`，本轮审计修复未进入该合并；补充 PR #282 承接这些修复，并基于 `28d116f3` 重新验证。#279 已进入正式收口，无需用户再发启动指令。J01/J11 阶段门槛缺口见 [独立核验](../../implementation/joint-behavior-retarget/subagent-terminal/next-gates.md)；完整 SHA、观察窗口、当时的 PR/CI 状态见 [执行账本](execution-ledger.json)。`Ready` 与 `current_head_matches` 都是该观察窗口的快照，执行前必须重新读取远端。结构契约测试不替代真实主机验收。


## 下一波派发依据

[下一波最小切片核验](../../implementation/joint-behavior-retarget/independent/next-wave-assessment.md) 读取 `28d116f3f8c15f64bebb314308adf320d8380b2b` 原始规范，列出 8 个最小任务与共享写入冲突。[独立 oracle 准备核验](../../implementation/joint-behavior-retarget/management-independent/oracle-readiness.md) 补足真实入口和反例要求。这两份报告均为派发输入，未给任何正式 gate 签发 PASS。

下一执行窗口先由主入口明确 J01 组件契约与真实集成验收的分层方案，并结合 #271 实际合并对象给 O06 写当前候选接口判断；如需修改依赖，单独形成设计修订并实际审计。随后三槽分别承担 J01 oracle/接线边界、J02b 离线采用闭包、J11 规格 oracle/J12 文件级预检，空闲槽推进 J03 隔离 driver。满足各自开工条件后才写产品候选；主入口独占中央账本，schema 只允许一个写者。

JA01 精确请求 `task local_verified`；早期预检笔记的 `implementation_verified` 重述不能改变该目标。JA02 需要允许对照和真实 adapter 调用零证据，永远拒绝的 helper 不能证明 repo fence。JA20 需要实际 broker DDL/构建生产者；DAG 无环、future-storage.sql 和合成摘要均不足以完成该验收。保留原 JA01/JA02/JA20 义务，不通过改名或压低测试范围消除缺口。


本批建议先审批 #282，再由主入口自动核对更新后的 main 并重验 #279 的合并候选，然后通知审批 #279。两项产品改动的文件范围分离，但当前证据均绑定同一 main；先合并任何一项都会改变另一项的集成基线，不能把它们描述为无需再检查的独立候选。等待合并期间继续推进不依赖该合并的预检和已授权切片。
