# pstack 优先：能力与交付对账

当前合并快照：`493caa4e46e616b1d7e9e1c87ed0a5775eae3ad1`。#302已合并；主线为 **4 个 OSStack 入口、14 个共享方法**。本轮真实修复实验仍绑定先前13方法的main1bf1f6ca，不重标为新main测试。

**近期目标是把 pstack 方法变成可在 Codex、Claude 中完成实际任务的能力。** Firstmate 的已有组件继续复用；远端主管、事件入口、长期监督等深层联合运行时后排，只有必要依赖提前。

## 怎么理解进度

原看板的“29待办”是32个大里程碑中的旧状态，不是29个等量开发任务。39张活动卡是另一组统计单位。方法交付、独立验证、实验准备的Done不累加成里程碑完成率。下面的已交付与待验证/未实现可以同时成立。

版本化映射是当前汇总来源；安装版RPC没有原生父子卡写入接口，因此用评论回链，不把依赖图冒充父子聚合。看板实际状态与建议调整分别记录，写入后必须保存RPC回执。工程切片成熟度单独列出；具体工作者是否运行看活动卡，正式通过仍需原验收门槛。

## 现在可用与边界

| 范围 | 当前交付 | 尚未证明 |
|---|---|---|
| 方法材料 | 四入口，可导出至Codex/Claude项目布局；14个共享方法，另有并行分工指南 | 全部入口原生自动发现、稳定路由、所有方法实际任务效果 |
| 验证工具 | skills-check实际退出分类、固定旅程、证据投影与原始证据归档 | 通用地图维护闭环、所有仓库和宿主泛化 |
| 任务方法 | 缺陷修复、功能开发、重构、评审、影响面、性能、需求澄清、架构、连续性、PR收口等材料 | 新联合运行时的编排、恢复、资格和监督整体完成 |
| 组件基础 | 已合并严格契约、来源检查、恢复离线规格与清理产品切片 | J01/J11等完整验收、生产启用 |

原有Codex LIMITED、Claude FAILED等实验结论保留；静态审计通过和导出通过不能改写这些结果。正式32项完整验收没有签发，不代表已合并组件测试没有价值。

## 下一批按完整能力收口

当前队列以 [pstack-feature-queue.md](pstack-feature-queue.md) 为准。已完成的历史任务不再次列为待开工。

1. PR303：完整材料分页工具，五项适用CI成功，Ready等用户合并；工具字节送达不证明模型完整消费。
2. PR304：完整五案例旅程候选，默认两例兼容；五项适用CI已通过，等待303合并后main重验。
3. card_522ee55d：完整五案例安全证据投影已实现并验证，修复了清理身份矛盾误接受；保持默认兼容与原件不变，正在准备依赖304的PR。
4. 随后用新的当前任务验证Codex/Claude实际使用闭环；此前历史修复及LIMITED/FAILED保留，不重跑翻绿。Firstmate深运行时后排。

## pstack能力清单

