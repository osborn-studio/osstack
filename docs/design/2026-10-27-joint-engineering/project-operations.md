# Firstmate × pstack 联合项目推进规则

发布：PR315 https://github.com/osborn-studio/osstack/pull/315，head08342874b1ffdbdf447f38d5221ffbb9aed8eeda，Draft/base codex/pstack-method-bridge-delivery，CI41048799532运行。312→313→314→315依序人类merge、actual-main核验/retarget/适用重验；不要合featurebase。最终publication241docs/1hygiene通过；四fresh dist与保存bytes/hash/patch一致后才恢复。原P6仍BLOCKED。

## 2026-10-30 首次原生 Loop 尝试与显式 scratch 接点

固定0.15.36材料已实际经既有 Loop/host 交给原生 Codex，card_ebb91eda、任务 pstack-first-use-node26-20261030。第一条复现命令在 Vitest scratch mkdir 遭 EPERM，零测试、零修改；原生完成回复后宿主检查 Node22通过/Node26失败，Loop escalated。两份持久收据与人工同卡回链保留；这是 assisted U1 失败观察，不是 local_verified 或 P6完成。原packet保持BLOCKED且不重跑翻绿。

新增 CodexCliAdapter 可选 writableRoots，显式传 --add-dir；仅workspace-write非空、去重前≤8、绝对现存非根目录，三调用入口支持；不由环境变量自动推权限。实例复用/构造时canonical快照不等任务隔离或OS围栏，实际CLI目录写入效果尚未证明。作者36、独立27通过，实际Sonnet5.5静态PASS_WITH_CONCERNS；完整回归与出版结果见[首用记录](../../implementation/pstack-first-use/README.md)。下一步先验证任务专用scratch在真实宿主的权限，再选真正新需求完成RED→修复→GREEN→独立最终候选→同卡证据；保持人工绑定可用，不扩维护平台/新scheduler。普通deliver默认只读及V2 reported identity前提仍不能省略。

PR312仍Ready等人类合并，313/314保持Draft等各自parent合并/main复验。314当前b161的CI41043889043五适用SUCCESS/paidSKIP，synthetic cb3b7d4c为314→313，22包7420pass7skip0fail；不是当前main或新接点CI。详[原始CI](../../implementation/pstack-method-bridge/ci-final/README.md)。当前main仍abcd9edf。Firstmate深运行禁止；4入口14方法、24PS20partial4deferred0whole、32J formalfalse均不升级。


最新发布：PR312仍Ready/main待gilberthello合并；PR313 headf6d7 CI41036945434五适用SUCCESS/paidSKIP但保持Draft/base312。新PR314 Draft/base codex/pstack-adoption-bundle-delivery，head b161223bb3d2a3574a3ce9797ae07cbcd63c3fb3，CI41043889043运行。按312→313→314人类合并、actualmain核对/retarget/适用重验，不合featurebase。P4/P5组件已交付候选；下一步P6真实模型/同卡闭环。main仍abcd9edf，禁止Firstmate深运行。

## 最新执行：固定方法接入既有调用边界（2026-10-30）

[本批实现与证据](../../implementation/pstack-method-bridge/README.md)提供单bug_fix纯编译、全新局部准备入口、完整compiled重编核验和调用前mandatory方法材料/预算/收据。编译34、宿主76、准备16定向通过；精确ac9全仓22包7420pass5skip0fail、9106tracked字节同，后off-mode入口修复单列定向/独立，不重标最终full。实际固定Git51文件复核和三角色受控adapter/六收据成立，尚非原生模型修复或local_verified。

下一轮直接一张当前真实卡走既有V2 deliver/Loop，不再扩维护平台或只加材料。显式卡/合同与收据回写可先assisted；检查必须与目标仓库现有host policy一致。原失败、协议反例处置与静态审计保留；4入口14方法、24PS/19W/48A及32J正式状态不升级。


## 最新执行：固定 v0.15.36，接通 Loop Engineering 与看板首用（2026-10-30）

固定 pstack0.15.36/c742dd61，不追上游main。本批[采用与导出](../../implementation/pstack-adoption-bundle/README.md)实际核11组件、51唯一文件174474bytes，更新五份bugfix/调查/评审/证据/来源材料；两种项目局部bundle可导出，来源角色及材料hash可检查。声明依赖闭包不等自动语义完整、认证或host送达；外部host/check仍not_checked。

修订后来源35、export/provenance115定向通过，独立控制与实际两布局导出保留原件。full在审计小修前精确2389dcd9为22包7334pass5skip0fail，9033tracked字节前后同、初始4fresh dist脏；不重标最终whole-tree。Node26 transform与首次Node22 ABI环境失败、审计发现和修复均保留。W19到312有限收口，不扩健康平台。S1–S3只等用户签收，不阻开发；原24PS/19W/48A及32J正式状态不升级。


## 当前执行优先：pstack原范围验收对账

