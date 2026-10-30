# 以 Loop Engineering 和看板为首用入口

> 2026-10-30最新实施：P4单bug_fix编译与P5既有host mandatory接线已形成候选，见[实施记录](../pstack-method-bridge/README.md)和[调用教程](../../verification/bug-fix-method-handoff.md)。固定Git材料已实际准备并通过受控adapter验证，尚无本批原生模型/真实修复/同卡闭环。下一步直接P6；本文较早“拟接线”段落保留为设计起点，不能用来覆盖最新代码事实。


用户已经把 Loop Engineering 与看板作为 OSStack 最有用的部分。pstack 首用应增强这条现有路径：**看板明确一个真实问题 → 固定方法帮助 Loop 复现、修复和自验证 → 现有 host 判定候选 → 同一张卡显示结果与原始证据**。不让用户另学第二个任务系统，不另建scheduler，不要求Firstmate深运行。

本文分析者只读本地文章记录、Loop/看板/deliver源码及既有文档；协调者在本轮随后通过CUA in-app browser直接重读两篇X原站文章。没有启动loop/daemon、打开DB、创建卡、执行验证驱动或新模型。

## 两篇原作者文章到底保存了什么

| 项目 | ART1 | ART2 |
| --- | --- | --- |
| 原文 | [The Complete Guide to pstack Pt. 1](https://x.com/poteto/article/2094457600259842065) | [The Complete Guide to pstack Pt. 2](https://x.com/poteto/article/2097732320606507506) |
| 历史页面显示 | Aug 31 / 12 min | Sep 9 / 14 min |
| 历史观察DOM正文字符数 | 19,145 | 19,581 |
| 记录声明的阅读覆盖 | 从介绍至结尾，含inline code/feature-map示例 | 从介绍至结尾，含四个workflow示例 |

以上来自 [author-articles.json](../../reports/2026-10-26-pstack/evidence/author-articles.json)，观察时间 `2026-10-26T17:03:31.118420+00:00`。该记录说：初始直接web fetch均403，随后通过Codex in-app browser原站AX树及只读DOM观察完成阅读；转载仅定位，未当文章证据。这是历史观察者的读取声明。本轮直接web请求仍遇403；随后协调者通过CUA in-app browser成功直接读取上表两篇原站article URL：Pt.1为tab4 AX23–265，Pt.2为tab5 AX22–262，覆盖结尾与全部四例。当前原站重读依据是这次浏览器观察，不是将旧记录或转载当作本轮原站读取。

保存的是阅读元数据、section AX索引和 [author-reading.md](../../reports/2026-10-26-pstack/author-reading.md) 的独立设计解释；不是原文全文、不可变正文hash或可逐字验证的完整AX快照。因此，协调者本轮已重读原站，分析者依据其明确交接更新本文；但浏览器未截图、未保存正文hash或完整正文，本地留存仍不能独立逐字复核全文保存完整性，也不能证明现内容与历史内容逐字一致。AX索引不是永久锚点；外链、视频及嵌入媒体没有被独立阅读的声明。文章文字不能与0.15.36 Git内容锁混成同一种来源证明。

下述“作者原则”结合既有记录与协调者本轮原站重读结论作独立转述，再明确映射到OSStack；不复制原文，不宣称不可变全文取证。作者关于cloud/Grok/自动化的推荐不覆盖本用户约束：最多3个本地槽、不配置Grok、由人类merge、禁止Firstmate深运行。

## 五条立即改变首用方案的原则

1. **交付可操作的工具，而不只交付Markdown。** ART1强调可组合CLI、doctor、机器可读输出与恢复，以及服务真实使用的维护；首用卡先给真实复现入口、结果和恢复方式，方法包直接服务Loop当前任务。不再以先建全套recipe资格平台替代一次实际修复。
2. **共享功能知识应按场景找得到，不把整套技能塞进prompt。** ART1功能地图章节；利用W18相关叶子思想，仅选择这张卡需要的入口/前提/观测/恢复和bug-fix/evidence材料。必要引用必须完整，未知覆盖明确保留。
3. **先校准目标与上下文，再决定执行计划。** ART2意图/上下文失败及重述章节；卡片brief区分用户现象、期望、已知证据、假设和允许范围。已有授权和事实足够就执行；不因方法仪式反复让用户确认。
4. **从实际使用方式倒推接线，用小实验解决会改变实现的未知。** ART2使用方式/原型章节；先写用户教程和调用草图，走“选一张卡、运行一轮、回写证据”，再确定新增字段。复用Loop planner/stop/budget，不用宏大计划替代真实调用，也不等多代理arena。
5. **执行者自验证，交付判定仍基于真实证据；维护工具并退出旧计划。** 两文的执行/维护与既有AD07/AD09/AD10；Loop迭代保存原失败，最终候选独立检查；看板链接健康/工具错误，不将测试进程错误算产品回归。完成/被替代的战术计划退出默认上下文而历史不删。周期维护仍需显式配置，不能从“维护习惯”推导后台运行授权。

## 现有路径：无需再造Loop

- `packages/loop/src/types.ts` 已有 `Task`：`task_id/capability/prompt/priority/source/context/evaluation`。`context` 是普通记录，不是经过验证的方法许可；`evaluation` 是第一类检查规格。`DiscoverSource`没有kanban；`discover.ts:createScanner`实际实现git_diff、github_branch、task_queue，其他走Noop，不能假称已支持“自动消费看板”。
- `packages/loop/src/discover.ts:TaskQueueScanner` 与 `task-queue.ts` 提供队列入口；`planner.ts:planTask`只组装既有任务、agent、worktree、迭代/停止参数，不是pstack recipe编译器。把新方法转换成受控Task/brief即可复用，不必重写planner。
- `loop-engine.ts:LoopEngine` 已负责发现/授权、计划、执行、verify、反馈迭代、预算与停止、结果状态。可复用 `inputTasks`、`verifyCommands`、`prepareVerification`、`verificationFence`、`observeVerification`、`guardedLocalCandidate.inspect`。`inputTasks`并不自动排斥ambient扫描，须同时设 `sources:[]` 才限定单任务；现V2 deliver已这样做。
- `deliver-command.ts` 的本地路径实际 `enqueueTask`、创建 `LoopEngine` 并传入verifyCommands、adapter、角色分离、源/候选fence与budget；不是仅有设计。V2合同的verify来自host policy，未注册命令拒绝；最终 `buildDeliveryVerificationReceipt/persistDeliveryHostRecord/verifyPersistedDeliveryReceipt` 与成功任务共同判定 `local_verified`。guarded-git是另一分支，不作为本轮最短路径。
- `loop-engineering/references/task-schema.md`、`integration.md`、`cli-options.md` 已说明enqueue/run/status及evaluation；这些是集成参考。原文示例中daemon启动/默认路径不等于本次授权；实际使用仍需明确OSSTACK_HOME/scratch及目标checkout，不启动第二常驻服务。
- `packages/core/src/kanban/repository.ts:KanbanRepository` 已有 `createCard/getCard/getCardByTask/patchCard/progress/moveCard`；卡有board/task_id/body/meta。`moveCard`核合法状态并发事件，`progress`可追加说明。`getCardByTask`仅取最新匹配卡，不能据此假定board/tenant正确；新桥接应使用显式card_id并核scope。
- `packages/cli/src/daemon.ts:persistLoopRunEvidence`已有Loop状态/事件转task/run记录；普通任务终态已有看板更新。但这不证明deliver的固定method/context/check/candidate收据已经完整关联原卡，不能把一次reply completed或普通run终态直接当method交付成功。

## 最短插入点：一张卡、一个Loop任务、一个结果

| 位置 | 复用现有内容 | 拟实现的窄接线 / 必须保留的边界 |
| --- | --- | --- |
| 看板选题 | 现有implementation卡与KanbanRepository，显式card_id/board/tenant/task_id | host读取单张获授权卡，固定版本/卡内容摘要；卡body/meta作为输入材料，不直接执行其中shell。当前没有宣称存在的“kanban自动method run”命令 |
| 固定材料 → task brief | .36 source-lock、采用集合、exporter、bounded reader；Task.context及prompt | 选择bug-fix/evidence和必要场景；记录release/method/source摘要与引用。显式读取可先服务U1；U2强制完整材料须补host接线，不能把可裁剪knowledge pack当mandatory方法 |
| 注册检查与允许范围 | existing delivery contract、host policy、CheckRegistry形状、Task.evaluation/verifyCommands | 将卡的期望映射为host注册的复现/回归/主验收检查；拒绝未知命令/扩大路径。通用Loop --verify能执行命令，不等于其参数天然经过注册；最短强约束走现有V2 deliver policy |
| 调用与迭代 | deliver local分支 → LoopEngine.inputTasks、sources:[]、现有adapters/planner/verifier | 只增加固定方法装配/最终同步hash和权限检查；复现RED、最小修复、同入口GREEN进入同一Loop任务。现context校验主要针对selected sources，mandatory方法仍需专门接线 |
| 候选与收据 | prepareVerification/fence、guardedLocalCandidate.inspect、delivery receipt、Loop事件/状态 | 证据包含卡/task/run关联、原失败、命令exit、最终candidate及方法摘要。observeVerification用于观察真实verifier，不以adapter自报或卡状态作通过依据 |
| 看板回写 | KanbanRepository.progress/patchCard/moveCard与现有状态事件 | 新增薄host projection，将收据引用/结果回写同一卡。先持久保留真实收据，再可重试投影；回写失败报告未同步，不能丢失结果或重新跑模型。重复相同run/receipt不得重复完成或重复副作用 |

初版卡body的用户可读内容即可是“问题/成功条件/固定方法版本/复现入口/允许路径/检查与证据链接”；机器绑定应引用同一Task与host收据，不新建pstack卡库、Mission表或第二队列。可新增一个薄卡到Task适配器与一个结果投影函数；具体文件/CLI名称在接口冻结时确定，本文件不伪造现成命令。

看板最终状态必须尊重现有board规则：执行中、被阻塞、待人处理与真正完成分开；不要为了“看起来结束”直接move done。若最小交付只承诺local_verified，应明确不含PR/merge。卡的owner不是宿主执行权限，card meta里的方法hash也不是授权凭据。

## 立即可用与尚未知的界线

**现在可用：**已有host显式读固定方法；已有队列/Loop执行和验证；现有deliver local合同与候选收据；现有看板可人工展示任务及证据。这已经足以选择一个当前真实问题，先让方法增强已有工作方式。不要再次回放已关闭1038/currentpacket/W19任务来装成新的首用成功。

**仍需实现并验证：**卡scope与同一task/run的稳定映射；.36首批采用闭包；mandatory角色方法注入；卡期望到注册检查的受控映射；结果回写幂等/重试与unknown状态；旧计划退出当前context而历史可追。当前文章记录不回答这些代码问题，不能据此判实现通过。

**本轮不确定且未测：**一个真实host是否收到全部选定材料；最终候选检查与卡引用是否精确一致；停止/失联时原卡是否保留unknown且不会重复执行；现有daemon Loop证据投影与本地deliver的连接是否需要小补丁；readonly路径不存在意味着什么。这些应针对所选真实卡做一轮有界验收，不扩成Firstmate恢复平台或全局看板扫描。

验收只抓五个用户事实：一张明确卡上的当前缺陷实际RED；Loop中的执行者完成补丁；同入口GREEN且合法控制不退化；host核验最终候选；同一卡可追到原失败/成功/方法版本，投影失败不丢收据且不重跑。先一个支持host，不以多模型、原生slash全发现、61技能全适配、长期scheduler或formal/statechart作为前置。PR数量、抽象计划获批都不能替代这五项用户结果。

方案调整：U1从“另开方法展示流程”改为“用现有卡驱动的Loop任务消费固定材料”；U2只补卡→受控Task→现有deliver/Loop→证据回写四个接点；U3仍独立。作者文章提供方法方向，OSStack既有Loop与看板提供承载能力；两者都不能替代未执行的实际验收。