| 能力 | 交付状态 | 具体边界 |
|---|---|---|
| PS01 单入口任务路由与渐进方法组合 | 部分已交付 | 13共享方法、四入口路由/帮助；没有单一runtime编译/强制执行通道 |
| PS02 代码机制与历史动机取证 | 部分已交付 | investigation可用；how/why/teach为方法吸收，没有专门历史取证工具或全面效果验证 |
| PS03 意图校准与可纠正的问题模型 | 部分已交付 | task-framing已合并；实际两宿主均LIMITED，尚非任务执行收益证明 |
| PS04 从使用草图到原型证据的架构循环 | 部分已交付 | architecture/feature/refactoring可用；独立多原型arena和完整采纳循环未交付 |
| PS05 覆盖式并行与预先声明的竞赛 | 部分已交付 | PR301已合入并行分工指南；运行时派发、竞赛和完整宿主效果尚未验收。 |
| PS06 独立评审与意见裁决 | 部分已交付 | code-review材料+本项目独立审查审计实践；产品化跨模型评审/资格未闭合 |
| PS07 影响面与关键前提验证 | 部分已交付 | change-impact材料/关键前提检查；普遍宿主效果未验证 |
| PS08 可操控的验证基础设施与功能地图 | 部分已交付 | create-verification材料+两种真实CLI例子/五case driver/两行journey；任意项目自动生成完整旅程未证明 |
| PS09 验证基础设施的健康、归属与漂移维护 | 部分已交付 | 维护方法、健康/归属/清理工具及一次注入地图漂移→修复→同路径复验已交付；可复用全五case维护路径与广义漂移发现仍未闭合。 |
| PS10 形式化验证生命周期 | 暂缓/未实现 | 形式化生成/维护与代码mutation对应尚未作为pstack能力实现 |
| PS11 状态图与反例解释 | 暂缓/未实现 | 状态图/反例解释工具未移植，不把普通Mermaid文档当模型检验 |
| PS12 反思转结构化约束 | 部分已交付 | skill-authoring第14方法已随PR302合入；反思到技能约束仅材料切片，不是受控经验晋升运行时。 |
| PS13 决策轨迹与证据归因 | 部分已交付 | 原始回执/manifest/hash/错误保留及安全投影已可用；证据完整性不认证身份/历史真实性；#301紧凑证据及PR候选报告材料已合并，不新增运行时。 |
| PS14 性能结论审查 | 部分已交付 | 性能审查方法与合成数例可用；无因果性能提升结果 |
| PS15 有预算的 hillclimb 与盲评 | 暂缓/未实现 | 有预算hillclimb/盲评尚未实现；当前有限host probe不是效果benchmark |
| PS16 自包含单元与协调者边界 | 部分已交付 | PR301已合入并行分工指南；运行时派发、竞赛和完整宿主效果尚未验收。 |
| PS17 栈前沿与候选绑定验证 | 部分已交付 | PR readiness材料+候选绑定实践；栈前沿自动校验服务未接线；#301紧凑证据及PR候选报告材料已合并，不新增运行时。 |
| PS18 forge 观察器分类 | 部分已交付 | 一次forge状态分类方法；未移植watch-pr观察器，不把既有github组件当本批新增；PR301已合并紧凑报告/证据归因与协调指南，未提供自动forge观察、检索或恢复运行时。 |
| PS19 暂停与恢复对账 | 部分已交付 | session-continuity材料可用；恢复schema/spec不等于J12运行态恢复；PR301已合并紧凑报告/证据归因与协调指南，未提供自动forge观察、检索或恢复运行时。 |
| PS20 跨宿主方法适配 | 部分已交付 | 四入口双host导出；Codex和Claude各一次有界实际修复已记录，Claude必读材料不全、旧失败保留；全方法等价/强制context/资格未通过 |
| PS21 来源快照与能力资格验证 | 部分已交付 | 更早281来源快照组件与合同、292材料源清单；实际采用闭包/资格/漂移激活未闭合 |
| PS22 事件 intake 与补偿模式 | 暂缓/未实现 | Benny/外部事件intake补偿未启用或移植 |
| PS23 使用方式驱动的接口与文档设计 | 部分已交付 | caller-first architecture、验证材料与文档；三条冻结地图和冷用户验收未全通过 |
| PS24 历史上下文恢复与可理解的决策说明 | 部分已交付 | continuity/解释+301已合并简报材料；无全局记忆自动化；视频/Bot/个人风格暂缓；PR301已合并紧凑报告/证据归因与协调指南，未提供自动forge观察、检索或恢复运行时。 |

## J里程碑：已交付与剩余缺口

以下是工程对账，不签发正式资格。主要关联仅解释交付落点，不等于正式输出已实现；工程状态须有自身切片证据。支持关联或设计关联本身不提升状态。暂缓表示当前优先级后排，原设计义务保留。