实际main abcd9edf，PR311已合并，PR312 Ready等待人类merge。P2/P3与P4/P5候选已具备组件验证，下一步P6当前真实缺陷的实际host与同卡闭环。三槽负责源码、材料和独立验证，root独占中央/PR/full。未启动本批真实host任务；Firstmate深运行禁止。

> 当前排期与交付见 [delivery-status.md](delivery-status.md) 和 [delivery-rollup.json](delivery-rollup.json)。下方旧批次记录按历史SHA解释，不覆盖最新观察。

本会话是唯一项目与 PR 主入口。OSStack 保存任务进度、阻塞与证据；本会话负责解释依赖、分配子代理、核验结果和管理 PR。用户只需处理已经整理好的审批合并批次，以及确实需要其决定的范围或权限问题。用户已明确授权主入口修改 PR 的目标分支（retarget base，不直接推送 main）、准备和提交 PR、转 Ready、分配子代理与执行验证；审批合并仍由用户负责。

本规则依据 `work-packages.json`、`execution-gates.json`、`acceptance-cases.json`、当前执行账本和 Firstmate 交接记录。它不改变冻结设计的验收门槛，也不把已合并 PR 自动等同于完成整个里程碑。

## 1. 一个入口、本地子代理与独立会话

| 角色 | 本批工作 | 后续滚动分配 | 写入边界 |
|---|---|---|---|
| 子代理 A：来源/行为实现 | O06/N0 与 J11 下一批门槛提案（只读） | J02b 来源采用与分型注册 | 自己的隔离 worktree、明确文件清单 |
| 子代理 B：Session/恢复实现 | #279 独立故障验证、R02 组件收口与账本核验 | J11/J12 受限切片的独立验证 | 自己的隔离 worktree；状态/schema 共享路径单一 owner |
| 子代理 C：独立验证 | #279 正式 main 适配、终态故障回归与审计 | J03 driver 可另开实施任务；此时原作者之外的人承担该项验收判定 | 默认只读冻结候选；测试脚本与报告写独立 scratch |
| 本会话：集成负责人 | main/PR 核对、依赖和写路径分配、Sonnet 审计、账本、Ready 批次 | 接收结果，解冲突，批准进入下一执行窗口 | 独占联合账本、PR 元数据及跨切片集成 |

本代理树当前工具容量为主入口加 3 个子代理；这是单树限制，不是整个项目的人员上限。用户已授权主入口另开独立 Codex 会话并行开发测试。每个工作者最多 1 个在制任务；独立会话按明确任务、独占写入边界和实际资源预算增加，不以制造会话数量为目标。某个任务等待 CI 时可释放槽位处理独立工作，但保留候选 SHA 和责任人。共享协议、schema、daemon 同一文件的改动进入 owner 队列；主入口安排串行整合。默认同时只跑一套全仓重回归，其余槽位跑有价值的定向测试，避免资源争抢制造超时噪声。

每次派发必须写明：工作项/卡片、输入 main SHA 和前置候选 SHA、允许写入路径、交付/验收范围、禁止操作、证据目录。子代理不得自行修改其他分支、Ready 状态、联合账本或合并 PR。主入口负责最终发布。

## 2. 三张看板保持同一事实

| OSStack 看板 | 卡片 | 联合归属 |
|---|---|---|
| `joint-firstmate-pstack` | J01 `card_6d5d3d02`；J02 `card_a502fa36`；J03 `card_7d169d5f`；J11 `card_79cdb3e7`；J12 `card_e342e365` | 共同职责、验收与跨项目依赖 |
| `firstmate-upgrade-roadmap` | R02 `card_9ccb91b2`；R03 `card_2ff6f711`；R04 `card_c96c79e2` | #276 + #282；J02b 的来源/行为映射子范围 |
| `session-pilot-debt` | cleanup `card_4e8147d9`；terminal fence `card_d1a582eb`；DEBT02 `card_f251dadf` | #278；#279；J11/J12 与持久恢复义务 |

三张板上的对应项使用同一批次 ID、PR 链接和证据入口，避免重复算完成。需补充其他卡片时先查询真实 card ID，不推测或创建重复卡。以上映射不是对当前状态的断言，执行前读取最新板快照。

使用已经交接的安装版 OSStack 与明确的管理 home/socket，通过 `kanban.board`、`kanban.comment`、`kanban.move` 更新；不操作默认 `~/.osstack`，不直接改 DB，不用开发 checkout 打开管理 DB。板卡正文中的依赖只是说明，依赖执行由本会话核对。

状态采用真实支持的 `triage / todo / ready / running / blocked / done / archived`：待执行任务用 ready，领取后 running；候选交付后若仅等用户审批合并则 blocked 并写明原因。GitHub Ready 与板卡 ready 不混为一谈。`done` 仅用于该卡声明范围实际完成，整项 J02/J11/J12 不能因其中一个 PR 合并就完成。

每次评论/版本化账本最少记录：任务和负责人、前置项、main SHA、候选 code SHA、PR head SHA、命令/结果/退出码、审计模型与结论、原始证据及哈希、未覆盖范围、下一步。代码改动使原代码证据过期；仅文档提交要另记 head SHA 并核对产品 diff 未变，远端 CI 仍按当前 head 读取。历史失败与原始审计保留，处置说明另写。

## 3. 每批的执行闭环

1. 主入口刷新 origin/main、前置 PR 的真实 merge commit 和检查状态；读取三板，核对上次候选是否漂移。
2. 分配互不冲突的隔离任务。独立验收用例的预期、判定者与摘要在候选/评估结果出现前冻结；不能把事后增加的普通回归冒充符合设计的独立 oracle。
3. 子代理实现并做必要的定向测试，提交候选 SHA。主入口统一做组合核验、全仓必要检查和 Claude CLI `claude-sonnet-5-5` 审计；确认的问题回到 owner 修复，冻结新的候选并重验受影响范围。
4. 下游可在显式记录的隔离组合候选上提前开发、运行测试。其证据标为 provisional，不能直接继承为最新 main 的通过证据。前置合并后必须 retarget main，复核真实差异、契约/迁移谱系与组合行为，重跑适用验证并更新审计绑定。
5. 主入口统一更新 PR 描述、原始审计及账本。复制报告时连同完整附件归档复制，并校验压缩前后哈希；最终账本和全部证据文件暂存后，再运行仓库文档完整性检查（包括相对链接目标存在）与账本测试。不得用复制前的检查结果代替最终提交内容的检查。满足候选条件后转 GitHub Ready；CI 尚未通过的候选只报告“Ready，检查等待中”，不放进“可审批合并”批次。
6. 审批批次只含：PR 链接、建议顺序/是否独立、代码和证据摘要、当前 CI/mergeability、未覆盖能力。推送包含账本的文档提交后，主入口再次读取 PR head，核对相对固定 code SHA 仅有已审核的文档/changeset 差异（可执行 Python 文档检查另有管理审计），并读取新 head 的 CI；离线账本不可能自引用包含自身的提交。用户用 `gilberthello` 审批合并。模型审计不替代 GitHub approval；当前没有自动合并授权。
7. 用户确认合并后，主入口查证 merge commit，更新卡片和版本化账本，启动已获授权且依赖满足的下一批。CI/测试/审计失败由主入口追踪修复；只有权限、资源、产品取舍等确实无法自行解决的阻塞才请求用户介入。

普通进展集中在批次更新；出现 Ready 批次、需要用户决策的阻塞或重大失败才通知用户。用户不用逐个提醒重新定向、重跑或追问测试。已创建 Codex 本会话 heartbeat「OSStack 联合开发续办」（automation ID：`osstack`），每 30 分钟检查 PR/main 和账本变化；无变化保持安静。它负责唤醒主入口，OSStack 负责进度和证据，两者不是 OSStack 自治运行时资格。唤醒可用性仍取决于桌面宿主和工具连接；不可用时记录阻塞，不能假装持续执行。

## 4. 下一批队列与准确门槛

| 工作 | 可以现在做什么 | 可交付/验收门槛 |
|---|---|---|
| #282 R02 审计修复（已合并） | #276 旧候选缺失的预算、缓存和严格输入修复已由 #282 补齐；保留独立验证证据 | 候选代码绑定测试与 Sonnet 审计；最新 head 必需 CI、真实 main diff；不宣称 J02b 的采用依赖闭包已完成 |
| #278 cleanup（已合并） | 保留已合并候选的测试、审计和 merge commit；作为 #279 前置 | 历史证据保留原测试 base，不改写成当前 main 的验证；不宣称 terminal fence 或跨进程恢复已完成 |
| #279 terminal fence | #278 已合并，现已改为 main 并正式重验 | 确认无成功 terminal 的 EOF 不释放未知 producer 的 admission；重放不再次执行；重新运行停止证明和正常完成路径。#279 不解决 DEBT02 |
| J02b | A 槽可核对 J01 + 已合并 J02a/#281 的实际契约，准备采用、分型注册和 R03/R04 映射切片 | 正式 `J02.scoped` 依赖 `J01.scoped`，不能以 #273 合并代替整体 gate。验证来源认证/接收端校验、实际采用依赖闭包、inspection 到可采用快照/SourcePin 的映射和旧 manifest 兼容。JA03 验证源/采用依赖改变与未采用插件改变的不同影响；JA04 拒绝越界/未知字段且不执行 hook。R02 作为实际消费依赖时另显式加入其 SHA，不凭设计自动假定已接线 |
| J03 | 可在独立 scratch 做 session-answer-receipt driver；按 JP-03a/JP-03b 分拆 | `J03.scoped` 依赖 `J01.scoped`。JA05 走真实 host 的 doctor→drive answer→observe→cleanup 并读原 receipt；JA06 dry-run 对 DB/文件/进程无副作用；JA44 同 key 同输入重放、不同输入拒绝、资源只归本 run。使用 Session 新语义的最终候选必须覆盖 #278/#279 合并后的真实路径。J03 driver 通过不等于 live provider 资格 |
| J12 | B 槽在 #279 收口后优先准备 bootstrap/preflight 的受限实现；schema owner 独占共享状态文件 | #274 只是 J11 规格。先满足 `J11.scoped`，冻结实际 base/schema/DDL/构建谱系并通过 `J12.bootstrap_preflight`；之后才有 `J12.scoped`。JA52 要真实旧 hold、DDL 前/中/提交后退出、白名单单步迁移、普通 openDb 迁移前拒绝，原 hold 不变；JA51/JA21 验证权限、owner/generation、精确 invocation/证明、原子裁决与后态，不重发原 action。完整 `J12.full_recovery` 还依赖 `J17.recovery`，不能因局部恢复测试通过而宣称完整 broker/home 恢复 |