| 项目 | 已交付/可复用 | 待验证 | 未实现 | 待查明 | 排期 |
|---|---|---|---|---|---|
| J01 共享身份、完成与资格契约 | 严格身份/完成/资格/恢复契约及原始JSON、canonical、交叉字段和变异回归已交付。 | 已交付严格契约/回归仍待原JA59/70可信oracle流程与JA01/02真实宿主验收。 | 计划中的无副作用可信宿主准入入口尚未交付，不能由schema检查代替。 | 现有工程作者/审查者的证据是否满足原principal职责及独立性尚未正式确定。 | pstack或必要基础 |
| J02 共用来源快照与分型注册 | typed registry、v1兼容和opt-in source inspector可用；固定Git对象/路径/预算检查已有实现。 | source inspector和typed registry组件尚未完成原JA03/04整体验收。 | 采用依赖闭包及相应图/漂移失效消费链尚未交付。 | 调用方声明的repository identity是否有足够外部映射证据未确定。 | pstack或必要基础 |
| J03 session-answer-receipt 驱动夹具 | 现有CLI/daemon验证工具和固定两case旅程提供真实原始回执与证据。 | 现有真实CLI/daemon回执工具可复用，但未取得JA05/06/44对应资格。 | 计划中的method-control和session-answer-receipt统一驱动尚未交付。 | 现有工具迁入正式驱动需要多少新增接线，尚未按真实调用面验证。 | pstack或必要基础 |
| J04 必需方法材料与 v2 调用回执 | 14共享方法材料与现有execution-context基础可用。 | 共享材料和既有context基础尚未验证强制通道的实际adapter证据。 | MethodBinding必需材料装载、方法快照与完整v2调用回执链尚未交付。 | 各实际adapter可提供的版本/读取/预算证据能力尚未全量核定。 | pstack或必要基础 |
| J05 检查映射与单方法纯编译 | 共享方法含验证编写指导；尚无本计划recipe compiler交付证据。 | 暂无本计划recipe compiler候选可供正式JA10/11验收。 | 单方法纯编译与check映射输出尚未交付。 | J25.e0尚无决定，允许的完整方法链投资范围仍待真实可行性结果。 | pstack或必要基础 |
| J06 使用草图与三条功能地图 | feature-map模板、五case source验证及固定healthy/missing-ref两行图已交付。 | 现有feature-map模板、五case验证器和两case旅程尚未证明规定三图与冷调用者验收。 | 复现/等待/取消三图及统一usage-sketch回执交付尚未完成。 | 现有冷调用者使用观察能覆盖多少原V05要求尚未逐项认定。 | pstack或必要基础 |
| J07 产物消费与同候选评审 | 真实driver归档、严格两文件证据投影与输入完整性检查可用。 | 已交付证据投影与归档一致性工具尚未获得同候选产物消费正式验收。 | host-authoritative method artifacts及其资格消费链尚未交付。 | 保留证据的producer身份与历史真实性不能仅由hash/manifest确定。 | pstack或必要基础 |
| J08 首次受限试验准入 | 分层准入设计已明确无副作用host边界、正控制和真实入口复用。 | 已交付门槛设计及校验器尚无真实host准入/完整trial验收证据。 | method-host-admission入口及计划的首次受限trial链尚未交付。 | 各宿主可信调用边界与支持单元能力尚未完成资格核定。 | pstack或必要基础 |
| J09 首个本地 bug-fix 方法旅程 | bug-fix方法及真实CLI缺陷修复/回归工作流有交付。 | 已有bug-fix材料和实际产品缺陷回归尚未满足指定JA18方法旅程验收。 | recipe驱动的本地bug-fix旅程与method report尚未交付。 | 实际宿主完成该全链的稳定性和收益尚未证明。 | pstack或必要基础 |
| J10 方法资格与激活漂移管理 | 方法资格相关严格契约已有基础。 | 已有严格资格契约组件尚未完成持久资格/失效全链验收。 | 持久qualification、active漂移失效和方法改进晋升链尚未交付。 | E1价值决定、method-context测量及支持范围尚未确定。 | pstack或必要基础 |
| J11 恢复回执目标 schema 规格 | 真实home目录/旧hold和candidate48 DDL、逐字段删除/producer依赖回归、独立broker候选DDL已交付。 | 真实离线DDL、删除字段/producer图测试尚待正式JA20/47验收。 | 这些候选尚未注册运行时迁移；运行恢复属于后续J12，不应列为J11已实现。 | O03目标schema资格/部署分配与完整lineage仍未关闭。 | pstack或必要基础 |
| J12 目标 schema 恢复与操作员处置 | 离线schema/bootstrap/旧hold与broker组合测试可复用；既有graph recovery基础存在。 | 已有离线bootstrap/旧hold组合准备尚无真实操作员恢复资格证据。 | operator-recovery host、白名单迁移selector及跨进程原子处置链尚未交付。 | 可信操作员授权、实际进程存活/停止及恢复可支持范围仍待实测。 | pstack或必要基础 |
| J13 主控事件模型与累计预算 | 已有engineering持久store/DDL基础。 | 已有engineering store/DDL基础尚未接受新controller事件/预算全链验证。 | 联合controller/planner事件模型和累计预算执行链尚未交付。 | 跨重启/外部事件条件下的实际行为与成本尚未测定。 | 后排 |
| J14 Loop/Graph 准入与单次启动 | 既有Loop/Graph与executor基础存在。 | 既有Loop/Graph基础尚未取得JA24联合准入/单次启动证据。 | 联合engineering-executor及对应新准入接线尚未交付。 | 真实query/stop能力及其支持边界尚未资格测定。 | 后排 |
| J15 统一入口、范围纠正与路由 | 四命名入口、Codex/Claude可导出布局和13方法已合入；可按当前用户授权使用材料。 PR301已合并并行分工与紧凑报告；方法数仍13。 | 四入口/13材料的导出与读取证据不满足JA25/63/67持久问答和权限验收。 | 联合持久router、问题版本/纠偏与可信人类答案接线尚未交付。 | 四入口在所有目标宿主的原生发现/正确路由能力尚未证明。 | pstack或必要基础 |
| J16 跨方法与监督的联合旅程 | 已有真实验证器旅程和小规模宿主材料使用观察。 | 现有验证器旅程与有限host观察尚无JA26/27联合监督旅程资格。 | 跨方法与持续监督/恢复的完整joint journey及指定crash集成尚未交付。 | 组合链的端到端正确性与收益仍未知。 | 后排 |
| J17 容量、写集合与集成候选 | JP-17a独立broker namespace真实SQLite候选DDL/held orphan/不可变decision防护可用。 | JP-17a离线broker DDL和攻击回归尚未获得J17正式资格。 | JP-17b恢复与可信proof、JP-17c运行时容量/write-set/integration routing尚未交付。 | broker schema实际分配、跨进程fencing与隔离支持范围仍未确定。 | 后排 |
| J18 竞争与覆盖模式的多候选扩展 | 已有独立审查/不同候选比较经验，不属于新运行时交付。 | 已有人工独立评审/候选比较不是JA29运行时多候选验收。 | method-candidates与coverage/integration候选选择扩展尚未交付。 | 多候选方式对真实质量/成本的增益仍未知。 | 后排 |
| J19 上下文恢复与受控经验 | session-continuity方法保留当前授权核对、owner/dirty/base/next observer交接；反思指导只生成候选。 | 连续性方法的现有材料验证不满足JA30/69检索/晋升资格。 | 项目隔离上下文检索、有效期/provenance消费和受控经验晋升尚未交付。 | 未来规则能否捕获指定坏例且不误杀邻近好例尚未确定。 | pstack或必要基础 |
| J20 事件监督、低打扰与增量简报 | 连续负责/quiet的来源已经抽取为方法边界。 | 已有quiet/连续负责材料抽取尚无事件监督正式验收。 | 新联合事件监督、持久未决义务与增量brief运行链尚未交付。 | 实际长运行支持条件和低打扰效果尚未验证。 | 后排 |
| J21 远端子主管与父子回执 | 远程subcontroller合同/计划存在。 | 已有远端边界设计尚无实际subcontroller/父子回执验收候选。 | 远端子主管接线及恢复后的parent receipt处理尚未交付。 | 远端/租户/敌对同UID支持范围仍待O05测定。 | 后排 |
| J22 外部事件与授权公开承诺 | external intake/public commitment边界已有设计。 | 外部事件/公开承诺设计尚无原JA33/48实际验收。 | external intake及授权公开commitment运行链尚未交付。 | 实际外部服务权限、补偿能力和支持范围尚未确定。 | 后排 |
| J23 宿主与执行器资格测量 | 有Codex/Claude真实有限材料发现/使用实验，失败和限制保留。 | 有限真实宿主材料使用观察需保持其失败/限制，不能作为JA34全矩阵资格。 | 计划中的qualify-engineering-host和支持单元测量工具尚未交付。 | 未暴露的resolved model/principal及未观测宿主能力仍为unknown。 | 后排 |
| J24 有效版本、升级与恢复演练 | 既有engineering upgrade guard与真实升级/清理测试存在。 | 既有升级guard/真实CLI升级测试尚未满足JA35联合恢复矩阵验收。 | 指定joint升级smoke与全支持单元有效版本演练尚未交付。 | 真实跨版本恢复/隔离组合支持程度仍未确定。 | 后排 |
| J25 早期方法价值实验 | 有有限host行为/共享材料验证与原始失败，能提供后续实验输入。 | 有限host probe只可作实验输入，尚无E0/E1预登记任务的价值验收结果。 | 原方法价值协议与eval执行入口尚未交付。 | 真实收益、成本、holdout独立性及continue/shrink/stop决定均未确定。 | pstack或必要基础 |
| J26 来源能力与当前交付投影 | capability-index、交付账本及文档schema校验已存在；当前新增交付投影仅候选，不是计划中的runtime capabilities命令。 | 已交付静态能力/账本校验与当前只读rollup尚需对JA37/60证明边界逐项验收。 | 原计划capabilities validator/capability-delivery模块入口未交付；当前文档投影不能冒充这些实现。 | 当前只读rollup能覆盖原只读投影目标多少，应以其真实输入/校验范围确定，不能因无runtime直接否定。 | pstack或必要基础 |
| J27 灰度与支持范围内启用 | 设计runtime_enabled=false；无新联合support-cell启用证据。 | 没有已签发的新联合support-cell启用资格候选。 | 原计划分阶段release验证入口与联合运行手册尚未交付。 | local/default/full各支持范围的安全性与收益均尚未判定。 | 后排 |
| J28 高后果状态不变量形式化试点 | 有限形式状态验证已有计划。 | 已有形式化试点设计没有JA39已执行模型证据。 | 指定joint-effect TLA模型与检查入口尚未交付。 | 模型抽象对实际实现的覆盖与反例对应关系仍未知。 | 后排 |
| J29 性能与有预算的改进循环 | performance-measurement指导及明确标注的合成算术例已交付。 | 性能方法与合成算术验证尚无真实JA40预算改进验收。 | 指定性能eval入口和真实预算改进循环尚未交付。 | 端到端成本/性能收益、噪声与泛化效果未测定。 | pstack或必要基础 |
| J30 Forge 观察与栈前沿验证 | PR-readiness方法和本项目人工forge/CI取证流程已交付，当前head/base与review/integration分轴。 | PR-readiness材料/有限合成分类及人工forge取证尚未满足JA41/57运行验收。 | 新Forge observer、stack frontier与method report运行接线尚未交付。 | 实际不同forge/拓扑/权限条件下的覆盖与持续观察可靠性仍未知。 | pstack或必要基础 |
| J31 清理前保全与应用回执修复 | 真实Session finally/held admission/terminal fence/confirmed stop及applied evidence cleanup相关产品切片已合入。 | 真实cleanup/terminal产品切片仍未完成JA42/56全部保全与恢复验收。 | DEBT02跨进程unknown producer恢复与全保全清理链尚未交付。 | 所有dirty/unlanded资源类型及真实宿主进程树停止能力尚未充分验证。 | pstack或必要基础 |
| J32 联合四组对照与冷用户验收 | 已有少量宿主观察，可帮助冻结未来任务集。 | 有限宿主观察尚无JA43四组对照/独立冷用户结果。 | 指定联合四臂eval执行入口与完整实验交付尚未完成。 | Firstmate/pstack各自及组合因果贡献、真实成本和用户收益仍未知。 | 后排 |