每个新切片启动前核对设计中 O03/O06 等未决项的实际关闭证据；冻结文件的 historical planned 标记与当前执行状态分开记录，不能默默擦掉未决项。迁移编号需按最新 main 的真实谱系重新确认，J11 候选编号不是生产预留。

## 5. 能力边界

这里使用的是“本会话驱动 + OSStack 管理进度与证据 + 子代理执行”的工作方式。没有调用尚未实现的 `goal_dispatch`，也没有由 OSStack 自动恢复、接管或重新启动 Codex 会话。数据库可保留任务/证据，不等于执行器拥有自动恢复资格。模型审计、真实回归、GitHub CI 与用户批准分别记录各自证明范围。


## 历史批次观察（2026-10-27 UTC）

用户已合并 #278 和 #276。#276 实际合入旧候选 `5e86a778`，本轮审计修复未进入该合并；补充 PR #282 承接这些修复，并基于 `28d116f3` 重新验证。#279 已进入正式收口，无需用户再发启动指令。J01/J11 阶段门槛缺口见 [独立核验](../../implementation/joint-behavior-retarget/subagent-terminal/next-gates.md)；完整 SHA、观察窗口、当时的 PR/CI 状态见 [执行账本](execution-ledger.json)。`Ready` 与 `current_head_matches` 都是该观察窗口的快照，执行前必须重新读取远端。结构契约测试不替代真实主机验收。


## 下一波派发依据

[下一波最小切片核验](../../implementation/joint-behavior-retarget/independent/next-wave-assessment.md) 读取 `28d116f3f8c15f64bebb314308adf320d8380b2b` 原始规范，列出 8 个最小任务与共享写入冲突。[独立 oracle 准备核验](../../implementation/joint-behavior-retarget/management-independent/oracle-readiness.md) 补足真实入口和反例要求。这两份报告均为派发输入，未给任何正式 gate 签发 PASS。

下一执行窗口先由主入口明确 J01 组件契约与真实集成验收的分层方案，并结合 #271 实际合并对象给 O06 写当前候选接口判断；如需修改依赖，单独形成设计修订并实际审计。随后三槽分别承担 J01 oracle/接线边界、J02b 离线采用闭包、J11 规格 oracle/J12 文件级预检，空闲槽推进 J03 隔离 driver。满足各自开工条件后才写产品候选；主入口独占中央账本，schema 只允许一个写者。

JA01 精确请求 `task local_verified`；早期预检笔记的 `implementation_verified` 重述不能改变该目标。JA02 需要允许对照和真实 adapter 调用零证据，永远拒绝的 helper 不能证明 repo fence。JA20 需要实际 broker DDL/构建生产者；DAG 无环、future-storage.sql 和合成摘要均不足以完成该验收。保留原 JA01/JA02/JA20 义务，不通过改名或压低测试范围消除缺口。


上一批顺序为先审批 #282，再由主入口核对更新后的 main 并重验 #279 的合并候选，然后通知审批 #279。两项产品改动的文件范围分离，但当前证据均绑定同一 main；先合并任何一项都会改变另一项的集成基线，不能把它们描述为无需再检查的独立候选。等待合并期间继续推进不依赖该合并的预检和已授权切片。

## #282 合并后的当前执行窗口

已实际核实 #282 head `f81b72eb813533357e5317871dcbc5febe004244` 合入 main `ede5aadced37ac9dc29dd21f0e307ad2c46d2976`。#279 在该 main 上重新验证，旧 `fd14a6be` 的 CI 与 `c60850c4` 的产品测试仍仅为历史证据；本轮提交必须将新测试、实际 Sonnet 5.5 审计、代码 SHA 与 PR head 一同记录在执行账本及 [本轮证据](../../implementation/joint-terminal-post282/README.md)。只有最新发布 head 的 CI 完成后才通知用户审批合并。

三个本地子代理分别负责 #279 产品/测试/审计、独立故障验证与账本核验、O06/N0/J11 下一批门槛提案。独立会话 `01a17da2-4810-7543-b9d7-a008fe51c2e0` 负责 JA01/JA02 独立 oracle 和 scratch 夹具，初始基线同为 `ede5aadc`；它不修改产品、中央规范或账本，不重复 O06 和 #279 工作。原型通过、拒绝向量通过或静态接线分析均不等于正式 JA01/JA02 通过。主入口读取其交付并安排后续集成，不要求用户逐会话追踪。

跨会话任务同样进入 OSStack 卡片和主入口派发记录，记录会话 ID、基线、写入路径、前置条件、当前状态及交付摘要。主入口保留 PR 发布权，用户保留审批合并权。独立会话并行能力不授予尚未验收的 OSStack 自动调度或恢复权限。

中央 checkpoint 刷新脚本只由主入口单一写者执行；子代理和独立会话不得执行。Heartbeat 仅唤醒该同一主入口，不能另起并发写者。刷新前后检查 ledger 原始字节一致，并原子替换；失败的部分证据目录保持未发布，由主入口核对后再决定归档。最终提交前必须执行文档链接与账本检查。

## #279 收口后的任务边界

新批次基线为 `d3fa7ef681efc79a5fb2dff92172ef1be0978774`。`loader_adversarial` 在 `codex/joint-gate-layers` 独占 N0 门槛、验证器及相关规范；`terminal_preflight` 在 `codex/joint-broker-spec` 独占 broker 规格 SQL、fixture、manifest 与专属测试；`cleanup_regression` 只在独立 scratch 冻结反例并验证两类候选。根在 `codex/joint-nextwave-control` 独占中央账本、交接、PR 与全仓回归队列。禁止跨边界改动或重复派发。

JP-17a 使用 dedicated SQLite broker DB 作为明确的离线候选设计，namespace 与 home 分离；候选空库 0→1 只描述实际测试材料，不保留生产版本号、不改 home migration、不注册 runtime。部署路径、实际接线与正式资格留给后续受门槛约束的切片。门槛分层须独立审计并保留真实主机验收，不能因组件可并行实施而消除原义务。

每项候选保留真实 Claude CLI `claude-sonnet-5-5` 输入、原始响应、处置和 SHA 绑定。独立反例冻结时间只约束尚未读取的新候选；不会补认历史实现的 oracle 独立性，也不把多个模型当作已认证的安全主体。


## #284 合并后的执行窗口（2026-10-28，上海时间）

已从 GitHub 与远端 Git 核实：#283 合入 `697d0b9c86009a8ee11a1d06931fb787cf600f12`，#284 合入最新 main `3192b424174e5eb977d640cc0418e67c6b1461d1`。main 的 tree `228b2a0b9ae6708bc68bb3019921198484538320` 与此前独立合成验证的最终树完全相同；历史测试仍绑定原候选 SHA，本次不将树一致性写成新测试运行。两 PR 的发布 head 五项 CI 均成功，付费语义 smoke 跳过。

批次 `joint-post284` 三个独占任务已进入 OSStack：A 补齐 JP-01c 的 JA59 跨语言与 JA70 类型/关联回归；B 验证 JA20/JA47 home 与 broker 的真实离线输入及依赖反例；C 预冻结 J02b 离线采用闭包的夹具和边界。A/B 在隔离分支交付，C 仅写 scratch。中央账本及 PR 仍由主入口单一管理，全仓测试仅一个队列。

`J01.contracts` 尚未正式通过，模型名称不能代替可信 oracle principal，测试数量不能替代预冻结与身份条件。J02b/J03 产品开工保持依赖阻断；J03 不依赖 J02。J11/J12/J17 的正式授权、文件级崩溃和旧 writer fencing 义务保留；home 48、broker 0→1 均未被本次分配为生产迁移。所有新候选继续实际 Claude CLI Sonnet 5.5 审计、修复并保留原始意见；通知审批前重新查询发布 head 的 CI。

当前合并观察、三看板快照和派发回执见 [执行账本](execution-ledger.json)；较早章节是各自观察时刻的历史记录，不构成当前 Ready 或 gate 状态。


## 2026-10-28：方法与真实验证旅程并行实施

用户再次明确授权多子代理推进。当前三个在制项是：`card_766d64bc` 由 loader_adversarial 实现 feature/refactoring 方法与路由；`card_e0b5babf` 由 terminal_preflight 实现复用既有 healthy/missing-ref 的有限验证旅程；`card_3247e7bd` 由 cleanup_regression 先冻结行为与故障判据，再独立验证候选。两作者从 main `ca95aba1` 启动独占工作树，独立检验者仅写 scratch。原生发现实验的四次模型调用已经结束，不借本批重写旧结果或突破旧预算；新的真实宿主旅程需独立冻结后启动。

主入口接收这三个任务，集中实际 Sonnet 5.5 审计、必要全仓回归与 CI。原生发现文档收口可与方法材料增量合为一个 PR，实际验证旅程另列 PR，从而减少单纯证据提交的审批次数。历史宿主观察始终绑定原材料 SHA；新增方法须自行验证，不能继承旧发现实验为通过。


## 2026-10-28：影响分析与性能测量方法