## 合并PR与主要能力落点

| PR | 交付 | 主要关联J（非正式输出） | 支持项 |
|---|---|---|
| [#272](https://github.com/osborn-studio/osstack/pull/272) | 严格raw JSON与canonical digest基础 | J01 | J02 |
| [#273](https://github.com/osborn-studio/osstack/pull/273) | 共享方法/证据/资格合同与schema | J01 | J04,J07 |
| [#274](https://github.com/osborn-studio/osstack/pull/274) | home恢复schema/DDL/held fixture规格 | J11 | J12 |
| [#275](https://github.com/osborn-studio/osstack/pull/275) | Firstmate行为能力输入契约 | J02 | J01 |
| [#276](https://github.com/osborn-studio/osstack/pull/276) | 行为注册表加载器组件 | J02 | J10 |
| [#277](https://github.com/osborn-studio/osstack/pull/277) | Session应用回执持久化修复 | J31 | J03 |
| [#278](https://github.com/osborn-studio/osstack/pull/278) | Session start失败清理保全修复 | J31 | J03 |
| [#279](https://github.com/osborn-studio/osstack/pull/279) | Session terminal fence与释放语义 | J31 | J12 |
| [#280](https://github.com/osborn-studio/osstack/pull/280) | 联合设计和来源/交付文档主入口 | 设计公共输入 | J26 |
| [#281](https://github.com/osborn-studio/osstack/pull/281) | J02a有界Git来源检查与快照 | J02 | J26 |
| [#282](https://github.com/osborn-studio/osstack/pull/282) | 行为注册表审计确认问题修复 | J02 | J10 |
| [#283](https://github.com/osborn-studio/osstack/pull/283) | J01组件与J08真实host边界设计分层 | J01 | J08 |
| [#284](https://github.com/osborn-studio/osstack/pull/284) | broker schema/DDL/orphan离线规格 | J17 | J11 |
| [#285](https://github.com/osborn-studio/osstack/pull/285) | JA59/70组件回归与跨语言校验 | J01 |  |
| [#286](https://github.com/osborn-studio/osstack/pull/286) | home与broker恢复离线组合验证 | J11 | J17,J12 |
| [#288](https://github.com/osborn-studio/osstack/pull/288) | 四方法+真实回答回执验证工具 | J03 | J06,J09 |
| [#289](https://github.com/osborn-studio/osstack/pull/289) | skills check实际失败退出码修复 | J09 | J03 |
| [#290](https://github.com/osborn-studio/osstack/pull/290) | 两宿主历史证据读取+证据指南修正 | J23 | J07,J25 |
| [#291](https://github.com/osborn-studio/osstack/pull/291) | 可重复五case skills-check验证 | J03 | J06 |
| [#292](https://github.com/osborn-studio/osstack/pull/292) | 四命名入口+Codex/Claude可导出布局 | J15 | J04,J23 |
| [#293](https://github.com/osborn-studio/osstack/pull/293) | feature/refactoring两方法+有限原生发现实验 | J06 | J23 |
| [#294](https://github.com/osborn-studio/osstack/pull/294) | 两feature验证旅程+实际回执/功能地图 | J03 | J06,J07 |
| [#295](https://github.com/osborn-studio/osstack/pull/295) | 独占模型证据投影包 | J07 |  |
| [#296](https://github.com/osborn-studio/osstack/pull/296) | 代码审查第7方法+packet读取实验 | J07 | J06,J23 |
| [#297](https://github.com/osborn-studio/osstack/pull/297) | 影响面与性能测量第8/9方法 | J06 | J29 |
| [#298](https://github.com/osborn-studio/osstack/pull/298) | 任务深化与架构第10/11方法 | J06 | J05 |
| [#299](https://github.com/osborn-studio/osstack/pull/299) | 会话连续性第12方法+framing实际实验 | J19 |  |
| [#300](https://github.com/osborn-studio/osstack/pull/300) | PR readiness第13方法+4合成PR分类实验 | J30 | J07 |
| [#301](https://github.com/osborn-studio/osstack/pull/301) | 并行任务分工指南、紧凑证据与PR报告；仍为13个命名方法 | J15 | J19,J30 |

完整机器可读映射、历史源SHA及剩余原始验收项见 [delivery-rollup.json](delivery-rollup.json)。原始独立对账保存在 `docs/implementation/pstack-delivery-reconciliation/`，固定e26快照与本次新增301合并观察分别保留。

## 活动卡回链

39张活动卡已在JSON逐卡分型，并分别标注贡献、验证和仅设计背景关联。原快照状态保留；#301两卡已按新合并事实收口。独立测试、预检或有限宿主观察的Done只代表该活动结束，不代表对应大项通过。

J23一般运行时资格后排，但服务pstack闭环的真实宿主测量提前；新任务必须单独冻结协议，当前文档不是模型调用派发令。

看板已实际回写并回读：32大项为20项已有工程切片、12项待启动；这不是20项正式通过。39活动卡为37项结束、2项本批收口中。原29todo快照保留供追溯。

## 2026-10-29：真实使用补充（不增加方法数量）

#302现为Ready，仍待用户合并，主线13方法不变。维护映射已在真实验证器上完成漂移发现、唯一单元修正和同入口复验。Codex历史checker修复已产生本人实际回归RED→修复→GREEN；Claude未完成，受限命令形式被拒且零重试。独立宿主分项验收已完成：Codex限于该历史任务成立，Claude未修复；上述不替代J03/J06/J09/J23正式资格，也不是方法收益对照实验。详见[本轮记录](../../implementation/pstack-real-loops/README.md)。

最新收口：#302于2026-10-29T05:18:10Z合并，树c458ad2d与发布候选72ab99e7一致。上文Ready/13方法是各自历史快照；当前14方法不代表正式能力验收数量。

## 2026-10-29：Claude 实际导出器修复闭环

本轮没有新增方法。Claude 在一轮用户输入、零重试内完成8条单独命令：真实缺陷复现→新增行为测试RED（2过1败）→一行源码修正→同测试GREEN（3过），两个合法控制仍通过。任务是已修历史缺陷演练，不是当前main新缺陷。独立复验在旧/新源码上重跑模型所写测试，并检查6个预冻结隐藏输入；详见[实际修复记录](../../implementation/pstack-export-repair/README.md)。

实际调用native osstack-mode；evidence.md只读取60/64行，因此保留阅读不完整限制。PS01/PS08/PS20增加有限使用证据，PS09关联已有维护演练；4入口/14方法不变，32项正式里程碑未自动通过。旧Claude packet失败不改写。

## 2026-10-29：把材料完整读取接回现有使用路径

新增候选是只读分页工具及既有host-usage/bug-fix指引，不新增方法。后续页绑定首个完整文件摘要，文件改变、非法范围和超限明确失败；已对两个宿主各88个导出文件逐页重组核对字节。它帮助暴露遗漏页，不能证明模型看见或理解输出。先前Claude修复实验仍为LIMITED，不重新评分。本项回链PS01/PS08/PS20及J04（主）、J09/J23（支持），已完成定向、独立工具验证、实际Sonnet审计修订及注明范围的全仓回归，仍待发布CI与PR合并；详见[候选记录](../../implementation/method-material-reader/README.md)。

## 2026-10-29：pstack五case实际使用路径候选

既有journey新增可选`--scope full`，真实覆盖healthy/missing-ref/drift/mixed/empty，默认两case保持兼容。186定向、独立实际2+5case与失败反例、实际Sonnet静态审计通过，待发布CI及用户合并；未新增方法。旧两case投影器拒绝full而不丢弃行。PS08/PS09，J03主贡献、J06/J09支持，正式gate不变。见[交付记录](../../implementation/method-full-journey/README.md)及[功能优先队列](pstack-feature-queue.md)。