本批从实际 main92088fe5 启动。A 独占 change-impact 及中间共享路由，B 独占 performance-measurement 新材料，C 只写独立预冻结判据与验证证据。A 交接后主入口才接手第九项方法的共享路由，避免并发写同一文件。主入口统一运行实际 Sonnet5.5 审计、全仓单队列和发布检查。OSStack 卡片575bf2b9、b64a5211、a9783847分别记录三项任务，最终代码和证据合成一个审批批次；用户保留审批合并权。

## 构建产物与验证顺序

2026-10-29本地验证发现：build后恢复已跟踪的旧dist，会让测试加载与源码不匹配的产物；普通增量build可能因tsbuildinfo保持而不重写。测试前核实际导出与构建绑定，必要时使用该包支持的强制构建。所有适用验证结束前保留新鲜生成产物，记录before/after哈希；归档patch后才恢复不应入PR的生成修改。不能把“Git树干净”当作产物与源码匹配的替代证据。

## 2026-10-29：pstack 优先与分层交付对账

本轮及后续先补齐 pstack 当前能力的完整使用缺口。Firstmate 仅推进当前 pstack 路径必要依赖或已确认阻断修复；独立的长期监督、自动恢复、远端子主管、累计预算和灰度启用另列后续排期，不因易拆小卡而抢占主线。已在制的技能创建方法完成后，不自动继续扩充方法目录；先按 delivery-status.md 的能力完成条件选择下一项。

原工作包/验收文件保留设计基线；delivery-rollup.json 是当前交付投影，execution-ledger.json 保留SHA与历史证据。发生冲突时先查实际main/PR和相应验收证据，并修投影；不得用旧嵌套快照覆盖新事实。每个交付PR登记主J项、支持J项、来源能力、实际可用范围及未满足义务。每张执行卡登记所属交付能力与J项；卡完成只完成自己的范围，不自动通过父里程碑。

里程碑分别报告已交付切片、待验证、未实现和暂缓安排；这些维度可同时存在，不强行压成完成百分比。正式门槛通过只来自原验收，不由评论、导出测试或PR合并替代。看板原生状态与交付成熟度分别展示；在管理实例未暴露业务父子关系写接口时，用版本化映射与卡评论回链，不直写数据库或冒用依赖DAG作为任务汇总。

下一条 pstack 闭环应以真实任务结果为主要验收：在隔离的实际仓库/可复现历史缺陷上完成材料消费、真实失败、授权修复、同触发重验、证据报告。分别保留 Codex 与 Claude 的实际结果，不以导出可达、单纯回答正确或字数合格替代任务完成。原实验的硬字数限制和失败记录不回写；新协议如调整指标，必须先固定新版本并明确任务正确性/执行边界/保留失败的主判据，不能为翻绿旧实验而改分数。受限单元完成不放行正式运行时 gate。

大里程碑的running表示工程切片已开始且尚有明确缺口，不表示一个worker正在执行；活动卡running才用于领取状态。当前/建议状态分字段，调整后以RPC回读确认。成熟度与正式验收另列，不使用running计完成率。

### 2026-10-29：pstack真实任务队列

PR302由root在五项适用CI成功后转Ready，用户审批合并。root中央账本、A真实维护与CI核验、B两宿主实际修复执行、C独立验收分开负责；同一宿主仅一次600秒、零重试，失败不通过追加重试消除。下一批优先收口已有验证维护与bug-fix能力，不增加方法数量替代使用效果。已完成维护活动回链PS08/09及相关J项，仅有限工程证据，不提升正式门槛。完整观察见本轮pstack-real-loops记录。

### 2026-10-29 exporter实际任务收口规则

历史exporter任务已执行，模型8条原子命令与独立复验分列证据。旧packet失败不可重评分；本次evidence.md60/64读取缺口不能以实际修复成功掩盖。相同test/input的RED→GREEN仅证明该有限任务，不签PS/J整体资格。后续调度须读取新的export_repair_execution，不重复派发本次已用完的1turn预算；新任务另行定义范围和证据。


2026-10-29 actual-main publication: PR305 merged at e79fc926; PR306 head958eb722 is Ready on main after CI40920378111 five applicable SUCCESS/paid SKIP. Card_b8d97bff blocked only for user merge. No formal gate or whole capability promoted. See `docs/implementation/pr306-main-retarget/ci-final`.


2026-10-29T17:49:32Z: user merged PR306; actual main6c9a3e8f tree356296e4 equals published958. Maintenance card done for that slice. Next bounded PR candidate snapshot supports PS17/18 and PS13/J07; J20 is design context only. Current integration5744 adds actualmain with empty tree delta. No new method or formal milestone completion.


2026-10-29 latest delivery: actual main6c9a3e8f includes user-merged305/306. PR307 read-only candidate snapshot is Draft/main at8fd28911 with CI40929858660 running; original lint failure and subsequent inventory failure are preserved, repaired without relaxing gates. PR308 legacy StatusContext ingestion repair is Draft atb4a2fc30, based on307, CI40930144304 running. Same-test RED→GREEN, independently frozen36 vectors and Sonnet5.5 static PASS support the scoped repair; fullbda7207/5/0 and later172/14 focused receipts retain separate bindings. Root alone owns PR/ledger/full queue; A implementation, B downstream/CI, C independent checks have separate evidence. No new methods, no whole PS capability or formal J milestone completion. After user merges307, verify actualmain/tree/diff and retarget/revalidate308 before Ready; never merge into feature base.


2026-10-29 18:56UTC update: PR307 head8fd28911 now Ready/main after CI40929858660 five applicable SUCCESS/paid SKIP, root readiness mutation and readback confirmed. User approval/merge still required. PR308 headb4a2fc30 CI40930144304 also has five applicable SUCCESS/paid SKIP but remains Draft on parent307; actual-main retarget/revalidation is still required after user merge307. Both activity cards are blocked solely on their stated merge dependency, not formal qualification. Original lint/inventory failures remain preserved.


## 2026-10-30：307 合并后的执行窗口

#307 已由用户合入 main `de43f47c29d5c08ae6e6c5eb366767320ffcdd0c`，合并树等已发布8fd。#308 已以 `6d978973` 改为main，树等原b4a，CI40977980388与新鲜定向复验进行中，保持Draft。三个子代理分别承担主线复验、CheckRun异常状态修复、预冻结独立反例验证；OSStack新卡card_14b72dd7贡献PS18并支持PS17/J07，root独占PR/中央账本/full队列。异常或不完整CheckRun不能误判成功，neutral/skipped既有显式政策保留。没有新增方法或正式资格通过，历史失败/CI不改写。


## CheckRun 分类修复候选（2026-10-30）

PS18/J07支持卡card_14b72dd7已完成作者56同测试RED17→GREEN、独立57预冻向量旧20失败→新全过；root d5eea3e5全仓22包7232通过/5跳过/0失败，8677已跟踪文件字节执行期间不变，初始含4新鲜dist，不称clean committed tree。实际Sonnet5.5静态PASS，原意见与失败保留。只明确完成且SUCCESS/NEUTRAL/SKIPPED可成功，已知失败优先，其他不完整/未知pending。已有卡不自动刷新；snapshot另有政策。待发布依赖308的Draft，308当前4a7ee75d/main新CI40979169462尚未完成；不得合入featurebase。见[修复记录](../../implementation/stack-checkrun-state/README.md)。


Publication snapshot 2026-10-30T00:28:26.368600+00:00: PR309 f31e557a is Draft on parent308, CI40979844215 running; PR308 4a7ee75d targets main with CI40979169462 running. Root requires all applicable checks before Ready; user merge308 must precede actual-main retarget/revalidation of309. Original superseded308 run40977980388 was cancelled to release final candidate CI, not retried as a test failure.


Next selected slice (proposal only): a one-time explicit ordered 1–3 PR stack-frontier report reusing the merged singleton collector, preserving unknowns and never authorizing merge. Author and independent source-grounded selections are retained in `docs/implementation/stack-checkrun-state/next-selection`. Historical comparison and stored-card refresh are deferred. Implementation and acceptance freeze are not yet dispatched; no inherited host budget or new method.


Final PR308 closure 2026-10-30T00:46:39.573481+00:00: head4a7ee75d is Ready on actual main de43 after CI40979169462 five applicable SUCCESS/paid SKIP, root readiness mutation and readback. Actual synthetic25bb08b5 check/Test22packages7207pass7skip0fail, GitHub172/CLI14; exporter94total93pass1skip, projection88/journey43/reader14/maintenance24 and actual fixtures pass. Complete log is retained losslessly, no remote artifact download or rehash claim. Card7e0b1be2 blocked only for user merge. Historical CI/full/REVISE remain separately bound. PR309 stays Draft until parent merge and actual-main retarget/revalidation.


User merge308 2026-10-30T00:51:07.891452+00:00: actual main a250ad88/tree735612bc equals published4a7. Card7e0b1be2 done for the bounded slice. PR309 fc272c63 now targets main, tree equals f31 and complete16path delta unchanged; fresh verification/newCI40982097784 running. Historical parentCI40979844215 remains f31→4a,22packages7230pass7skip0fail (not local7232/5). Three-agent dispatch resumes: A implements ordered1–3 PR stack-frontier report after C independent freeze; C independently verifies; B revalidates309; root uniquely owns PR/ledger/full. New card6962ab52 contributes PS17 with PS18/13/J07 support, J20 design only. No new method/host budget or formal gate.


## 2026-10-30：309 已合并，顺序候选核对进入发布

用户于01:13:25Z合并309；actual main e4643324/treeafb6等fc272。309新main CI40982097784五适用SUCCESS/paidSKIP，check/Test22包7230pass7skip0fail；原完整log与Ready→merge回执保留，不重标旧localfull。

新有界工具只读核对显式1–3个PR顺序，不新增method。root540全仓22包7261pass5skip0fail，8784tracked执行期间字节同，初始4freshdistdirty，非clean committed tree；后单独CLI显示修复及docs/main合并不冒充finalfull。最终代码/文档8e830561在actualmain e464上224GitHub/29CLI/94export通过。C42场景58断言；Sonnet初静态PASS附真实autolink/bidi缺陷，作者同29CLI RED17/12→GREEN29，独立Pandoc10例旧7fail→新全过，限定SonnetclosurePASS，原意见和失败保留。一次真实308→309八查询在01:05历史时点识别mergedprefix/frontier且保留draft/checkpending/reviewrequired；不是Ready/merge授权或当前状态。card6962ab52贡献PS17，PS18/13/J07支持、J20设计；32J formalfalse和24PS20partial4deferred0whole不变。下一需求由源驱动选题，不重跑旧宿主失败翻绿。

## 发布回执：PR310 / pstack原范围对账

PR310 Draft/main，head `db0652dde3ec4695ef592b0d7f1c14a14a30917e`，CI40988439592运行。收口有序PR前沿在途工具和原24PS/19W/48A对账；用户验收及原C0–C3未签发，原失败保留。接下来优先原C0→C1→C2，Firstmate深runtime后排。

## PR310 最终 CI 与 Ready（2026-10-30）

PR310 head db0652dde3ec4695ef592b0d7f1c14a14a30917e 已Ready/main/MERGEABLE。CI40988439592五适用SUCCESS/paidSKIP，实际synthetic db37d26669d6bcb155cd9b99d08859d5d32c9777，22包7259pass7skip0fail；export94total93pass1skip，github224/stackCLI29。仅等gilberthello审批合并；不代表原pstack C0–C3或32J正式验收，S1–S3签收仍未发生。原失败和旧SHA证据保持。 完整原日志losslessgzip、metadata、Ready回读和三板见 `docs/implementation/pr-stack-candidate/ci-final`；未下载远程artifact，不声称重hash。未修改候选产品或重复代码审计。

## PR310 已合并与原 C0 调用体验（2026-10-30）

用户gilberthello合并310，actual main01ec1852/tree98584660等已发布db065；有序前沿卡done仅该切片。下一card_039f599c贡献PS23/PS08，J03/J06支持：复用固定五案例地图维护入口，冻结准则、最小教程、请求无继承历史的子代理实际正常/错误/恢复（上下文排他性另记限制）、独立核验。无新方法或生产runtime，不签发整个W17/C0或用户阶段验收。

用户明确约束：先不要进入Firstmate深运行。本轮只限pstack C0调用体验；任何Firstmate深运行实施或启用均未派发。

## C0/W17 有限教程观察收口（2026-10-30）

[教程与证据](../../implementation/pstack-c0-usage/README.md)：已构建环境中实际输入拒绝exit2/no output→仅自有地图补empty→同入口新output consistent0，五例产品0/1/2/1/0、driver均0，原错误与语义保留。独立核case145+journey32成员及source1065/build2352；1493产品/脚本/清单字节未变，运行初始4freshdist脏。冻结CU中8有限pass、CU01排他上下文unknown、CU08全局资源观察limited；无完整A39/W17/C0或用户阶段验收。原A39首次冻结前接口推导不能由本后验观察替代。仅控制分支发布待下批吸收，card_039f599c done只此有界记录；W18/W19及原C1→C2继续，先不要进入Firstmate深运行。


## 2026-10-30 W18 implementation publication

[Bounded feature reader](../../implementation/pstack-feature-map/README.md) now selects metadata using the existing public BM25 API and reads only selected/required local leaves. Three workers split code, independent inputs and actual command documentation; root owns integration, ledger, PR and full queue. Final 40 focused checks pass. Full9e37bfa0 has22 packages/7261passed/5skipped/0failed,8914tracked bytes unchanged during execution with four initial fresh-dist changes; later small unavailable-export repair has its own RED/GREEN and independent old/new controls, not a relabelled full run. Publication CI remains separate. Card_9a676553 contributes PS08, supports PS23/J03/J06; no formal gate or whole capability completion. W19 configured ownership/health and original C1/C2 remain next, Firstmate deep runtime prohibited.


2026-10-30 publication: [PR311](https://github.com/osborn-studio/osstack/pull/311) is Draft/main at `f70f40265ddfb1e419d6b8f5145d46c71060b9bc`; CI41014856944 is running. Five applicable successes and final readback are required before Ready. No approval/merge is performed by agents. Current bounded W18 implementation is separate from remaining W19/C0/C1/C2.


2026-10-30 final CI closeout: PR311 head `f70f4026` is Ready/main after CI41014856944 five applicable SUCCESS/paid SKIP and root readback (`isDraft=false`, `MERGEABLE`). Actual synthetic checkout `7aec62e116a37788b283e0634f4e0163f9755c81`: 22 packages7259pass7skip0fail; feature-map40, export93pass1skip, reader14/journey43/map24/projection88. Original full log and independent checks are retained in [CI closeout](../../implementation/pstack-feature-map/ci-final/README.md); no remote artifact rehash claim. Card9a676553 blocked only for gilberthello merge, not whole W18/C0 qualification. Next W19 remains authorized; Firstmate deep runtime prohibited.
